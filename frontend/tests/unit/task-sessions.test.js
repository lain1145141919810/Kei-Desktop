"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TaskSessions } = require("../../src/main/task-sessions");
const { sanitizeTask } = require("../../src/main/executor-service");

function setup(recent = []) {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-sessions-"));
    const notices = [];
    const executors = {
        async list() { return { ok: true, executors: [{ id: "fx", name: "フィクスチャ", available: true }] }; },
        async recent() { return { ok: true, tasks: recent }; },
        async submit(executorId, input) { return { ok: true, task: { id: "t-new", executorId, status: "queued", input, createdAt: 1 } }; },
        async cancel() { return { ok: true }; },
        async answer() { return { ok: true }; },
    };
    const sessions = new TaskSessions({ executors, file: path.join(dir, "s.json"), audit() {}, publish() {}, notify: n => notices.push(n) });
    return { sessions, notices, dir };
}
const task = (id, status, extra = {}) => ({ id, executorId: "fx", status, createdAt: 1, inputRequest: null, result: null, error: null, ...extra });

test("each transition is announced once; resumed terminal tasks are not re-announced", async () => {
    const { sessions, notices } = setup([task("old", "succeeded", { result: { text: "done", artifacts: [] } })]);
    await sessions.resume();
    assert.equal(notices.length, 0, "a task that finished before startup is not announced");
    await sessions.submit("fx", "長いレポートをまとめて");
    sessions.observe("kei:tasks:update", task("t-new", "running"));
    sessions.observe("kei:tasks:update", task("t-new", "waiting_for_input", { inputRequest: { id: "q1", prompt: "どの章？" } }));
    sessions.observe("kei:tasks:update", task("t-new", "waiting_for_input", { inputRequest: { id: "q1", prompt: "どの章？" } }));
    sessions.observe("kei:tasks:update", task("t-new", "succeeded", { result: { text: "完了", artifacts: ["a.txt"] } }));
    sessions.observe("kei:tasks:update", task("t-new", "succeeded", { result: { text: "完了", artifacts: ["a.txt"] } }));
    assert.deepEqual(notices.map(n => n.kind), ["input", "succeeded"]);
    assert.equal(notices[0].title, "長いレポートをまとめて");
    assert.equal(sessions.snapshot().sessions.find(s => s.id === "t-new").result.artifacts, 1);
});

test("progress events update the summary; only finished tasks can be dismissed; titles persist", async () => {
    const { sessions, dir } = setup();
    await sessions.submit("fx", "データを整理");
    sessions.observe("kei:tasks:update", task("t-new", "running"));
    sessions.observe("kei:tasks:event", "t-new", { type: "task.progress", data: { stage: "読み込み", percent: 42.4, message: "3/7 ファイル" } });
    const live = sessions.snapshot().sessions[0];
    assert.equal(live.percent, 42);
    assert.equal(live.message, "3/7 ファイル");
    assert.equal(sessions.dismiss("t-new").ok, false, "running tasks stay listed");
    sessions.observe("kei:tasks:update", task("t-new", "failed", { error: { code: "adapter_exited", mayHaveSideEffects: true } }));
    assert.equal(sessions.snapshot().waiting, 0);
    assert.equal(sessions.dismiss("finished").ok, true);
    assert.equal(sessions.snapshot().sessions.length, 0);
    const again = new TaskSessions({ executors: { async list() { return { executors: [] }; }, async recent() { return { tasks: [task("t-new", "failed")] }; } },
        file: path.join(dir, "s.json"), audit() {}, publish() {}, notify() {} });
    await again.resume();
    assert.equal(again.snapshot().sessions.length, 0, "dismissal survives a restart");
    assert.equal(again.tasks.get("t-new").title, "データを整理", "title survives a restart");
});

test("confirmed cancellation follows the terminal host sequence and survives an older response", () => {
    const { sessions, notices } = setup();
    const local = { cancel: { accepted: true, confirmed: false } };
    const pending = sanitizeTask(task("t-new", "cancelling", { sequence: 4 }), local);
    const confirmed = sanitizeTask(task("t-new", "cancelled", { sequence: 5 }), local);
    sessions.observe("kei:tasks:update", pending);
    assert.deepEqual(sessions.snapshot().sessions[0].cancel, { accepted: true, confirmed: false });
    assert.deepEqual(notices, []);
    sessions.observe("kei:tasks:update", confirmed);
    sessions.observe("kei:tasks:update", pending);
    assert.equal(sessions.snapshot().sessions[0].status, "cancelled");
    assert.deepEqual(sessions.snapshot().sessions[0].cancel, { accepted: true, confirmed: true });
    assert.deepEqual(notices.map(notice => notice.kind), ["cancelled"]);
});
