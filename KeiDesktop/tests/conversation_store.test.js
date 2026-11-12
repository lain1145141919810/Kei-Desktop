const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createStore = require('../conversation-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kei-history-'));
let clock = Date.UTC(2026, 10, 11, 12, 0, 0);
const open = () => createStore({ dir, now: () => clock });
try {
    let store = open();
    assert.equal(store.current(), null, 'a new log has no current conversation');
    assert.throws(() => store.record({ id: 'x', role: 'narrator', text: 'hi' }), /Invalid/);
    assert.throws(() => store.record({ id: 'x', role: 'user', text: '  ' }), /Empty/);

    const question = store.record({ id: 'u:t1', role: 'user', source: 'text', turn: 't1', text: '东京的天气怎么样？' });
    clock += 5000;
    store.record({ id: 'k:t1', role: 'kei', turn: 't1', text: '今天晴。' });
    clock += 1000;
    // A translation arriving later updates the same entry instead of adding one.
    const updated = store.record({ id: 'k:t1', role: 'kei', turn: 't1', text: '今天晴。', ja: '今日は晴れです。' });
    assert.equal(updated.conv, question.conv);
    assert.equal(updated.ts, question.ts + 5000, 'an update keeps the original time');
    assert.equal(store.current().entries.length, 2);

    // Restart inside the idle gap: the same conversation continues.
    clock += 60 * 1000;
    store = open();
    assert.equal(store.current().id, question.conv, 'history survives a restart');
    assert.equal(store.current().entries[1].ja, '今日は晴れです。');
    store.record({ id: 'u:t2', role: 'user', source: 'voice', text: '谢谢' });
    assert.equal(store.list().length, 1);

    // A long silence starts a new conversation; the old one stays readable.
    clock += 31 * 60 * 1000;
    assert.equal(store.current().id, question.conv, 'elapsed time preserves the selected conversation');
    store.select(null);
    const next = store.record({ id: 'u:t3', role: 'user', source: 'text', text: 'Pomodoro 是什么？' });
    assert.notEqual(next.conv, question.conv);
    const listed = store.list();
    assert.deepEqual(listed.map(item => item.id), [next.conv, question.conv], 'newest first');
    assert.equal(listed[0].current, true);
    assert.equal(listed[1].title, '东京的天气怎么样？');
    assert.equal(listed[1].count, 3);

    // Search covers Chinese and Japanese text, case-insensitively.
    assert.deepEqual(store.list({ query: 'pomodoro' }).map(item => item.id), [next.conv]);
    const japanese = store.list({ query: '晴れ' });
    assert.equal(japanese.length, 1);
    assert.match(japanese[0].snippet, /晴れ/);
    assert.equal(store.list({ query: '不存在的词' }).length, 0);

    // A torn line from a crash must not hide the rest of the log.
    fs.appendFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.jsonl'))), '{"conv":"broken', 'utf8');
    store = open();
    assert.equal(store.list().length, 2);
    assert.equal(store.read(question.conv).entries.length, 3);

    assert.equal(store.remove(question.conv), true);
    assert.equal(store.read(question.conv), null);
    assert.equal(open().list().length, 1, 'a deleted conversation is gone from disk');
    assert.equal(store.remove('missing'), false);
    store.clear();
    assert.equal(open().list().length, 0);
    assert.deepEqual(fs.readdirSync(dir), [], 'clearing removes the log files');
    console.log('conversation store passed');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
