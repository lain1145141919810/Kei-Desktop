"use strict";
// Trusted main-process client for the Kei host API v1 (backend-acceptance/host-api.md).
// The connection token never leaves this module; renderers only see sanitized data.

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

class HostError extends Error {
    constructor(code, message, status = 0) {
        super(message || code);
        this.code = code;
        this.status = status;
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Round 08 (decision 4): the bearer token may only travel to the local host over loopback
// HTTP. connection.json must name a bare http://127.0.0.1|localhost|[::1]:port origin;
// anything else (other hosts, https, userinfo, paths, queries) is refused before any request.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
function checkHostOrigin(raw) {
    let url;
    try { url = new URL(String(raw)); } catch { throw new HostError("insecure_host_url", "Host URL is invalid"); }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password
        || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || !url.port) {
        throw new HostError("insecure_host_url", "Host URL must be loopback HTTP");
    }
    return url.origin;
}
const ROUTE = /^\/v1\/[A-Za-z0-9._~\/-]*(\?[A-Za-z0-9._~=&%-]*)?$/;

class HostClient extends EventEmitter {
    // options: { python, artifact, dataDir } to launch, or { connectionFile } to attach.
    constructor(options) {
        super();
        this.options = options;
        this.child = null;
        this.connection = null;
        this.connected = false;
        this.epoch = null;
        this.cursor = 0;
        this.polling = false;
        this.stopped = false;
    }

    describe() {
        const { python, artifact, dataDir, connectionFile, executorDir, chatConfig } = this.options;
        return connectionFile
            ? { mode: "attach", connectionFile }
            : { mode: "launch", python, artifact, dataDir, executorDir: executorDir || null, chatConfig: chatConfig || null };
    }

    async start() {
        if (this.options.connectionFile) {
            this.connection = await this.#readConnection(this.options.connectionFile, 8000);
        } else {
            const { python, artifact, dataDir, executorDir, executorConfig, chatConfig } = this.options;
            // Round 07 / 24: trusted operator inputs passed through unchanged.
            const extra = [];
            if (executorDir) extra.push("--executor-dir", executorDir);
            if (executorConfig) extra.push("--executor-config", executorConfig);
            if (chatConfig) extra.push("--chat-config", chatConfig);
            fs.mkdirSync(dataDir, { recursive: true });
            const file = path.join(dataDir, "connection.json");
            let ready = false;
            let readyOutput = "";
            this.child = spawn(python, [artifact, "--data-dir", dataDir, "--port", "0", ...extra], {
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
            });
            this.child.stdout.on("data", chunk => {
                if (ready) return;
                readyOutput = (readyOutput + chunk.toString()).slice(-4096);
                ready = /(?:^|\n)Kei plugin host API 1 ready on 127\.0\.0\.1:[0-9]+\r?\n/.test(readyOutput);
            });
            this.child.on("error", () => { this.child = null; });
            this.child.on("exit", (code, signal) => {
                this.child = null;
                if (!this.stopped) this.#setConnected(false, `host exited (${code ?? signal})`);
            });
            this.connection = await this.#readConnection(file, 15000, () => ready);
        }
        if (this.connection.apiVersion !== 1) throw new HostError("unsupported_api", "Host API is not version 1");
        this.origin = checkHostOrigin(this.connection.url);
        const status = await this.request("GET", "/v1/status");
        this.epoch = status.epoch ?? null;
        this.#setConnected(true);
        this.#pollLifecycle();
        return status;
    }

    async #readConnection(file, timeoutMs, ready = null) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            if (ready && !this.child) {
                throw new HostError("host_exited", "The local host process exited before reporting readiness");
            }
            try {
                const data = !ready || ready() ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
                if (typeof data.url === "string" && typeof data.token === "string") return data;
            } catch { /* not written yet */ }
            await sleep(60);
        }
        throw new HostError("host_timeout", "Host did not write connection.json in time");
    }

    #setConnected(value, reason) {
        if (this.connected === value) return;
        this.connected = value;
        this.emit(value ? "connected" : "disconnected", reason);
    }

    async request(method, route, body) {
        if (!this.connection) throw new HostError("host_unavailable", "Host is not connected");
        const headers = { Authorization: `Bearer ${this.connection.token}` };
        let payload;
        if (Buffer.isBuffer(body)) {
            headers["Content-Type"] = "application/zip";
            payload = body;
        } else if (body !== undefined) {
            headers["Content-Type"] = "application/json";
            payload = JSON.stringify(body);
        }
        if (!this.origin) throw new HostError("host_unavailable", "Host is not connected");
        if (typeof route !== "string" || !ROUTE.test(route)) throw new HostError("invalid_request", "Invalid host route");
        let response;
        try {
            response = await fetch(this.origin + route, {
                redirect: "error", // never follow a redirect with the bearer token
                method, headers, body: payload, signal: AbortSignal.timeout(30000),
            });
        } catch (error) {
            throw new HostError("host_unavailable", error.message);
        }
        let json;
        try { json = await response.json(); } catch { throw new HostError("invalid_response", `HTTP ${response.status}`, response.status); }
        if (json?.error) throw new HostError(json.error.code, json.error.message, response.status);
        if (json?.apiVersion !== 1) throw new HostError("unsupported_api", "Unexpected API version", response.status);
        return json.data;
    }

    // Host lifecycle events. Emits "lifecycle" per event and "reset" when the epoch
    // changes or retention was exceeded, so callers refresh and close stale sessions.
    async #pollLifecycle() {
        if (this.polling) return;
        this.polling = true;
        let failures = 0;
        while (!this.stopped) {
            try {
                const data = await this.request("GET", `/v1/events?after=${this.cursor}`);
                if (!this.connected) this.#setConnected(true);
                failures = 0;
                if ((this.epoch && data.epoch !== this.epoch) || data.reset) {
                    this.epoch = data.epoch;
                    this.cursor = data.cursor;
                    this.emit("reset");
                } else {
                    this.epoch = data.epoch;
                    for (const event of data.events || []) this.emit("lifecycle", event);
                    this.cursor = data.cursor;
                }
            } catch (error) {
                failures += 1;
                if (failures >= 2) this.#setConnected(false, error.message);
            }
            await sleep(this.connected ? 400 : 1500);
        }
        this.polling = false;
    }

    async stop() {
        this.stopped = true;
        const child = this.child;
        if (!child) return;
        await new Promise(resolve => {
            const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 5000);
            child.once("exit", () => { clearTimeout(timer); resolve(); });
            try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
        });
    }
}

module.exports = { HostClient, HostError, checkHostOrigin };
