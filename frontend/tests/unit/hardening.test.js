"use strict";
// Round 08 decision 4: release hardening of the trusted shell.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseFrameUrl, validateEntryMetadata, isTrustedPageUrl, isAllowedFilePath } = require("../../src/main/page-protocol");
const { HostClient, checkHostOrigin } = require("../../src/main/host-client");
const { PageBroker } = require("../../src/main/page-broker");

const TAG = "0123456789abcdef0123456789abcdef";

test("frame URLs must be exactly kei-page://frame/<32 hex>", () => {
    assert.equal(parseFrameUrl(`kei-page://frame/${TAG}`), TAG);
    for (const bad of [`kei-page://frame/${TAG}?x=1`, `kei-page://frame/${TAG}#h`, `kei-page://frame/${TAG}/x`,
        `kei-page://other/${TAG}`, `kei-page://u:p@frame/${TAG}`, `kei-page://frame:1/${TAG}`, "kei-page://frame/ABC", `http://frame/${TAG}`]) {
        assert.equal(parseFrameUrl(bad), null, bad);
    }
});

test("entry metadata: well-formed passes; malformed action metadata is rejected", () => {
    const good = { pluginId: "studio.counter", id: "desktop-counter", slot: "extensions", title: "カウンター", actions: ["current", "increment"], order: 20, icon: null };
    assert.deepEqual(validateEntryMetadata(good), good);
    const bad = [
        { actions: "current" }, { actions: [1] }, { actions: ["Bad Action"] }, { actions: ["current", "current"] },
        { actions: Array.from({ length: 65 }, (_, i) => `a${i}`) }, { slot: "everywhere" }, { pluginId: "../x" },
        { id: "" }, { title: "" }, { order: 1.5 }, { icon: "toolong" },
    ];
    for (const change of bad) assert.equal(validateEntryMetadata({ ...good, ...change }), null, JSON.stringify(change));
    assert.equal(validateEntryMetadata(null), null);
});

test("trusted page URL must match exactly (hash allowed, query and other files not)", () => {
    const admin = "file:///opt/kei/src/renderer/admin/admin.html";
    assert.equal(isTrustedPageUrl(admin, admin), true);
    assert.equal(isTrustedPageUrl(admin + "#mcp", admin), true);
    for (const bad of [admin + "?x=1", "file:///opt/kei/src/renderer/admin/admin.html.evil", "file:///opt/kei/src/renderer/admin/../desktop/index.html",
        "file://remote/opt/kei/src/renderer/admin/admin.html", "kei-page://frame/" + TAG, "https://example.com/admin.html"]) {
        assert.equal(isTrustedPageUrl(bad, admin), false, bad);
    }
});

test("file: allow-list is a directory containment check, not a string prefix", () => {
    const roots = ["/opt/kei/src/renderer", "/opt/kei/assets"];
    assert.equal(isAllowedFilePath("/opt/kei/src/renderer/desktop/index.html", roots, "/"), true);
    assert.equal(isAllowedFilePath("/opt/kei/assets/kei-logo.png", roots, "/"), true);
    assert.equal(isAllowedFilePath("/opt/kei/src/renderer-evil/x.js", roots, "/"), false);
    assert.equal(isAllowedFilePath("/opt/kei/src/main/main.js", roots, "/"), false);
    assert.equal(isAllowedFilePath("/etc/passwd", roots, "/"), false);
    // Windows drive letters are case-insensitive; lowercase launch paths must match Chromium uppercase file:///D:/ URLs.
    assert.equal(isAllowedFilePath("D:\\kei\\src\\renderer\\desktop\\index.html", ["d:\\kei\\src\\renderer"], "\\"), true);
    assert.equal(isAllowedFilePath("D:\\kei\\src\\renderer-evil\\x.js", ["d:\\kei\\src\\renderer"], "\\"), false);
    assert.equal(isTrustedPageUrl("file:///D:/kei/src/renderer/desktop/index.html", "file:///d:/kei/src/renderer/desktop/index.html", "win32"), true);
    assert.equal(isTrustedPageUrl("file:///D:/kei/src/renderer/desktop/index.html", "file:///d:/kei/src/renderer/desktop/index.html", "linux"), false);
    assert.equal(isTrustedPageUrl("file:///D:/kei/src/renderer/desktop/INDEX.html", "file:///d:/kei/src/renderer/desktop/index.html", "win32"), false);
});

test("host origin: only bare loopback HTTP with a port", () => {
    assert.equal(checkHostOrigin("http://127.0.0.1:4100"), "http://127.0.0.1:4100");
    assert.equal(checkHostOrigin("http://localhost:4100/"), "http://localhost:4100");
    assert.equal(checkHostOrigin("http://[::1]:4100"), "http://[::1]:4100");
    for (const bad of ["https://127.0.0.1:4100", "http://example.com:4100", "http://127.0.0.2:4100", "http://u:p@127.0.0.1:4100",
        "http://127.0.0.1:4100/v1", "http://127.0.0.1:4100?x", "http://127.0.0.1", "file:///tmp/x", "not a url"]) {
        assert.throws(() => checkHostOrigin(bad), e => e.code === "insecure_host_url", bad);
    }
});

