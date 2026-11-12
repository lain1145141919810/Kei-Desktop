// Expression reactions to events outside of speech.
// While Kei speaks, the runtime's affect picks her expression (app.js ->
// CharacterController.beginExpressionForTurn). This fills the silent moments:
// listening, thinking, working, being interrupted, losing the connection.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.KeiReactionsFactory = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    // event -> [expression, how long to hold it (ms)]
    const REACTIONS = {
        heard: ['small_smile', 2500],          // the user said or typed something
        thinking: ['thoughtful', 20000],       // agent.begin
        working: ['serious', 45000],           // a tool is running
        'tool-failed': ['flustered', 3000],    // a tool step failed
        interrupted: ['surprised', 1600],      // barge-in or cancelled task
        disconnected: ['sad', 5000],           // runtime connection lost
        reconnected: ['happy', 2500],          // runtime is back
        'file-received': ['bashful', 2500],    // a file was handed over
        'focus-done': ['gentle', 6000],        // pomodoro: time for a break
        'break-done': ['serious', 4000],       // pomodoro: back to work
        'nothing-to-say': ['neutral', 0],      // turn ended without a reply
    };

    function createReactions({ isSpeaking = () => false, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        let character = null;
        let timer = null;
        let wasConnected = null;
        const seenTurns = new Set();

        function play(name) {
            const reaction = REACTIONS[name];
            // Speech owns the face: never fight the affect-driven expression.
            if (!reaction || !character || isSpeaking()) return false;
            const [expression, hold] = reaction;
            clearTimer(timer);
            timer = null;
            if (!character.setExpression(expression)) return false;
            if (hold > 0) {
                timer = setTimer(() => {
                    timer = null;
                    if (!isSpeaking()) character.setExpression('neutral');
                }, hold);
            }
            return true;
        }

        function handleRuntimeEvent(event) {
            if (!event || typeof event !== 'object' || event.session_id === 'desktop-lifecycle') return;
            const payload = event.payload || {};
            switch (event.type) {
                case 'user.transcript':
                case 'user.message': play('heard'); break;
                case 'agent.begin':
                    if (event.turn_id) { seenTurns.add(event.turn_id); if (seenTurns.size > 30) seenTurns.delete(seenTurns.values().next().value); }
                    play('thinking');
                    break;
                case 'agent.tool.start': play('working'); break;
                case 'agent.tool.end': play(payload.status === 'failed' ? 'tool-failed' : 'thinking'); break;
                case 'agent.done': if (payload.has_reply === false) play('nothing-to-say'); break;
                case 'tts.start':
                    // The speaking expression takes over; drop any pending reset.
                    clearTimer(timer);
                    timer = null;
                    break;
                case 'interrupt':
                case 'task.cancel':
                    // Only react to turns this window saw start.
                    if (event.turn_id && seenTurns.delete(event.turn_id)) setTimer(() => play('interrupted'), 0);
                    break;
            }
        }

        return {
            attach(target) { character = target; },
            play,
            handleRuntimeEvent,
            setConnected(connected) {
                if (wasConnected === connected) return;
                const first = wasConnected === null;
                wasConnected = connected;
                // app.js resets the face when the socket closes; react after that.
                if (!first) setTimer(() => play(connected ? 'reconnected' : 'disconnected'), 0);
            },
            names: () => Object.keys(REACTIONS),
        };
    }

    return { createReactions, REACTIONS };
});

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    // Devtools: KeiReactions.names(), KeiReactions.play('focus-done')
    window.KeiReactions = window.KeiReactionsFactory.createReactions({
        isSpeaking: () => document.body.classList.contains('speaking'),
    });
}
