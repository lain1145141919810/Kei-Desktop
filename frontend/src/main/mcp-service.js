"use strict";
// MCP settings and diagnostics (backend docs/mcp-api.md). Trusted main process only:
// credential references are names of host-process environment variables, request IDs are
// generated here, and any tool not designated read-only by the operator requires a native
// confirmation dialog shown by main. The renderer cannot set `confirmed`.

const crypto = require("node:crypto");
const { dialog } = require("electron");
const { sanitizeServerDefinition, sanitizeToolCall, checkServerId } = require("./service-validation");

function sanitizeServer(s) {
    const diagnostics = s.diagnostics || {};
    return {
        id: s.id,
        name: s.name,
        transport: s.transport,
        enabled: Boolean(s.enabled),
        state: s.state,
        timeoutSeconds: s.timeoutSeconds,
        protocolMode: s.protocolMode,
        credentialRef: s.credentialRef ? { env: s.credentialRef.env, target: s.credentialRef.target ?? null } : null,
        readOnlyTools: Array.isArray(s.readOnlyTools) ? s.readOnlyTools : [],
        url: s.url ?? null,
        command: s.command ?? null,
        cwd: s.cwd ?? null,
        diagnostics: {
            protocolVersion: diagnostics.protocolVersion ?? null,
            serverInfo: diagnostics.serverInfo ? { name: diagnostics.serverInfo.name, version: diagnostics.serverInfo.version } : null,
            lastError: typeof diagnostics.lastError === "string" ? diagnostics.lastError : (diagnostics.lastError?.code ?? null),
        },
    };
}

function sanitizeTools(data) {
    return {
        serverId: data.serverId,
        protocolVersion: data.protocolVersion ?? null,
        tools: (data.tools || []).map(t => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null })),
    };
}

function errorOut(error, extra = {}) {
    return {
        ok: false,
        ...extra,
        error: {
            code: error.code || "internal_error",
            mayHaveRun: error.details?.mayHaveRun ?? undefined,
            protocolCode: error.details?.protocolCode ?? undefined,
        },
    };
}

class McpService {
    constructor(host, { audit, adminWindow }) {
        this.host = host;
        this.audit = audit;
        this.adminWindow = adminWindow; // () => BrowserWindow | null
        this.pluginAccess = new Map();  // keep operator pluginAccess across UI edits
    }

    async list() {
        const data = await this.host.request("GET", "/v1/mcp/servers");
        for (const s of data.servers || []) this.pluginAccess.set(s.id, s.pluginAccess || {});
        return { ok: true, sdkVersion: data.sdkVersion ?? null, sdkAvailable: Boolean(data.sdkAvailable), servers: (data.servers || []).map(sanitizeServer) };
    }

    async save(id, input) {
        if (!checkServerId(id)) return { ok: false, error: { code: "invalid_server_id" } };
        const checked = sanitizeServerDefinition(input);
        if (checked.error) return { ok: false, error: { code: checked.error } };
        const def = { ...checked.def, pluginAccess: this.pluginAccess.get(id) || {} };
        try {
            const server = await this.host.request("PUT", `/v1/mcp/servers/${id}`, def);
            this.audit("mcp.save", { serverId: id, transport: def.transport, credentialRef: def.credentialRef?.env ?? null });
            return { ok: true, server: sanitizeServer(server) };
        } catch (error) { return errorOut(error); }
    }

    async setEnabled(id, enabled) {
        if (!checkServerId(id) || typeof enabled !== "boolean") return { ok: false, error: { code: "invalid_request" } };
        try {
            const server = await this.host.request("POST", `/v1/mcp/servers/${id}/enabled`, { enabled });
            this.audit("mcp.enabled", { serverId: id, enabled });
            return { ok: true, server: sanitizeServer(server) };
        } catch (error) { return errorOut(error); }
    }

    async remove(id) {
        if (!checkServerId(id)) return { ok: false, error: { code: "invalid_request" } };
        try {
            await this.host.request("DELETE", `/v1/mcp/servers/${id}`);
            this.audit("mcp.delete", { serverId: id });
            return { ok: true };
        } catch (error) { return errorOut(error); }
    }

    async tools(id, mode = "list") {
        if (!checkServerId(id)) return { ok: false, error: { code: "invalid_request" } };
        const route = mode === "refresh" ? ["POST", `/v1/mcp/servers/${id}/refresh`, {}]
            : mode === "reconnect" ? ["POST", `/v1/mcp/servers/${id}/reconnect`, {}]
                : ["GET", `/v1/mcp/servers/${id}/tools`];
        try {
            const data = await this.host.request(...route);
            this.audit(`mcp.${mode}`, { serverId: id, ok: true });
            // refresh / reconnect may return the catalog or only state; always read the catalog after.
            const catalog = data?.tools ? data : await this.host.request("GET", `/v1/mcp/servers/${id}/tools`);
            return { ok: true, ...sanitizeTools(catalog) };
        } catch (error) {
            this.audit(`mcp.${mode}`, { serverId: id, ok: false, code: error.code });
            return errorOut(error, { serverId: id });
        }
    }

