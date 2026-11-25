"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { FocusService } = require("../../src/main/focus-service");

function fakeHost({ notices = [] } = {}) {
    const calls = [];
    let claimed = new Set();
    let session = 0;
    let open = null;
    const host = {
        calls,
        closeSession() { open = null; },
        async request(method, route, body) {
            calls.push([method, route, body?.action ?? null]);
            if (route === "/v1/entries") return [{ pluginId: "kei.focus", id: "timer" }];
            if (route === "/v1/pages/open") { open = "s" + (++session); return { sessionId: open }; }
            if (route === "/v1/pages/close") return { closed: true };
            if (route === "/v1/pages/call") {
                if (body.sessionId !== open) { const e = new Error("closed"); e.code = "page_closed"; throw e; }
                if (body.action === "claim") {
                    if (claimed.has(body.arguments.id)) return { result: { claimed: null } };
                    claimed.add(body.arguments.id);
                    return { result: { claimed: { id: body.arguments.id, phase: "focus" } } };
                }
                const waiting = notices.filter(n => !claimed.has(n.id));
                return { result: { status: "running", phase: "focus", preset: "25", remaining: 60000, completed: 1, notices: waiting } };
            }
            throw new Error("unexpected " + route);
        },
    };
    return host;
}

test("focus service claims each notice once and publishes a snapshot", async () => {
    const host = fakeHost({ notices: [{ id: "n1" }] });
    const notified = [], published = [];
    const service = new FocusService({ host, audit() {}, notify: n => notified.push(n), publish: s => published.push(s) });
    service.start();
    assert.equal((await service.control("start")).ok, true);
    assert.equal((await service.control("pause")).ok, true);
    assert.equal(notified.length, 1, "native notification only after a successful claim");
    assert.equal(notified[0].phase, "focus");
    assert.equal(service.status().status, "running");
    assert.ok(published.length >= 1);
    service.stop();
});

test("focus service only forwards the timer's own controls", async () => {
    const service = new FocusService({ host: fakeHost(), audit() {}, notify() {}, publish() {} });
    service.start();
    assert.equal((await service.control("legacy.import")).error.code, "invalid_request");
    assert.equal((await service.control("claim")).error.code, "invalid_request");
    assert.equal((await service.control("preset", { preset: "99" })).error.code, "invalid_request");
    assert.equal((await service.control("preset", { preset: "50" })).ok, true);
    service.stop();
});

test("focus service reopens a closed session once", async () => {
    const host = fakeHost();
    const service = new FocusService({ host, audit() {}, notify() {}, publish() {} });
    service.start();
    await service.control("start");
    host.closeSession();
    assert.equal((await service.control("pause")).ok, true);
    assert.equal(host.calls.filter(c => c[1] === "/v1/pages/open").length, 2);
    service.stop();
});
