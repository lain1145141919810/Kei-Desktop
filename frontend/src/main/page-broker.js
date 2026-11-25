"use strict";
// Owns every plugin page session. Session IDs, cursors and HTML stay in main; the trusted
// renderer only knows an opaque frame tag. Each tag maps to exactly one host session and
// one <iframe>. Any lifecycle change for the plugin closes its frames immediately.

const crypto = require("node:crypto");
const { sanitizeCall, createRateLimiter, withHostCsp, slotAllowed, PAGE_CSP, parseFrameUrl, validateEntryMetadata, HOST_PAGE_CALL_BYTES } = require("./page-protocol");

const PAGE_SCHEME = "kei-page";
const CONVERSATION_SCOPES = ["chat.ask", "attachments.read"];
const REVOKING_EVENTS = new Set(["plugin.disabled", "plugin.reloaded", "plugin.uninstalled", "plugin.activation_failed"]);

class PageBroker {
    constructor(host, log = () => {}) {
        this.host = host;
        this.log = log;
        this.frames = new Map(); // tag -> frame record
    }

    frameUrl(tag) {
        return `${PAGE_SCHEME}://frame/${tag}`;
    }

    // Called from the trusted window's IPC handler after sender verification.
    async open(webContents, windowKind, pluginId, entryId) {
        const conversationId = this.conversation?.();
        const conversationVersion = this.conversationVersion?.();
        const entries = await this.host.request("GET", "/v1/entries");
        const listed = Array.isArray(entries) ? entries.find(item => item?.pluginId === pluginId && item?.id === entryId) : null;
        if (!listed) return { ok: false, error: { code: "entry_not_found" } };
        // Round 08: refuse malformed host metadata instead of guessing.
        const entry = validateEntryMetadata(listed);
        if (!entry) { this.log("page.open.rejected", { pluginId, entryId, code: "malformed_entry" }); return { ok: false, error: { code: "malformed_entry" } }; }
        if (!slotAllowed(windowKind, entry.slot)) return { ok: false, error: { code: "slot_denied" } };
        const page = await this.host.request("POST", "/v1/pages/open", { pluginId, entryId });
        // The session's own action list (if present) must be well-formed and within the entry's.
        let actions = entry.actions;
        if (page?.entry?.actions !== undefined) {
            const own = validateEntryMetadata({ ...entry, actions: page.entry.actions });
            if (!own || !own.actions.every(a => entry.actions.includes(a))) {
                this.host.request("POST", "/v1/pages/close", { sessionId: page.sessionId }).catch(() => {});
                this.log("page.open.rejected", { pluginId, entryId, code: "malformed_entry" });
                return { ok: false, error: { code: "malformed_entry" } };
            }
            actions = own.actions;
        }
        if (typeof page?.sessionId !== "string" || typeof page?.html !== "string") return { ok: false, error: { code: "invalid_response" } };
        // Round 09: bind the trusted conversation only for plugins granted a conversation-scoped
        // service (Round 06: chat.ask; attachments.read). Others (e.g. kei.observation) get no
        // conversation, so a page can never configure conversation-bound state on its own.
        let bindConversation = false;
        try {
            const plugin = await this.host.request("GET", `/v1/plugins/${pluginId}`);
            const grants = plugin?.effectiveGrants || [];
            bindConversation = CONVERSATION_SCOPES.some(scope => grants.includes(scope));
        } catch { bindConversation = false; }
        if (bindConversation && (conversationId !== this.conversation?.() || conversationVersion !== this.conversationVersion?.())) {
            this.host.request("POST", "/v1/pages/close", { sessionId: page.sessionId }).catch(() => {});
            return { ok: false, error: { code: "conversation_changed" } };
        }
        const tag = crypto.randomBytes(16).toString("hex");
        const frame = {
            tag, pluginId, entryId, windowKind,
            webContentsId: webContents.id,
            webContents,
            sessionId: page.sessionId,
            cursor: page.cursor ?? 0,
            epoch: null,
            actions,
            html: page.html,
            served: false,
            boundFrame: null,   // frameTreeNodeId of the subframe that navigated to this page
            // Round 09: the trusted conversation active when this page opened. Every call
            // carries it; the page can never choose or change it.
            conversationId: bindConversation ? (conversationId ?? null) : null,
            authorized: false,  // the matching subframe request passed webRequest checks
            closed: false,
            allow: createRateLimiter(),
            timer: null,
        };
        this.frames.set(tag, frame);
        this.#pollEvents(frame);
        this.log("page.open", { pluginId, entryId, windowKind, tag });
        return {
            ok: true,
            frame: {
                tag,
                url: this.frameUrl(tag),
                pluginId,
                entryId,
                title: entry.title,
                slot: entry.slot,
                icon: entry.icon ?? null,
            },
        };
    }

