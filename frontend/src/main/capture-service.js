"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { dialog, desktopCapturer, BrowserWindow } = require("electron");
const { openSelectedCapture } = require("./selected-capture");

const PLUGIN = "kei.observation";
const ENTRY = "observation";
const REQUIRED_GRANTS = ["observation.read", "observation.control", "vision.describe"];
const REVOKING = new Set(["plugin.disabled", "plugin.reloaded", "plugin.uninstalled", "plugin.activation_failed"]);
const FIXTURE_ID = "fixture:synthetic";
const PAGE_SIZE = 8;

async function listSources() {
    const own = new Set(BrowserWindow.getAllWindows().map(win => win.getMediaSourceId()));
    const found = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    return found.filter(source => !own.has(source.id)).map(source => ({
        id: source.id, name: source.name || source.id, kind: source.id.startsWith("screen:") ? "display" : "window",
    })).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "display" ? -1 : 1));
}

async function chooseSource(sources, parent, signal, messageBox = (...args) => dialog.showMessageBox(...args)) {
    const count = Math.ceil(sources.length / PAGE_SIZE);
    let page = 0;
    while (!signal.aborted && page >= 0 && page < count) {
        const slice = sources.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const buttons = slice.map(source => (source.kind === "display" ? "画面" : "ウィンドウ") + "：" + source.name);
        const back = page > 0 ? buttons.push("前へ") - 1 : -1;
        const next = page < count - 1 ? buttons.push("次へ") - 1 : -1;
        const cancelId = buttons.push("キャンセル") - 1;
        const answer = await messageBox(parent || undefined, {
            type: "question",
            title: "画面観察",
            message: "観察する画面またはウィンドウを選んでください（" + (page + 1) + "/" + count + "）",
            detail: "選んだ対象だけを取得し、Kei の視覚モデルに送ります。停止するまで続きます（Ctrl+Alt+S または「停止」）。",
            buttons, cancelId, defaultId: cancelId, noLink: true, signal,
        });
        if (signal.aborted || answer.response < 0 || answer.response === cancelId) return null;
        if (answer.response === next) page++;
        else if (answer.response === back) page--;
        else return slice[answer.response] ?? null;
    }
    return null;
}

class CaptureService {
    constructor(host, { audit, broadcast, parentWindow, conversation,
        enumerate = listSources, choose = chooseSource, openStream = openSelectedCapture }) {
        this.host = host;
        this.audit = audit;
        this.broadcast = broadcast;
        this.parentWindow = parentWindow;
        this.conversation = conversation;
        this.enumerate = enumerate;
        this.choose = choose;
        this.openStream = openStream;
        this.state = null;
        this.pending = null;
        this.hostQueue = Promise.resolve();
        this.lastStop = null;
        const fixture = process.env.KEI_CAPTURE_FIXTURE;
        this.fixtureFiles = fixture ? fixture.split(path.delimiter).filter(Boolean).map(file => path.resolve(file)) : [];
        this.fixtureIndex = 0;
    }

    status() {
        const state = this.state;
        return {
            active: Boolean(state), starting: Boolean(this.pending),
            source: state ? { name: state.name, kind: state.kind } : null,
            origin: state?.origin.type ?? null, lastCapture: state?.lastCapture ?? null,
            captures: state?.captures ?? 0, lastStop: this.lastStop,
        };
    }

