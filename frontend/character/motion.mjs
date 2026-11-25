import { Quaternion } from "three";
import { alignPhraseToSegments, computeCueSchedule } from "./speech-sync.mjs";

export const MOTION_BONES = Object.freeze([
    "hips", "spine", "chest", "neck", "head", "leftEye", "rightEye",
    ...["left", "right"].flatMap(side => [
        ...["Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot", "Toes"].map(part => side + part),
        ...["Thumb", "Index", "Middle", "Ring", "Little"].flatMap(finger => (
            finger === "Thumb" ? ["Metacarpal", "Proximal", "Distal"] : ["Proximal", "Intermediate", "Distal"]
        ).map(part => side + finger + part)),
    ]),
]);
const allowed = new Set(MOTION_BONES);
const PLUGIN = "kei.hastsec";
const ENTRY = "motion-provider";
const fallback = code => ({ state: "fallback", code });
// Bounded reconnect for transient provider-page failures (DEF-02). The entry is re-checked
// before every attempt, so a deliberate disable, uninstall or revocation is never undone.
const RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000]);
const STABLE_MS = 10_000;
const TERMINAL_OPEN_ERRORS = new Set(["entry_not_found", "slot_denied", "malformed_entry"]);
// kei:page:closed reasons that mean "someone meant to close this page": no automatic reopen.
const DELIBERATE_CLOSE = new Set(["user", "navigated", "host_disconnected", "plugin.disabled",
    "plugin.uninstalled", "plugin.activation_failed"]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const goodQuaternion = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && Math.abs(Math.hypot(...value) - 1) <= 0.002;
const smoothstep = x => {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
};

export class MotionTimeline {
    constructor() {
        this.clip = null;
        this.start = 0;
        this.onFinish = null;
        this.trimStartSec = 0;
        this.transitionFrom = null;
        this.transitionMs = 0;
        this.releaseState = null;
        this.lastSampled = null;
    }

    play(clip, now, onFinish = null, options = {}) {
        if (!clip || clip.version !== 1 || typeof clip.motion !== "string" || clip.rate !== 20 ||
            !Array.isArray(clip.mask) || !clip.mask.length || clip.mask.some(name => !allowed.has(name)) ||
            new Set(clip.mask).size !== clip.mask.length || !Array.isArray(clip.frames) ||
            clip.frames.length < 2 || clip.frames.length > 181 ||
            clip.frames.some(frame => !Array.isArray(frame) || frame.length !== clip.mask.length || !frame.every(goodQuaternion))) return false;
        const fromPose = options.fromPose ?? (this.lastSampled ? { ...this.lastSampled } : null);
        this.clear("cancelled");
        this.clip = clip;
        this.start = now;
        this.trimStartSec = Math.max(0, Math.min(0.35, (Number(options.trimStartMs) || 0) / 1000));
        this.onFinish = typeof onFinish === "function" ? onFinish : null;
        this.transitionFrom = fromPose && typeof fromPose === "object" ? fromPose : null;
        this.transitionMs = this.transitionFrom ? Math.max(80, Math.min(240, Number(options.transitionMs) || 150)) : 0;
        this.releaseState = null;
        return true;
    }

    /**
     * Cancel active clip immediately while smoothly easing the current bone pose
     * back to neutral over `durationMs` so interruption never snaps visually.
     */
    release(now, durationMs = 200, fromPose = null) {
        const hadClip = Boolean(this.clip);
        const cb = this.onFinish;
        const prevClip = this.clip;
        this.clip = null;
        this.onFinish = null;
        this.transitionFrom = null;
        this.transitionMs = 0;
        if (hadClip && cb) cb("cancelled");
        const snapshot = fromPose || this.lastSampled;
        if (prevClip && snapshot && durationMs > 0) {
            const mask = prevClip.mask.filter(name => goodQuaternion(snapshot[name]));
            if (mask.length) {
                this.releaseState = {
                    motion: prevClip.motion,
                    mask,
                    from: mask.map(name => new Quaternion().fromArray(snapshot[name])),
                    start: now,
                    durationMs,
                };
                return;
            }
        }
        this.releaseState = null;
        this.lastSampled = null;
    }

    clear(reason = "cancelled") {
        const hadClip = Boolean(this.clip);
        const cb = this.onFinish;
        this.clip = null;
        this.onFinish = null;
        this.transitionFrom = null;
        this.transitionMs = 0;
        this.releaseState = null;
        this.lastSampled = null;
        if (hadClip && cb) cb(reason);
    }

    sample(now) {
        if (this.clip) {
            const { frames, rate, mask, motion } = this.clip;
            const elapsedSec = Math.max(0, (now - this.start) / 1000);
            const at = (elapsedSec + this.trimStartSec) * rate;
            const last = frames.length - 1;
            if (at >= last) {
                this.clear("completed");
                return null;
            }
            const first = Math.floor(at);
            const frac = at - first;
            const fadeIn = this.transitionMs > 0 ? 1 : smoothstep(at / (rate * 0.18));
            const fadeOut = smoothstep((last - at) / (rate * 0.22));
            const blend = Math.min(1, fadeIn, fadeOut);
            const tBlend = this.transitionMs > 0 ? smoothstep((now - this.start) / this.transitionMs) : 1;
            const rotations = frames[first].map((rotation, index) => {
                const target = new Quaternion().fromArray(rotation)
                    .slerp(new Quaternion().fromArray(frames[first + 1][index]), frac);
                if (tBlend < 1 && this.transitionFrom) {
                    const prevArr = this.transitionFrom[mask[index]];
                    if (goodQuaternion(prevArr)) {
                        return new Quaternion().fromArray(prevArr).slerp(target, tBlend);
                    }
                }
                return target;
            });
            this.lastSampled = Object.fromEntries(mask.map((name, idx) => [name, rotations[idx].toArray()]));
            return { motion, mask, rotations, blend, at, releasing: false };
        }
        if (this.releaseState) {
            const progress = (now - this.releaseState.start) / this.releaseState.durationMs;
            if (progress >= 1) {
                this.releaseState = null;
                this.lastSampled = null;
                return null;
            }
            // Fade blend smoothly from 1 -> 0 so vrm.mjs eases back toward rest default quaternion
            const blend = 1 - smoothstep(progress);
            return {
                motion: this.releaseState.motion,
                mask: this.releaseState.mask,
                rotations: this.releaseState.from.map(q => q.clone()),
                blend,
                at: 0,
                releasing: true,
            };
        }
        return null;
    }
}

export class MotionProvider {
    constructor(bridge, timeline, getRig, getPose = null, options = {}) {
        this.bridge = bridge;
        this.timeline = timeline;
        this.getRig = getRig;
        this.getPose = typeof getPose === "function" ? getPose : null;
        // `version` is the playback generation: interrupt() bumps it to cancel solves/clips.
        // `connection` is the provider-page generation: only close()/dispose() bump it. Keeping
        // them apart stops a cold-start stage change from tearing down an in-flight open (DEF-02).
        this.version = 0;
        this.connection = 0;
        this.tag = null;
        this.disposed = false;
        this.refreshing = null;
        this.refreshPending = false;
        this.lateClosed = new Set();
        this.retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : RETRY_DELAYS_MS;
        this.stableMs = Number.isFinite(options.stableMs) ? options.stableMs : STABLE_MS;
        this.retryTimer = null;
        this.stableTimer = null;
        this.attempts = 0;
        this.connectionState = "connecting";
        this.lastError = null;
        this.previewAfter = 0;
        this.status = "unavailable";
        this.prewarmState = { done: false, count: 0, elapsedMs: null };
        this.prewarming = null;
        // kei.hastsec catalog: loading | ready (ids known) | unavailable (e.g. checkout not set).
        this.library = { state: "unknown", ids: null, code: null };
        this.onState = typeof options.onState === "function" ? options.onState : null;
        this.lastNotified = "";
        const external = () => {
            // A registry change or host reconnect grants a fresh retry budget.
            if (this.connectionState === "failed") this.attempts = 0;
            void this.refresh();
        };
        this.listeners = [
            bridge.onEntriesChanged(external),
            bridge.onStatus(status => status?.connected ? external() : this.close()),
            bridge.pages.onClosed((tag, reason) => {
                if (tag !== this.tag) {
                    // kei:page:closed can overtake the pages.open() reply; remember it so the
                    // closed tag is never adopted.
                    if (this.refreshing) this.lateClosed.add(tag);
                    return;
                }
                this.close(false);
                if (!DELIBERATE_CLOSE.has(reason)) this.#scheduleRetry(reason || "page_closed");
            }),
            bridge.pages.onEvent((tag, event) => {
                if (tag !== this.tag || event?.topic !== "hastsec.preview") return;
                const preview = event.data;
                if (!Number.isSafeInteger(preview?.issuedAt) || preview.issuedAt <= this.previewAfter) return;
                if (preview.type === "stop") this.interrupt();
                if (preview.type === "play") void this.request(preview.intent);
            }),
        ];
        void this.refresh();
    }

    // Serialised: a trigger that arrives while a refresh is running is queued, not dropped
    // (an entries change during the first entries() call used to be lost).
    async refresh() {
        if (this.disposed) return;
        if (this.refreshing) {
            this.refreshPending = true;
            return this.refreshing;
        }
        const run = this.#connect();
        this.refreshing = run;
        this.#notify();
        try {
            await run;
        } finally {
            if (this.refreshing === run) this.refreshing = null;
            this.#notify();
        }
        if (this.refreshPending && !this.disposed) {
            this.refreshPending = false;
            return this.refresh();
        }
    }

    async #connect() {
        const generation = this.connection;
        let entries;
        try {
            entries = await this.bridge.entries();
        } catch {
            entries = null;
        }
        if (this.disposed || generation !== this.connection) return;
        if (!entries?.ok || !entries.entries.some(entry => entry.pluginId === PLUGIN && entry.id === ENTRY)) {
            // Not installed/enabled, or host unreachable: a settled state, not a failure to retry.
            this.close();
            this.attempts = 0;
            this.lastError = entries?.ok ? null : (entries?.error?.code ?? "host_unavailable");
            return;
        }
        if (this.tag) {
            this.connectionState = "connected";
            if (this.library.state === "unavailable") void this.#loadLibrary(this.tag);
            return;
        }
        this.connectionState = this.attempts ? "retrying" : "connecting";
        this.#notify();
        this.lateClosed.clear();
        let opened;
        try {
            opened = await this.bridge.pages.open(PLUGIN, ENTRY);
        } catch {
            opened = { ok: false, error: { code: "open_failed" } };
        }
        const tag = opened?.ok ? opened.frame?.tag : null;
        const lost = tag ? this.lateClosed.has(tag) : false;
        this.lateClosed.clear();
        if (this.disposed || generation !== this.connection) {
            // Deliberately closed/disposed while opening: discard the late page.
            if (tag && !lost) await this.bridge.pages.close(tag).catch(() => {});
            return;
        }
        if (!tag || lost) {
            const code = lost ? "closed_during_open" : (opened?.error?.code ?? "open_failed");
            if (TERMINAL_OPEN_ERRORS.has(code)) {
                this.connectionState = "unavailable";
                this.lastError = code;
                return;
            }
            this.#scheduleRetry(code);
            return;
        }
        this.tag = tag;
        this.status = "idle";
        this.connectionState = "connected";
        this.lastError = null;
        this.connectedAt = Date.now();
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        clearTimeout(this.stableTimer);
        // Only a page that stays up refills the retry budget, so a crash loop stays bounded.
        this.stableTimer = setTimeout(() => {
            this.stableTimer = null;
            if (this.tag === tag) this.attempts = 0;
        }, this.stableMs);
        void this.#loadLibrary(tag);
        void this.prewarm();
    }

    async #loadLibrary(tag) {
        if (this.library.state === "loading" && this.library.tag === tag) return;
        this.library = { state: "loading", ids: null, code: null, tag };
        this.#notify();
        const reply = await this.call(tag, "catalog", {});
        if (tag !== this.tag || this.disposed) return;
        if (reply?.state === "ready" && Array.isArray(reply.motions)) {
            const ids = new Set(reply.motions.map(item => item?.id).filter(id => typeof id === "string"));
            this.library = { state: "ready", ids, code: null, tag };
        } else {
            this.library = { state: "unavailable", ids: null, code: reply?.code ?? reply?.state ?? "library_unavailable", tag };
        }
        this.#notify();
    }

    // Unknown IDs are rejected before any solve. Without a catalog the solver stays the judge.
    #known(motion) {
        return typeof motion === "string" && (!this.library.ids || this.library.ids.has(motion));
    }

    #partition(steps, hooks) {
        const valid = [];
        const skippedSteps = [];
        steps.forEach((step, index) => {
            if (this.#known(step?.motion)) {
                valid.push(step);
                return;
            }
            const skipped = { index, motion: step?.motion ?? null, phrase: step?.phrase ?? null, reason: "unknown_motion", sync: null };
            skippedSteps.push(skipped);
            hooks.onStepSkipped?.(index, step, skipped);
        });
        return { valid, skippedSteps };
    }

    #scheduleRetry(code) {
        if (this.disposed) return;
        this.lastError = code;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (this.attempts >= this.retryDelays.length) {
            this.connectionState = "failed";
            this.#notify();
            return;
        }
        const delay = this.retryDelays[this.attempts++];
        this.connectionState = "retrying";
        this.#notify();
        const generation = this.connection;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.disposed && generation === this.connection && !this.tag) void this.refresh();
        }, delay);
    }

    async prewarm(motions = null) {
        if (this.disposed || !this.tag || this.prewarming) return this.prewarmState;
        const rig = this.getRig();
        if (!rig) return this.prewarmState;
        const tag = this.tag;
        const job = this.call(tag, "prewarm", motions ? { rig, motions } : { rig }).then(reply => {
            if (reply?.state === "ready") {
                this.prewarmState = {
                    done: true,
                    count: reply.prewarmed ?? 0,
                    computed: reply.computed ?? 0,
                    elapsedMs: reply.elapsedMs ?? null,
                };
                this.#notify();
            }
            return this.prewarmState;
        }).catch(() => this.prewarmState).finally(() => {
            if (this.prewarming === job) this.prewarming = null;
        });
        this.prewarming = job;
        return job;
    }

    async call(tag, action, args) {
        try {
            const reply = await this.bridge.pages.call(tag, { type: "kei:call", id: crypto.randomUUID(), action, arguments: args });
            return reply?.ok ? reply.result : fallback(reply?.error?.code ?? "provider_unavailable");
        } catch { return fallback("provider_unavailable"); }
    }

    interrupt({ smooth = false } = {}) {
        this.previewAfter = Date.now();
        this.version++;
        if (this.tag && this.job) void this.call(this.tag, "solve.cancel", { jobId: this.job });
        if (this.tag && this.prefetchJob) void this.call(this.tag, "solve.cancel", { jobId: this.prefetchJob });
        this.job = null;
        this.prefetchJob = null;
        if (smooth && this.timeline.clip) {
            this.timeline.release(performance.now(), 200, this.getPose?.() ?? null);
        } else if (!smooth || !this.timeline.releaseState) {
            this.timeline.clear("cancelled");
        }
        this.diagnostics = null;
        this.status = this.tag ? "idle" : "unavailable";
    }

    async #solveClip(intent, rig, tag, current, isPrefetch = false) {
        const args = {
            motion: intent.motion,
            speed: intent.speed ?? 1,
            strength: intent.strength ?? 0.9,
            rig,
        };
        if (intent.variant) args.variant = intent.variant;
        if (intent.preferReady) args.preferReady = true;
        if (intent.noCache) args.noCache = true;
        let reply = await this.call(tag, "solve", args);
        const job = reply.jobId;
        if (!current()) {
            if (job && tag === this.tag) void this.call(tag, "solve.cancel", { jobId: job });
            return fallback("stale_motion");
        }
        if (reply.state === "ready") return reply;
        if (isPrefetch) this.prefetchJob = job; else this.job = job;
        const expires = performance.now() + 30_500;
        const intervals = [25, 45, 80, 120, 170];
        let step = 0;
        while (current() && reply.state === "pending" && typeof job === "string" && performance.now() < expires) {
            await sleep(intervals[Math.min(step++, intervals.length - 1)]);
            if (current()) reply = await this.call(tag, "solve.poll", { jobId: job });
        }
        if (isPrefetch) { if (this.prefetchJob === job) this.prefetchJob = null; }
        else if (this.job === job) this.job = null;
        if (!current()) {
            if (job && tag === this.tag && reply.state === "pending") void this.call(tag, "solve.cancel", { jobId: job });
            return fallback("stale_motion");
        }
        if (reply.state === "pending") {
            if (tag === this.tag) void this.call(tag, "solve.cancel", { jobId: job });
            return fallback("solve_timeout");
        }
        return reply;
    }

    #playSolved(reply, options = {}) {
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const fromPose = options.smoothTransition === false ? null : (this.getPose?.() ?? null);
        if (reply.state === "ready" && this.timeline.play(reply.clip, performance.now(), reason => {
            if (this.status === "playing" && !this.timeline.clip) this.status = this.tag ? "idle" : "unavailable";
            resolveDone(reason);
        }, { fromPose, trimStartMs: options.trimStartMs ?? 0 })) {
            this.status = "playing";
            this.diagnostics = reply.diagnostics;
            const rawDur = Math.round(((reply.clip.frames.length - 1) / reply.clip.rate) * 1000);
            const durationMs = Math.max(100, rawDur - (options.trimStartMs ?? 0));
            return {
                state: "ready",
                diagnostics: reply.diagnostics,
                motion: reply.clip.motion,
                beat: reply.clip.beat ?? null,
                durationMs,
                done,
            };
        }
        resolveDone("cancelled");
        this.status = reply.code ?? "motion_unavailable";
        return fallback(this.status);
    }

    async request(intent) {
        if (!this.#known(intent?.motion)) return fallback("unknown_motion");
        this.interrupt();
        const rig = this.getRig();
        if (!rig) {
            this.status = "rig_mismatch";
            return fallback(this.status);
        }
        const tag = this.tag;
        if (!tag || this.disposed) return fallback("provider_unavailable");
        const version = this.version;
        const current = () => version === this.version && tag === this.tag && !this.disposed;
        this.status = "solving";
        const reply = await this.#solveClip(intent, rig, tag, current, false);
        if (!current()) return fallback("stale_motion");
        return this.#playSolved(reply);
    }

    async playSequence(steps, hooks = {}) {
        if (!Array.isArray(steps) || steps.length === 0 || steps.length > 3) return fallback("invalid_intent");
        const partitioned = this.#partition(steps, hooks);
        if (!partitioned.valid.length) {
            return { state: "fallback", code: "unknown_motion", completedSteps: [], skippedSteps: partitioned.skippedSteps, totalSteps: steps.length };
        }
        const requestedSteps = steps.length;
        steps = partitioned.valid;
        this.interrupt();
        const rig = this.getRig();
        if (!rig) {
            this.status = "rig_mismatch";
            return fallback(this.status);
        }
        const tag = this.tag;
        if (!tag || this.disposed) return fallback("provider_unavailable");
        const version = this.version;
        const current = () => version === this.version && tag === this.tag && !this.disposed;
        const completedSteps = [];
        let pendingSolve = this.#solveClip(steps[0], rig, tag, current, false);
        for (let i = 0; i < steps.length; i++) {
            if (!current()) return { state: "cancelled", completedSteps, skippedSteps: partitioned.skippedSteps, totalSteps: requestedSteps };
            this.status = "solving";
            const solved = await pendingSolve;
            if (!current()) return { state: "cancelled", completedSteps, skippedSteps: partitioned.skippedSteps, totalSteps: requestedSteps };
            if (solved.state !== "ready") {
                this.status = solved.code ?? "motion_unavailable";
                return { state: "fallback", code: this.status, completedSteps, skippedSteps: partitioned.skippedSteps, totalSteps: requestedSteps };
            }
            const started = this.#playSolved(solved);
            if (started.state !== "ready") {
                return { state: "fallback", code: started.code, completedSteps, skippedSteps: partitioned.skippedSteps, totalSteps: requestedSteps };
            }
            hooks.onStepStart?.(i, steps[i], started);
            pendingSolve = i + 1 < steps.length
                ? this.#solveClip(steps[i + 1], rig, tag, current, true)
                : null;
            const outcome = await started.done;
            hooks.onStepEnd?.(i, steps[i], outcome);
            if (outcome !== "completed" || !current()) {
                return { state: "cancelled", completedSteps, skippedSteps: partitioned.skippedSteps, totalSteps: requestedSteps };
            }
            completedSteps.push({ motion: started.motion, diagnostics: started.diagnostics });
        }
        return { state: "completed", completedSteps, skippedSteps: partitioned.skippedSteps, totalSteps: requestedSteps };
    }

    /**
     * Play ordered cues anchored to spoken phrases on the WebAudio PlaybackClock.
     *
     * Never delays first audible speech. Skips cues whose target phrase has already
     * passed beyond tolerance, smoothly transitions between poses, and falls back
     * cleanly to reading-cadence timing when speech is disabled.
     */
    async playSyncedSequence(steps, sync = {}, hooks = {}) {
        if (!Array.isArray(steps) || steps.length === 0 || steps.length > 3) return fallback("invalid_intent");
        const partitioned = this.#partition(steps, hooks);
        if (!partitioned.valid.length) {
            return { state: "fallback", code: "unknown_motion", completedSteps: [], skippedSteps: partitioned.skippedSteps, totalSteps: steps.length };
        }
        const requestedSteps = steps.length;
        steps = partitioned.valid;
        this.interrupt({ smooth: true });
        const rig = this.getRig();
        if (!rig) {
            this.status = "rig_mismatch";
            return fallback(this.status);
        }
        const tag = this.tag;
        if (!tag || this.disposed) return fallback("provider_unavailable");
        const version = this.version;
        const current = () => version === this.version && tag === this.tag && !this.disposed;

        const speechEnabled = Boolean(sync.speechEnabled && typeof sync.getAudioTime === "function" && typeof sync.getSegments === "function");
        const maxLateMs = Number(sync.maxLateMs) || 280;
        const completedSteps = [];
        const skippedSteps = [...partitioned.skippedSteps];

        // Begin resolving step 0 immediately without blocking speech synthesis
        let pendingSolve = this.#solveClip(
            { ...steps[0], preferReady: speechEnabled && !steps[0].noCache },
            rig, tag, current, false,
        );
        let earliestAudioSec = null;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!current()) return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
            this.status = "solving";
            const solved = await pendingSolve;
            if (!current()) return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
            if (solved.state !== "ready") {
                this.status = solved.code ?? "motion_unavailable";
                return { state: "fallback", code: this.status, completedSteps, skippedSteps, totalSteps: requestedSteps };
            }

            // Start prefetching step i+1 right away so it's ready before step i ends
            pendingSolve = i + 1 < steps.length
                ? this.#solveClip({ ...steps[i + 1], preferReady: speechEnabled && !steps[i + 1].noCache }, rig, tag, current, true)
                : null;

            const beat = solved.clip.beat ?? {
                prepMs: 250,
                peakMs: Math.round((((solved.clip.frames.length - 1) / solved.clip.rate) * 1000) * 0.45),
                releaseMs: Math.round((((solved.clip.frames.length - 1) / solved.clip.rate) * 1000) * 0.78),
                durationMs: Math.round(((solved.clip.frames.length - 1) / solved.clip.rate) * 1000),
                variantId: solved.diagnostics?.variantId ?? "default",
                handedness: solved.diagnostics?.handedness ?? "none",
                ownsHead: solved.clip.mask.includes("head") || solved.clip.mask.includes("neck"),
            };

            let syncMeta = {
                phrase: step.phrase ?? null,
                timing: step.timing ?? "peak",
                matchType: speechEnabled ? "pending" : "speech-disabled-cadence",
                timingSource: speechEnabled ? "measured-audio-envelope-estimate" : "reading-cadence-estimate",
                isEstimate: true,
                targetAudioSec: null,
                actualStartAudioSec: null,
                predictedPeakAudioSec: null,
                predictedPeakToPhraseOffsetMs: null,
                trimStartMs: 0,
            };

            let trimStartMs = 0;
            if (speechEnabled) {
                // Wait up to 2.2s for the first TTS segment covering this utterance (or fail over cleanly if TTS fails)
                const waitDeadline = performance.now() + 2200;
                let segments = sync.getSegments() || [];
                while (current() && !segments.length && performance.now() < waitDeadline) {
                    if (sync.isSpeechStopped?.()) break;
                    await sleep(15);
                    segments = sync.getSegments() || [];
                }
                if (!current() || sync.isSpeechStopped?.()) {
                    return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
                }

                // If step targets a phrase not yet in scheduled segments and synthesis is still streaming, wait briefly
                let aligned = alignPhraseToSegments(segments, step.phrase, i, steps.length, step.timing ?? "peak");
                if (aligned && aligned.matchType === "fallback-unmatched" && sync.isSynthesizing?.()) {
                    const segWaitEnd = performance.now() + 1800;
                    while (current() && sync.isSynthesizing?.() && performance.now() < segWaitEnd) {
                        if (sync.isSpeechStopped?.()) break;
                        await sleep(25);
                        segments = sync.getSegments() || [];
                        const retry = alignPhraseToSegments(segments, step.phrase, i, steps.length, step.timing ?? "peak");
                        if (retry && retry.matchType !== "fallback-unmatched") {
                            aligned = retry;
                            break;
                        }
                    }
                }
                if (!current() || sync.isSpeechStopped?.()) {
                    return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
                }

                const nowAudio = sync.getAudioTime();
                if (aligned && Number.isFinite(nowAudio)) {
                    const sched = computeCueSchedule({
                        targetAudioSec: aligned.targetAudioSec,
                        beat,
                        nowAudioSec: nowAudio,
                        timing: step.timing ?? "peak",
                        earliestAudioSec,
                        maxLateMs,
                    });
                    syncMeta = {
                        ...syncMeta,
                        matchType: aligned.matchType,
                        confidence: aligned.confidence,
                        timingSource: aligned.timingSource,
                        isEstimate: aligned.isEstimate,
                        targetAudioSec: Number(aligned.targetAudioSec.toFixed(3)),
                        targetRelMs: aligned.targetRelMs,
                        segmentId: aligned.segmentId,
                    };
                    if (sched.action === "skip_late") {
                        const skipped = {
                            index: i,
                            motion: step.motion,
                            phrase: step.phrase ?? null,
                            reason: sched.skipReason,
                            sync: syncMeta,
                        };
                        skippedSteps.push(skipped);
                        hooks.onStepSkipped?.(i, step, skipped);
                        continue;
                    }
                    trimStartMs = sched.trimStartMs;
                    syncMeta.trimStartMs = trimStartMs;
                    if (sched.action === "schedule" && sched.startAudioSec > nowAudio + 0.008) {
                        // Wait on the real AudioContext clock until exact preparation onset
                        while (current()) {
                            if (sync.isSpeechStopped?.()) {
                                return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
                            }
                            const tNow = sync.getAudioTime();
                            if (!Number.isFinite(tNow) || tNow >= sched.startAudioSec - 0.008) break;
                            await sleep(Math.min(20, Math.max(4, Math.round((sched.startAudioSec - tNow) * 500))));
                        }
                        if (!current() || sync.isSpeechStopped?.()) {
                            return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
                        }
                    }
                    const actualStart = sync.getAudioTime();
                    if (!Number.isFinite(actualStart) || actualStart > aligned.targetAudioSec + maxLateMs / 1000) {
                        const skipped = {
                            index: i, motion: step.motion, phrase: step.phrase ?? null,
                            reason: "target_phrase_passed", sync: syncMeta,
                        };
                        skippedSteps.push(skipped);
                        hooks.onStepSkipped?.(i, step, skipped);
                        continue;
                    }
                    if (Number.isFinite(actualStart)) {
                        const effectivePeakSec = Math.max(0.05, (beat.peakMs - trimStartMs) / 1000);
                        const predictedPeak = actualStart + effectivePeakSec;
                        syncMeta.actualStartAudioSec = Number(actualStart.toFixed(3));
                        syncMeta.predictedPeakAudioSec = Number(predictedPeak.toFixed(3));
                        syncMeta.predictedPeakToPhraseOffsetMs = Number(((predictedPeak - aligned.targetAudioSec) * 1000).toFixed(1));
                    }
                }
            } else if (i > 0) {
                // Speech disabled: brief natural breath beat between consecutive cues
                await sleep(120);
                if (!current()) return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
            }

            const started = this.#playSolved(solved, { trimStartMs, smoothTransition: true });
            if (started.state !== "ready") {
                return { state: "fallback", code: started.code, completedSteps, skippedSteps, totalSteps: requestedSteps };
            }
            hooks.onStepStart?.(i, step, started, syncMeta);

            // Wait for actual completion (or allow smooth cross-transition in the final 160ms release tail
            // ONLY if the next cue's scheduled audio-clock onset needs to prepare right then)
            const outcome = await started.done;
            hooks.onStepEnd?.(i, step, outcome, syncMeta);
            if (outcome !== "completed" || !current()) {
                return { state: "cancelled", completedSteps, skippedSteps, totalSteps: requestedSteps };
            }
            if (speechEnabled) {
                const endedAudio = sync.getAudioTime();
                if (Number.isFinite(endedAudio)) earliestAudioSec = endedAudio;
            }
            completedSteps.push({
                motion: started.motion,
                variantId: beat.variantId,
                handedness: beat.handedness,
                ownsHead: beat.ownsHead,
                diagnostics: started.diagnostics,
                sync: syncMeta,
            });
        }
        return { state: "completed", completedSteps, skippedSteps, totalSteps: requestedSteps };
    }

    snapshot() {
        const connecting = !this.tag && (this.connectionState === "connecting" || this.connectionState === "retrying");
        return {
            connected: Boolean(this.tag),
            state: connecting ? this.connectionState
                : this.status === "playing" && !this.timeline.clip ? "idle" : this.status,
            motion: this.timeline.clip?.motion ?? null,
            diagnostics: this.diagnostics ?? null,
            prewarm: this.prewarmState,
            readiness: this.readiness(),
            library: { state: this.library.state, motions: this.library.ids?.size ?? null, code: this.library.code },
            connection: {
                state: this.connectionState,
                attempts: this.attempts,
                maxAttempts: this.retryDelays.length,
                lastError: this.lastError,
            },
        };
    }

    // Deliberate teardown (entry gone, host lost, page closed, dispose). Bumps the connection
    // generation so any in-flight open is discarded and pending retries are dropped.
    close(notify = true) {
        const tag = this.tag;
        this.connection++;
        clearTimeout(this.retryTimer);
        clearTimeout(this.stableTimer);
        this.retryTimer = null;
        this.stableTimer = null;
        this.interrupt();
        this.tag = null;
        this.status = "unavailable";
        this.connectionState = "unavailable";
        this.library = { state: "unknown", ids: null, code: null };
        this.prewarmState = { done: false, count: 0, elapsedMs: null };
        if (notify && tag) void this.bridge.pages.close(tag).catch(() => {});
        this.#notify();
    }

    // Manual "再試行" from the character panel: a fresh retry budget, entry re-checked first.
    retry() {
        if (this.disposed || this.tag) return Promise.resolve(this.snapshot());
        this.attempts = 0;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        return Promise.resolve(this.refresh()).then(() => this.snapshot());
    }

    // Connection/readiness summary for visible status: unavailable | connecting | retrying |
    // failed | loading (page up, catalog pending) | library_unavailable | ready.
    readiness() {
        if (this.tag) {
            if (this.library.state === "ready") return "ready";
            return this.library.state === "unavailable" ? "library_unavailable" : "loading";
        }
        return this.connectionState === "connected" ? "unavailable" : this.connectionState;
    }

    #notify() {
        if (!this.onState || this.disposed) return;
        const key = [this.readiness(), this.attempts, this.lastError, this.library.code].join("|");
        if (key === this.lastNotified) return;
        this.lastNotified = key;
        try { this.onState(this.snapshot()); } catch { /* status display must not break the provider */ }
    }

    dispose() {
        this.disposed = true;
        for (const unsubscribe of this.listeners) unsubscribe();
        this.close();
    }
}
