"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeCall, createRateLimiter, withHostCsp, slotAllowed, PAGE_CSP, MAX_MESSAGE_BYTES } = require("../../src/main/page-protocol");

test("accepts a declared call and strips extra fields", () => {
    const result = sanitizeCall({ type: "kei:call", id: "greet", action: "greet", arguments: { name: "ケイ" }, sessionId: "forged", url: "http://x" }, ["greet"]);
    assert.deepEqual(result, { call: { id: "greet", action: "greet", arguments: { name: "ケイ" } } });
});

test("defaults missing arguments to an empty object", () => {
    assert.deepEqual(sanitizeCall({ type: "kei:call", id: "a", action: "current" }, ["current"]).call.arguments, {});
});

test("rejects undeclared actions with scope_denied", () => {
    assert.deepEqual(sanitizeCall({ type: "kei:call", id: "x", action: "reset", arguments: {} }, ["current", "increment"]), { error: "scope_denied", id: "x" });
});

test("rejects malformed messages", () => {
    for (const message of [null, "kei:call", [], { type: "kei:event" }, { type: "kei:call", id: 1, action: "a" },
        { type: "kei:call", id: "a", action: "Bad Action" }, { type: "kei:call", id: "a", action: "a", arguments: [] },
        { type: "kei:call", id: "x".repeat(200), action: "a" }]) {
        assert.ok(sanitizeCall(message, ["a"]).error, JSON.stringify(message));
    }
});

test("rejects oversized arguments", () => {
    const big = { text: "x".repeat(MAX_MESSAGE_BYTES + 1) };
    assert.equal(sanitizeCall({ type: "kei:call", id: "a", action: "a", arguments: big }, ["a"]).error, "message_too_large");
});

test("page call limit follows the host's 2 MiB /v1/pages/call limit, with envelope headroom", () => {
    assert.ok(MAX_MESSAGE_BYTES > 64 * 1024 && MAX_MESSAGE_BYTES < 2 * 1024 * 1024);
    // A 1 MiB multi-byte (Japanese) payload is accepted; byte length, not string length, counts.
    const ok = { text: "あ".repeat(Math.floor((1024 * 1024) / 3)) };
    assert.ok(sanitizeCall({ type: "kei:call", id: "a", action: "a", arguments: ok }, ["a"]).call);
    const over = { text: "あ".repeat(Math.ceil(MAX_MESSAGE_BYTES / 3) + 1) };
    assert.equal(sanitizeCall({ type: "kei:call", id: "a", action: "a", arguments: over }, ["a"]).error, "message_too_large");
});

test("rate limiter allows the limit per window then refuses", () => {
    let now = 0;
    const allow = createRateLimiter(3, 1000, () => now);
    assert.deepEqual([allow(), allow(), allow(), allow()], [true, true, true, false]);
    now = 1000;
    assert.equal(allow(), true);
});

test("host CSP is inserted after the doctype and before packaged markup", () => {
    const html = withHostCsp("<!doctype html>\n<html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src *\"><body>x</body></html>");
    assert.ok(html.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`));
    assert.ok(PAGE_CSP.includes("connect-src 'none'") && PAGE_CSP.startsWith("default-src 'none'"));
    assert.ok(withHostCsp("<p>no doctype</p>").startsWith("<meta http-equiv=\"Content-Security-Policy\""));
});

test("Kei plugin base style and theme listener precede packaged markup", () => {
    const html = withHostCsp("<!doctype html><style>body{color:red}</style><body>x</body>");
    const base = html.indexOf('<style id="kei-plugin-base">');
    assert.ok(base > 0 && base < html.indexOf("<style>body{color:red}"));
    assert.ok(html.includes(':where(body)'), "base rules are zero-specificity");
    assert.ok(html.includes('d.type==="kei:theme"') && html.includes("e.source===parent"));
});

test("slots are limited per trusted window", () => {
    assert.equal(slotAllowed("desktop", "extensions"), true);
    assert.equal(slotAllowed("desktop", "admin"), false);
    assert.equal(slotAllowed("admin", "admin"), true);
    assert.equal(slotAllowed("admin", "extensions"), false);
    assert.equal(slotAllowed("plugin", "extensions"), false);
});

test("denied URL auditing includes only a fixed scheme label", () => {
    const { auditScheme } = require("../../src/main/page-protocol");
    assert.equal(auditScheme("https://example.invalid/private?q=synthetic-marker"), "https");
    assert.equal(auditScheme("synthetic-marker:ignored"), "other");
    assert.equal(auditScheme("data:text/plain,synthetic-marker"), "data");
});
