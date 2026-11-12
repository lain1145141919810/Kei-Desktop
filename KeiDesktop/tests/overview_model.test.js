const assert = require('node:assert/strict');
const { build, dateLine, clock } = require('../renderer/shell/overview_model.js');

assert.equal(dateLine(new Date(2026, 10, 12, 9, 0).getTime()), '11月12日（木）');
assert.equal(clock(18 * 60000 + 20000), '18:20');
assert.equal(clock(-5), '00:00');
const value = (overview, id) => overview.rows.find(row => row.id === id)?.value;
const MIN = 60000;

// Nothing set up yet: still an honest, short overview.
let overview = build({
    focus: { phase: 'focus', running: false, remaining: 25 * MIN, total: 25 * MIN, completed: 0, task: '', openTasks: 0 },
    reading: null, watch: { observing: false, proactive: true }, last: null, connected: true,
});
assert.equal(overview.title, '待機中');
assert.deepEqual(overview.rows.map(row => row.id), ['timer', 'task', 'watch'], 'rows without content are left out');
assert.equal(value(overview, 'timer'), '止まっています · 今日 0 回');
assert.equal(value(overview, 'task'), 'まだありません');
assert.equal(value(overview, 'watch'), '画面観察はオフ', 'proactive speech is not claimed while observation is off');

// A working afternoon.
overview = build({
    focus: { phase: 'focus', running: true, remaining: 18 * MIN + 20000, total: 25 * MIN, completed: 2, task: 'レポートの構成を決める', openTasks: 3 },
    reading: { title: 'Attention Is All You Need.pdf', done: false, todayDone: false, todayFrom: 13, todayTo: 20, readToday: 0 },
    watch: { observing: true, proactive: true },
    last: { text: '先生、調べました。関連する論文が 3 本見つかりました。', steps: [
        { label: '資料検索', status: 'completed', count: 3 }, { label: '資料を読む', status: 'failed' }] },
    connected: true,
});
assert.equal(value(overview, 'timer'), '集中中 · 残り 18:20 · 今日 2 回');
assert.equal(value(overview, 'task'), 'いま：レポートの構成を決める（ほか 2 件）');
assert.equal(value(overview, 'reading'), 'Attention Is All You Nee… · 今日は 13〜20 ページ');
assert.equal(value(overview, 'watch'), '画面観察中 · 気づいたら声をかけます');
assert.equal(value(overview, 'last'), '先生、調べました。関連する論文が 3 本見つかりました。（資料検索 3 件）', 'only finished steps are credited');
assert.deepEqual(overview.rows.map(row => row.action), ['focus', 'focus', 'reading', 'quick', 'backlog'], 'each row opens its own place');

// Paused mid-break, tasks but none chosen, reading goal met, interrupted answer, runtime away.
overview = build({
    focus: { phase: 'break', running: false, remaining: 3 * MIN, total: 5 * MIN, completed: 1, task: '', openTasks: 2 },
    reading: { title: '線形代数入門', done: false, todayDone: true, todayFrom: 21, todayTo: 20, readToday: 12 },
    watch: { observing: true, proactive: false },
    last: { text: 'x'.repeat(80), steps: [], interrupted: true },
    connected: false,
});
assert.equal(overview.title, '接続を待っています');
assert.equal(value(overview, 'timer'), '一時停止中（休憩 · 残り 03:00） · 今日 1 回');
assert.equal(value(overview, 'task'), '2 件あります。取り組むものを選べます');
assert.equal(value(overview, 'reading'), '線形代数入門 · 今日の分は達成（12 ページ）');
assert.equal(value(overview, 'watch'), '画面観察中');
assert.equal(overview.rows.at(-1).label, 'さっき（中断）');
assert.equal(value(overview, 'last'), `${'x'.repeat(46)}…`, 'a long answer is shortened');
assert.equal(value(build({ reading: { title: 'T', done: true } }), 'reading'), 'T · 読み終わりました');
console.log('overview model passed');