    async call(serverId, toolName, args) {
        const checked = sanitizeToolCall(serverId, toolName, args);
        if (checked.error) return { ok: false, serverId, toolName, error: { code: checked.error } };
        const list = await this.list(); // read-only designation comes from the host, not the renderer
        const server = list.servers.find(s => s.id === serverId);
        if (!server) return { ok: false, serverId, toolName, error: { code: "mcp_server_not_found" } };
        const readOnly = server.readOnlyTools.includes(toolName);
        const requestId = `ui-${crypto.randomUUID()}`;
        let confirmed = false;
        if (!readOnly) {
            const preview = JSON.stringify(checked.call.arguments);
            const answer = await dialog.showMessageBox(this.adminWindow() || undefined, {
                type: "warning",
                title: "MCP ツールの実行確認",
                message: `${server.name}（${serverId}）の「${toolName}」を実行しますか？`,
                detail: `このツールは読み取り専用として登録されていないため、外部のデータが変更される可能性があります。\n引数：${preview.length > 400 ? preview.slice(0, 400) + "…" : preview}\nリクエスト ID：${requestId}`,
                buttons: ["実行する", "キャンセル"],
                defaultId: 1,
                cancelId: 1,
                noLink: true,
            });
            confirmed = answer.response === 0;
            this.audit("mcp.confirm", { serverId, toolName, requestId, confirmed });
            if (!confirmed) return { ok: false, serverId, toolName, requestId, readOnly, error: { code: "user_cancelled" } };
        }
        try {
            const data = await this.host.request("POST", `/v1/mcp/servers/${serverId}/call`, {
                requestId, toolName, arguments: checked.call.arguments, ...(confirmed ? { confirmed: true } : {}),
            });
            this.audit("mcp.call", { serverId, toolName, requestId, ok: true, isError: Boolean(data.result?.isError) });
            const result = data.result || {};
            return {
                ok: true, serverId: data.serverId, toolName: data.toolName, requestId: data.requestId, readOnly, confirmed,
                result: {
                    isError: Boolean(result.isError),
                    content: (result.content || []).filter(c => c.type === "text").map(c => ({ type: "text", text: c.text })),
                    structuredContent: result.structuredContent ?? null,
                },
            };
        } catch (error) {
            this.audit("mcp.call", { serverId, toolName, requestId, ok: false, code: error.code });
            return errorOut(error, { serverId, toolName, requestId, readOnly, confirmed });
        }
    }

    // Round 08 decision 1: a plugin page asks for a mutation confirmation. pluginId comes
    // from main's frame record, never from the page. Main checks the plugin's mcp.call grant
    // and the operator's pluginAccess, shows the native dialog for non-read-only tools, and
    // only then asks the host for its request-bound, one-use token (60 s).
    async confirmForPlugin(pluginId, pluginName, serverId, toolName, args) {
        const checked = sanitizeToolCall(serverId, toolName, args);
        if (checked.error) return { ok: false, error: { code: checked.error } };
        let plugin;
        try { plugin = await this.host.request("GET", `/v1/plugins/${pluginId}`); } catch { plugin = null; }
        const grants = plugin?.effectiveGrants || plugin?.grants || [];
        const list = await this.list();
        const server = list.servers.find(s => s.id === serverId);
        const allowed = this.pluginAccess.get(serverId)?.[pluginId] || [];
        if (!plugin?.enabled || !grants.includes("mcp.call") || !server || !server.enabled || !allowed.includes(toolName)) {
            this.audit("mcp.plugin_confirm", { pluginId, serverId, toolName, outcome: "scope_denied" });
            return { ok: false, error: { code: "mcp_scope_denied" } };
        }
        if (server.readOnlyTools.includes(toolName)) {
            this.audit("mcp.plugin_confirm", { pluginId, serverId, toolName, outcome: "read_only" });
            return { ok: true, readOnly: true, confirmation: null };
        }
        const preview = JSON.stringify(checked.call.arguments);
        const answer = await dialog.showMessageBox(this.desktopWindow?.() || this.adminWindow() || undefined, {
            type: "warning",
            title: "プラグインからの MCP 実行の確認",
            message: `プラグイン「${pluginName || pluginId}」が ${server.name}（${serverId}）の「${toolName}」を実行しようとしています。許可しますか？`,
            detail: `このツールは読み取り専用ではないため、外部のデータが変更される可能性があります。許可は今回の引数で 1 回だけ有効です（60 秒以内）。\nプラグイン：${pluginId}\n引数：${preview.length > 400 ? preview.slice(0, 400) + "…" : preview}`,
            buttons: ["許可する", "キャンセル"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
        });
        if (answer.response !== 0) {
            this.audit("mcp.plugin_confirm", { pluginId, serverId, toolName, outcome: "user_cancelled" });
            return { ok: false, error: { code: "user_cancelled" } };
        }
        try {
            const data = await this.host.request("POST", "/v1/mcp/confirm", {
                pluginId, serverId, toolName, arguments: checked.call.arguments, confirmed: true,
            });
            this.audit("mcp.plugin_confirm", { pluginId, serverId, toolName, outcome: "token_issued" });
            return { ok: true, readOnly: false, confirmation: data.confirmation };
        } catch (error) { return errorOut(error); }
    }

    async cancel(requestId) {
        if (typeof requestId !== "string" || !/^ui-[0-9a-f-]{36}$/.test(requestId)) return { ok: false, error: { code: "invalid_request" } };
        try {
            await this.host.request("POST", "/v1/mcp/cancel", { requestId });
            return { ok: true };
        } catch (error) { return errorOut(error); }
    }
}

module.exports = { McpService, sanitizeServer };