    // protocol.handle("kei-page") — serves a frame document exactly once.
    serve(requestUrl) {
        const tag = parseFrameUrl(requestUrl);
        const frame = tag ? this.frames.get(tag) : null;
        // Round 08: only the bound subframe's authorized request is ever answered, once.
        if (!frame || frame.closed || frame.served || !frame.authorized) {
            if (tag) this.log("page.serve.denied", { tag, reason: !frame ? "unknown" : frame.served ? "replay" : "unauthorized" });
            return null;
        }
        frame.served = true;
        const html = withHostCsp(frame.html);
        frame.html = null;
        return {
            body: html,
            headers: {
                "content-type": "text/html; charset=utf-8",
                "content-security-policy": PAGE_CSP,
                "x-content-type-options": "nosniff",
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
            },
        };
    }

    // Round 08: bind a one-shot page to the issuing window and the exact direct child frame
    // that navigates to it. Called from will-frame-navigate; returns false to block.
    bindFrame(webContents, url, frame) {
        const tag = parseFrameUrl(url);
        const record = tag ? this.frames.get(tag) : null;
        if (!record || record.closed || record.served || record.boundFrame !== null) return false;
        if (record.webContentsId !== webContents.id || !frame) return false;
        const main = webContents.mainFrame;
        const parent = frame.parent;
        if (!parent || parent.processId !== main.processId || parent.routingId !== main.routingId) return false;
        record.boundFrame = frame.frameTreeNodeId;
        return true;
    }

    // Round 08: called from session.webRequest.onBeforeRequest for kei-page:// URLs.
    authorizeRequest(details) {
        const tag = parseFrameUrl(details.url);
        const record = tag ? this.frames.get(tag) : null;
        const ok = Boolean(record && !record.closed && !record.served && !record.authorized
            && record.boundFrame !== null
            && details.resourceType === "subFrame"
            && details.webContentsId === record.webContentsId
            && details.frame && details.frame.frameTreeNodeId === record.boundFrame);
        if (ok) record.authorized = true;
        else this.log("page.request.denied", { tag: tag || null, type: details.resourceType, url: String(details.url).slice(0, 80) });
        return ok;
    }

    ownFrame(webContents, tag) {
        const frame = this.frames.get(tag);
        return frame && !frame.closed && frame.webContentsId === webContents.id ? frame : null;
    }

    async call(webContents, tag, message) {
        const frame = this.ownFrame(webContents, tag);
        const id = typeof message?.id === "string" ? message.id : undefined;
        if (!frame) return { ok: false, id, error: { code: "page_closed" } };
        if (frame.conversationId && frame.conversationId !== this.conversation?.()) {
            return { ok: false, id, error: { code: "conversation_changed" } };
        }
        const checked = sanitizeCall(message, frame.actions);
        if (checked.error) {
            this.log("page.call.rejected", { pluginId: frame.pluginId, entryId: frame.entryId, code: checked.error });
            return { ok: false, id: checked.id, error: { code: checked.error } };
        }
        const body = { sessionId: frame.sessionId, action: checked.call.action, arguments: checked.call.arguments };
        if (frame.conversationId) body.context = { conversationId: frame.conversationId };
        const requestBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
        if (requestBytes > HOST_PAGE_CALL_BYTES) {
            this.log("page.call.rejected", { pluginId: frame.pluginId, entryId: frame.entryId, code: "message_too_large" });
            return { ok: false, id, error: { code: "message_too_large" } };
        }
        if (!frame.allow()) return { ok: false, id, error: { code: "rate_limited" } };
        try {
            const data = await this.host.request("POST", "/v1/pages/call", body);
            // Round 09: a result that lands after a conversation switch is discarded.
            if (frame.closed || (this.conversation && frame.conversationId && frame.conversationId !== this.conversation())) {
                this.log("page.call.discarded", { pluginId: frame.pluginId, entryId: frame.entryId, action: checked.call.action, reason: "conversation_changed" });
                return { ok: false, id: checked.call.id, error: { code: "conversation_changed" } };
            }
            const entry = { pluginId: frame.pluginId, entryId: frame.entryId, action: checked.call.action, ok: true };
            // Round 10: record migration IDs (Round 06 contract: legacy imports log their migration IDs).
            const migrationId = data?.result?.migrationId;
            if (typeof migrationId === "string" && /^[0-9a-f]{16,128}$/.test(migrationId)) {
                entry.migrationId = migrationId;
                entry.requestBytes = requestBytes;
                if (typeof data.result.duplicate === "boolean") entry.duplicate = data.result.duplicate;
            }
            this.log("page.call", entry);
            return { ok: true, id: checked.call.id, result: data.result };
        } catch (error) {
            this.log("page.call", { pluginId: frame.pluginId, entryId: frame.entryId, action: checked.call.action, ok: false, code: error.code });
            // Round 09: a call whose page was closed by a conversation switch is a discarded late result.
            if (frame.closed && frame.closeReason === "conversation_changed") {
                this.log("page.call.discarded", { pluginId: frame.pluginId, entryId: frame.entryId, action: checked.call.action, reason: "conversation_changed", code: error.code });
                return { ok: false, id: checked.call.id, error: { code: "conversation_changed" } };
            }
            if (error.code === "page_closed") this.close(tag, "page_closed", false);
            return { ok: false, id: checked.call.id, error: { code: error.code || "action_failed" } };
        }
    }

