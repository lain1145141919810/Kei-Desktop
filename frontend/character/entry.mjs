import { loadLive2D } from "kei-live2d-adapter";
import { bytes as vrmBytes, vrmInfo } from "kei-vrm-asset";
import { loadVrm } from "./vrm.mjs";
import { PlaybackClock, previewAudio } from "./playback.mjs";
import { ExpressionProvider, ExpressionTimeline } from "./expression.mjs";
import { EXPRESSION_LABELS, FacePreview } from "./face-preview.mjs";
import { automaticBlink } from "./blink.mjs";
import { MotionProvider, MotionTimeline } from "./motion.mjs";

const STORAGE_KEY = "kei.character.settings.v1";
const LABELS = { live2d: "Live2D", vrm: "VRM" };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const VRM_FRAME_MS = 1000 / 90;

function readSettings() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
        return {};
    }
}

function mount(stage, controls) {
    const existing = instances.get(stage);
    if (existing) return existing;
    const original = stage.dataset.renderer;
    const placeholder = stage.querySelector(".stage-placeholder");
    const abort = new AbortController();
    const clock = new PlaybackClock();
    const settings = readSettings();
    const statistics = { created: 0, disposed: 0, frames: 0, listeners: 0, drawsFailed: 0 };
    const modelButtons = [...controls.querySelectorAll("[data-character-model]")];
    const subtitle = document.createElement("div");
    subtitle.className = "character-subtitle ui-panel";
    subtitle.hidden = true;
    subtitle.setAttribute("aria-live", "polite");
    stage.after(subtitle);
    const state = controls.querySelector("[role=status]");
    const cg = controls.querySelector("[data-character-cg]");
    const compact = controls.querySelector("[data-character-compact]");
    const preview = controls.querySelector("[data-character-audio=sample]");
    const stop = controls.querySelector("[data-character-audio=stop]");
    const faceLabel = document.createElement("label");
    const expressionSelect = document.createElement("select");
    faceLabel.className = "character-expression";
    faceLabel.hidden = true;
    expressionSelect.dataset.characterExpression = "";
    faceLabel.append("表情プレビュー ", expressionSelect);
    state.before(faceLabel);
    // DEF-02: visible body-motion library status (VRM only) with a manual retry.
    const motionState = document.createElement("div");
    const motionText = document.createElement("span");
    const motionRetry = document.createElement("button");
    motionState.className = "character-motion-status";
    motionState.hidden = true;
    motionText.setAttribute("role", "status");
    motionRetry.type = "button";
    motionRetry.className = "pill";
    motionRetry.textContent = "再試行";
    motionRetry.hidden = true;
    motionState.append(motionText, motionRetry);
    state.before(motionState);
    let active = null;
    let requested = 0;
    let jobs = Promise.resolve();
    let raf = null;
    let resizeFrame = null;
    let nextVrmDraw = 0;
    let lastRender = null;
    let sceneReveal;
    let visible = !document.hidden;
    let cgMode = Boolean(settings.cg);
    let isCompact = Boolean(settings.compact);
    let nativeCompact = document.body.classList.contains("native-compact");
    let opening = document.body.dataset.presentationPhase === "opening";
    let expressionAdapter = null;
    let lastSample = null;
    let pointerX = 0;
    let pointerY = 0;
    let smileUntil = 0;
    let gesture = null;
    let disposed = false;
    const expressionTimeline = new ExpressionTimeline();
    const facePreview = new FacePreview();
    const reaction = new FacePreview();
    const expressionProvider = window.kei ? new ExpressionProvider(window.kei, expressionTimeline) : null;
    const motionTimeline = new MotionTimeline();
    const motionProvider = window.kei
        ? new MotionProvider(window.kei, motionTimeline, () => active?.adapter.motionRig?.(), () => active?.adapter.capturePose?.(),
            { onState: renderMotionState })
        : null;

    function renderMotionState(snapshot = motionProvider?.snapshot()) {
        const readiness = snapshot?.readiness ?? "unavailable";
        const connection = snapshot?.connection ?? {};
        const labels = {
            unavailable: "利用できません",
            connecting: "接続中…",
            retrying: `再接続中…（${connection.attempts ?? 0}/${connection.maxAttempts ?? 0}）`,
            failed: "接続できませんでした",
            loading: "モーションライブラリを読み込み中…",
            library_unavailable: "モーションライブラリを利用できません（管理 → HAST-SEC 動作ライブラリ）",
            ready: "準備完了",
        };
        motionState.dataset.characterMotion = readiness;
        motionState.hidden = !snapshot || active?.kind !== "vrm";
        motionText.textContent = "身体モーション: " + (labels[readiness] ?? labels.unavailable);
        const code = connection.lastError ?? snapshot?.library?.code;
        motionText.title = code ? "code: " + code : "";
        motionRetry.hidden = readiness !== "failed";
    }

    function on(target, name, listener) {
        target.addEventListener(name, listener, { signal: abort.signal });
        statistics.listeners++;
    }

    function save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            model: active?.kind ?? settings.model, cg: cgMode, compact: isCompact,
        }));
    }

    function status(message) {
        state.textContent = message;
    }

    function showingCg() {
        return cgMode && !nativeCompact;
    }

    function renderable() {
        return active && visible && !opening && (!showingCg() || active.toon) && !disposed;
    }

    function gesturePose(now) {
        if (!gesture) return null;
        const time = (now - gesture.start) / 900;
        if (time >= 1) {
            gesture = null;
            return null;
        }
        const envelope = Math.sin(time * Math.PI);
        if (gesture.name === "nod") return { pitch: 0.34 * envelope * Math.sin(time * Math.PI * 2) };
        if (gesture.name === "tilt") return { roll: 0.20 * envelope };
        return { yaw: 0.27 * envelope * Math.sin(time * Math.PI * 4) };
    }

    function frame(now) {
        raf = null;
        if (!visible || disposed) return;
        const draw = renderable();
        const vrm = draw && active.kind === "vrm";
        if (vrm && resizeFrame !== null) {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = null;
            size();
        }
        if (vrm && now + 0.75 < nextVrmDraw) {
            schedule();
            return;
        }
        lastSample = clock.sample();
        const text = lastSample?.subtitle ?? "";
        if (subtitle.textContent !== text) subtitle.textContent = text;
        if (subtitle.hidden !== !text) subtitle.hidden = !text;
        const busy = clock.isBusy();
        if (stop.disabled === busy) stop.disabled = !busy;
        if (draw) {
            try {
                const dt = lastRender === null ? 0 : clamp((now - lastRender) / 1000, 0, 0.05);
                lastRender = now;
                if (vrm) {
                    const budget = active.toon ? 1000 / 60 : VRM_FRAME_MS;
                    nextVrmDraw = Math.max(now + budget * .65, nextVrmDraw + budget);
                }
                const blink = automaticBlink(now);
                const emotion = active.kind === "vrm" ? expressionTimeline.sample(now) : null;
                active.adapter.draw({
                    dt,
                    sway: Math.sin(now * 0.0017),
                    blink,
                    lookX: pointerX,
                    lookY: pointerY,
                    gesture: gesturePose(now),
                    smile: smileUntil > now ? 1 : 0,
                    mouth: lastSample?.value ?? 0,
                    speaking: busy,
                    emotion,
                    expressionPreview: facePreview.sample(now) ?? (emotion ? null : reaction.sample(now)),
                    bodyMotion: active.kind === "vrm" ? motionTimeline.sample(now) : null,
                });
                statistics.frames++;
            } catch (error) {
                statistics.drawsFailed++;
                status("描画エラー: " + error.message);
                retire(active);
                active = null;
                refresh();
            }
        }
        schedule();
    }

    function schedule() {
        const keepRunning = visible && !disposed && (renderable() || clock.isBusy());
        if (keepRunning && raf === null) raf = requestAnimationFrame(frame);
        if (!keepRunning && raf !== null) {
            cancelAnimationFrame(raf);
            raf = null;
            lastRender = null;
            nextVrmDraw = 0;
        }
    }

    function size(record = active, width = stage.clientWidth, height = stage.clientHeight) {
        if (!record || width < 1 || height < 1) return;
        const density = Math.min(devicePixelRatio || 1, 2);
        if (record.width === width && record.height === height && record.density === density) return;
        Object.assign(record, { width, height, density });
        record.adapter.resize(width, height, density);
    }

    function scheduleResize() {
        if (resizeFrame !== null || disposed) return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            if (renderable()) size();
        });
    }

    function refresh() {
        stage.classList.toggle("character-compact", isCompact);
        stage.dataset.renderer = active?.kind ?? original;
        const useCg = showingCg();
        const returningToAvatar = stage.dataset.scene === "cg" && !stage.hasAttribute("data-toon") && !useCg;
        stage.dataset.scene = useCg ? "cg" : "character";
        if (placeholder) {
            placeholder.classList.toggle("character-hidden", Boolean(active || useCg));
        }
        if (active) {
            active.toon = active.adapter.setToonCg?.(useCg) ?? false;
            active.canvas.hidden = useCg && !active.toon;
            if (useCg) sceneReveal?.cancel();
            if (returningToAvatar && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
                sceneReveal = active.canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
            }
        }
        stage.toggleAttribute("data-toon", Boolean(active?.toon));
        for (const button of modelButtons) button.setAttribute("aria-pressed", String(active?.kind === button.dataset.characterModel));
        cg.setAttribute("aria-pressed", String(useCg));
        compact.setAttribute("aria-pressed", String(isCompact || nativeCompact));
        if (motionProvider) renderMotionState();
        if ((active?.adapter ?? null) !== expressionAdapter) {
            expressionAdapter = active?.adapter ?? null;
            const options = (expressionAdapter?.expressionOptions ?? []).filter(name => Object.hasOwn(EXPRESSION_LABELS, name));
            expressionSelect.replaceChildren(...["neutral", ...options].map(name => new Option(EXPRESSION_LABELS[name], name)));
            expressionSelect.value = facePreview.name;
            faceLabel.hidden = options.length === 0;
        }
        scheduleResize();
        schedule();
    }

    function reportCapabilities(record = active) {
        if (!record || !window.kei?.personas?.setCapabilities) return;
        const options = (record.adapter.expressionOptions ?? []).filter(name => Object.hasOwn(EXPRESSION_LABELS, name));
        const supportedFaces = ["neutral", ...new Set(options)];
        const supportsBodyMotion = record.kind === "vrm" && typeof record.adapter.motionRig === "function";
        const payload = {
            modelKey: record.kind,
            modelKind: record.kind,
            modelName: record.adapter.capabilities?.name || LABELS[record.kind] || record.kind,
            supportsBodyMotion,
            supportedFaces,
            supportedGestures: ["none", "nod", "tilt", "shake"],
            active: true,
        };
        void window.kei.personas.setCapabilities(payload).catch(() => {});
        return payload;
    }

    function retire(record) {
        if (!record) return;
        try {
            record.adapter.dispose();
        } finally {
            record.canvas.remove();
            statistics.disposed++;
        }
    }

    function select(kind, customVrm) {
        if (!Object.hasOwn(LABELS, kind) || disposed) return Promise.resolve(false);
        if (active?.kind === kind && !customVrm) {
            requested++;
            return Promise.resolve(true);
        }
        const request = ++requested;
        const job = jobs.then(async () => {
            if (disposed || requested !== request) return false;
            for (const button of modelButtons) button.disabled = true;
            status(LABELS[kind] + " を読み込み中…");
            const canvas = document.createElement("canvas");
            canvas.className = "character-canvas";
            canvas.dataset.kind = kind;
            canvas.setAttribute("aria-label", LABELS[kind]);
            let candidate;
            try {
                const adapter = kind === "live2d" ? await loadLive2D(canvas) : await loadVrm(
                    canvas, customVrm ?? (vrmBytes && vrmBytes.slice().buffer),
                    { onHitMap: () => stage.dispatchEvent(new Event("kei:stage-hit-map")) },
                );
                candidate = { kind, canvas, adapter };
                statistics.created++;
                size(candidate);
                adapter.draw({ dt: 0, sway: 0, blink: 0, smile: 0, lookX: 0, lookY: 0, mouth: 0 });
                if (opening) await adapter.warmHitMap?.().catch(() => {});
                if (disposed || request !== requested) return false;
                retire(active);
                if (active) expressionProvider?.interrupt();
                if (active) motionProvider?.interrupt();
                facePreview.clear();
                reaction.clear();
                lastRender = null;
                nextVrmDraw = 0;
                active = candidate;
                candidate = null;
                stage.append(canvas);
                const reportedCaps = reportCapabilities(active);
                stage.dispatchEvent(new CustomEvent("kei:stage-character-changed", {
                    detail: { model: active.kind, capabilities: reportedCaps ?? null },
                }));
                refresh();
                if (active.kind === "vrm") void motionProvider?.prewarm?.();
                if (!customVrm) save();
                status([adapter.capabilities.name || LABELS[kind], ...(adapter.capabilities.authors ?? [])].join(" · "));
                return true;
            } catch (error) {
                if (request === requested && !disposed) status(LABELS[kind] + " の読み込みに失敗: " + error.message);
                return false;
            } finally {
                retire(candidate);
                if (!disposed) for (const button of modelButtons) button.disabled = false;
            }
        });
        jobs = job.catch(error => {
            if (!disposed) status(error.message);
        });
        return job;
    }

    function stopAudio(ids, { keepMotion = false } = {}) {
        if (!clock.interrupt(ids)) return false;
        if (!keepMotion) {
            expressionProvider?.interrupt();
            motionProvider?.interrupt({ smooth: true });
        }
        lastSample = null;
        subtitle.textContent = "";
        subtitle.hidden = true;
        stop.disabled = true;
        schedule();
        return true;
    }

    const playback = Object.freeze({
        begin(turnId) {
            stopAudio(undefined, { keepMotion: true });
            const ids = clock.begin(turnId);
            schedule();
            return ids;
        },
        segment(data) {
            const queued = clock.enqueue(data);
            schedule();
            return queued;
        },
        frame: data => clock.acceptFrame(data),
        sample: () => lastSample && { ...lastSample },
        audioTime: () => clock.outputPosition()?.time ?? null,
        metrics: () => clock.context && ({
            sampleRate: clock.context.sampleRate, baseLatency: clock.context.baseLatency,
            outputLatency: clock.context.outputLatency, state: clock.context.state,
        }),
        interrupt: stopAudio,
        disconnect: stopAudio,
        legacy(event, ids) {
            if (!ids || !clock.matches(ids) || event?.turn_id !== ids.turnId) return false;
            const payload = event.payload ?? {};
            if (event.type === "interrupt") return stopAudio(ids);
            // Old envelopes remain valid when the producer provides the segment and its playback lease.
            // Bare historical mouth levels leave the PCM envelope in control.
            if (event.type !== "tts.mouth" || payload.final) return false;
            return clock.acceptFrame({
                ...ids, segmentId: payload.segment_id, seq: payload.seq,
                positionMs: payload.position_ms, value: payload.value,
            });
        },
    });

    on(stage, "kei:stage-resize", scheduleResize);
    on(document, "kei:opening-complete", () => {
        opening = false;
        refresh();
    });
    on(document, "kei:compact-mode", event => {
        nativeCompact = event.detail.active;
        refresh();
    });
    on(stage, "kei:stage-visibility", event => {
        visible = Boolean(event.detail.visible);
        schedule();
    });
    on(window, "pointermove", event => {
        if (!renderable()) return;
        const bounds = active.canvas.getBoundingClientRect();
        pointerX = clamp((event.clientX - bounds.left) / bounds.width * 2 - 1, -1, 1);
        pointerY = clamp((event.clientY - bounds.top) / bounds.height * 2 - 1, -1, 1);
        if (Math.abs(pointerX) < 1 && Math.abs(pointerY) < 1) active.adapter.prepareHit?.();
    });
    on(stage, "click", event => {
        if (!renderable() || event.target !== active.canvas) return;
        const bounds = active.canvas.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width * 2 - 1;
        const y = (event.clientY - bounds.top) / bounds.height * 2 - 1;
        if (!active.adapter.hit(x, y, true)) return;
        smileUntil = performance.now() + 850;
        stage.dispatchEvent(new CustomEvent("kei:stage-hit", { detail: { x, y, renderer: active.kind } }));
    });
    for (const button of modelButtons) on(button, "click", () => select(button.dataset.characterModel));
    on(cg, "click", () => {
        cgMode = !cgMode;
        refresh();
        save();
    });
    on(compact, "click", async () => {
        const native = await window.kei?.compact?.status();
        if (native?.supported) {
            document.dispatchEvent(new Event("kei:compact-toggle"));
            return;
        }
        isCompact = !isCompact;
        refresh();
        save();
    });
    on(document, "keydown", event => {
        if (event.key !== "Escape" || !isCompact) return;
        isCompact = false;
        refresh();
        save();
    });
    on(preview, "click", async () => {
        try {
            const ids = playback.begin("character-preview");
            await playback.segment({ ...ids, segmentId: "one", audio: previewAudio(), subtitle: "音声プレビュー 1" });
            await playback.segment({ ...ids, segmentId: "two", audio: previewAudio(350), subtitle: "音声プレビュー 2" });
        } catch (error) {
            status("音声を再生できません: " + error.message);
        }
    });
    on(stop, "click", () => stopAudio());
    on(motionRetry, "click", () => {
        motionRetry.disabled = true;
        void motionProvider?.retry().finally(() => { motionRetry.disabled = false; });
    });
    on(expressionSelect, "change", () => {
        const name = expressionSelect.value;
        if (name !== "neutral" && !active?.adapter.expressionOptions?.includes(name)) return;
        expressionProvider?.interrupt();
        facePreview.select(name, performance.now());
    });
    on(window, "pagehide", () => api.dispose());
    const unsubHostStatus = window.kei?.onStatus?.(st => { if (st?.connected && active) reportCapabilities(active); });
    abort.signal.addEventListener("abort", () => unsubHostStatus?.());

    const api = Object.freeze({
        select,
        hitPoint(clientX, clientY) {
            if (!renderable()) return false;
            const rect = active.canvas.getBoundingClientRect();
            if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return false;
            return active.adapter.hit((clientX - rect.left) / rect.width * 2 - 1, (clientY - rect.top) / rect.height * 2 - 1);
        },
        resize: (width, height) => size(active, width, height),
        // Contextual expressions share the model's blend path with the preview menu.
        face(name) {
            if (disposed || typeof name !== "string") return false;
            if (name !== "neutral" && !active?.adapter.expressionOptions?.includes(name)) return false;
            reaction.select(name, performance.now());
            return true;
        },
        gesture(name) {
            if (disposed || !["none", "nod", "tilt", "shake"].includes(name)) return false;
            gesture = name === "none" ? null : { name, start: performance.now() };
            schedule();
            return true;
        },
        smile(ms = 850) {
            if (disposed) return;
            smileUntil = performance.now() + Math.max(0, Math.min(4000, Number(ms) || 0));
        },
        setVisible(value) {
            visible = Boolean(value);
            schedule();
        },
        playback,
        expressions: Object.freeze({
            request(intent, text) {
                if (active?.kind !== "vrm" || !expressionProvider) {
                    return Promise.resolve({ state: "fallback", code: "renderer_unsupported" });
                }
                return expressionProvider.request(intent, text);
            },
            interrupt: () => expressionProvider?.interrupt(),
            snapshot: () => ({
                provider: expressionProvider?.snapshot() ?? null,
                face: active?.adapter.face?.() ?? null,
                preview: facePreview.name,
            }),
        }),
        motion: Object.freeze({
            request: intent => motionProvider?.request(intent) ?? Promise.resolve({ state: "fallback", code: "provider_unavailable" }),
            playSequence: (steps, hooks) => motionProvider?.playSequence(steps, hooks) ?? Promise.resolve({ state: "fallback", code: "provider_unavailable" }),
            playSyncedSequence: (steps, sync, hooks) => motionProvider?.playSyncedSequence(steps, sync, hooks) ?? Promise.resolve({ state: "fallback", code: "provider_unavailable" }),
            prewarm: motions => motionProvider?.prewarm(motions) ?? Promise.resolve({ done: false, count: 0 }),
            interrupt: opts => motionProvider?.interrupt(opts),
            retry: () => motionProvider?.retry() ?? Promise.resolve(null),
            snapshot: () => ({ provider: motionProvider?.snapshot(), render: active?.adapter.motion?.() }),
        }),
        snapshot: () => ({
            ...statistics, listeners: disposed ? 0 : statistics.listeners,
            model: active?.kind ?? null, capabilities: active?.adapter.capabilities ?? null,
            canvas: stage.querySelectorAll("canvas.character-canvas").length,
            loops: Number(raf !== null), cg: showingCg(), compact: isCompact || nativeCompact, visible,
            toon: Boolean(active?.toon),
            gesture: gesture?.name ?? null,
            vrm: vrmInfo,
        }),
        async dispose() {
            if (disposed) return jobs;
            disposed = true;
            requested++;
            abort.abort();
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
            expressionProvider?.dispose();
            motionProvider?.dispose();
            clock.dispose();
            schedule();
            retire(active);
            active = null;
            subtitle.remove();
            faceLabel.remove();
            stage.classList.remove("character-compact");
            stage.dataset.renderer = original;
            if (placeholder) placeholder.classList.remove("character-hidden");
            instances.delete(stage);
            return jobs;
        },
    });
    instances.set(stage, api);
    controls.hidden = false;
    refresh();
    const preferred = Object.hasOwn(LABELS, settings.model) ? settings.model : "live2d";
    void select(preferred).then(ok => {
        if (!ok && !disposed && preferred === "live2d" && vrmBytes) return select("vrm");
    });
    return api;
}

const instances = new WeakMap();
window.KeiCharacterStage = Object.freeze({ mount, get: stage => instances.get(stage) });
window.KeiCharacterStage.mount(document.querySelector("#character-stage"), document.querySelector("#character-controls"));
