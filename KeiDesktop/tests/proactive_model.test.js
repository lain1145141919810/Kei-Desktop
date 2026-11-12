const assert = require('node:assert/strict');
const { ProactiveModel, similarity } = require('../renderer/shell/proactive_model.js');
const MIN = 60000;
let now = 1_000_000_000_000;
const coding = 'VS Code で Python のテストが 3 件失敗している。ターミナルに AssertionError が表示されている。';
const video = 'ブラウザーで料理の動画を全画面で再生している。';
const seen = (description, age = 5000) => ({ enabled: true, description, lastSuccess: now - age });

assert.ok(similarity(coding, coding) === 1);
assert.ok(similarity(coding, coding.replace('3 件', '2 件')) > 0.6, 'a small change is the same scene');
assert.ok(similarity(coding, video) < 0.6, 'a different activity is a new scene');

const model = new ProactiveModel();
assert.equal(model.shouldAsk(seen(coding), { now, busy: false }), false, 'off by default');
model.setEnabled(true, now);
assert.equal(model.shouldAsk(seen(coding), { now, busy: false }), false, 'watches for a while before the first question');
now += 3 * MIN;
assert.equal(model.shouldAsk({ enabled: false, description: coding, lastSuccess: now }, { now, busy: false }), false, 'needs the observer');
assert.equal(model.shouldAsk(seen(''), { now, busy: false }), false, 'needs a real observation');
assert.equal(model.shouldAsk(seen(coding, 5 * MIN), { now, busy: false }), false, 'a stale observation is not used');
assert.equal(model.shouldAsk(seen(coding), { now, busy: true }), false, 'never while Kei is speaking or thinking');
model.noteTalk(now - 30000);
assert.equal(model.shouldAsk(seen(coding), { now, busy: false }), false, 'never right after a conversation');
now += 2 * MIN;
assert.equal(model.shouldAsk(seen(coding), { now, busy: false }), true);
model.asked(coding, now);

now += 11 * MIN;
assert.equal(model.shouldAsk(seen(coding.replace('3 件', '2 件')), { now, busy: false }), false, 'the same scene is not asked about twice');
assert.equal(model.shouldAsk(seen(video), { now: now - 6 * MIN, busy: false }), false, 'at most one question per ten minutes');
assert.equal(model.shouldAsk(seen(video), { now, busy: false }), true, 'a new scene after the interval is asked about');

model.setEnabled(false, now);
assert.equal(model.shouldAsk(seen(video), { now, busy: false }), false);
console.log('proactive model passed');
