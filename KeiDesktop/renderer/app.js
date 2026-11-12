const WS_URL =
    "ws://127.0.0.1:17881/ws?client=kei-desktop";

const idleVideo =
    document.getElementById(
        "idle-video"
    );

const talkVideo =
    document.getElementById(
        "talk-video"
    );

const subtitleElement =
    document.getElementById(
        "subtitle"
    );

const subtitleChinese = document.getElementById("subtitle-chinese");
const subtitleJapanese = document.getElementById("subtitle-japanese");

const connectionDot =
    document.getElementById(
        "connection-dot"
    );

const connectionText =
    document.getElementById(
        "connection-text"
    );

const characterRenderer =
    new WebMRenderer({
        idleVideo:
            idleVideo,

        talkVideo:
            talkVideo,

        talkVariants: [
            "../assets/character/CH0335_home_Talk_01_M.webm",
        ],
    });


const character =
    new CharacterController(
        characterRenderer
    );

window.KeiReactions?.attach(character);

const scene = new SceneController({
    root: document.getElementById("window"),
    backgroundLayer: document.getElementById("scene-background-layer"),
    background: document.getElementById("scene-background"),
    environmentFxLayer: document.getElementById("environment-fx-layer"),
    characterStage: document.getElementById("character-stage"),
    characterFxLayer: document.getElementById("character-fx-layer"),
    uiLayer: document.getElementById("scene-ui-layer"),
});

// The backlog labels task steps with the same wording as the work card.
if (window.KeiConversation) {
    window.KeiConversation.describeStep = payload => {
        const activity = scene._presentationActivity(payload);
        return activity ? scene._stepLabel({
            activity, toolName: payload.tool_name || "",
            label: typeof payload.step_label === "string" ? payload.step_label.trim().slice(0, 24) : "",
        }) : null;
    };
}

const state = {
    connected: false,

    speaking: false,

    chineseText: "",
    japaneseText: "",

    affect: null,

    currentTurnId: null,

    subtitleTimer: null,
    subtitleGeneration: 0,
};


let socket = null;

let reconnectTimer = null;

let reconnectDelay = 1000;

const pendingSubtitles =
    new Map();
const pendingTranslations = new Map();

const pendingAffects = new Map();
const retiredTurnIds = new Set();

function retireTurn(turnId) {
    if (!turnId) return;
    pendingAffects.delete(turnId);
    pendingTranslations.delete(turnId);
    retiredTurnIds.add(turnId);
    while (retiredTurnIds.size > 30) {
        retiredTurnIds.delete(retiredTurnIds.values().next().value);
    }
}

let activeTtsTurnId =
    null;

const lifecycle = new DesktopLifecycleController({
    overlay: document.getElementById("lifecycle-overlay"),
    video: document.getElementById("lifecycle-video"),
    button: document.getElementById("power-button"),
    bridge: window.keiDesktop,
    onClose: (loginTurnId) => {
        const turnId = activeTtsTurnId || state.currentTurnId || loginTurnId;
        if (turnId) window.keiDesktop?.stopPlayback(turnId);
        character.interrupt();
        setSpeaking(false);
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    },
});


function rememberSubtitle(
    turnId,
    text
) {
    if (
        !turnId
        ||
        !text
    ) {
        return;
    }

    pendingSubtitles.set(
        turnId,
        text
    );

    // 防止异常情况下缓存无限增长
    while (
        pendingSubtitles.size > 20
    ) {
        const oldestKey =
            pendingSubtitles
                .keys()
                .next()
                .value;

        pendingSubtitles.delete(
            oldestKey
        );
    }
}


function subtitleForTurn(
    turnId
) {
    if (!turnId) {
        return "";
    }

    const text =
        pendingSubtitles.get(
            turnId
        );

    if (text) {
        return text;
    }

    return "";
}

// ============================================================
// UI
// ============================================================

function setConnectionState(
    connected
) {
    state.connected =
        connected;

    window.KeiConversation?.setConnected(connected);
    window.KeiReactions?.setConnected(connected);

    if (connected) {

        connectionDot.style.background =
            "#7cff9b";

        connectionText.textContent =
            "接続済み";

    } else {

        connectionDot.style.background =
            "#ff7373";

        connectionText.textContent =
            "未接続";
    }
}


function setSpeaking(
    speaking
) {
    if (state.speaking === speaking) {
        return;
    }

    state.speaking =
        speaking;

    document.body.classList.toggle(
        "speaking",
        speaking
    );


    character.setSpeaking(
        speaking
    );
}


