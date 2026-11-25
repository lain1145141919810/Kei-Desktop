"use strict";
// Executor controls (backend docs/execution-api.md). Runs in the trusted main process:
// discovers adapters, submits user-authorized tasks with main-generated request IDs,
// follows each task's ordered event stream and pushes sanitized updates to Kei windows.

const crypto = require("node:crypto");
const { sanitizeTaskRequest, checkTaskId, TERMINAL } = require("./service-validation");

const CONVERSATION_ID = "kei-desktop-admin";

function sanitizeExecutor(e) {
    return {
        id: e.id,
        name: e.name,
        version: e.version,
        available: Boolean(e.available),
        reason: e.reason ?? null,
        capabilities: Object.fromEntries(Object.entries(e.capabilities || {}).map(([k, v]) => [k, Boolean(v)])),
        options: e.options ? {
            models: Array.isArray(e.options.models) ? e.options.models.map(m => ({ id: m.id, label: m.label })) : [],
            childRoles: Array.isArray(e.options.childRoles) ? e.options.childRoles : [],
        } : null,
    };
}

function sanitizeTask(t, local = {}) {
    return {
        id: t.id,
        requestId: t.requestId,
        executorId: t.executorId,
        status: t.status,
        sequence: t.sequence,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        inputRequest: t.inputRequest ? { id: t.inputRequest.id, prompt: t.inputRequest.prompt } : null,
        result: t.result ? { text: t.result.text ?? "", artifacts: Array.isArray(t.result.artifacts) ? t.result.artifacts : [] } : null,
        error: t.error ? { code: t.error.code, mayHaveSideEffects: Boolean(t.error.mayHaveSideEffects) } : null,
        input: local.input ?? null,
        cancel: t.status === "cancelled"
            ? { accepted: local.cancel?.accepted ?? false, confirmed: true }
            : local.cancel ?? null,
    };
}

function sanitizeEvent(e) {
    const data = e.data && typeof e.data === "object" ? e.data : {};
    const safe = {};
    for (const key of ["stage", "inputId", "prompt", "code", "mayHaveSideEffects", "text", "artifacts", "message", "percent"]) {
        if (data[key] !== undefined) safe[key] = data[key];
    }
    return { sequence: e.sequence, type: e.type, timestamp: e.timestamp, data: safe };
}

class ExecutorService {
    constructor(host, { broadcast, audit }) {
        this.host = host;
        this.broadcast = broadcast;
        this.audit = audit;
        this.local = new Map();     // taskId -> { input, cancel }
        this.following = new Map(); // taskId -> { cursor }
        this.executors = [];
    }

    async list() {
        const data = await this.host.request("GET", "/v1/executors");
        this.executors = (data.executors || []).map(sanitizeExecutor);
        return { ok: true, executors: this.executors };
    }

    async submit(executorId, input, options) {
        await this.list(); // availability is judged by main from the host, not by the renderer
        const checked = sanitizeTaskRequest(this.executors, executorId, input, options);
        if (checked.error) return { ok: false, error: { code: checked.error } };
        const body = {
            executorId, requestId: `ui-${crypto.randomUUID()}`, conversationId: CONVERSATION_ID, input: checked.input,
        };
        if (checked.options) body.options = checked.options;
        const task = await this.host.request("POST", "/v1/tasks", body);
        this.local.set(task.id, { input: checked.input, cancel: null });
        this.audit("task.submit", { taskId: task.id, executorId, requestId: body.requestId });
        this.#follow(task.id);
        return { ok: true, task: sanitizeTask(task, this.local.get(task.id)) };
    }

    async recent() {
        const tasks = await this.host.request("GET", `/v1/tasks?conversationId=${encodeURIComponent(CONVERSATION_ID)}`);
        for (const task of tasks) if (!TERMINAL.has(task.status)) this.#follow(task.id);
        return { ok: true, tasks: tasks.map(t => sanitizeTask(t, this.local.get(t.id))) };
    }

    async events(taskId) {
        if (!checkTaskId(taskId)) return { ok: false, error: { code: "invalid_request" } };
        const events = [];
        let cursor = 0;
        for (let page = 0; page < 50; page++) {
            const data = await this.host.request("GET", `/v1/tasks/${taskId}/events?after=${cursor}`);
            events.push(...(data.events || []).map(sanitizeEvent));
            cursor = data.cursor;
            if (!data.hasMore) break;
        }
        return { ok: true, events };
    }

    async cancel(taskId) {
        if (!checkTaskId(taskId)) return { ok: false, error: { code: "invalid_request" } };
        const data = await this.host.request("POST", `/v1/tasks/${taskId}/cancel`, {});
        const local = this.local.get(taskId) || { input: null };
        // Record exactly what the host said: requested (accepted, unconfirmed) vs confirmed.
        local.cancel = { accepted: Boolean(data.accepted), confirmed: Boolean(data.confirmed), at: Date.now() };
        this.local.set(taskId, local);
        this.audit("task.cancel", { taskId, accepted: local.cancel.accepted, confirmed: local.cancel.confirmed });
        const task = sanitizeTask(data.task, local);
        this.broadcast("kei:tasks:update", task);
        this.#follow(taskId);
        return { ok: true, accepted: task.cancel.accepted, confirmed: task.cancel.confirmed, task };
    }

    async answer(taskId, inputId, value) {
        if (!checkTaskId(taskId) || typeof inputId !== "string" || inputId.length > 128) return { ok: false, error: { code: "invalid_request" } };
        if (typeof value !== "string" || value.length > 4000) return { ok: false, error: { code: "invalid_task_input" } };
        const task = await this.host.request("POST", `/v1/tasks/${taskId}/input`, { inputId, value });
        this.audit("task.input", { taskId, inputId });
        const out = sanitizeTask(task, this.local.get(taskId));
        this.broadcast("kei:tasks:update", out);
        this.#follow(taskId);
        return { ok: true, task: out };
    }

    // Follow one task's ordered events until it is terminal and fully read.
    async #follow(taskId) {
        if (this.following.has(taskId)) return;
        const state = { cursor: 0 };
        this.following.set(taskId, state);
        try {
            for (;;) {
                let data;
                try {
                    data = await this.host.request("GET", `/v1/tasks/${taskId}/events?after=${state.cursor}`);
                } catch (error) {
                    if (error.code === "host_unavailable") { await new Promise(r => setTimeout(r, 1000)); continue; }
                    break;
                }
                for (const event of data.events || []) this.broadcast("kei:tasks:event", taskId, sanitizeEvent(event));
                state.cursor = data.cursor;
                if (data.hasMore) continue;
                const task = await this.host.request("GET", `/v1/tasks/${taskId}`);
                this.broadcast("kei:tasks:update", sanitizeTask(task, this.local.get(taskId)));
                if (TERMINAL.has(task.status)) {
                    const tail = await this.host.request("GET", `/v1/tasks/${taskId}/events?after=${state.cursor}`);
                    for (const event of tail.events || []) this.broadcast("kei:tasks:event", taskId, sanitizeEvent(event));
                    break;
                }
                await new Promise(r => setTimeout(r, 250));
            }
        } finally {
            this.following.delete(taskId);
        }
    }

    stopAll() { this.following.clear(); }
}

module.exports = { ExecutorService, sanitizeExecutor, sanitizeTask, sanitizeEvent, CONVERSATION_ID };
