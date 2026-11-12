const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const rendererDir = path.join(__dirname, '..', 'renderer');
const expressions = [];
const scene = { active: null, resultStarts: [], resultFinishes: [] };
const element = () => ({
    textContent: '', hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
});
const elements = new Map();
const document = {
    hidden: false,
    body: element(),
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    },
    addEventListener() {},
};
const context = {
    document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 1,
    clearTimeout() {},
    WebSocket: class { static OPEN = 1; static CONNECTING = 0; addEventListener() {} },
    WebMRenderer: class {},
    CharacterController: class {
        initialize() { return Promise.resolve(); }
        setVisible() {}
        reserveExpressionForTurn() {}
        setAffect() {}
        setSpeaking() {}
        beginExpressionForTurn(turnId, affect) {
            expressions.push([turnId, context.ExpressionResolver.resolve(affect)]);
        }
        interrupt() { expressions.push(['interrupt', 'neutral']); }
        hardResetMouth() {}
        releaseMouth() {}
        finishExpressionForTurn() {}
    },
    SceneController: class {
        handleRuntimeEvent(event) {
            if (event.type === 'agent.begin') scene.active = event.turn_id;
        }
        isActiveTurn(turnId) { return scene.active === turnId; }
        renderResult() {}
        startResultPresentation(turnId) { scene.resultStarts.push(turnId); return true; }
        finishPresentation(turnId, options) { scene.resultFinishes.push([turnId, options]); }
        interrupt() { scene.active = null; }
    },
    DesktopLifecycleController: class {
        phase = 'ready';
        start() {}
    },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(rendererDir, 'character', 'expression_resolver.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8'), context);

const send = (type, turn_id, payload = {}, text = '') =>
    context.handleRuntimeEvent({ type, turn_id, payload, text });
const happy = { valence: .65, arousal: .7, intensity: .65, warmth: .85, restraint: .4 };
const serious = { valence: -.35, arousal: .35, intensity: .65 };

send('agent.begin', 'cancelled-before-speech');
send('task.cancel', 'cancelled-before-speech');
assert.equal(vm.runInContext("retiredTurnIds.has('cancelled-before-speech')", context), true,
    'an agent-only cancellation retires its turn');
send('assistant.reply', 'cancelled-before-speech', {}, 'Late reply');
send('tts.start', 'cancelled-before-speech', { source_text: 'Late reply' });
assert.equal(vm.runInContext('state.currentTurnId', context), null,
    'late audio and subtitles cannot revive cancelled work');

send('agent.begin', 'first');
send('assistant.affect', 'first', { affect: happy });
assert.equal(expressions.length, 0, 'affect waits for speech');
send('assistant.reply', 'first', {}, 'Hello');
send('tts.start', 'first', { source_text: 'Hello' });
assert.deepEqual(expressions.at(-1), ['first', 'happy'], 'early affect survives reply');
send('assistant.affect', 'first', { affect: serious });
assert.deepEqual(expressions.at(-1), ['first', 'serious'], 'late affect updates active speech');

send('interrupt', 'first');
send('agent.begin', 'second');
send('assistant.affect', 'first', { affect: happy });
send('assistant.reply', 'second', {}, 'Next');
send('tts.start', 'second', { source_text: 'Next' });
assert.deepEqual(expressions.at(-1), ['second', 'neutral'], 'old turn cannot change new expression');

send('interrupt', 'second');
send('agent.begin', 'third');
send('assistant.reply', 'third', { affect: serious }, 'Fallback');
send('tts.start', 'third', { source_text: 'Fallback' });
assert.deepEqual(expressions.at(-1), ['third', 'serious'], 'reply payload recovers missed early affect');

send('interrupt', 'third');
send('agent.begin', 'failed-before-audio');
send('assistant.reply', 'failed-before-audio', {}, 'Text answer survives');
send('agent.done', 'failed-before-audio', { has_reply: true });
send('tts.end', 'failed-before-audio', { status: 'error', segment_final: true });
assert.equal(scene.resultStarts.at(-1), 'failed-before-audio');
assert.equal(scene.resultFinishes.at(-1)[1].delay, 4000);
assert.equal(elements.get('subtitle-chinese').textContent, 'Text answer survives');
assert.equal(vm.runInContext("retiredTurnIds.has('failed-before-audio')", context), true);
const finishedCount = scene.resultFinishes.length;
send('tts.end', 'failed-before-audio', { status: 'error', segment_final: true });
assert.equal(scene.resultFinishes.length, finishedCount,
    'duplicate failure cannot restart the result timer');

