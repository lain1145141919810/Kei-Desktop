"use strict";
// Round 09: Japanese chat over the host's core conversation API (Round 06 contract).
//   POST /v1/chat/ask {conversationId, requestId, question, selection?}
//   GET  /v1/chat/turns?conversationId= · GET /v1/chat/turns/{id} · POST /v1/chat/turns/{id}/cancel
// requestIds are generated and persisted in main before the first POST, so an unconfirmed
// send is re-submitted with the same requestId (the host returns the stored turn: no duplicate).

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
// Errors after which we do not know whether the host stored the turn: keep the outbox entry.
const UNKNOWN_DELIVERY = new Set(["host_unavailable", "invalid_response"]);

function sanitizePerformance(p) {
    if (!p || typeof p !== "object") return null;
    const body = Array.isArray(p.body)
        ? p.body
            .filter(step => step && typeof step === "object" && typeof step.motion === "string")
            .slice(0, 3)
            .map(step => {
                const clean = {
                    motion: step.motion,
                    speed: typeof step.speed === "number" && Number.isFinite(step.speed) ? step.speed : 1,
                    strength: typeof step.strength === "number" && Number.isFinite(step.strength) ? step.strength : 0.9,
                };
                if (typeof step.phrase === "string" && step.phrase.trim() && step.phrase.length <= 80) clean.phrase = step.phrase.trim();
                if (typeof step.variant === "string" && step.variant.trim() && step.variant.length <= 48) clean.variant = step.variant.trim();
                if (step.timing === "onset" || step.timing === "peak" || step.timing === "release") clean.timing = step.timing;
                return clean;
            })
        : [];
    const out = {
        face: typeof p.face === "string" ? p.face : "neutral",
        motion: typeof p.motion === "string" ? p.motion : "none",
        body,
        source: typeof p.source === "string" ? p.source : "embedded",
    };
    if (Array.isArray(p.rejected) && p.rejected.length) {
        out.rejected = p.rejected.slice(0, 6).map(r => ({
            motion: typeof r?.motion === "string" ? r.motion : null,
            reason: typeof r?.reason === "string" ? r.reason : "rejected",
        }));
    }
    return out;
}

function sanitizeTurn(t, retries = {}) {
    const out = {
        turnId: t.turnId,
        requestId: t.requestId,
        conversationId: t.conversationId,
        question: t.question,
        selection: t.selection ? { text: String(t.selection.text ?? ""), source: t.selection.source ?? null, page: t.selection.page ?? null } : null,
        reply: t.reply ?? null,
        spokenReply: typeof t.spokenReply === "string" ? t.spokenReply : null,
        error: t.error ? { code: t.error.code } : null,
        status: t.status,
        createdAt: t.createdAt,
        retryOf: retries[t.requestId] ?? null,
    };
    if (t.visualStale === true) out.visualStale = true;
    if (t.performance) out.performance = sanitizePerformance(t.performance);
    if (t.persona && typeof t.persona === "object") {
        out.persona = {
            revision: Number.isSafeInteger(t.persona.revision) ? t.persona.revision : null,
            id: typeof t.persona.id === "string" ? t.persona.id : null,
            name: typeof t.persona.name === "string" ? t.persona.name : null,
            modelKey: typeof t.persona.modelKey === "string" ? t.persona.modelKey : null,
            policyHash: typeof t.persona.policyHash === "string" ? t.persona.policyHash : null,
        };
    }
    return out;
}

function cleanQuestion(value) {
    return typeof value === "string" && value.trim() && value.length <= 4000 ? value : null;
}

class ChatService {
    constructor(host, store, { broadcast, audit, onSwitch }) {
        this.host = host;
        this.store = store;
        this.broadcast = broadcast;
        this.audit = audit;
        this.onSwitch = onSwitch;
        this.following = new Set();
    }

    state() {
        return { ok: true, active: this.store.active, conversations: this.store.list() };
    }

    async history() {
        const conversationId = this.store.active;
        const turns = await this.host.request("GET", `/v1/chat/turns?conversationId=${encodeURIComponent(conversationId)}`);
        const retries = this.store.retries();
        const known = new Set(turns.map(t => t.requestId));
        const pending = this.store.outbox(conversationId).filter(e => !known.has(e.requestId))
            .map(e => ({ pending: true, requestId: e.requestId, conversationId, question: e.question, selection: e.selection, status: "unconfirmed", createdAt: e.createdAt / 1000 }));
        for (const t of turns) if (!TERMINAL.has(t.status)) this.#follow(t.turnId, conversationId);
        return { ok: true, conversationId, turns: [...turns.map(t => sanitizeTurn(t, retries)), ...pending] };
    }

    async send(question) {
        const text = cleanQuestion(question);
        if (!text) return { ok: false, error: { code: "invalid_chat_request" } };
        const entry = this.store.newRequest(this.store.active, text);
        this.store.touch(entry.conversationId, text);
        this.audit("chat.send", { conversationId: entry.conversationId, requestId: entry.requestId });
        return this.#submit(entry);
    }

