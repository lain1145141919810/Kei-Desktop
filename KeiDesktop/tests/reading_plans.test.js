const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createPlans = require('../reading-plans');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kei-plans-'));
const file = path.join(dir, 'reading-plans.json');
let clock = new Date(2026, 10, 11, 20, 0, 0).getTime();
const open = () => createPlans({ file, now: () => clock });
const DAY = 86400000;
try {
    let plans = open();
    assert.deepEqual(plans.list(), []);
    assert.throws(() => plans.create({ title: ' ', totalPages: 10, pagesPerDay: 1 }), /名前/);
    assert.throws(() => plans.create({ title: 'x', totalPages: 0, pagesPerDay: 1 }), /総ページ数/);
    assert.throws(() => plans.create({ title: 'x', totalPages: 10, pagesPerDay: 11 }), /1 日のページ数/);

    const plan = plans.create({ title: '  Attention Is All You Need.pdf ', totalPages: 100, pagesPerDay: 20 });
    assert.equal(plan.title, 'Attention Is All You Need.pdf');
    assert.deepEqual([plan.schedule.todayFrom, plan.schedule.todayTo, plan.schedule.finishDay], [1, 20, '2026-11-15'],
        '100 pages at 20 a day from today ends on the fifth day');

    // Partway through today's goal.
    let state = plans.progress(plan.id, 12);
    assert.deepEqual([state.schedule.readToday, state.schedule.todayFrom, state.schedule.todayTo, state.schedule.todayDone], [12, 13, 20, false]);
    // Reading ahead completes today without moving the goalposts.
    state = plans.progress(plan.id, 25);
    assert.deepEqual([state.schedule.readToday, state.schedule.todayDone, state.schedule.percent], [25, true, 25]);
    assert.equal(state.schedule.finishDay, '2026-11-15', '75 pages left at 20 a day: four more days');
    // A correction backwards is not counted as reading.
    state = plans.progress(plan.id, 18);
    assert.equal(state.schedule.readToday, 18);
    assert.throws(() => plans.progress(plan.id, 101), /0〜100/);
    assert.throws(() => plans.progress('missing', 1), /見つかりません/);

    state = plans.note(plan.id, { question: 'この式の意味は？', excerpt: 'Attention(Q, K, V) = softmax(...)' });
    assert.deepEqual([state.notes[0].page, state.notes[0].question], [18, 'この式の意味は？']);

    // The next day: a new goal from where the reader stopped; everything survives a restart.
    clock += DAY;
    plans = open();
    state = plans.list()[0];
    assert.deepEqual([state.currentPage, state.schedule.readToday, state.schedule.todayFrom, state.schedule.todayTo], [18, 0, 19, 38]);
    assert.equal(state.notes.length, 1, 'the plan and its notes can be revisited');

    // More than one plan, most recently used first.
    const second = plans.create({ title: '線形代数入門', totalPages: 30, pagesPerDay: 30 });
    assert.deepEqual(plans.list().map(item => item.title), ['線形代数入門', 'Attention Is All You Need.pdf']);
    state = plans.progress(second.id, 30);
    assert.deepEqual([state.schedule.done, state.schedule.finishDay, state.schedule.percent], [true, null, 100]);
    plans.remove(second.id);
    assert.equal(open().list().length, 1);

    // A damaged file is set aside instead of being silently overwritten.
    fs.writeFileSync(file, '{not json', 'utf8');
    assert.deepEqual(open().list(), []);
    assert.ok(fs.existsSync(`${file}.damaged`));
    console.log('reading plans passed');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
