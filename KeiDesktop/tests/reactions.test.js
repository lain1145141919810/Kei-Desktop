const assert = require('node:assert/strict');
const { createReactions } = require('../renderer/character/reactions.js');

const shown = [];
const timers = [];
let speaking = false;
const reactions = createReactions({
    isSpeaking: () => speaking,
    setTimer: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cancelled = true; },
});
const flush = () => { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.callback(); };
const send = (type, turn_id, payload = {}, session_id = 'desktop') => reactions.handleRuntimeEvent({ type, turn_id, payload, session_id });

assert.equal(reactions.play('heard'), false, 'nothing happens before a character is attached');
reactions.attach({ setExpression: name => { shown.push(name); return true; } });

// One typed question that needs a search, fails once, then is interrupted.
send('user.message', 't1');
assert.equal(shown.at(-1), 'small_smile');
send('agent.begin', 't1');
assert.equal(shown.at(-1), 'thoughtful');
send('agent.tool.start', 't1', { tool_name: 'desktop_web_search' });
assert.equal(shown.at(-1), 'serious');
send('agent.tool.end', 't1', { status: 'failed' });
assert.equal(shown.at(-1), 'flustered');
send('agent.tool.end', 't1', { status: 'completed' });
assert.equal(shown.at(-1), 'thoughtful');
timers.length = 0;
send('interrupt', 't1');
flush();
assert.equal(shown.at(-1), 'surprised');
flush();
assert.equal(shown.at(-1), 'neutral', 'a reaction settles back to neutral');

// Speech owns the face.
const before = shown.length;
send('interrupt', 'never-started');
flush();
assert.equal(shown.length, before, 'an interrupt for an unknown turn is ignored');
send('agent.begin', 't2');
speaking = true;
send('tts.start', 't2');
flush();
assert.equal(shown.at(-1), 'thoughtful', 'the pending reset is dropped when speech starts');
assert.equal(reactions.play('focus-done'), false, 'no reaction while Kei is speaking');
speaking = false;

// The login announcement is not a conversation event.
const quiet = shown.length;
send('agent.begin', 'login', {}, 'desktop-lifecycle');
assert.equal(shown.length, quiet);

// Connection: the first state is not news; later changes are.
reactions.setConnected(true); flush();
assert.equal(shown.length, quiet);
reactions.setConnected(false); flush();
assert.equal(shown.at(-1), 'sad');
reactions.setConnected(true); flush();
assert.equal(shown.at(-1), 'happy');

assert.equal(reactions.play('focus-done'), true);
assert.equal(shown.at(-1), 'gentle');
assert.equal(reactions.play('no-such-reaction'), false);
assert.equal(new Set(['heard', 'thinking', 'working', 'tool-failed', 'interrupted', 'disconnected', 'reconnected', 'file-received', 'focus-done', 'break-done'].map(name => {
    reactions.play(name); return shown.at(-1);
})).size, 9, 'nine distinct expressions are reachable');
console.log('reactions passed');
