const assert = require('node:assert/strict');
const { PomodoroModel } = require('../renderer/shell/pomodoro_model.js');
const MIN = 60000;
let now = new Date(2026, 10, 11, 9, 0, 0).getTime();

const timer = new PomodoroModel();
assert.equal(timer.remainingAt(now), 25 * MIN);
assert.equal(timer.tick(now), null, 'an idle timer never fires');
timer.start(now);
now += 10 * MIN;
assert.equal(timer.remainingAt(now), 15 * MIN);
timer.pause(now);
now += 60 * MIN;
assert.equal(timer.remainingAt(now), 15 * MIN, 'a paused timer does not run down');
timer.start(now);
now += 15 * MIN;
assert.equal(timer.tick(now), 'focus-done');
assert.equal(timer.phase, 'break');
assert.equal(timer.completed, 1);
assert.equal(timer.running, true, 'the break starts by itself');
now += 5 * MIN;
assert.equal(timer.tick(now), 'break-done');
assert.equal(timer.phase, 'focus');

// The fourth focus block of the day earns the long break.
for (let i = 0; i < 3; i++) {
    now += 25 * MIN; assert.equal(timer.tick(now), 'focus-done');
    if (i < 2) { now += 5 * MIN; assert.equal(timer.tick(now), 'break-done'); }
}
assert.equal(timer.completed, 4);
assert.equal(timer.phase, 'long-break');
assert.equal(timer.remainingAt(now), 15 * MIN);

// Skipping a focus block does not count it.
timer.skip(now);
assert.equal(timer.phase, 'focus');
timer.skip(now);
assert.equal(timer.phase, 'break');
assert.equal(timer.completed, 4);
assert.equal(timer.running, true, 'skip keeps a running timer running');

// Restart: a running timer picks up where the clock says it should be.
timer.reset();
timer.start(now);
const restored = new PomodoroModel(JSON.parse(JSON.stringify(timer)));
now += 5 * MIN;
assert.equal(restored.remainingAt(now), 20 * MIN);
// Closed (or asleep) through the end: advance quietly and wait for the user.
now += 3 * 60 * MIN;
assert.equal(restored.tick(now), null, 'no announcement hours late');
assert.equal(restored.phase, 'break');
assert.equal(restored.running, false);

// A new day starts the count again.
now += 24 * 60 * MIN;
restored.reset(); restored.start(now);
assert.equal(restored.completed, 0);

restored.setPreset('50');
assert.equal(restored.running, false);
assert.equal(restored.remainingAt(now), 50 * MIN);
restored.setPreset('nonsense');
assert.equal(restored.preset, '50');
assert.equal(new PomodoroModel({ preset: 'x', phase: 'y', remaining: -5, completed: 'many' }).remainingAt(now), 25 * MIN,
    'damaged saved state falls back to defaults');
console.log('pomodoro model passed');
