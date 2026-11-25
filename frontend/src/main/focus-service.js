"use strict";
// Trusted focus-timer driver (Round 12 README, "Focus timer"): keeps kei.focus/timer ticking
// even while its page is closed, claims each completion notice exactly once before showing the
// native notification, and feeds the toolbar chip. The session ID stays in main.

const PLUGIN = "kei.focus";
const ENTRY = "timer";
const CONTROLS = new Set(["start", "pause", "resume", "skip", "cancel", "preset"]);
const PRESETS = new Set(["25", "50", "15"]);
const RUNNING_MS = 1000;
const IDLE_MS = 15000;
const RETRY_MS = 30000;

const NOTICE_TEXT = {
    focus: { title: "集中おつかれさま", body: "区切りがつきました。少し休憩しましょう。" },
    break: { title: "休憩おわり", body: "次の集中を始めましょうか。" },
    "long-break": { title: "長い休憩おわり", body: "リフレッシュできましたか？ 次へ進みましょう。" },
};

class FocusService {
    constructor({ host, audit, notify, publish }) {
        this.host = host;
        this.audit = audit;
        this.notify = notify;     // ({ title, body, phase }) => void
        this.publish = publish;   // (snapshot | null) => void
        this.sessionId = null;
        this.timer = null;
        this.snapshot = null;
        this.busy = null;
        this.stopped = true;
        this.generation = 0;
    }

    start() {
        this.stopped = false;
        this.#schedule(0);
    }

    stop() {
        this.stopped = true;
        this.generation++;
        clearTimeout(this.timer);
        this.timer = null;
        void this.#close();
        this.#set(null);
    }

    // Plugin lifecycle or host reset: drop the session and look again.
    invalidate() {
        this.generation++;
        void this.#close();
        this.#set(null);
        if (!this.stopped) this.#schedule(500);
    }

    status() {
        return this.snapshot;
    }

    async control(action, args = {}) {
        if (!CONTROLS.has(action)) return { ok: false, error: { code: "invalid_request" } };
        const call = action === "preset" ? { preset: PRESETS.has(args?.preset) ? args.preset : null } : {};
        if (action === "preset" && !call.preset) return { ok: false, error: { code: "invalid_request" } };
        const result = await this.#call(action, call);
        if (!result) return { ok: false, error: { code: "plugin_disabled" } };
        if (result.error) return { ok: false, error: { code: "action_failed", message: result.error.message } };
        this.#schedule(RUNNING_MS);
        return { ok: true, focus: this.snapshot };
    }

    #set(snapshot) {
        const before = JSON.stringify(this.snapshot);
        this.snapshot = snapshot;
        if (JSON.stringify(snapshot) !== before) this.publish(snapshot);
    }

    #schedule(ms) {
        clearTimeout(this.timer);
        if (this.stopped) return;
        this.timer = setTimeout(() => void this.#tick(), ms);
        this.timer.unref?.();
    }

    async #open(generation) {
        if (this.sessionId) return true;
        try {
            const entries = await this.host.request("GET", "/v1/entries");
            if (!Array.isArray(entries) || !entries.some(item => item?.pluginId === PLUGIN && item?.id === ENTRY)) return false;
            const page = await this.host.request("POST", "/v1/pages/open", { pluginId: PLUGIN, entryId: ENTRY });
            if (generation !== this.generation || this.stopped) {
                if (typeof page?.sessionId === "string") {
                    await this.host.request("POST", "/v1/pages/close", { sessionId: page.sessionId }).catch(() => {});
                }
                return false;
            }
            this.sessionId = typeof page?.sessionId === "string" ? page.sessionId : null;
            if (this.sessionId) this.audit("focus.session", { opened: true });
            return Boolean(this.sessionId);
        } catch {
            return false;
        }
    }

    async #close() {
        const sessionId = this.sessionId;
        this.sessionId = null;
        if (sessionId) await this.host.request("POST", "/v1/pages/close", { sessionId }).catch(() => {});
    }

    // One call at a time; a closed session is reopened once.
    async #call(action, args) {
        const generation = this.generation;
        const run = async () => {
            for (let attempt = 0; attempt < 2; attempt++) {
                if (this.stopped || generation !== this.generation || !(await this.#open(generation))) return null;
                const sessionId = this.sessionId;
                try {
                    const data = await this.host.request("POST", "/v1/pages/call", { sessionId, action, arguments: args });
                    if (generation !== this.generation) return null;
                    const result = data?.result;
                    if (result && !result.error) await this.#absorb(result, sessionId, generation);
                    return result ?? null;
                } catch (error) {
                    if (!["page_closed", "session_not_found"].includes(error?.code)) return null;
                    if (this.sessionId === sessionId) this.sessionId = null;
                }
            }
            return null;
        };
        const previous = this.busy || Promise.resolve();
        const next = previous.then(run, run).finally(() => { if (this.busy === next) this.busy = null; });
        this.busy = next;
        return next;
    }

    async #absorb(result, sessionId, generation) {
        this.#set({
            status: String(result.status || "idle"),
            phase: String(result.phase || "focus"),
            preset: String(result.preset || "25"),
            remaining: Math.max(0, Number(result.remaining) || 0),
            completed: Math.max(0, Number(result.completed) || 0),
            at: Date.now(),
        });
        for (const notice of Array.isArray(result.notices) ? result.notices : []) {
            if (generation !== this.generation || typeof notice?.id !== "string") continue;
            try {
                const claim = (await this.host.request("POST", "/v1/pages/call", { sessionId, action: "claim", arguments: { id: notice.id } }))?.result;
                if (!claim?.claimed) continue; // another surface already delivered it
                const text = NOTICE_TEXT[claim.claimed.phase] || NOTICE_TEXT.focus;
                this.audit("focus.notice", { phase: claim.claimed.phase });
                this.notify({ ...text, phase: claim.claimed.phase });
            } catch { /* retried on the next tick while unexpired */ }
        }
    }

    async #tick() {
        const generation = this.generation;
        const result = await this.#call("tick", {});
        if (generation !== this.generation) return;
        if (!result) {
            this.#set(null);
            return this.#schedule(RETRY_MS);
        }
        this.#schedule(this.snapshot?.status === "running" ? RUNNING_MS : IDLE_MS);
    }
}

module.exports = { FocusService, FOCUS_CONTROLS: CONTROLS };