function showSubtitle(
    text,
    japaneseText = ""
) {
    if (!text) {
        return;
    }

    // Show only the text actually spoken by the Japanese voice.
    text = japaneseText || text;
    japaneseText = "";

    const generation = ++state.subtitleGeneration;
    state.chineseText =
        text;

    subtitleChinese.textContent = text;
    subtitleJapanese.textContent = japaneseText;
    subtitleJapanese.hidden = !japaneseText;
    subtitleElement.setAttribute("aria-hidden", "false");

    subtitleElement.classList.add(
        "visible"
    );


    if (
        state.subtitleTimer
    ) {
        clearTimeout(
            state.subtitleTimer
        );
    }


    state.subtitleTimer =
        setTimeout(
            () => {

                if (
                    !state.speaking && generation === state.subtitleGeneration
                ) {
                    hideSubtitle();
                }

            },
            15000
        );
}


function showEmptyDialogue() {
    ++state.subtitleGeneration;
    clearTimeout(state.subtitleTimer);
    state.subtitleTimer = null;
    state.chineseText = "";
    state.japaneseText = "";
    subtitleChinese.textContent = "";
    subtitleJapanese.textContent = "";
    subtitleJapanese.hidden = true;
    subtitleElement.setAttribute("aria-hidden", "false");
    subtitleElement.classList.add("visible");
}

// Kei's last line stays on screen after she stops talking, long enough to be
// read again, then fades. Anything new (her next line, an interruption)
// replaces this through the generation counter.
function lingerSubtitle() {
    const generation = ++state.subtitleGeneration;
    clearTimeout(state.subtitleTimer);
    const hold = Math.max(8000, Math.min(20000, 4000 + state.chineseText.length * 150));
    state.subtitleTimer = setTimeout(() => {
        if (generation !== state.subtitleGeneration || state.speaking) return;
        hideSubtitle();
        // Clear the text only after the fade, so the words do not vanish first.
        state.subtitleTimer = setTimeout(() => {
            if (generation === state.subtitleGeneration && !state.speaking) showEmptyDialogue();
        }, 320);
    }, hold);
}

function retainInterruptedSubtitle() {
    ++state.subtitleGeneration;
    clearTimeout(state.subtitleTimer);
    state.subtitleTimer = null;
    if (state.chineseText) {
        subtitleElement.setAttribute("aria-hidden", "false");
        subtitleElement.classList.add("visible");
    }
}

function hideSubtitle() {

    subtitleElement.setAttribute("aria-hidden", "true");

    subtitleElement
        .classList
        .remove(
            "visible"
        );
}

// ============================================================
// Character State
// ============================================================



// ============================================================
// Runtime Event Handling
// ============================================================