send('agent.begin', 'failed-after-audio');
send('assistant.reply', 'failed-after-audio', {}, 'Partially spoken answer');
send('tts.start', 'failed-after-audio', { source_text: 'Partially spoken answer' });
send('tts.end', 'failed-after-audio', { status: 'error', segment_final: true });
assert.equal(scene.resultFinishes.at(-1)[0], 'failed-after-audio');
assert.equal(scene.resultFinishes.at(-1)[1].completed, true);

send('agent.begin', 'failed-first-part');
send('assistant.reply', 'failed-first-part', {}, 'More than one part');
send('tts.start', 'failed-first-part', { source_text: 'First part' });
send('tts.end', 'failed-first-part', { status: 'error', segment_final: false });
assert.equal(vm.runInContext('activeTtsTurnId', context), 'failed-first-part',
    'a nonfinal TTS error must leave later parts eligible to play');
assert.equal(vm.runInContext("retiredTurnIds.has('failed-first-part')", context), false);

send('interrupt', 'failed-first-part');
send('agent.begin', 'failed-before-first-part');
send('assistant.reply', 'failed-before-first-part', {}, 'Keep text for a later part');
send('tts.end', 'failed-before-first-part', { status: 'error', segment_final: false });
assert.equal(vm.runInContext("pendingSubtitles.has('failed-before-first-part')", context), true,
    'nonfinal failure before the first speaker frame must preserve the reply');
send('tts.start', 'failed-before-first-part', { segment_index: 2 });
assert.equal(elements.get('subtitle-chinese').textContent, 'Keep text for a later part');

send('tts.end', 'failed-before-first-part', { status: 'cancelled', segment_final: false });
assert.equal(vm.runInContext("retiredTurnIds.has('failed-before-first-part')", context), true,
    'cancellation still retires the turn');

send('agent.begin', 'stream-all-audio-failed');
send('assistant.reply', 'stream-all-audio-failed', {}, 'Text remains available');
send('agent.done', 'stream-all-audio-failed', { has_reply: true });
send('tts.end', 'stream-all-audio-failed', { status: 'error', segment_final: false });
const previousFinishCount = scene.resultFinishes.length;
send('tts.end', 'stream-all-audio-failed', {
    status: 'completed', reason: 'streamed_turn_complete', segment_final: true,
});
assert.equal(scene.resultFinishes.length, previousFinishCount + 1,
    'a streamed final marker must close an answer whose audio never started');
assert.equal(scene.resultStarts.at(-1), 'stream-all-audio-failed');
assert.equal(elements.get('subtitle-chinese').textContent, 'Text remains available');

send('agent.begin', 'next-after-failure');
send('assistant.reply', 'next-after-failure', {}, 'New answer');
send('tts.start', 'next-after-failure', { source_text: 'New answer' });
const nextFinishCount = scene.resultFinishes.length;
send('tts.end', 'stream-all-audio-failed', {
    status: 'completed', reason: 'streamed_turn_complete', segment_final: true,
});
assert.equal(scene.resultFinishes.length, nextFinishCount,
    'a late marker from the failed turn must not finish the new turn');
assert.equal(vm.runInContext('activeTtsTurnId', context), 'next-after-failure');
send('tts.end', 'next-after-failure', {
    status: 'completed', reason: 'streamed_turn_complete', segment_final: true,
});
assert.equal(scene.resultFinishes.at(-1)[0], 'next-after-failure');
assert.equal(vm.runInContext('activeTtsTurnId', context), null);

// After Kei finishes a line, it stays on screen instead of vanishing with her voice.
send('agent.begin', 'lingering');
send('assistant.reply', 'lingering', {}, 'Stay a while');
send('tts.start', 'lingering', { source_text: 'Stay a while' }, 'Stay a while');
send('tts.end', 'lingering', { status: 'completed', segment_final: true });
assert.equal(elements.get('subtitle-chinese').textContent, 'Stay a while',
    'the finished line lingers');

console.log('affect flow passed');
