"use strict";
// Round 09: conversation store, chat service retry semantics and selection validation.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConversationStore } = require("../../src/main/conversation-store");
const { ChatService } = require("../../src/main/chat-service");
const { sanitizeSelection } = require("../../src/main/service-validation");
const { PageBroker } = require("../../src/main/page-broker");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kei-chat-")), "conversations.json");

// A host double with the Round 06 semantics: exact retry returns the stored turn.
function fakeHost() {
    const turns = new Map(); // `${conv}:${req}` -> turn
    const host = {
        posts: 0, failNextAck: false, down: false,
        async request(method, route, body) {
            if (host.down) throw Object.assign(new Error("down"), { code: "host_unavailable" });
            if (method === "POST" && route === "/v1/chat/ask") {
                host.posts += 1;
                const key = `${body.conversationId}:${body.requestId}`;
                let turn = turns.get(key);
                if (!turn) {
                    turn = { turnId: `t${turns.size + 1}`, ...body, selection: body.selection ?? null, reply: `fixture:${body.question}`, error: null, status: "completed", createdAt: turns.size };
                    turns.set(key, turn);
                }
                if (host.failNextAck) { host.failNextAck = false; throw Object.assign(new Error("lost"), { code: "host_unavailable" }); }
                return turn;
            }
            if (method === "GET" && route.startsWith("/v1/chat/turns?")) {
                const conv = decodeURIComponent(route.split("=")[1]);
                return [...turns.values()].filter(t => t.conversationId === conv);
            }
            if (method === "GET" && route.startsWith("/v1/chat/turns/")) return [...turns.values()].find(t => t.turnId === route.split("/").pop());
            throw Object.assign(new Error("unexpected " + route), { code: "unexpected" });
        },
        turns,
    };
    return host;
}
const noop = () => {};

test("store: persists the active conversation, list, outbox and retry links", () => {
    const file = tmp();
    const a = new ConversationStore(file);
    const first = a.active;
    const second = a.create();
    const entry = a.newRequest(second, "質問");
    a.linkRetry("r-x", "t-old");
    const b = new ConversationStore(file);
    assert.equal(b.active, second);
    assert.deepEqual(b.list().map(c => c.id).sort(), [first, second].sort());
    assert.equal(b.outbox(second)[0].requestId, entry.requestId);
    assert.equal(b.retries()["r-x"], "t-old");
    assert.match(b.active, /^[A-Za-z0-9_-]{1,100}$/);
});

test("chat: an unacknowledged send keeps its requestId; resend and restart resume do not duplicate the turn", async () => {
    const host = fakeHost();
    const store = new ConversationStore(tmp());
    const chat = new ChatService(host, store, { broadcast: noop, audit: noop, onSwitch: noop });
    host.failNextAck = true;
    const first = await chat.send("こんにちは");
    assert.equal(first.ok, false);
    assert.equal(first.pending, true);
    assert.equal(store.outbox().length, 1, "kept in the outbox");

    const again = await chat.resend(first.requestId);
    assert.equal(again.ok, true);
    assert.equal(again.turn.requestId, first.requestId);
    assert.equal(host.turns.size, 1, "host still has exactly one turn");
    assert.equal(store.outbox().length, 0);

    // Simulated restart with an unconfirmed entry: resumeAfterStart reuses the requestId.
    host.failNextAck = true;
    const lost = await chat.send("再起動前");
    const restarted = new ChatService(host, new ConversationStore(store.file), { broadcast: noop, audit: noop, onSwitch: noop });
    assert.equal(await restarted.resumeAfterStart(), 1);
    assert.equal([...host.turns.values()].filter(t => t.requestId === lost.requestId).length, 1);
    assert.equal(host.turns.size, 2);
});

test("chat: definitive refusals leave nothing pending; empty questions never reach the host", async () => {
    const host = fakeHost();
    const store = new ConversationStore(tmp());
    const chat = new ChatService(host, store, { broadcast: noop, audit: noop, onSwitch: noop });
    assert.equal((await chat.send("   ")).error.code, "invalid_chat_request");
    assert.equal(host.posts, 0);
    host.request = async () => { throw Object.assign(new Error("busy"), { code: "conversation_busy" }); };
    const busy = await chat.send("質問");
    assert.equal(busy.error.code, "conversation_busy");
    assert.equal(store.outbox().length, 0);
});

test("chat: switching conversations calls onSwitch(previous) and resend is limited to the active conversation", async () => {
    const host = fakeHost();
    const store = new ConversationStore(tmp());
    const calls = [];
    const chat = new ChatService(host, store, { broadcast: noop, audit: noop, onSwitch: (prev, next) => calls.push([prev, next]) });
    const a = store.active;
    host.failNextAck = true;
    const pending = await chat.send("A の質問");
    const state = await chat.newConversation();
    assert.deepEqual(calls, [[a, state.active]]);
    assert.equal((await chat.resend(pending.requestId)).error.code, "invalid_chat_request", "not from another conversation");
    await chat.activate(a);
    assert.equal((await chat.resend(pending.requestId)).ok, true);
    assert.equal((await chat.activate("missing")).error.code, "conversation_not_found");
});