function handleRuntimeEvent(
    event
) {

    if (
        !event
        ||
        typeof event !== "object"
    ) {
        return;
    }


    const type =
        event.type;

    const payload =
        event.payload || {};


    if (type !== "tts.mouth") {
        console.log(
            "[Kei Desktop]",
            type,
            event
        );
    }


    // A proactive check that Kei answered with silence leaves no trace at all.
    const verdict = window.KeiProactive?.intercept(event);
    if (verdict === "silence") {
        // Close the turn on stage as a cancellation. The lifecycle session keeps
        // the transcript and the reactions from treating it as a conversation event.
        handleRuntimeEvent({ type: "interrupt", session_id: "desktop-lifecycle", turn_id: event.turn_id, payload: { synthetic: true } });
        return;
    }
    if (verdict) return;

    if (type === "desktop.thread.rollover") {
        window.keiDesktop.history("rollover", {turn:event.turn_id, thread:event.payload.thread})
            .then(() => window.KeiShell?.showToast?.("要約を引き継ぎ、新しい会話を始めました"))
            .catch(console.error);
        return;
    }
    // The transcript records every turn, including ones the stage ignores.
    window.KeiConversation?.handleRuntimeEvent(event);
    window.KeiReactions?.handleRuntimeEvent(event);

    switch (type) {
        case "agent.scene.snapshot": {
            if (scene.handleRuntimeEvent(event) && event.turn_id) {
                retiredTurnIds.delete(event.turn_id);
            }
            break;
        }
        case "agent.begin":
        case "agent.tool.start":
        case "agent.tool.end":
        case "agent.done": {
            scene.handleRuntimeEvent(event);
            break;
        }
        
        case "tts.mouth": {

            if (
                !activeTtsTurnId
                ||
                event.turn_id
                !== activeTtsTurnId
            ) {
                break;
            }


            const value =
                Number(
                    payload.value ?? 0
                );


            if (payload.final) {
                if (payload.reason === "completed") {
                    character.releaseMouth();
                } else {
                    character.hardResetMouth();
                }
            } else {
                character.setMouth(value);
            }


            break;
        }
        // ----------------------------------------------------
        // AstrBot 中文回复
        // ----------------------------------------------------

        case "assistant.reply": {

            const turnId =
                event.turn_id
                ||
                null;

            if (turnId && retiredTurnIds.has(turnId)) {
                console.log('[Kei Desktop] ignore retired assistant.reply:', turnId);
                break;
            }


            const text =
                payload.tts_text
                ||
                event.text
                ||
                "";


            if (turnId && turnId !== state.currentTurnId) {
                state.currentTurnId = turnId;
                state.affect = null;
                character.reserveExpressionForTurn(turnId);
            }

            // A mood tool can publish affect while the Agent is still working.
            // Keep that same-turn choice until the first speaker frame arrives.
            if (turnId && payload.affect && typeof payload.affect === 'object') {
                pendingAffects.set(turnId, payload.affect);
                state.affect = payload.affect;
                character.setAffect(payload.affect);
                if (activeTtsTurnId === turnId) {
                    character.beginExpressionForTurn(turnId, payload.affect);
                }
            }

            state.chineseText =
                text;


            rememberSubtitle(
                turnId,
                text
            );

            scene.renderResult(turnId, event.text || text, payload.result_summary || "");


            console.log(
                "[Kei Desktop] subtitle cached:",
                turnId,
                text
            );


            // 注意：
            // 这里不再 showSubtitle()
            // 等真正 tts.start 时再显示。

            break;
        }


        // ----------------------------------------------------
        // Affect / Prosody
        // ----------------------------------------------------

        case "assistant.affect": {
            const turnId = event.turn_id || null;
            if (!turnId || retiredTurnIds.has(turnId)
                || (turnId !== state.currentTurnId && !scene.isActiveTurn(turnId))) {
                console.log('[Kei Desktop] ignore stale affect:', turnId);
                break;
            }
            const affect = payload.affect && typeof payload.affect === 'object'
                ? payload.affect
                : payload;
            pendingAffects.set(turnId, affect);
            while (pendingAffects.size > 20) {
                pendingAffects.delete(pendingAffects.keys().next().value);
            }
            if (turnId === state.currentTurnId) {
                state.affect = affect;
                character.setAffect(affect);
            }
            if (activeTtsTurnId === turnId) {
                character.beginExpressionForTurn(turnId, affect);
            }


            console.log(
                "[Kei Desktop] affect:",
                affect
            );

            break;
        }


        // ----------------------------------------------------
        // 中文 -> 日文
        // ----------------------------------------------------

        case "assistant.translation": {

            const turnId = event.turn_id || null;
            if (!turnId || retiredTurnIds.has(turnId)) break;
            const japanese = event.text || payload.text || "";
            if (!pendingTranslations.has(turnId)) pendingTranslations.set(turnId, new Map());
            pendingTranslations.get(turnId).set(Number(payload.segment_index || 1), japanese);
            while (pendingTranslations.size > 20) {
                pendingTranslations.delete(pendingTranslations.keys().next().value);
            }

            state.japaneseText =
                japanese;


            console.log(
                "[Kei Desktop] Japanese:",
                state.japaneseText
            );

            break;
        }


        // ----------------------------------------------------
        // TTS started
        // ----------------------------------------------------

        case "tts.start": {

            const turnId =
                event.turn_id
                ||
                null;


            if (!turnId) {

                console.warn(
                    "[Kei Desktop] "
                    + "tts.start without turn_id"
                );

                break;
            }

            if (retiredTurnIds.has(turnId) ||
                (state.currentTurnId && !retiredTurnIds.has(state.currentTurnId) && turnId !== state.currentTurnId)) {
                console.log('[Kei Desktop] ignore stale tts.start:', turnId);
                break;
            }

            if (!state.currentTurnId || retiredTurnIds.has(state.currentTurnId)) {
                state.currentTurnId = turnId;
                character.reserveExpressionForTurn(turnId);
            }


            scene.startResultPresentation(turnId);
            activeTtsTurnId =
                turnId;



            const subtitle = event.text || payload.translated_text
                || pendingTranslations.get(turnId)?.get(Number(payload.segment_index || 1))
                || subtitleForTurn(turnId);
            if (subtitle) {
                showSubtitle(subtitle);
            } else {

                console.warn(
                    "[Kei Desktop] "
                    + "no cached subtitle:",
                    turnId
                );
            }


            setSpeaking(
                true
            );
            character.beginExpressionForTurn(turnId, pendingAffects.get(turnId) || null);


            console.log(
                "[Kei Desktop] "
                + "audio synced start:",
                turnId
            );


            break;
        }


        // ----------------------------------------------------
        // TTS ended
        // ----------------------------------------------------

        case "tts.end": {

            const turnId =
                event.turn_id
                ||
                null;
            
            const segmentFinal =
                payload.segment_final
                ??
                true;

            if (
                !activeTtsTurnId
                ||
                turnId
                !== activeTtsTurnId
            ) {

                if (turnId && !segmentFinal && scene.isActiveTurn(turnId)
                    && (payload.status === "completed" || payload.status === "error")) {
                    break;
                }

                // A streamed reply can finish after every audio part failed
                // before tts.start. Its completion marker still needs a text
                // fallback and must close the result presentation.
                const unspokenFinal = payload.status === "error"
                    || (payload.status === "completed"
                        && payload.reason === "streamed_turn_complete");
                if (turnId && segmentFinal && unspokenFinal
                    && !retiredTurnIds.has(turnId) && scene.isActiveTurn(turnId)) {
                    scene.startResultPresentation(turnId);
                    scene.finishPresentation(turnId, { completed: true, delay: 4000 });
                    // No audio means no spoken Japanese; fall back to the reply itself.
                    const fallbackText = Array.from(pendingTranslations.get(turnId)?.values() || []).join("")
                        || subtitleForTurn(turnId);
                    if (fallbackText && !state.speaking) showSubtitle(fallbackText);
                    const subtitleGeneration = state.subtitleGeneration;
                    clearTimeout(state.subtitleTimer);
                    // Unspoken text is the only copy the user gets: give it time.
                    if (subtitleGeneration === state.subtitleGeneration) lingerSubtitle();
                    retireTurn(turnId);
                } else {
                    console.log(
                        "[Kei Desktop] "
                        + "ignore stale tts.end:",
                        turnId,
                        "active=",
                        activeTtsTurnId
                    );
                }


                if (turnId) {

                    pendingSubtitles.delete(
                        turnId
                    );
                }


                break;
            }


            if (payload.status === "completed") {
                character.releaseMouth();
            } else {
                character.hardResetMouth();
            }

            // Internal TTS parts and nonfinal sentences belong to the
            // same answer. Keep the subtitle and speaking state while
            // the next audio part is being prepared.
            if (!segmentFinal && payload.status !== "cancelled") {
                break;
            }


            setSpeaking(
                false
            );
            if (payload.status === 'completed') {
                character.finishExpressionForTurn(turnId);
            } else {
                character.interrupt();
            }


            activeTtsTurnId =
                null;

            retireTurn(turnId);

            scene.finishPresentation(turnId, {
                final: segmentFinal,
                completed: payload.status === "completed" || payload.status === "error",
                delay: payload.status === "error" ? 4000 : 2000,
            });


            if (segmentFinal) {

                pendingSubtitles.delete(
                    turnId
                );
            }

            if (segmentFinal && payload.status === "completed") {
                lingerSubtitle();
                break;
            }

            if (segmentFinal && payload.status === "error") {
                const subtitleGeneration = state.subtitleGeneration;
                if (subtitleGeneration === state.subtitleGeneration) lingerSubtitle();
                break;
            }

            const hideDelay =
                segmentFinal
                    ? 1200
                    : 250;
            const subtitleGeneration = state.subtitleGeneration;
            state.subtitleTimer = setTimeout(
                () => {

                    if (
                        subtitleGeneration === state.subtitleGeneration
                        && activeTtsTurnId
                        === null
                        &&
                        !state.speaking
                    ) {

                        hideSubtitle();
                    }

                },
                hideDelay
            );


            break;
        }

        // ----------------------------------------------------
        // interrupt / barge-in
        // ----------------------------------------------------

        case "task.cancel":
        case "interrupt": {

            const turnId =
                event.turn_id
                ||
                null;

            // Agent work can be cancelled before any reply or TTS turn exists.
            // Scene identity is independent of the character's speaking turn.
            const cancelsActiveScene = turnId && scene.isActiveTurn(turnId);
            if (cancelsActiveScene) {
                scene.interrupt(turnId);
                retainInterruptedSubtitle();
            }


            if (turnId && turnId !== activeTtsTurnId && turnId !== state.currentTurnId) {
                if (cancelsActiveScene) retireTurn(turnId);

                console.log(
                    "[Kei Desktop] "
                    + "ignore stale interrupt:",
                    turnId
                );

                break;
            }


            const interruptedTurnId =
                activeTtsTurnId
                ||
                turnId;


            state.speaking =
                false;


            document.body.classList.remove(
                "speaking"
            );


            character.interrupt();
            scene.interrupt(interruptedTurnId);
            retireTurn(interruptedTurnId);
            if (state.currentTurnId === interruptedTurnId) {
                state.currentTurnId = null;
                state.affect = null;
            } else if (state.currentTurnId) {
                character.reserveExpressionForTurn(state.currentTurnId);
            }


            if (interruptedTurnId) {

                pendingSubtitles.delete(
                    interruptedTurnId
                );
            }


            activeTtsTurnId =
                null;


            retainInterruptedSubtitle();


            break;
        }
    }
}
// ============================================================
// WebSocket
// ============================================================