function listen(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

test("host client refuses redirects and never forwards the bearer token", async () => {
    const seen = [];
    const elsewhere = await listen((req, res) => { seen.push(req.headers.authorization || null); res.end("{}"); });
    const host = await listen((req, res) => {
        res.writeHead(307, { Location: `http://127.0.0.1:${elsewhere.address().port}/v1/status` });
        res.end();
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kei-unit-"));
    const file = path.join(dir, "connection.json");
    fs.writeFileSync(file, JSON.stringify({ apiVersion: 1, url: `http://127.0.0.1:${host.address().port}`, token: "unit-token" }));
    const client = new HostClient({ connectionFile: file });
    try {
        await assert.rejects(client.start(), e => e.code === "host_unavailable");
        assert.deepEqual(seen, [], "redirect target must not be contacted");
    } finally {
        client.stopped = true;
        host.close(); elsewhere.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("host client refuses a non-loopback connection.json before any request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kei-unit-"));
    const file = path.join(dir, "connection.json");
    fs.writeFileSync(file, JSON.stringify({ apiVersion: 1, url: "http://example.com:80", token: "unit-token" }));
    const client = new HostClient({ connectionFile: file });
    try {
        await assert.rejects(client.start(), e => e.code === "insecure_host_url");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function fakeHost(entries, page) {
    const calls = [];
    return {
        calls,
        async request(method, route, body) {
            calls.push([method, route.split("?")[0], body]);
            if (route === "/v1/entries") return entries;
            if (route === "/v1/pages/open") return page;
            if (route === "/v1/pages/close") return { closed: true };
            if (route.startsWith("/v1/pages/events")) return new Promise(() => {}); // never resolves
            throw Object.assign(new Error("unexpected"), { code: "unexpected" });
        },
    };
}
const wc = { id: 7, isDestroyed: () => false, send() {}, mainFrame: { processId: 1, routingId: 1 } };
const entry = { pluginId: "studio.counter", id: "desktop-counter", slot: "extensions", title: "カウンター", actions: ["current", "increment"], order: 20, icon: null };

test("broker refuses malformed entry metadata and closes a session whose actions exceed the entry", async () => {
    const malformed = new PageBroker(fakeHost([{ ...entry, actions: ["current", 42] }], null));
    assert.equal((await malformed.open(wc, "desktop", entry.pluginId, entry.id)).error.code, "malformed_entry");

    const host = fakeHost([entry], { sessionId: "s1", html: "<p>x</p>", cursor: 0, entry: { actions: ["current", "reset"] } });
    const widened = new PageBroker(host);
    assert.equal((await widened.open(wc, "desktop", entry.pluginId, entry.id)).error.code, "malformed_entry");
    assert.ok(host.calls.some(([m, r, b]) => m === "POST" && r === "/v1/pages/close" && b.sessionId === "s1"));
});

test("one-shot page is bound to its window and exact subframe, and served once", async () => {
    const broker = new PageBroker(fakeHost([entry], { sessionId: "s1", html: "<!doctype html><p>x</p>", cursor: 0, entry: { actions: ["current"] } }));
    const opened = await broker.open(wc, "desktop", entry.pluginId, entry.id);
    const url = opened.frame.url;
    const child = { frameTreeNodeId: 5, parent: { processId: 1, routingId: 1 } };
    const otherWindow = { ...wc, id: 8 };
    const nested = { frameTreeNodeId: 6, parent: { processId: 1, routingId: 99 } };

    assert.equal(broker.serve(url), null, "not served before bind + authorization");
    assert.equal(broker.bindFrame(otherWindow, url, child), false, "other window cannot bind");
    assert.equal(broker.bindFrame(wc, url, nested), false, "nested frame cannot bind");
    assert.equal(broker.bindFrame(wc, url, child), true);
    assert.equal(broker.bindFrame(wc, url, { ...child, frameTreeNodeId: 9 }), false, "second frame cannot rebind");

    const req = (over = {}) => ({ url, resourceType: "subFrame", webContentsId: 7, frame: { frameTreeNodeId: 5 }, ...over });
    assert.equal(broker.authorizeRequest(req({ frame: { frameTreeNodeId: 9 } })), false, "different subframe");
    assert.equal(broker.authorizeRequest(req({ webContentsId: 8 })), false, "different window");
    assert.equal(broker.authorizeRequest(req({ resourceType: "xhr" })), false, "not a frame load");
    assert.equal(broker.authorizeRequest(req()), true);
    const served = broker.serve(url);
    assert.ok(served.body.includes("Content-Security-Policy"));
    assert.equal(broker.serve(url), null, "replay refused");
    assert.equal(broker.authorizeRequest(req()), false, "no second authorization");
    broker.closeAll("test");
});
