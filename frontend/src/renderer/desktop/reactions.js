"use strict";
// Kei's face follows the conversation (v0.3.2 character/reactions.js): thinking while a
// reply is pending, a small smile when it arrives, flustered on an error, gentle for her own
// asides (greeting, focus timer) and bashful when poked. Uses the stage API's face()/smile()
// and does nothing when the renderer does not support expressions.
(function () {
    const $ = id => document.getElementById(id);
    const stage = $("character-stage");
    const echo = $("user-echo");
    const subtitle = $("subtitle");
    const status = $("composer-status");
    if (!stage || !echo || !subtitle) return;
    const renderer = () => window.KeiCharacterStage?.get(stage);

    let current = "neutral";
    let until = 0;          // a timed face holds until this time
    let timer = null;
    let visualVersion = 0;
    let lastTurn = null;
    let personaRevision = 0;
    let workUntil = 0;
    let plan = null;
    let bodyState = null;
    let timings = null;
    function face(name, ms = 0) {
        const api = renderer();
        if (!api?.face) return;
        clearTimeout(timer);
        if (api.face(name)) current = name;
        until = ms ? Date.now() + ms : 0;
        if (ms) timer = setTimeout(settle, ms);
    }
    function settle() {
        if (echo.classList.contains("is-waiting")) return face("thoughtful");
        face("neutral");
    }

    let waiting = false;
    let lastLine = "";
    function onChat() {
        const nowWaiting = echo.classList.contains("is-waiting");
        const line = $("subtitle-chinese")?.textContent || "";
        if (nowWaiting && !waiting) face("thoughtful");
        if (!nowWaiting && waiting) {
            if (status?.dataset.tone === "error") face("flustered", 2600);
            else if (subtitle.dataset.replyStatus === "completed") { face("smallSmile", 4200); renderer()?.smile?.(900); }
            else settle();
        }
        if (!nowWaiting && Date.now() >= workUntil && subtitle.classList.contains("is-aside") && line && line !== lastLine) {
            face("gentle", 5200);
            renderer()?.smile?.(700);
        }
        waiting = nowWaiting;
        lastLine = line;
    }
    const observer = new MutationObserver(onChat);
    observer.observe(echo, { attributes: true, attributeFilter: ["class"] });
    observer.observe(subtitle, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true, characterData: true });
    if (status) observer.observe(status, { attributes: true, attributeFilter: ["data-tone"] });

    // Poked: a short bashful look, unless she is busy thinking.
    stage.addEventListener("kei:stage-hit", () => {
        if (waiting) return;
        const pool = ["bashful", "smallSmile", "flustered"];
        face(pool[Math.floor(Math.random() * pool.length)], 1800);
    });
    function invalidatePlan({ smooth = false } = {}) {
        visualVersion++;
        plan = null;
        timings = null;
        if (bodyState && bodyState.state === "running") bodyState = { ...bodyState, state: "cancelled" };
        renderer()?.gesture?.("none");
        renderer()?.motion?.interrupt?.({ smooth });
    }

    function applyPlan(kind, response, token, stageApi, model, startedAt, source, replyText = "", requestId = null) {
        if (token !== visualVersion || performance.now() - startedAt > 6200 ||
            renderer() !== stageApi || stageApi.snapshot().model !== model || waiting) return;
        if (kind === "work-input" && window.KeiSessions?.snapshot()?.waiting === 0) return;
        const body = Array.isArray(response.body) ? response.body : [];
        const rejected = Array.isArray(response.rejected) ? response.rejected
            : Array.isArray(response.rejectedBody) ? response.rejectedBody : [];
        const validatedAt = performance.now();
        plan = { kind, face: response.face, motion: response.motion, body, rejected, source };
        timings = {
            kind,
            source,
            startedAt,
            validatedMs: Number((validatedAt - startedAt).toFixed(1)),
            solverStartedMs: null,
            firstPoseMs: null,
            completedMs: null,
        };
        face(response.face, 3600);
        // Apply procedural head gesture immediately; if a body clip takes head ownership
        // (e.g. nod or hesitant tilt), vrm.mjs and onStepStart yield cleanly without double-driving.
        stageApi.gesture(response.motion);

        if (!body.length) {
            bodyState = { state: "none", steps: [], completedSteps: [], skippedSteps: [], rejected, source };
            return;
        }
        if (stageApi.snapshot().model !== "vrm" || (!stageApi.motion?.playSyncedSequence && !stageApi.motion?.playSequence)) {
            bodyState = { state: "skipped", reason: "renderer_unsupported", steps: body, completedSteps: [], skippedSteps: [], rejected, source };
            return;
        }
        const sequenceLog = [];
        const trimmedReply = typeof replyText === "string" ? replyText.trim() : "";
        const scheduledReply = () => {
            const schedule = window.KeiVoice?.schedule?.();
            return schedule && schedule.requestId === requestId && schedule.text === trimmedReply ? schedule : null;
        };
        const speechEnabled = Boolean(kind === "reply" && window.KeiVoice?.enabled?.() && trimmedReply);
        bodyState = {
            state: "running",
            steps: body,
            completedSteps: [],
            skippedSteps: [],
            rejected,
            source,
            speechSynced: speechEnabled,
            sequenceLog,
        };
        timings.solverStartedMs = Number((performance.now() - startedAt).toFixed(1));

        const hooks = {
            onStepStart(index, step, started, syncMeta = null) {
                if (token !== visualVersion) return;
                if (started.beat?.ownsHead) stageApi.gesture("none");
                const nowMs = Number((performance.now() - startedAt).toFixed(1));
                if (index === 0 || timings.firstPoseMs === null) timings.firstPoseMs = nowMs;
                sequenceLog.push({
                    index,
                    motion: step.motion,
                    variantId: started.beat?.variantId ?? started.diagnostics?.variantId ?? null,
                    handedness: started.beat?.handedness ?? started.diagnostics?.handedness ?? null,
                    ownsHead: Boolean(started.beat?.ownsHead ?? started.diagnostics?.ownsHead),
                    speed: step.speed,
                    strength: step.strength,
                    phrase: step.phrase ?? null,
                    event: "started",
                    atMs: nowMs,
                    cached: Boolean(started.diagnostics?.cached),
                    prewarmed: Boolean(started.diagnostics?.prewarmed),
                    solveMs: started.diagnostics?.solveMs ?? null,
                    durationMs: started.durationMs,
                    beat: started.beat ?? null,
                    constraints: started.diagnostics?.constraints ?? null,
                    sync: syncMeta,
                });
            },
            onStepSkipped(index, step, skipped) {
                if (token !== visualVersion) return;
                sequenceLog.push({
                    index,
                    motion: step.motion,
                    phrase: step.phrase ?? null,
                    event: "skipped_late",
                    reason: skipped.reason,
                    atMs: Number((performance.now() - startedAt).toFixed(1)),
                    sync: skipped.sync ?? null,
                });
            },
            onStepEnd(index, step, outcome, syncMeta = null) {
                if (token !== visualVersion && outcome === "completed") return;
                sequenceLog.push({
                    index,
                    motion: step.motion,
                    event: outcome,
                    atMs: Number((performance.now() - startedAt).toFixed(1)),
                    sync: syncMeta,
                });
            },
        };

        const runPromise = stageApi.motion.playSyncedSequence
            ? stageApi.motion.playSyncedSequence(body, {
                speechEnabled,
                replyText: trimmedReply,
                getAudioTime: () => stageApi.playback?.audioTime?.() ?? null,
                getSegments: () => {
                    const sched = scheduledReply();
                    return sched ? sched.segments : [];
                },
                isSynthesizing: () => {
                    const sched = scheduledReply();
                    return Boolean(sched && !sched.synthesizingDone && sched.state !== "stopped" && sched.state !== "ended");
                },
                isSpeechStopped: () => {
                    const sched = scheduledReply();
                    return Boolean(sched && sched.state === "stopped");
                },
            }, hooks)
            : stageApi.motion.playSequence(body, hooks);

        void runPromise.then(result => {
            if (token !== visualVersion) return;
            timings.completedMs = Number((performance.now() - startedAt).toFixed(1));
            bodyState = {
                state: result.state,
                code: result.code ?? null,
                steps: body,
                completedSteps: result.completedSteps ?? [],
                skippedSteps: result.skippedSteps ?? [],
                rejected,
                source,
                speechSynced: speechEnabled,
                sequenceLog,
            };
        });
    }

    async function visual(kind, turnId, replyText = "", requestId = null) {
        const token = ++visualVersion;
        const startedAt = performance.now();
        const startedWall = Date.now();
        const stageApi = renderer();
        if (!stageApi?.gesture || !window.kei?.chat?.visual) return;
        const model = stageApi.snapshot().model;
        const response = await window.kei.chat.visual(kind, turnId).catch(() => null);
        if (token !== visualVersion || Date.now() - startedWall > 6200 ||
            renderer() !== stageApi || stageApi.snapshot().model !== model || waiting) return;
        if (kind === "work-input" && window.KeiSessions?.snapshot()?.waiting === 0) return;
        if (response?.state !== "ready") return;
        applyPlan(kind, response, token, stageApi, model, startedAt, "visual", replyText, requestId);
    }

    window.kei?.chat?.onTurn?.(({ conversationId, turn }) => {
        if (conversationId !== document.body.dataset.conversationId || !turn) return;
        if (turn.status !== "completed") {
            invalidatePlan({ smooth: true });
            return;
        }
        if (turn.turnId && turn.turnId !== lastTurn) {
            lastTurn = turn.turnId;
            waiting = false;
            if (turn.visualStale || (Number.isSafeInteger(turn.persona?.revision) && turn.persona.revision < personaRevision)) return;
            const replyText = typeof turn.spokenReply === "string" ? turn.spokenReply : "";
            if (turn.performance) {
                const token = ++visualVersion;
                const stageApi = renderer();
                if (!stageApi?.gesture) return;
                applyPlan("reply", turn.performance, token, stageApi, stageApi.snapshot().model, performance.now(), turn.performance.source || "embedded", replyText, turn.requestId);
            } else {
                void visual("reply", turn.turnId, replyText, turn.requestId);
            }
        }
    });
    window.kei?.chat?.onSwitched?.(() => invalidatePlan({ smooth: true }));
    window.kei?.personas?.onChanged?.(event => {
        if (Number.isSafeInteger(event?.revision)) personaRevision = event.revision;
        invalidatePlan({ smooth: true });
    });
    stage.addEventListener("kei:stage-character-changed", () => invalidatePlan({ smooth: false }));
    $("composer")?.addEventListener("submit", () => invalidatePlan({ smooth: true }));
    window.addEventListener("keydown", event => { if (event.key === "Escape") invalidatePlan({ smooth: true }); });
    window.KeiReactions = {
        face,
        work(kind) {
            invalidatePlan({ smooth: true });
            const event = { input: ["thoughtful", "work-input"], succeeded: ["smallSmile", "work-success"],
                failed: ["flustered", "work-error"] }[kind];
            workUntil = Date.now() + 4000;
            face(event?.[0] ?? "neutral", 4000);
            if (event) void visual(event[1]);
        },
        snapshot: () => ({ current, until, plan, body: bodyState, timings }),
    };
})();
