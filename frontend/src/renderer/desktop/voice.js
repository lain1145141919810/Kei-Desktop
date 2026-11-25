"use strict";
// ケイの声: read Kei's lines aloud through the TTS provider selected in 管理 → モデル
// (docs/model-providers.md, desktop models.invoke) and play them on the character stage's
// playback clock so her mouth follows the audio. Opt-in from 操作; off by default.
(function () {
    const kei = window.kei;
    const $ = id => document.getElementById(id);
    const line = $("subtitle-chinese");
    const quick = $("quick-panel");
    if (!kei?.models?.invoke || !line || !quick) return;

    const ERRORS = {
        model_unavailable: "管理 → モデル で音声合成を選んでください。",
        model_credential_unavailable: "音声合成の認証情報（環境変数）が見つかりません。",
        audio_silent: "無音の音声が返されました。もう一度お試しください。",
        model_provider_failed: "音声合成から使用できる音声が返りませんでした。Aqua の動作を確認してください。",
        model_provider_busy: "音声合成が混み合っています。",
        model_input_invalid: "読み上げられない文章でした。",
        host_unavailable: "Kei ホストに接続できません。",
    };

    // ---- 操作 panel switch (same pattern as 画面観察)
    const row = document.createElement("div");
    row.className = "quick-item";
    row.id = "voice-block";
    row.innerHTML = '<div><div class="quick-title">ケイの声で読み上げる</div><div class="popover-note" id="voice-status">オフ</div></div>'
        + '<button id="voice-toggle" class="switch" type="button" role="switch" aria-checked="false" aria-label="ケイの声で読み上げる"><i></i></button>';
    $("capture-block")?.after(row);
    const toggle = $("voice-toggle");
    const note = $("voice-status");

    let enabled = false;
    try { enabled = localStorage.getItem("kei-voice") === "on"; } catch { /* default off */ }
    function setEnabled(on, message) {
        enabled = on;
        toggle.setAttribute("aria-checked", String(on));
        note.textContent = message || (on ? "返事とひとことを読み上げます" : "オフ");
        try { localStorage.setItem("kei-voice", on ? "on" : "off"); } catch { /* optional */ }
        if (!on) stop();
    }
    toggle.addEventListener("click", () => setEnabled(!enabled));

    // ---- speaking
    const stage = $("character-stage");
    const playback = () => window.KeiCharacterStage?.get(stage)?.playback;
    let job = 0;
    let currentSchedule = null;
    const scheduleListeners = new Set();
    function notifySchedule() {
        const snap = currentSchedule ? { ...currentSchedule, segments: currentSchedule.segments.map(s => ({ ...s })) } : null;
        for (const cb of scheduleListeners) {
            try { cb(snap); } catch { /* listener error must not stop speech */ }
        }
    }
    function stop() {
        job++;
        if (currentSchedule && currentSchedule.state !== "ended") {
            currentSchedule = { ...currentSchedule, state: "stopped" };
            notifySchedule();
        }
        try { playback()?.interrupt(); } catch { /* not mounted */ }
        stage?.classList.remove("is-voicing");
    }
    // Round 26: segmentation lives in speech-plan.js (first sentence alone for an earlier first PCM).
    const plan = window.KeiSpeechPlan;
    const sentences = text => plan.segmentSpeech(text);
    const latencies = [];
    function recordLatency(entry) {
        latencies.push(plan.latencyRecord(entry));
        if (latencies.length > 20) latencies.shift();
    }
    function bytesOf(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }
    async function synthesize(text, mine) {
        for (let attempt = 0; attempt < 5; attempt++) {
            if (mine !== job) return null;
            const reply = await kei.models.invoke("tts", { text, voice: "kei", locale: "ja-JP" }).catch(() => ({ ok: false, error: { code: "host_unavailable" } }));
            if (reply?.ok && reply.value?.output?.audio?.base64) return { audio: reply.value.output.audio, attempts: attempt + 1 };
            const code = reply?.error?.code || "model_unavailable";
            if (code !== "model_provider_busy") throw Object.assign(new Error(code), { code });
            if (attempt < 4) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
        throw Object.assign(new Error("model_provider_busy"), { code: "model_provider_busy" });
    }
    async function speak(text, meta = {}) {
        const mine = ++job;
        const startedAt = performance.now();
        const ledger = { requestId: meta.requestId ?? null, submittedAt: Number.isFinite(meta.submittedAt) ? meta.submittedAt : null,
            replyAt: Number.isFinite(meta.replyAt) ? meta.replyAt : startedAt, firstRequestAt: null, firstPcmAt: null,
            firstSoundAt: null, segments: 0, firstSegmentChars: 0, outcome: "pending" };
        const player = playback();
        if (!player) { note.textContent = "キャラクターが表示されていないため読み上げできません"; return; }
        let ids;
        try { ids = player.begin("voice-" + mine); } catch { return; }
        currentSchedule = {
            job: mine,
            requestId: meta.requestId ?? null,
            text,
            playbackId: ids.playbackId,
            turnId: ids.turnId,
            state: "synthesizing",
            segments: [],
        };
        notifySchedule();
        stage.classList.add("is-voicing");
        const pieces = sentences(text);
        ledger.segments = pieces.length;
        ledger.firstSegmentChars = pieces[0]?.length ?? 0;
        // One TTS request in flight at a time (single-worker providers answer 429 otherwise),
        // but the next one is sent as soon as the previous PCM arrives, not after decoding.
        const request = index => {
            const at = performance.now();
            const pending = synthesize(pieces[index], mine);
            pending.catch(() => {}); // awaited below; a superseded prefetch must not go unhandled
            return { at, pending };
        };
        try {
            let first = null, last = null;
            let next = pieces.length ? request(0) : null;
            for (const [index, piece] of pieces.entries()) {
                const current = next;
                const requestedAt = current.at;
                if (index === 0) {
                    note.textContent = "音声を準備しています…";
                    ledger.firstRequestAt = requestedAt;
                }
                const synthesis = await current.pending;
                if (mine !== job || !synthesis) return;
                const receivedAt = performance.now();
                if (index === 0) ledger.firstPcmAt = receivedAt;
                next = index + 1 < pieces.length ? request(index + 1) : null;
                const scheduled = await player.segment({ ...ids, segmentId: "s" + index, audio: bytesOf(synthesis.audio.base64), requireAudible: true, subtitle: "" });
                if (mine !== job || !scheduled) return;
                if (index === 0) {
                    const audioNow = player.audioTime?.();
                    ledger.firstSoundAt = performance.now() + (Number.isFinite(audioNow) ? Math.max(0, scheduled.start - audioNow) * 1000 : 0);
                }
                currentSchedule.segments.push({
                    segmentId: scheduled.segmentId,
                    text: piece,
                    start: scheduled.start,
                    end: scheduled.end,
                    duration: scheduled.duration,
                    activeStart: scheduled.activeStart,
                    activeEnd: scheduled.activeEnd,
                    speechWindows: scheduled.speechWindows,
                    timings: {
                        requestMs: requestedAt - startedAt,
                        synthesisMs: receivedAt - requestedAt,
                        decodeAndScheduleMs: performance.now() - receivedAt,
                        attempts: synthesis.attempts,
                    },
                });
                currentSchedule.state = "playing";
                notifySchedule();
                if (first === null) first = { start: scheduled.start, at: performance.now() };
                last = scheduled.end;
            }
            if (mine === job && currentSchedule) {
                currentSchedule.synthesizingDone = true;
                currentSchedule.latency = plan.latencyRecord({ ...ledger, outcome: "scheduled" });
                notifySchedule();
            }
            ledger.outcome = "scheduled";
            note.textContent = "返事とひとことを読み上げます";
            // Stay "voicing" until the last scheduled segment has played out.
            if (first && last !== null) {
                const remaining = (last - first.start) * 1000 - (performance.now() - first.at) + 250;
                if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
            }
            if (mine === job && currentSchedule) {
                currentSchedule.state = "ended";
                notifySchedule();
            }
        } catch (error) {
            ledger.outcome = error.code || "error";
            if (mine === job) {
                note.textContent = ERRORS[error.code] || `読み上げできませんでした（${error.code || "error"}）`;
                if (currentSchedule) { currentSchedule.state = "stopped"; notifySchedule(); }
            }
        } finally {
            if (mine === job) stage.classList.remove("is-voicing");
            else if (ledger.outcome === "pending") ledger.outcome = "superseded";
            recordLatency(ledger);
        }
    }

    $("composer")?.addEventListener("submit", stop);
    window.kei?.chat?.onSwitched?.(stop);
    stage?.addEventListener("kei:stage-character-changed", stop);
    window.addEventListener("keydown", event => { if (event.key === "Escape" && stage?.classList.contains("is-voicing")) stop(); });
    setEnabled(enabled);
    window.KeiVoice = {
        speak,
        // `meta` = { requestId, submittedAt } from chat.js for the latency ledger.
        readReply(text, meta = {}) {
            if (enabled && typeof text === "string" && text.trim()) void speak(text, { ...meta, replyAt: performance.now() });
        },
        latency: () => latencies.map(entry => ({ ...entry })),
        stop,
        enabled: () => enabled,
        schedule: () => currentSchedule ? { ...currentSchedule, segments: currentSchedule.segments.map(s => ({ ...s })) } : null,
        onSchedule(cb) {
            scheduleListeners.add(cb);
            return () => scheduleListeners.delete(cb);
        },
    };
})();