    async #pollEvents(frame) {
        while (!frame.closed) {
            try {
                const data = await this.host.request(
                    "GET", `/v1/pages/events?sessionId=${encodeURIComponent(frame.sessionId)}&after=${frame.cursor}`,
                );
                if (frame.closed) break;
                if ((frame.epoch && data.epoch !== frame.epoch) || data.reset) {
                    this.close(frame.tag, "reset", false);
                    break;
                }
                frame.epoch = data.epoch;
                frame.cursor = data.cursor;
                for (const event of data.events || []) {
                    if (event.type !== "plugin.message" || event.pluginId !== frame.pluginId) continue;
                    const { topic, data: payload } = event.data || {};
                    if (typeof topic !== "string") continue;
                    this.#send(frame, "kei:page:event", frame.tag, { topic, data: payload ?? null });
                }
            } catch (error) {
                if (error.code === "page_closed" || error.code === "host_unavailable") {
                    this.close(frame.tag, error.code, false);
                    break;
                }
            }
            await new Promise(resolve => { frame.timer = setTimeout(resolve, 300); });
        }
    }

    #send(frame, channel, ...args) {
        if (!frame.webContents.isDestroyed()) frame.webContents.send(channel, ...args);
    }

    // Remove a frame now: stop polling, tell its window to drop the iframe, and (when the
    // session may still be live) close it on the host.
    close(tag, reason, notifyHost = true) {
        const frame = this.frames.get(tag);
        if (!frame || frame.closed) return false;
        frame.closed = true;
        frame.closeReason = reason;
        clearTimeout(frame.timer);
        this.frames.delete(tag);
        this.#send(frame, "kei:page:closed", tag, reason);
        this.log("page.close", { pluginId: frame.pluginId, entryId: frame.entryId, tag, reason });
        try { this.onFrameClosed?.(frame, reason); } catch { /* observer must not break close */ } // Round 08
        if (notifyHost) this.host.request("POST", "/v1/pages/close", { sessionId: frame.sessionId }).catch(() => {});
        return true;
    }

    closeOwnedBy(webContents, tag, reason = "user") {
        return this.ownFrame(webContents, tag) ? this.close(tag, reason) : false;
    }

    closePlugin(pluginId, reason) {
        for (const frame of [...this.frames.values()]) {
            if (frame.pluginId === pluginId) this.close(frame.tag, reason, reason === "user");
        }
    }

    // Round 09: close every page bound to a conversation that is no longer active.
    closeConversation(conversationId, reason = "conversation_changed") {
        for (const frame of [...this.frames.values()]) {
            if (frame.conversationId && frame.conversationId === conversationId) this.close(frame.tag, reason);
        }
    }

    closeWebContents(webContentsId, reason) {
        for (const frame of [...this.frames.values()]) {
            if (frame.webContentsId === webContentsId) this.close(frame.tag, reason);
        }
    }

    closeAll(reason) {
        for (const tag of [...this.frames.keys()]) this.close(tag, reason, false);
    }

    // Lifecycle events are polled, so one can arrive after the user already reopened a page
    // on the plugin's new generation. Ask the host about each open session instead of
    // closing blindly: revoked sessions answer page_closed and are removed at once; fresh
    // ones stay. (Mutations made from our own admin UI close frames synchronously.)
    onLifecycle(event) {
        if (!REVOKING_EVENTS.has(event.type)) return;
        for (const frame of [...this.frames.values()]) {
            if (frame.pluginId === event.pluginId) this.#verify(frame, event.type);
        }
    }

    async #verify(frame, reason) {
        try {
            // after=cursor without advancing it: the regular poller still delivers any events.
            await this.host.request("GET", `/v1/pages/events?sessionId=${encodeURIComponent(frame.sessionId)}&after=${frame.cursor}`);
        } catch (error) {
            if (error.code === "page_closed" || error.code === "host_unavailable") this.close(frame.tag, reason, false);
        }
    }

    openCount(pluginId) {
        return [...this.frames.values()].filter(frame => !pluginId || frame.pluginId === pluginId).length;
    }
}

module.exports = { PageBroker, PAGE_SCHEME, REVOKING_EVENTS };