    async #submit(entry) {
        const body = { conversationId: entry.conversationId, requestId: entry.requestId, question: entry.question };
        if (entry.selection) body.selection = entry.selection;
        try {
            const turn = await this.host.request("POST", "/v1/chat/ask", body);
            this.store.acknowledge(entry.requestId);
            this.#follow(turn.turnId, entry.conversationId);
            return { ok: true, conversationId: entry.conversationId, turn: sanitizeTurn(turn, this.store.retries()) };
        } catch (error) {
            if (UNKNOWN_DELIVERY.has(error.code)) {
                this.audit("chat.unconfirmed", { requestId: entry.requestId, code: error.code });
                return { ok: false, pending: true, conversationId: entry.conversationId, requestId: entry.requestId, error: { code: error.code } };
            }
            this.store.acknowledge(entry.requestId); // definitive refusal: nothing was stored
            return { ok: false, conversationId: entry.conversationId, requestId: entry.requestId, error: { code: error.code } };
        }
    }

    // Re-submit a logical request with its original requestId (exact retry, deduplicated by the host).
    async resend(requestId) {
        const sent = typeof requestId === "string" ? this.store.sent(requestId) : null;
        if (!sent || sent.conversationId !== this.store.active) return { ok: false, error: { code: "invalid_chat_request" } };
        this.audit("chat.resend", { requestId });
        return this.#submit({ requestId, conversationId: sent.conversationId, question: sent.question, selection: sent.selection });
    }

    // A failed or cancelled turn: a new logical request with the same question, linked so the
    // UI shows one question with its latest attempt.
    async retry(turnId) {
        let turn;
        try { turn = await this.host.request("GET", `/v1/chat/turns/${encodeURIComponent(turnId)}`); } catch (error) { return { ok: false, error: { code: error.code } }; }
        if (turn.conversationId !== this.store.active || !["failed", "cancelled"].includes(turn.status)) return { ok: false, error: { code: "invalid_chat_request" } };
        const entry = this.store.newRequest(turn.conversationId, turn.question, turn.selection ?? null);
        this.store.linkRetry(entry.requestId, turn.turnId);
        this.audit("chat.retry", { supersedes: turn.turnId, requestId: entry.requestId });
        return this.#submit(entry);
    }

    async cancel(turnId) {
        if (typeof turnId !== "string") return { ok: false, error: { code: "invalid_chat_request" } };
        try {
            const data = await this.host.request("POST", `/v1/chat/turns/${encodeURIComponent(turnId)}/cancel`, {});
            this.audit("chat.cancel", { turnId, accepted: data.accepted, confirmed: data.confirmed });
            return { ok: true, accepted: data.accepted, confirmed: data.confirmed, turn: sanitizeTurn(data.turn, this.store.retries()) };
        } catch (error) { return { ok: false, error: { code: error.code } }; }
    }

    async #follow(turnId, conversationId) {
        if (this.following.has(turnId)) return;
        this.following.add(turnId);
        try {
            const backoff = [20, 30, 50, 80, 120, 200, 300];
            // Allow the configured 120-second provider deadline to reach a terminal state.
            for (let i = 0; i < 450; i++) {
                let turn;
                try { turn = await this.host.request("GET", `/v1/chat/turns/${encodeURIComponent(turnId)}`); }
                catch (error) { if (error.code === "host_unavailable") { await new Promise(r => setTimeout(r, 1000)); continue; } break; }
                this.broadcast("kei:chat:turn", { conversationId, turn: sanitizeTurn(turn, this.store.retries()) });
                if (TERMINAL.has(turn.status)) break;
                await new Promise(r => setTimeout(r, backoff[Math.min(i, backoff.length - 1)]));
            }
        } finally { this.following.delete(turnId); }
    }

    // After startup: re-submit every unconfirmed request (same requestId), then resume.
    async resumeAfterStart() {
        const entries = this.store.outbox();
        for (const entry of entries) await this.#submit(entry);
        this.audit("chat.resume", { resubmitted: entries.length });
        return entries.length;
    }

    async #switched(previous) {
        const next = this.store.active;
        if (previous !== next) {
            this.audit("conversation.switch", { from: previous, to: next });
            await this.onSwitch(previous, next);
            this.broadcast("kei:chat:switched", this.state());
        }
        return this.state();
    }

    newConversation() {
        const previous = this.store.active;
        this.store.create();
        return this.#switched(previous);
    }

    async activate(id) {
        const previous = this.store.active;
        if (typeof id !== "string" || !this.store.activate(id)) return { ok: false, error: { code: "conversation_not_found" } };
        return this.#switched(previous);
    }
}

module.exports = { ChatService, sanitizeTurn };