    #publish() {
        this.broadcast("kei:capture:status", this.status());
    }

    #serial(task) {
        const job = this.hostQueue.then(task);
        this.hostQueue = job.catch(() => {});
        return job;
    }

    #current(request) {
        return this.pending === request && !request.abort.signal.aborted &&
            this.conversation() === request.conversationId;
    }

    #cancelChoice() {
        if (!this.pending) return false;
        const old = this.pending;
        this.pending = null;
        const stream = old.stream;
        old.stream = null;
        old.abort.abort();
        stream?.close();
        return true;
    }

    async toggle(origin) {
        return this.state || this.pending ? this.stop("user", origin) : this.start(origin);
    }

    async start(origin) {
        if (this.state) return { ok: true, status: this.status() };
        this.#cancelChoice();
        const request = { origin, conversationId: this.conversation(), abort: new AbortController(), stream: null };
        this.pending = request;
        this.#publish();
        try {
            const plugin = await this.host.request("GET", "/v1/plugins/" + PLUGIN).catch(() => null);
            if (!this.#current(request)) return this.#fail("capture_cancelled", origin, false);
            const grants = plugin?.effectiveGrants || plugin?.grants || [];
            if (!plugin?.enabled || !REQUIRED_GRANTS.every(grant => grants.includes(grant))) {
                return this.#fail("observation_unavailable", origin);
            }

            const sources = await this.enumerate();
            if (!this.#current(request)) return this.#fail("capture_cancelled", origin, false);
            if (this.fixtureFiles.length) sources.unshift({ id: FIXTURE_ID, name: "テスト用の合成画像（フィクスチャ）", kind: "window" });
            if (!sources.length) return this.#fail("capture_source_unavailable", origin);
            const parent = this.parentWindow();
            const picked = await this.choose(sources, parent, request.abort.signal);
            if (!this.#current(request)) return this.#fail("capture_cancelled", origin, false);
            const source = sources.find(item => item.id === picked?.id);
            if (!source) {
                this.audit("capture.chooser", { chosen: false, origin: origin.type });
                return this.#fail("user_cancelled", origin, false);
            }

            request.stream = source.id === FIXTURE_ID ? this.#fixtureStream() :
                this.openStream(source, { signal: request.abort.signal, parentWindow: parent });
            await request.stream.ready;
            if (!this.#current(request)) return this.#fail("capture_cancelled", origin, false);

            return await this.#serial(async () => {
                if (!this.#current(request)) return this.#fail("capture_cancelled", origin, false);
                const page = await this.host.request("POST", "/v1/pages/open", { pluginId: PLUGIN, entryId: ENTRY });
                const state = { ...source, origin, sessionId: page.sessionId, stream: request.stream,
                    conversationId: request.conversationId, timer: null, inFlight: false, captures: 0, lastCapture: null };
                let configuring = false;
                try {
                    if (!this.#current(request)) return this.#fail("capture_cancelled", origin, false);
                    configuring = true;
                    const reply = (await this.host.request("POST", "/v1/pages/call", {
                        sessionId: state.sessionId, action: "configure",
                        arguments: { enabled: true, sourceId: state.id, kind: state.kind },
                        context: { conversationId: state.conversationId },
                    })).result;
                    if (!this.#current(request)) return this.#fail("capture_cancelled", origin, false);
                    if (!reply || reply.error || typeof reply.generation !== "number") {
                        return this.#fail(reply?.error?.code || "capture_configure_failed", origin);
                    }
                    state.generation = reply.generation;
                    state.intervalMs = Math.max(2, Number(reply.intervalSeconds) || 4) * 1000;
                    this.state = state;
                    request.stream = null;
                    this.pending = null;
                    this.audit("capture.start", { origin: origin.type, kind: state.kind,
                        fixture: state.id === FIXTURE_ID, generation: state.generation });
                    this.#schedule(state, 0);
                    return { ok: true, status: this.status() };
                } finally {
                    if (this.state !== state) await this.#cleanupHost(state, configuring);
                }
            });
        } catch {
            return this.#current(request) ? this.#fail("capture_source_unavailable", origin) :
                this.#fail("capture_cancelled", origin, false);
        } finally {
            if (this.pending === request) this.pending = null;
            if (request.stream) {
                request.abort.abort();
                request.stream.close();
            }
            this.#publish();
        }
    }

    #fixtureStream() {
        return {
            ready: Promise.resolve(),
            frame: () => ({
                mime: "image/png",
                base64: fs.readFileSync(this.fixtureFiles[this.fixtureIndex++ % this.fixtureFiles.length]).toString("base64"),
            }),
            close() {},
        };
    }

    #fail(code, origin, log = true) {
        if (log) this.audit("capture.refused", { code, origin: origin?.type });
        return { ok: false, error: { code } };
    }

    #schedule(state, delay) {
        if (this.state !== state) return;
        clearTimeout(state.timer);
        state.timer = setTimeout(() => this.#tick(state), delay);
    }

    async #tick(state) {
        if (this.state !== state) return;
        if (this.conversation() !== state.conversationId) {
            await this.stop("conversation_changed");
            return;
        }
        let image = null;
        try {
            image = await state.stream.frame();
        } catch {
            // A closed or disappeared source never causes a capture of another window.
        }
        if (this.state !== state) return;
        if (this.conversation() !== state.conversationId) {
            await this.stop("conversation_changed");
            return;
        }
        if (!image) {
            await this.stop("source_unavailable");
            return;
        }
        state.inFlight = true;
        let result;
        try {
            result = (await this.host.request("POST", "/v1/pages/call", {
                sessionId: state.sessionId, action: "capture",
                arguments: { generation: state.generation, sourceId: state.id, image },
                context: { conversationId: state.conversationId, capture: { authorized: true, sourceId: state.id, kind: state.kind } },
            })).result;
        } catch (error) {
            result = { error: { code: error.code || "host_unavailable" } };
        } finally {
            state.inFlight = false;
        }
        if (this.state !== state) return;
        const code = result?.error?.code;
        if (["page_closed", "capture_closed", "host_unavailable"].includes(code)) {
            await this.stop(code);
            return;
        }
        if (!code && !result?.skipped) {
            state.captures++;
            state.lastCapture = Date.now();
            this.#publish();
        }
        if (code) this.audit("capture.frame.error", { code });
        this.#schedule(state, state.intervalMs);
    }

    async #cleanupHost(state, configured) {
        if (state.inFlight) await this.host.request("POST", "/v1/pages/capture/cancel", { sessionId: state.sessionId }).catch(() => {});
        if (configured) await this.host.request("POST", "/v1/pages/call", {
            sessionId: state.sessionId, action: "configure", arguments: { enabled: false },
            context: { conversationId: state.conversationId },
        }).catch(() => {});
        await this.host.request("POST", "/v1/pages/close", { sessionId: state.sessionId }).catch(() => {});
    }

    async stop(reason, origin = null, { hostReachable = true } = {}) {
        const pending = this.#cancelChoice();
        const state = this.state;
        if (!state && !pending) return { ok: true, status: this.status() };
        this.state = null;
        clearTimeout(state?.timer);
        state?.stream.close();
        this.lastStop = { reason, at: Date.now() };
        this.#publish();
        const cancelledInFlight = Boolean(state?.inFlight);
        if (state && hostReachable) await this.#serial(() => this.#cleanupHost(state, true));
        this.audit("capture.stop", { reason, by: origin?.type ?? null, cancelledInFlight, captures: state?.captures ?? 0 });
        return { ok: true, status: this.status() };
    }

    onLifecycle(event) {
        if (event.pluginId === PLUGIN && REVOKING.has(event.type)) void this.stop(event.type);
    }

    onFrameClosed(frame) {
        if ([this.state?.origin, this.pending?.origin].some(origin => origin?.type === "page" && origin.tag === frame.tag)) {
            void this.stop("page_closed");
        }
    }

    onConversationChanged() {
        return this.stop("conversation_changed");
    }

    onHostLost() {
        return this.stop("host_unavailable", null, { hostReachable: false });
    }
}

module.exports = { CaptureService, chooseSource, OBSERVATION_PLUGIN: PLUGIN };
