"use strict";
// Admin: MCP サーバー — add servers by reference-only credentials, enable/disable, refresh
// tools, view diagnostics, reconnect, and call tools by (serverId, toolName). Mutating tools
// are confirmed by a native dialog in main; this page cannot mark a call confirmed.

(function () {
    const api = window.kei.mcp;
    const $ = id => document.getElementById(id);
    const { errorText } = window.KeiPluginFrames;

    const STATE = {
        idle: ["待機", "off"], connecting: ["接続中", "warn"], ready: ["接続済み", "on"],
        offline: ["オフライン", "bad"], disabled: ["無効", "off"],
    };

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else if (key === "dataset") Object.assign(node.dataset, value);
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? "" : value);
        }
        node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
        return node;
    }

    let toastTimer;
    function toast(text) {
        const node = document.getElementById("toast");
        node.textContent = text;
        node.classList.add("visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove("visible"), 3600);
    }

    let servers = [];
    let pendingOverwrite = null;
    const catalogs = new Map(); // serverId -> { tools, protocolVersion } | { error }
    const calls = new Map();    // serverId -> [call results]
    const busy = new Set();

    // ---------------------------------------------------------------- form
    function syncTransport() {
        const http = $("mcp-transport").value === "streamable-http";
        for (const node of document.querySelectorAll("#mcp-form .stdio-only")) node.hidden = http;
        for (const node of document.querySelectorAll("#mcp-form .http-only")) node.hidden = !http;
    }
    $("mcp-transport").addEventListener("change", syncTransport);
    syncTransport();

    $("mcp-form").addEventListener("submit", async event => {
        event.preventDefault();
        $("mcp-form-error").textContent = "";
        const transport = $("mcp-transport").value;
        const cred = $("mcp-cred").value.trim();
        const definition = {
            name: $("mcp-name").value,
            transport,
            timeoutSeconds: $("mcp-timeout").value || undefined,
            protocolMode: $("mcp-protocol").value,
            readOnlyTools: $("mcp-readonly").value.split(/[,、\s]+/).map(s => s.trim()).filter(Boolean),
            credentialRef: cred ? { env: cred, target: transport === "stdio" ? ($("mcp-cred-target").value.trim() || undefined) : undefined } : null,
        };
        if (transport === "stdio") {
            definition.command = $("mcp-command").value;
            definition.args = $("mcp-args").value.split("\n").map(s => s.trim()).filter(Boolean);
            definition.cwd = $("mcp-cwd").value.trim() || undefined;
        } else {
            definition.url = $("mcp-url").value.trim();
        }
        const id = $("mcp-id").value.trim();
        if (servers.some(s => s.id === id) && pendingOverwrite !== id) {
            pendingOverwrite = id;
            $("mcp-form-status").textContent = `ID「${id}」はすでにあります。上書きするにはもう一度「保存」を押してください（以前の接続と実行中の要求は終了します）。`;
            return;
        }
        pendingOverwrite = null;
        $("mcp-save").disabled = true;
        try {
            const response = await api.save(id, definition);
            if (response?.ok) {
                $("mcp-form-status").textContent = `「${response.server.name}」（${response.server.id}）を保存しました`;
                $("mcp-form").reset();
                syncTransport();
                await refresh();
            } else {
                $("mcp-form-error").textContent = `保存できませんでした：${errorText(response?.error?.code)}`;
            }
        } finally {
            $("mcp-save").disabled = false;
        }
    });

    // ---------------------------------------------------------------- servers
    async function withBusy(id, run) {
        if (busy.has(id)) return;
        busy.add(id);
        render();
        try { return await run(); } finally { busy.delete(id); await refresh(); }
    }

    async function loadTools(id, mode) {
        const response = await api.tools(id, mode);
        catalogs.set(id, response?.ok ? { tools: response.tools, protocolVersion: response.protocolVersion }
            : { error: response?.error?.code || "internal_error" });
    }

    function callEntry(c) {
        const ok = c.ok && !c.result?.isError;
        const text = c.ok
            ? (c.result.content.map(x => x.text).join("\n") || "") + (c.result.structuredContent ? `\n${JSON.stringify(c.result.structuredContent)}` : "")
            : errorText(c.error?.code);
        return el("div", { class: `call-entry ${ok ? "succeeded" : "failed"}`, dataset: { serverId: c.serverId, toolName: c.toolName, requestId: c.requestId || "", ok: String(Boolean(c.ok)) } },
            el("div", { class: "mono", text: `${c.serverId} / ${c.toolName}${c.requestId ? ` · ${c.requestId}` : ""}` }),
            el("div", { class: "call-text", text: c.ok && c.result.isError ? `ツールがエラーを返しました：${text}` : text }),
            !c.ok && c.error?.code ? el("div", { class: "note", text: `コード：${c.error.code}${c.error.mayHaveRun ? " · 実行された可能性があります" : ""}` }) : null);
    }

    function toolRows(server) {
        const catalog = catalogs.get(server.id);
        if (!catalog) return el("p", { class: "note", text: "「ツールを更新」で一覧を取得します。" });
        if (catalog.error) return el("div", { class: "error tool-error", text: `ツールを取得できません：${errorText(catalog.error)}（${catalog.error}）` });
        return el("table", { class: "tool-table" },
            el("thead", {}, el("tr", {}, el("th", { text: "ツール" }), el("th", { text: "説明" }), el("th", { text: "引数（JSON）" }), el("th", { text: "" }))),
            el("tbody", {}, ...catalog.tools.map(tool => {
                const readOnly = server.readOnlyTools.includes(tool.name);
                const args = el("input", { class: "tool-args", value: "{}", "aria-label": `${server.id} の ${tool.name} の引数` });
                return el("tr", { dataset: { serverId: server.id, toolName: tool.name } },
                    el("td", {}, el("span", { class: "mono", text: tool.name }), " ",
                        el("span", { class: `badge ${readOnly ? "on" : "warn"}`, text: readOnly ? "読み取り専用" : "要確認" })),
                    el("td", { text: tool.description }),
                    el("td", {}, args),
                    el("td", {}, el("button", { type: "button", class: "small", "data-action": "call", disabled: !server.enabled, onclick: async () => {
                        let parsed;
                        try { parsed = JSON.parse(args.value || "{}"); } catch { toast(errorText("invalid_arguments")); return; }
                        const result = await api.call(server.id, tool.name, parsed);
                        const list = calls.get(server.id) || [];
                        list.unshift(result);
                        calls.set(server.id, list.slice(0, 8));
                        render();
                    } }, "実行")));
            })));
    }

    function serverCard(s) {
        const [stateLabel, stateClass] = STATE[s.state] || [s.state, "off"];
        const isBusy = busy.has(s.id);
        const endpoint = s.transport === "stdio" ? `stdio · ${s.command || ""}` : `HTTP · ${s.url || ""}`;
        const d = s.diagnostics;
        const confirmBox = el("div", { class: "confirm", hidden: true },
            el("div", { class: "note", text: "このサーバーを削除しますか？実行中の要求は終了します。" }),
            el("div", { class: "row" },
                el("button", { type: "button", class: "danger solid small", "data-action": "delete-confirm", onclick: () => withBusy(s.id, () => api.remove(s.id).then(r => { catalogs.delete(s.id); calls.delete(s.id); return r; })) }, "削除"),
                el("button", { type: "button", class: "ghost small", onclick: () => { confirmBox.hidden = true; } }, "キャンセル")));
        return el("article", { class: "card mcp-card", dataset: { serverId: s.id, state: s.state, enabled: String(s.enabled) } },
            el("div", { class: "plugin-head" },
                el("span", { class: "plugin-name", text: s.name }),
                el("span", { class: "plugin-id", text: s.id }),
                el("span", { class: "badge", text: s.transport === "stdio" ? "stdio" : "HTTP" }),
                el("span", { class: `badge plugin-state mcp-state ${stateClass}`, text: stateLabel })),
            el("div", { class: "meta" },
                el("span", { class: "mono", text: endpoint }),
                s.credentialRef ? el("span", { text: `認証情報の参照：${s.credentialRef.env}${s.credentialRef.target ? ` → ${s.credentialRef.target}` : ""}` }) : el("span", { text: "認証情報なし" }),
                s.timeoutSeconds ? el("span", { text: `タイムアウト ${s.timeoutSeconds} 秒` }) : null),
            el("div", { class: "meta diagnostics" },
                d.protocolVersion ? el("span", { text: `プロトコル ${d.protocolVersion}` }) : null,
                d.serverInfo ? el("span", { text: `サーバー ${d.serverInfo.name} ${d.serverInfo.version}` }) : null),
            d.lastError ? el("div", { class: "error diagnostic", role: "alert", text: `接続エラー：${errorText(d.lastError)}（${d.lastError}）` }) : null,
            el("div", { class: "row" },
                el("button", { type: "button", class: "ghost small", "data-action": "toggle", disabled: isBusy,
                    onclick: () => withBusy(s.id, () => api.setEnabled(s.id, !s.enabled).then(r => { if (s.enabled) catalogs.delete(s.id); return r; })) },
                s.enabled ? "無効にする" : "有効にする"),
                el("button", { type: "button", class: "ghost small", "data-action": "refresh", disabled: isBusy, onclick: () => withBusy(s.id, () => loadTools(s.id, catalogs.has(s.id) ? "refresh" : "list")) }, "ツールを更新"),
                el("button", { type: "button", class: "ghost small", "data-action": "reconnect", disabled: isBusy || !s.enabled, onclick: () => withBusy(s.id, () => loadTools(s.id, "reconnect")) }, "再接続"),
                el("button", { type: "button", class: "danger small", "data-action": "delete", disabled: isBusy, onclick: () => { confirmBox.hidden = false; } }, "削除…")),
            confirmBox,
            toolRows(s),
            el("div", { class: "call-log" }, ...(calls.get(s.id) || []).map(callEntry)));
    }

    function render() {
        if (document.activeElement?.classList?.contains("tool-args")) return; // keep typing intact
        $("mcp-list").replaceChildren(...servers.map(serverCard));
        $("mcp-empty").hidden = servers.length > 0;
    }

    async function refresh() {
        const response = await api.list().catch(() => null);
        if (!response?.ok) {
            $("mcp-summary").textContent = errorText(response?.error?.code || "host_unavailable");
            return;
        }
        servers = response.servers;
        const ready = servers.filter(s => s.state === "ready").length;
        $("mcp-summary").textContent = `${servers.length} 件 · 接続済み ${ready} 件 · SDK ${response.sdkAvailable ? response.sdkVersion : "未インストール"}`;
        render();
    }

    window.kei.onStatus(status => { if (status.connected) refresh(); });
    $("refresh").addEventListener("click", refresh);
    refresh();
})();
