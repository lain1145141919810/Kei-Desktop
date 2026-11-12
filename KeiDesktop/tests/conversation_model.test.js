const assert = require('node:assert/strict');
const { ConversationModel } = require('../renderer/conversation/conversation_model.js');

const saved = [];
const pending = [];
const model = new ConversationModel({ persist: entry => saved.push(entry), onPending: turn => pending.push(turn), now: () => 1000 });
const send = (type, turn_id, payload = {}, text = '', session_id = 'desktop') =>
    model.handle({ type, turn_id, payload, text, session_id });
const last = () => saved.at(-1);

// The recorded login line is lifecycle audio, not conversation.
send('assistant.reply', 'login', {}, 'NAVI……ログインしました', 'desktop-lifecycle');
send('tts.start', 'login', {}, 'NAVI……ログインしました', 'desktop-lifecycle');
assert.equal(saved.length, 0);

// Voice turn.
send('user.transcript', 'v1', {}, '今天有什么安排？');
assert.deepEqual(last(), { id: 'u:v1', role: 'user', source: 'voice', turn: 'v1', text: '今天有什么安排？' });
send('assistant.translation', 'v1', { segment_index: 2 }, '二つ目。');
assert.equal(last().ja, '二つ目。', 'a translation can arrive before the reply');
send('assistant.reply', 'v1', { result_summary: '• 摘要' }, '第一句。第二句。');
send('assistant.translation', 'v1', { segment_index: 1 }, '一つ目。');
assert.equal(last().id, 'k:v1');
assert.equal(last().text, '第一句。第二句。');
assert.equal(last().ja, '一つ目。二つ目。', 'segments are joined in spoken order');
assert.equal(last().summary, '• 摘要');
send('tts.end', 'v1', { status: 'completed', segment_final: true });
const count = saved.length;
send('interrupt', 'v1');
assert.equal(saved.length, count, 'a late interrupt cannot mark a finished answer');

// Typed turn: shown immediately, and an echo from the runtime is not doubled.
model.addLocalUser('t1', '帮我搜索一下');
assert.equal(last().id, 'u:t1');
assert.equal(pending.at(-1), 't1', 'typing starts the waiting indicator');
const afterLocal = saved.length;
send('user.message', 't1', {}, '帮我搜索一下');
assert.equal(saved.length, afterLocal);
send('assistant.reply', 't1', {}, '好的，老师。');
assert.equal(pending.at(-1), null, 'a reply clears the waiting indicator');
send('interrupt', 't1');
assert.equal(last().status, 'interrupted', 'barge-in is recorded on the unfinished answer');

// A message published by another desktop surface (PDF companion) is recorded.
send('user.message', 'r1', {}, '用户问题：解释这段');
assert.equal(last().id, 'u:r1');
assert.equal(last().source, 'text');

// tts_text is the fallback when the reply event carries no text.
send('assistant.reply', 'p1', { tts_text: '只有语音文本' });
assert.equal(last().text, '只有语音文本');

// Empty and malformed events are ignored.
const before = saved.length;
send('user.transcript', 'e1', {}, '   ');
send('assistant.reply', null, {}, 'no turn');
model.handle(null);
model.handle({ type: 'assistant.reply', turn_id: 'x' });
assert.equal(saved.length, before);

model.addLocalUser('t2', '还在吗');
model.disconnected();
assert.equal(pending.at(-1), null, 'a dropped connection clears the waiting indicator');
// Task steps: labelled by the injected describer, written onto Kei's entry.
const labelled = new ConversationModel({
    persist: entry => saved.push(entry),
    describeStep: payload => (payload.tool_name === 'hidden_tool' ? null : `label:${payload.tool_name}`),
});
const step = (type, turn, payload) => labelled.handle({ type, turn_id: turn, payload, session_id: 'desktop' });
const mark = saved.length;
step('agent.tool.start', 's1', { tool_name: 'search' });
step('agent.tool.end', 's1', { tool_name: 'search', status: 'completed', result_count: 3 });
step('agent.tool.start', 's1', { tool_name: 'hidden_tool' });
step('agent.tool.start', 's1', { tool_name: 'shell' });
assert.equal(saved.length, mark, 'steps wait for an entry with words');
labelled.handle({ type: 'assistant.reply', turn_id: 's1', text: '結果です。', payload: {}, session_id: 'desktop' });
assert.deepEqual(last().steps, [
    { label: 'label:search', status: 'completed', count: 3 },
    { label: 'label:shell', status: 'running' },
]);
step('agent.tool.end', 's1', { tool_name: 'shell', status: 'failed' });
assert.equal(last().steps[1].status, 'failed', 'a failed step is recorded as failed');
step('agent.tool.start', 's1', { tool_name: 'read' });
step('task.cancel', 's1', {});
assert.equal(last().steps[2].status, 'cancelled', 'cancelling the task closes its running step');
assert.equal(last().status, 'interrupted');
labelled.handle({ type: 'assistant.reply', turn_id: 's2', text: '作業中。', payload: {}, session_id: 'desktop' });
step('agent.tool.start', 's2', { tool_name: 'search' });
labelled.disconnected();
assert.equal(last().steps[0].status, 'cancelled', 'a lost connection closes running steps');

// Dropped files are named on the user's entry.
labelled.addLocalUser('f1', '読んで', ['sample.txt']);
assert.deepEqual(last().files, ['sample.txt']);
console.log('conversation model passed');