test("selection: whitespace-only text is blocked; source and page are validated", () => {
    assert.equal(sanitizeSelection({ text: " \n\t " }).error, "empty_selection");
    assert.equal(sanitizeSelection({ text: "" }).error, "empty_selection");
    assert.equal(sanitizeSelection({ text: "x".repeat(12001) }).error, "invalid_selection");
    assert.equal(sanitizeSelection({ text: "本文", page: 0 }).error, "invalid_selection");
    assert.equal(sanitizeSelection({ text: "本文", page: "3" }).selection.page, 3);
    assert.deepEqual(sanitizeSelection({ text: "本文", source: "", page: "" }).selection, { text: "本文", source: null, page: null });
    assert.equal(sanitizeSelection("本文").error, "invalid_selection");
});

test("broker: chat.ask pages carry their own conversation; results after a switch are discarded; switch closes them", async () => {
    let active = "c-a";
    const bodies = [];
    let release;
    const host = {
        async request(method, route, body) {
            if (route === "/v1/entries") return [{ pluginId: "kei.pdf", id: "reading", slot: "extensions", title: "読書", actions: ["plans.list"], order: 100, icon: null }];
            if (route === "/v1/pages/open") return { sessionId: "s1", html: "<p>x</p>", cursor: 0 };
            if (route === "/v1/plugins/kei.pdf") return { id: "kei.pdf", enabled: true, effectiveGrants: ["pdf.read", "chat.ask"] };
            if (route === "/v1/plugins/kei.observation") return { id: "kei.observation", enabled: true, effectiveGrants: ["observation.control", "vision.describe"] };
            if (route === "/v1/pages/call") { bodies.push(body); await new Promise(r => { release = r; }); return { result: [] }; }
            if (route.startsWith("/v1/pages/events")) return new Promise(() => {});
            return {};
        },
    };
    const wc = { id: 1, isDestroyed: () => false, send() {}, mainFrame: { processId: 1, routingId: 1 } };
    const broker = new PageBroker(host);
    broker.conversation = () => active;
    const opened = await broker.open(wc, "desktop", "kei.pdf", "reading");
    const pending = broker.call(wc, opened.frame.tag, { type: "kei:call", id: "1", action: "plans.list", arguments: {} });
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(bodies[0].context, { conversationId: "c-a" });
    active = "c-b";
    assert.equal((await broker.call(wc, opened.frame.tag, { type: "kei:call", id: "2", action: "plans.list" })).error.code, "conversation_changed");
    assert.equal(bodies.length, 1);
    release();
    assert.equal((await pending).error.code, "conversation_changed");
    broker.closeConversation("c-a");
    assert.equal(broker.ownFrame(wc, opened.frame.tag), null);
});

test("broker: a page still opening across a conversation switch cannot bind back to the old conversation", async () => {
    let revision = 0;
    const closed = [];
    let finishOpen;
    const waiting = new Promise(resolve => { finishOpen = resolve; });
    const host = {
        async request(_method, route, body) {
            if (route === "/v1/entries") return [{ pluginId: "kei.pdf", id: "reading", slot: "extensions", title: "読書", actions: [] }];
            if (route === "/v1/pages/open") return waiting;
            if (route === "/v1/plugins/kei.pdf") return { effectiveGrants: ["chat.ask"] };
            if (route === "/v1/pages/close") closed.push(body.sessionId);
        },
    };
    const broker = new PageBroker(host);
    broker.conversation = () => "c-a";
    broker.conversationVersion = () => revision;
    const pending = broker.open({ id: 1 }, "desktop", "kei.pdf", "reading");
    revision += 2; // The user left and returned before the host replied.
    finishOpen({ sessionId: "old", html: "<p>x</p>" });
    assert.equal((await pending).error.code, "conversation_changed");
    assert.deepEqual(closed, ["old"]);
    assert.equal(broker.frames.size, 0);
});

test("broker: plugins without a conversation-scoped grant get no conversation context", async () => {
    const bodies = [];
    const host = {
        async request(method, route, body) {
            if (route === "/v1/entries") return [{ pluginId: "kei.observation", id: "observation", slot: "extensions", title: "画面観察", actions: ["configure"], order: 100, icon: null }];
            if (route === "/v1/pages/open") return { sessionId: "s2", html: "<p>x</p>", cursor: 0 };
            if (route === "/v1/plugins/kei.observation") return { id: "kei.observation", enabled: true, effectiveGrants: ["observation.read", "observation.control", "vision.describe"] };
            if (route === "/v1/pages/call") { bodies.push(body); return { result: {} }; }
            if (route.startsWith("/v1/pages/events")) return new Promise(() => {});
            return {};
        },
    };
    const wc = { id: 2, isDestroyed: () => false, send() {}, mainFrame: { processId: 1, routingId: 1 } };
    const broker = new PageBroker(host);
    broker.conversation = () => "c-a";
    const opened = await broker.open(wc, "desktop", "kei.observation", "observation");
    await broker.call(wc, opened.frame.tag, { type: "kei:call", id: "1", action: "configure", arguments: { enabled: true, sourceId: "screen:0:0", kind: "display" } });
    assert.equal(bodies[0].context, undefined);
    broker.closeAll("test");
});
