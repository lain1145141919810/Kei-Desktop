"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CaptureService, chooseSource } = require("../../src/main/capture-service");

const candidates = Array.from({ length: 21 }, (_, index) => ({
    id: "window:" + (index + 1) + ":0", name: "Test source " + (index + 1), kind: "window",
}));
const ORIGIN = { type: "shortcut" };
const IMAGE = { mime: "image/png", base64: "fixture-data" };
function defer() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function until(condition) {
    const end = Date.now() + 1600;
    while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(condition());
}

function setup(overrides = {}) {
    const calls = [];
    const sourcesOpened = [];
    const streamClosed = [];
    const audit = [];
    let conversation = "isolated-first";
    const host = { async request(method, route, body) {
        calls.push({ method, route, body });
        if (method === "GET") return { enabled: true, effectiveGrants: ["observation.read", "observation.control", "vision.describe"] };
        if (route === "/v1/pages/open") return { sessionId: "test-session" };
        return { result: { generation: 9, intervalSeconds: 4 } };
    } };
    const service = new CaptureService(host, {
        audit: (name, record) => audit.push({ name, record }), broadcast: () => {}, parentWindow: () => null,
        conversation: () => conversation,
        enumerate: async () => candidates.slice(),
        choose: async list => list[15],
        openStream(source) {
            sourcesOpened.push(source.id);
            return { ready: Promise.resolve(), frame: async () => IMAGE,
                close: () => streamClosed.push(source.id) };
        }, ...overrides,
    });
    return { service, calls, sourcesOpened, streamClosed, audit, setConversation: value => { conversation = value; } };
}

test("the native chooser can reach every page and return a candidate after index eight", async () => {
    const visited = [];
    const select = await chooseSource(candidates, null, new AbortController().signal, async (_parent, options) => {
        visited.push(options.message);
        if (visited.length <= 2) return { response: options.buttons.indexOf("次へ") };
        if (visited.length === 3) return { response: options.buttons.indexOf("前へ") };
        return { response: options.buttons.findIndex(button => button.endsWith("Test source 15")) };
    });
    assert.deepEqual(select, candidates[14]);
    assert.deepEqual(visited.map(message => message.slice(-4)), ["1/3）", "2/3）", "3/3）", "2/3）"]);
});

test("only the selected ID gets a stream, capture context and pixels", async () => {
    const { service, calls, sourcesOpened, streamClosed } = setup();
    assert.equal((await service.start(ORIGIN)).ok, true);
    await until(() => service.status().captures === 1);
    await service.stop("user");
    assert.deepEqual(sourcesOpened, [candidates[15].id]);
    assert.deepEqual(streamClosed, sourcesOpened);
    const sent = calls.filter(item => item.body?.action === "capture");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.arguments.sourceId, candidates[15].id);
    assert.deepEqual(sent[0].body.context, {
        conversationId: "isolated-first", capture: { authorized: true, sourceId: candidates[15].id, kind: "window" },
    });
});

test("disable or page close during native selection invalidates a late choice before opening a stream", async () => {
    for (const revoke of [
        service => service.onLifecycle({ pluginId: "kei.observation", type: "plugin.disabled" }),
        service => service.onFrameClosed({ tag: "owned-page" }),
        service => service.onConversationChanged(),
    ]) {
        const choice = defer();
        let signal;
        const { service, calls, sourcesOpened } = setup({
            choose: (_sources, _window, abort) => { signal = abort; return choice.promise; },
        });
        const started = service.start({ type: "page", tag: "owned-page" });
        await until(() => Boolean(signal));
        revoke(service);
        assert.equal(signal.aborted, true);
        assert.equal(service.status().starting, false);
        choice.resolve(candidates[15]);
        assert.equal((await started).error.code, "capture_cancelled");
        assert.deepEqual(sourcesOpened, []);
        assert.equal(calls.filter(item => item.route === "/v1/pages/open").length, 0);
    }
});

test("a replaced request remains stale even if its old chooser returns after the new one", async () => {
    const old = defer();
    let requests = 0;
    const { service, sourcesOpened } = setup({
        choose: async () => ++requests === 1 ? old.promise : candidates[17],
    });
    const first = service.start(ORIGIN);
    await until(() => requests === 1);
    const second = await service.start(ORIGIN);
    assert.equal(second.ok, true);
    old.resolve(candidates[0]);
    assert.equal((await first).error.code, "capture_cancelled");
    assert.deepEqual(sourcesOpened, [candidates[17].id]);
    await service.stop("user");
});

test("source disappearance reports failure and never selects a display fallback", async () => {
    const closed = [];
    const { service, calls } = setup({
        openStream(source) {
            return { ready: Promise.resolve(), frame: async () => null, close: () => closed.push(source.id) };
        },
    });
    assert.equal((await service.start(ORIGIN)).ok, true);
    await until(() => service.status().lastStop?.reason === "source_unavailable");
    assert.deepEqual(closed, [candidates[15].id]);
    assert.equal(calls.some(item => item.body?.action === "capture"), false);
});

test("revocation during stream startup closes it and holds off host configuration", async () => {
    const ready = defer();
    let started = false;
    let closed = 0;
    const { service, calls } = setup({
        openStream() {
            started = true;
            return { ready: ready.promise, frame: async () => IMAGE, close: () => { closed++; } };
        },
    });
    const opening = service.start(ORIGIN);
    await until(() => started);
    await service.stop("plugin.disabled");
    assert.equal(closed, 1);
    ready.resolve();
    assert.equal((await opening).error.code, "capture_cancelled");
    assert.equal(calls.some(item => item.route === "/v1/pages/open"), false);
});

test("switching conversations drops an outstanding frame and closes the track immediately", async () => {
    const frame = defer();
    let grabbing = false;
    let closed = false;
    const { service, calls, setConversation } = setup({
        openStream() {
            return { ready: Promise.resolve(), frame: () => { grabbing = true; return frame.promise; },
                close: () => { closed = true; } };
        },
    });
    await service.start(ORIGIN);
    await until(() => grabbing);
    setConversation("isolated-second");
    const stopped = service.onConversationChanged();
    assert.equal(closed, true);
    frame.resolve(IMAGE);
    await stopped;
    assert.equal(calls.some(item => item.body?.action === "capture"), false);
});
