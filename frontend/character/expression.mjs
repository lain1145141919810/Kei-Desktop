const PLUGIN = "kei.lumenact";
const ENTRY = "expression-provider";
const RESERVED = new Set(["neutral", "aa", "ih", "ou", "ee", "oh", "blink", "blinkleft", "blinkright",
    "lookleft", "lookright", "lookup", "lookdown"]);
const clamp = value => Math.min(1, Math.max(0, value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function emotionTarget(name) {
    return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(name) && !RESERVED.has(name.toLowerCase());
}

function validClip(clip) {
    return clip?.format === "kei.expression.clip.v1" && typeof clip.clipId === "string" && /^[0-9]{1,5}$/.test(clip.clipId) &&
        Number.isFinite(clip.fps) && clip.fps >= 1 && clip.fps <= 120 &&
        Number.isInteger(clip.frames) && clip.frames >= 2 && clip.frames <= 1800 &&
        Array.isArray(clip.targets) && clip.targets.length > 0 && clip.targets.length <= 12 &&
        clip.targets.every(emotionTarget) && new Set(clip.targets).size === clip.targets.length &&
        Array.isArray(clip.tracks) && clip.tracks.length === clip.targets.length &&
        clip.tracks.every(track => Array.isArray(track) && track.length === clip.frames &&
            track.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
}

export class ExpressionTimeline {
    constructor() {
        this.clip = null;
    }

    play(clip, now) {
        if (!validClip(clip)) return false;
        this.clip = clip;
        this.start = now;
        return true;
    }

    clear() {
        this.clip = null;
    }

    sample(now) {
        if (!this.clip) return null;
        const { clipId, fps, frames, targets, tracks } = this.clip;
        const elapsed = Math.max(0, now - this.start);
        const duration = (frames - 1) / fps * 1000;
        if (elapsed >= duration) {
            this.clear();
            return null;
        }
        const frame = elapsed * fps / 1000;
        const first = Math.floor(frame);
        const weight = frame - first;
        const fade = clamp(Math.min(elapsed, duration - elapsed) / 140);
        return {
            clipId,
            values: Object.fromEntries(targets.map((name, index) => {
                const track = tracks[index];
                const next = Math.min(first + 1, frames - 1);
                return [name, (track[first] + (track[next] - track[first]) * weight) * fade];
            })),
        };
    }
}

export class ExpressionProvider {
    constructor(bridge, timeline) {
        this.bridge = bridge;
        this.timeline = timeline;
        this.tag = null;
        this.refreshVersion = 0;
        this.requestVersion = 0;
        this.jobId = null;
        this.status = "unavailable";
        this.previewAfter = 0;
        this.disposed = false;
        this.listeners = [
            bridge.onEntriesChanged(() => void this.refresh()),
            bridge.onStatus(state => state?.connected ? undefined : this.close()),
            bridge.pages.onClosed(tag => {
                if (this.tag === tag) this.close(false);
            }),
            bridge.pages.onEvent((tag, event) => {
                if (tag !== this.tag || event?.topic !== "lumenact.preview") return;
                const message = event.data;
                if (!Number.isSafeInteger(message?.issuedAt) || message.issuedAt <= this.previewAfter) return;
                if (message.type === "stop") this.interrupt();
                else if (message.type === "play" && this.timeline.play(message.clip, performance.now())) {
                    this.cancelSelection();
                    this.selection = message.selection;
                    this.status = "preview";
                }
            }),
        ];
        void this.refresh();
    }

    async refresh() {
        if (this.disposed) return;
        const version = ++this.refreshVersion;
        try {
            const listed = await this.bridge.entries();
            if (this.disposed || version !== this.refreshVersion) return;
            const found = listed.ok && listed.entries.some(entry =>
                entry.pluginId === PLUGIN && entry.id === ENTRY && entry.slot === "character-settings");
            if (!found) {
                this.close();
                return;
            }
            if (this.tag) return;
            const opened = await this.bridge.pages.open(PLUGIN, ENTRY);
            if (!opened.ok) return;
            if (this.disposed || version !== this.refreshVersion) {
                await this.bridge.pages.close(opened.frame.tag);
                return;
            }
            this.tag = opened.frame.tag;
            this.status = "idle";
        } catch {
            if (version === this.refreshVersion) this.close();
        }
    }

    async call(tag, action, args) {
        try {
            return await this.bridge.pages.call(tag, { type: "kei:call", id: crypto.randomUUID(), action, arguments: args });
        } catch {
            return { ok: false, error: { code: "provider_unavailable" } };
        }
    }

    cancelSelection() {
        this.requestVersion++;
        if (this.tag && this.jobId) void this.call(this.tag, "select.cancel", { jobId: this.jobId });
        this.jobId = null;
    }

    interrupt() {
        this.previewAfter = Date.now();
        this.cancelSelection();
        this.timeline.clear();
        this.selection = null;
        this.status = this.tag ? "idle" : "unavailable";
    }

    close(notify = true) {
        this.refreshVersion++;
        const tag = this.tag;
        this.interrupt();
        this.tag = null;
        this.status = "unavailable";
        if (notify && tag) void this.bridge.pages.close(tag).catch(() => {});
    }

    async request(intent, text = "") {
        this.interrupt();
        const tag = this.tag;
        if (!tag || this.disposed) return { state: "fallback", code: "provider_unavailable" };
        const version = this.requestVersion;
        const current = () => this.tag === tag && version === this.requestVersion && !this.disposed;
        this.status = "selecting";
        let response = await this.call(tag, "select", { intent, text });
        if (!current()) {
            if (response.result?.jobId && this.tag === tag) {
                void this.call(tag, "select.cancel", { jobId: response.result.jobId });
            }
            return { state: "fallback", code: "stale_selection" };
        }
        const jobId = response.result?.jobId;
        this.jobId = jobId ?? null;
        const deadline = performance.now() + 42500;
        while (current() && response.ok && response.result?.state === "pending" &&
            typeof jobId === "string" && performance.now() < deadline) {
            await sleep(160);
            if (current()) response = await this.call(tag, "select.poll", { jobId });
        }
        if (!current()) return { state: "fallback", code: "stale_selection" };
        if (response.result?.state === "pending") this.cancelSelection();
        this.jobId = null;
        const result = response.result?.state !== "pending" && response.result ||
            { state: "fallback", code: response.error?.code ?? "selection_timeout" };
        if (result.state === "ready" && this.timeline.play(result.clip, performance.now())) {
            this.selection = result.selection;
            this.status = "playing";
            return { state: "ready", selection: result.selection, clipId: result.clip.clipId };
        }
        this.status = result.code ?? "invalid_curve";
        return { state: "fallback", code: this.status };
    }

    snapshot() {
        return { connected: Boolean(this.tag), status: this.status, selection: this.selection ?? null,
            clipId: this.timeline.clip?.clipId ?? null };
    }

    dispose() {
        this.disposed = true;
        for (const unsubscribe of this.listeners) unsubscribe();
        this.close();
    }
}
