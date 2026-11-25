"use strict";
// Background task sessions (作業): long-running executor tasks that keep running and being
// followed by main while no Kei window is looking. Built on ExecutorService (which owns the
// host calls and the ordered event stream); this module keeps a compact per-task summary,
// announces transitions once (native notification + a desktop notice), remembers titles and
// dismissals across restarts, and serves a small desktop-facing view.

const fs = require("node:fs");
const path = require("node:path");
const { TERMINAL } = require("./service-validation");

const MAX_LISTED = 30;
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
const ACTIVE = new Set(["queued", "running", "waiting_for_input", "cancelling"]);

function clip(text, max) {
    if (typeof text !== "string") return "";
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

class TaskSessions {
    constructor({ executors, file, audit, publish, notify }) {
        this.executors = executors;
        this.file = file;
        this.audit = audit;
        this.publish = publish;   // (snapshot) => void, throttled here
        this.notify = notify;     // ({ kind, id, title, detail }) => void
        this.tasks = new Map();   // id -> summary
        this.names = new Map();   // executorId -> display name
        this.store = { titles: {}, dismissed: [] };
        this.announced = new Map(); // id -> last announced kind
        this.timer = null;
        this.#load();
    }

    #load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (data && typeof data === "object") {
                this.store.titles = data.titles && typeof data.titles === "object" ? data.titles : {};
                this.store.dismissed = Array.isArray(data.dismissed) ? data.dismissed.filter(x => typeof x === "string").slice(-500) : [];
            }
        } catch { /* first run */ }
    }

    #save() {
        try {
            const ids = Object.keys(this.store.titles);
            if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete this.store.titles[id];
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const scratch = this.file + ".tmp";
            fs.writeFileSync(scratch, JSON.stringify(this.store), { mode: 0o600 });
            fs.renameSync(scratch, this.file);
        } catch { /* best effort */ }
    }

    // ---- inputs from ExecutorService broadcasts
    observe(channel, ...args) {
        if (channel === "kei:tasks:update") this.#ingest(args[0], true);
        else if (channel === "kei:tasks:event") this.#event(args[0], args[1]);
    }

    async resume() {
        try {
            const listed = await this.executors.list();
            for (const e of listed.executors || []) this.names.set(e.id, e.name);
            const recent = await this.executors.recent(); // also follows every non-terminal task
            for (const task of recent.tasks || []) this.#ingest(task, false);
            this.#changed();
        } catch { /* host not ready; called again on reconnect */ }
    }

    #ingest(task, announce) {
        if (!task || typeof task.id !== "string") return;
        const before = this.tasks.get(task.id);
        if (before && ((Number.isInteger(task.sequence) && Number.isInteger(before.sequence) && task.sequence < before.sequence) ||
            (TERMINAL.has(before.status) && !TERMINAL.has(task.status)))) return;
        if (task.input && !this.store.titles[task.id]) { this.store.titles[task.id] = clip(task.input, 80); this.#save(); }
        const summary = {
            id: task.id,
            executorId: task.executorId,
            executor: this.names.get(task.executorId) || task.executorId,
            title: this.store.titles[task.id] || `タスク ${task.id.slice(0, 8)}`,
            status: task.status,
            sequence: task.sequence ?? null,
            createdAt: task.createdAt ?? before?.createdAt ?? null,
            updatedAt: task.updatedAt ?? null,
            finishedAt: TERMINAL.has(task.status) ? (before?.finishedAt ?? Date.now()) : null,
            stage: before?.stage ?? null,
            message: before?.message ?? null,
            percent: before?.percent ?? null,
            inputRequest: task.inputRequest ? { id: task.inputRequest.id, prompt: clip(task.inputRequest.prompt, 300) } : null,
            result: task.result ? { text: clip(task.result.text, 600), artifacts: task.result.artifacts.length } : null,
            error: task.error ? { code: task.error.code, mayHaveSideEffects: task.error.mayHaveSideEffects } : null,
            cancel: task.cancel ? { accepted: task.cancel.accepted, confirmed: task.cancel.confirmed } : null,
        };
        this.tasks.set(task.id, summary);
        if (announce) this.#announce(summary);
        else if (TERMINAL.has(summary.status) || summary.inputRequest) this.announced.set(summary.id, this.#kind(summary));
        if (before?.status !== summary.status && ["cancelling", "cancelled"].includes(summary.status)) {
            clearTimeout(this.timer);
            this.timer = null;
            this.publish(this.snapshot());
        } else {
            this.#changed();
        }
    }

    #event(taskId, event) {
        const summary = this.tasks.get(taskId);
        if (!summary || !event || event.type !== "task.progress") return;
        const data = event.data || {};
        if (typeof data.stage === "string") summary.stage = clip(data.stage, 80);
        if (typeof data.message === "string") summary.message = clip(data.message, 160);
        if (Number.isFinite(data.percent)) summary.percent = Math.max(0, Math.min(100, Math.round(data.percent)));
        this.#changed();
    }

    #kind(summary) {
        if (summary.inputRequest && summary.status === "waiting_for_input") return "input:" + summary.inputRequest.id;
        if (summary.status === "succeeded") return "succeeded";
        if (summary.status === "failed") return "failed";
        if (summary.status === "cancelled") return "cancelled";
        return null;
    }

    #announce(summary) {
        const kind = this.#kind(summary);
        if (!kind || this.announced.get(summary.id) === kind) return;
        this.announced.set(summary.id, kind);
        const base = kind.startsWith("input:") ? "input" : kind;
        // The desktop checks that an input request is still pending before
        // applying its asynchronous expression. Publish the state first.
        if (base === "input") this.publish(this.snapshot());
        this.audit("session.notice", { taskId: summary.id, kind: base });
        this.notify({ kind: base, id: summary.id, title: summary.title, executor: summary.executor,
            detail: base === "input" ? summary.inputRequest.prompt : base === "failed" ? summary.error?.code : summary.result?.text || "" });
    }

    #changed() {
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.publish(this.snapshot()); }, 200);
        this.timer.unref?.();
    }

    snapshot() {
        const now = Date.now();
        const dismissed = new Set(this.store.dismissed);
        const list = [...this.tasks.values()]
            .filter(t => !dismissed.has(t.id))
            .filter(t => !TERMINAL.has(t.status) || !t.finishedAt || now - t.finishedAt < KEEP_FINISHED_MS)
            .sort((a, b) => (ACTIVE.has(b.status) - ACTIVE.has(a.status)) || String(b.createdAt).localeCompare(String(a.createdAt)))
            .slice(0, MAX_LISTED);
        return {
            sessions: list,
            running: list.filter(t => ACTIVE.has(t.status) && t.status !== "waiting_for_input").length,
            waiting: list.filter(t => t.status === "waiting_for_input").length,
            finished: list.filter(t => TERMINAL.has(t.status)).length,
        };
    }

    // ---- desktop actions (validated again inside ExecutorService)
    async submit(executorId, input, options) {
        const reply = await this.executors.submit(executorId, input, options);
        if (reply.ok) { this.store.titles[reply.task.id] = clip(input, 80); this.#save(); this.#ingest(reply.task, false); }
        return reply;
    }

    cancel(id) {
        if (!this.tasks.has(id)) return { ok: false, error: { code: "invalid_request" } };
        return this.executors.cancel(id);
    }
    answer(id, inputId, value) {
        const task = this.tasks.get(id);
        if (task?.status !== "waiting_for_input" || task.inputRequest?.id !== inputId) {
            return { ok: false, error: { code: "invalid_request" } };
        }
        return this.executors.answer(id, inputId, value);
    }

    dismiss(id) {
        const ids = id === "finished" ? [...this.tasks.values()].filter(t => TERMINAL.has(t.status)).map(t => t.id)
            : (this.tasks.get(id) && TERMINAL.has(this.tasks.get(id).status) ? [id] : []);
        if (!ids.length) return { ok: false, error: { code: "invalid_request" } };
        this.store.dismissed = [...new Set([...this.store.dismissed, ...ids])].slice(-500);
        this.#save();
        this.#changed();
        return { ok: true, dismissed: ids.length };
    }
}

module.exports = { TaskSessions, ACTIVE_STATUSES: ACTIVE };