function connect() {

    if (
        socket
        &&
        (
            socket.readyState
            === WebSocket.OPEN

            ||

            socket.readyState
            === WebSocket.CONNECTING
        )
    ) {
        return;
    }


    console.log(
        "[Kei Desktop] connecting:",
        WS_URL
    );


    const connection = new WebSocket(WS_URL);
    socket = connection;


    connection.addEventListener(
        "open",
        () => {
            if (socket !== connection) return;

            console.log(
                "[Kei Desktop] connected"
            );


            setConnectionState(
                true
            );

            lifecycle.runtimeReady();


            reconnectDelay =
                1000;


            if (
                reconnectTimer
            ) {

                clearTimeout(
                    reconnectTimer
                );

                reconnectTimer =
                    null;
            }
        }
    );


    connection.addEventListener(
        "message",
        (message) => {
            if (socket !== connection) return;

            try {

                const event =
                    JSON.parse(
                        message.data
                    );


                if (lifecycle.phase === "closing") return;
                lifecycle.observeEvent(event);
                handleRuntimeEvent(
                    event
                );

            } catch (error) {

                console.error(
                    "[Kei Desktop] invalid event:",
                    error,
                    message.data
                );
            }
        }
    );


    connection.addEventListener(
        "close",
        () => {
            if (socket !== connection) return;
            socket = null;

            console.warn(
                "[Kei Desktop] disconnected"
            );


            setConnectionState(
                false
            );

            const interruptedTurnId = activeTtsTurnId || state.currentTurnId;
            if (interruptedTurnId) {
                window.keiDesktop?.stopPlayback(interruptedTurnId);
                retireTurn(interruptedTurnId);
            }
            activeTtsTurnId = null;
            state.currentTurnId = null;
            state.affect = null;
            pendingSubtitles.clear();
            pendingTranslations.clear();
            pendingAffects.clear();
            character.interrupt();
            setSpeaking(false);
            scene.resetToIdle(null, { clearRevision: true });
            showEmptyDialogue();


            scheduleReconnect();
        }
    );


    connection.addEventListener(
        "error",
        (error) => {
            if (socket !== connection) return;

            console.error(
                "[Kei Desktop] websocket error:",
                error
            );
        }
    );
}


function scheduleReconnect() {

    if (lifecycle.phase === "closing") return;

    if (
        reconnectTimer
    ) {
        return;
    }


    reconnectTimer =
        setTimeout(
            () => {

                reconnectTimer =
                    null;

                connect();

            },
            reconnectDelay
        );


    reconnectDelay =
        Math.min(
            reconnectDelay * 1.5,
            10000
        );
}


// ============================================================
// Start
// ============================================================

async function start() {

    if(window.KeiProfileReady)await window.KeiProfileReady;
    lifecycle.start();

    setConnectionState(
        false
    );


    await character.initialize();

    character.setVisible(!document.hidden);


    if(window.keiLocal){
        window.keiLocal.events(event=>{lifecycle.observeEvent(event);handleRuntimeEvent(event);});
        setConnectionState(true);lifecycle.runtimeReady();
    }else connect();
}


document.addEventListener("visibilitychange", () => {
    character.setVisible(!document.hidden);
});

start();
