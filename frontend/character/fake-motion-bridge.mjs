// Deterministic stand-in for window.kei used by the motion-provider tests. It models the
// parts of the preload bridge MotionProvider touches (entries, pages.open/close/call and the
// onEntriesChanged/onStatus/pages.onClosed/onEvent subscriptions) with explicit latencies, so
// cold-start races can be replayed without Electron, the host or the private Windows assets.

const PLUGIN = "kei.hastsec";
const ENTRY = "motion-provider";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function fakeClip(motion = "greeting-wave") {
    const q = [0, 0, Math.SQRT1_2 * 0.2, Math.sqrt(1 - 0.02)];
    const n = Math.hypot(...q);
    const rotation = q.map(value => value / n);
    return {
        version: 1, motion, rate: 20, mask: ["rightUpperArm"],
        frames: Array.from({ length: 12 }, (_, i) => [i % 2 ? rotation : [0, 0, 0, 1]]),
    };
}

export class FakeMotionBridge {
    constructor({ entriesMs = 1, openMs = 3, enabled = true, connected = true, openFailures = [],
        catalog = { state: "ready", motions: [{ id: "greeting-wave" }, { id: "kei-explain-measured" }, { id: "right-cheerful" }] } } = {}) {
        this.catalog = catalog;
        this.entriesMs = entriesMs;
        this.openMs = openMs;
        this.enabled = enabled;
        this.connected = connected;
        this.openFailures = [...openFailures]; // error codes returned by successive opens
        this.log = [];
        this.open = new Map(); // tag -> { reason: null | string }
        this.handlers = { entries: new Set(), status: new Set(), closed: new Set(), event: new Set() };
        this.counter = 0;
        this.t0 = performance.now();
        const sub = set => callback => { set.add(callback); return () => set.delete(callback); };
        this.onEntriesChanged = sub(this.handlers.entries);
        this.onStatus = sub(this.handlers.status);
        this.pages = {
            open: (pluginId, entryId) => this.#open(pluginId, entryId),
            close: async (tag, reason = "user") => this.closeFromMain(tag, reason === "navigated" ? "navigated" : "user", "renderer"),
            call: async (tag, message) => this.#call(tag, message),
            onClosed: sub(this.handlers.closed),
            onEvent: sub(this.handlers.event),
        };
    }

    at() { return Number((performance.now() - this.t0).toFixed(2)); }
    record(type, data = {}) { this.log.push({ at: this.at(), type, ...data }); }

    async entries() {
        // The host answers from its registry at request time; the reply then travels back.
        const connected = this.connected;
        const enabled = this.enabled;
        await sleep(this.entriesMs);
        if (!connected) return { ok: false, error: { code: "host_unavailable" } };
        return { ok: true, entries: enabled ? [{ pluginId: PLUGIN, id: ENTRY, slot: "character-settings" }] : [] };
    }

    async #open(pluginId, entryId) {
        this.record("page.open.request", { pluginId, entryId });
        await sleep(this.openMs);
        if (!this.connected) return { ok: false, error: { code: "host_unavailable" } };
        if (!this.enabled) return { ok: false, error: { code: "entry_not_found" } };
        const failure = this.openFailures.shift();
        if (failure) {
            this.record("page.open.failed", { code: failure });
            return { ok: false, error: { code: failure } };
        }
        const tag = "tag-" + (++this.counter);
        this.open.set(tag, { reason: null });
        this.record("page.open", { tag });
        return { ok: true, frame: { tag, pluginId, entryId } };
    }

    async #call(tag, message) {
        if (!this.open.has(tag)) return { ok: false, id: message.id, error: { code: "page_closed" } };
        const args = message.arguments ?? {};
        if (message.action === "prewarm") return { ok: true, result: { state: "ready", prewarmed: 4, computed: 0, elapsedMs: 1 } };
        if (message.action === "solve") {
            this.record("solve", { tag, motion: args.motion });
            return { ok: true, result: { state: "ready", clip: fakeClip(args.motion), diagnostics: { cached: true } } };
        }
        if (message.action === "solve.cancel" || message.action === "solve.poll") return { ok: true, result: { state: "cancelled" } };
        if (message.action === "catalog") return { ok: true, result: this.catalog };
        return { ok: false, error: { code: "unknown_action" } };
    }

    // The broker closing a frame: drop it and notify the renderer, like kei:page:closed.
    closeFromMain(tag, reason, origin = "main") {
        if (!this.open.has(tag)) return false;
        this.open.delete(tag);
        this.record("page.close", { tag, reason, origin });
        for (const callback of [...this.handlers.closed]) callback(tag, reason);
        return true;
    }

    emitEntriesChanged(reason = "plugin.enabled") { for (const callback of [...this.handlers.entries]) callback(reason); }
    emitStatus(connected) {
        this.connected = connected;
        for (const callback of [...this.handlers.status]) callback({ connected });
    }

    // Deliberate disable from Admin: the broker closes the plugin's frames, then entries change.
    disable() {
        this.enabled = false;
        for (const tag of [...this.open.keys()]) this.closeFromMain(tag, "plugin.disabled");
        this.emitEntriesChanged("plugin.disabled");
    }

    enable() {
        this.enabled = true;
        this.emitEntriesChanged("plugin.enabled");
    }

    get openTags() { return [...this.open.keys()]; }
}

export const flush = (ms = 0) => sleep(ms);
