const assert = require('node:assert/strict');
const { TasksModel } = require('../renderer/shell/tasks_model.js');

let clock = 1000;
const tasks = new TasksModel(null, () => clock++);
assert.equal(tasks.add('   '), null, 'blank text adds nothing');
const report = tasks.add('  レポートの  構成を決める ');
assert.equal(report.text, 'レポートの 構成を決める');
assert.equal(tasks.focused.id, report.id, 'the first task becomes the focus');
const mail = tasks.add('メールに返信');
assert.equal(tasks.focused.id, report.id, 'adding more does not steal the focus');

// A finished focus block is credited to the task in focus.
assert.equal(tasks.creditBlock().id, report.id);
tasks.creditBlock();
assert.equal(report.blocks, 2);

// Finishing the focused task moves on to the next open one.
tasks.toggle(report.id);
assert.equal(tasks.focused.id, mail.id);
assert.deepEqual(tasks.list().map(task => task.text), ['メールに返信', 'レポートの 構成を決める'], 'open first, done last');
tasks.focus(report.id);
assert.equal(tasks.focused, null, 'a finished task cannot be the focus');
tasks.toggle(report.id);
assert.equal(report.done, false, 'a task can be reopened');

tasks.markDelegated(mail.id);
// Restart.
const restored = new TasksModel(JSON.parse(JSON.stringify(tasks)));
assert.equal(restored.tasks.length, 2);
assert.equal(restored.find(mail.id).delegated, true);
assert.equal(restored.find(report.id).blocks, 2);

restored.toggle(mail.id);
restored.clearDone();
assert.deepEqual(restored.tasks.map(task => task.id), [report.id]);
restored.remove(report.id);
assert.equal(restored.focused, null);
assert.equal(restored.creditBlock(), null, 'a block with no task in focus is simply not credited');

assert.equal(new TasksModel({ tasks: [{ id: 5 }, null, { id: 'ok', text: 'x', blocks: -3 }], focusId: 'gone' }).tasks[0].blocks, 0,
    'damaged saved data is cleaned, not trusted');
console.log('tasks model passed');
