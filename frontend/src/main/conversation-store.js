"use strict";
// Round 09: the trusted active conversation, owned by main and persisted in the profile.
// Chat, PDF pages and screen observation all read the active ID from here; no renderer or
// plugin page can set it except through the explicit switch/new actions in main.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const newId = prefix => `${prefix}-${crypto.randomUUID().replace(/-/g, "")}`;

class ConversationStore {
    constructor(file, now = () => Date.now()) {
        this.file = file;
        this.now = now;
        this.data = this.#load();
    }

    #load() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (raw?.version === 1 && Array.isArray(raw.conversations) && raw.conversations.every(c => ID.test(c.id))
                && ID.test(raw.active) && raw.conversations.some(c => c.id === raw.active)) {
                return {
                    version: 1, active: raw.active, conversations: raw.conversations,
                    outbox: Array.isArray(raw.outbox) ? raw.outbox.filter(e => ID.test(e.requestId) && ID.test(e.conversationId)) : [],
                    sent: raw.sent && typeof raw.sent === "object" ? raw.sent : {},
                    retries: raw.retries && typeof raw.retries === "object" ? raw.retries : {},
                };
            }
        } catch { /* first run or unreadable: start fresh (the old file is left in place) */ }
        const id = newId("c");
        return { version: 1, active: id, conversations: [{ id, title: null, createdAt: this.now(), updatedAt: this.now() }], outbox: [], sent: {}, retries: {} };
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
    }

    get active() { return this.data.active; }
    list() { return [...this.data.conversations].sort((a, b) => b.updatedAt - a.updatedAt); }
    has(id) { return this.data.conversations.some(c => c.id === id); }

    create() {
        const id = newId("c");
        this.data.conversations.push({ id, title: null, createdAt: this.now(), updatedAt: this.now() });
        this.data.active = id;
        this.save();
        return id;
    }

    activate(id) {
        if (!this.has(id)) return false;
        this.data.active = id;
        this.save();
        return true;
    }

    touch(id, title) {
        const c = this.data.conversations.find(x => x.id === id);
        if (!c) return;
        c.updatedAt = this.now();
        if (!c.title && title) c.title = String(title).slice(0, 60);
        this.save();
    }

    // One logical user request = one requestId, kept until the host has acknowledged it.
    newRequest(conversationId, question, selection = null) {
        const entry = { requestId: newId("r"), conversationId, question, selection, createdAt: this.now() };
        this.data.outbox.push(entry);
        this.data.sent[entry.requestId] = { conversationId, question, selection };
        this.save();
        return entry;
    }

    acknowledge(requestId) {
        const before = this.data.outbox.length;
        this.data.outbox = this.data.outbox.filter(e => e.requestId !== requestId);
        if (this.data.outbox.length !== before) this.save();
    }

    outbox(conversationId) { return this.data.outbox.filter(e => !conversationId || e.conversationId === conversationId); }
    sent(requestId) { return this.data.sent[requestId] || null; }

    linkRetry(requestId, supersededTurnId) {
        this.data.retries[requestId] = supersededTurnId;
        this.save();
    }

    retries() { return { ...this.data.retries }; }
}

module.exports = { ConversationStore, CONVERSATION_ID: ID };
