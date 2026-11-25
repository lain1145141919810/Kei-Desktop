"use strict";
// Pure validation for executor and MCP requests coming from the trusted admin renderer.
// Main re-checks everything here before calling the host; nothing is forwarded verbatim.

const SERVER_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const EXECUTOR_ID = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;
const TOOL_NAME = /^[A-Za-z0-9_.\-/:]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_TASK_INPUT = 8000;
const MAX_TOOL_ARGS_BYTES = 64 * 1024;

const isPlainObject = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const fail = code => ({ error: code });

function stringList(value, { max = 64, maxLength = 4096 } = {}) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > max) return null;
    if (!value.every(item => typeof item === "string" && item.length <= maxLength)) return null;
    return [...value];
}

// Build a host server definition from UI input. Only reference names for credentials
// are accepted; the UI never handles secret values.
function sanitizeServerDefinition(input) {
    if (!isPlainObject(input)) return fail("invalid_request");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 80) return fail("invalid_server_name");
    const transport = input.transport;
    if (transport !== "stdio" && transport !== "streamable-http") return fail("invalid_transport");
    const def = { name, transport, enabled: input.enabled !== false };

    if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null && input.timeoutSeconds !== "") {
        const timeout = Number(input.timeoutSeconds);
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) return fail("invalid_timeout");
        def.timeoutSeconds = timeout;
    }
    const mode = input.protocolMode ?? "auto";
    if (mode !== "auto" && mode !== "legacy") return fail("invalid_protocol_mode");
    def.protocolMode = mode;

    const readOnly = stringList(input.readOnlyTools, { maxLength: 128 });
    if (!readOnly || !readOnly.every(tool => TOOL_NAME.test(tool))) return fail("invalid_read_only_tools");
    def.readOnlyTools = [...new Set(readOnly)];

    if (input.credentialRef !== undefined && input.credentialRef !== null) {
        const ref = input.credentialRef;
        if (!isPlainObject(ref) || typeof ref.env !== "string" || !ENV_NAME.test(ref.env)) return fail("invalid_credential_ref");
        def.credentialRef = { env: ref.env };
        if (ref.target !== undefined && ref.target !== null && ref.target !== "") {
            if (transport !== "stdio" || typeof ref.target !== "string" || !ENV_NAME.test(ref.target)) return fail("invalid_credential_ref");
            def.credentialRef.target = ref.target;
        }
    }

    if (transport === "stdio") {
        if (typeof input.command !== "string" || !input.command.trim() || input.command.length > 1024) return fail("invalid_command");
        def.command = input.command.trim();
        const args = stringList(input.args);
        if (!args) return fail("invalid_args");
        def.args = args;
        if (input.cwd) {
            if (typeof input.cwd !== "string" || input.cwd.length > 1024) return fail("invalid_cwd");
            def.cwd = input.cwd;
        }
    } else {
        let url;
        try { url = new URL(String(input.url)); } catch { return fail("invalid_url"); }
        if (url.protocol !== "https:" && url.protocol !== "http:") return fail("invalid_url");
        if (url.username || url.password) return fail("credential_in_url");
        if (def.credentialRef && url.protocol === "http:" && !LOOPBACK.has(url.hostname)) return fail("insecure_credential_url");
        def.url = url.href;
    }
    return { def };
}

function checkServerId(id) {
    return typeof id === "string" && SERVER_ID.test(id);
}

function sanitizeToolCall(serverId, toolName, args) {
    if (!checkServerId(serverId)) return fail("invalid_request");
    if (typeof toolName !== "string" || !TOOL_NAME.test(toolName)) return fail("invalid_request");
    const value = args === undefined ? {} : args;
    if (!isPlainObject(value)) return fail("invalid_arguments");
    let size;
    try { size = Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return fail("invalid_arguments"); }
    if (size > MAX_TOOL_ARGS_BYTES) return fail("invalid_arguments");
    return { call: { serverId, toolName, arguments: JSON.parse(JSON.stringify(value)) } };
}

// executors: the latest GET /v1/executors list, fetched by main (never from the renderer).
function sanitizeTaskRequest(executors, executorId, input, options) {
    if (typeof executorId !== "string" || !EXECUTOR_ID.test(executorId)) return fail("invalid_request");
    const executor = executors.find(item => item.id === executorId);
    if (!executor) return fail("executor_not_found");
    if (!executor.available) return fail(executor.reason || "executor_unavailable");
    const text = typeof input === "string" ? input.trim() : "";
    if (!text || text.length > MAX_TASK_INPUT) return fail("invalid_task_input");
    const out = {};
    if (options !== undefined && options !== null) {
        if (!isPlainObject(options)) return fail("invalid_options");
        if (options.model !== undefined && options.model !== "") {
            const models = executor.options?.models || [];
            if (!models.some(model => model.id === options.model)) return fail("invalid_options");
            out.model = options.model;
        }
    }
    return { executor, input: text, options: Object.keys(out).length ? out : undefined };
}

function checkTaskId(id) {
    return typeof id === "string" && TASK_ID.test(id);
}

// Round 09: an explicit reading selection from trusted code (paste box or Ctrl+Alt+Q).
// Whitespace-only text is blocked here, before anything reaches a page or the model.
function sanitizeSelection(value) {
    if (!isPlainObject(value) || typeof value.text !== "string") return fail("invalid_selection");
    if (!value.text.trim()) return fail("empty_selection");
    if (value.text.length > 12000) return fail("invalid_selection");
    const source = value.source === undefined || value.source === null || value.source === "" ? null : value.source;
    if (source !== null && (typeof source !== "string" || !source.trim() || source.length > 250)) return fail("invalid_selection");
    const page = value.page === undefined || value.page === null || value.page === "" ? null : Number(value.page);
    if (page !== null && (!Number.isInteger(page) || page < 1 || page > 20000)) return fail("invalid_selection");
    return { selection: { text: value.text, source, page } };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

module.exports = {
    sanitizeServerDefinition, sanitizeToolCall, sanitizeTaskRequest, checkServerId, checkTaskId,
    TERMINAL, MAX_TASK_INPUT, sanitizeSelection,
};
