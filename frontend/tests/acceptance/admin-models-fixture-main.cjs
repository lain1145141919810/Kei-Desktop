"use strict";
// Test-only Electron main for DEF-01: loads the real admin.html with the real preload
// (--kei-window=admin) and answers its IPC from a deterministic host fixture. The driver
// (admin-models-fixture.mjs) flips the fixture through global.__fixture, which broadcasts the
// same events src/main/main.js sends on host connect/disconnect.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.commandLine.appendSwitch("lang", "ja");
app.setPath("userData", fs.mkdtempSync(path.join(process.env.TMPDIR || require("node:os").tmpdir(), "kei-admin-fixture-")));
const frontend = path.resolve(process.env.KEI_FRONTEND_DIR || path.join(__dirname, "..", ".."));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CAPS = ["tts", "asr", "vision", "embedding"];
const PROVIDER = { pluginId: "kei.openai-compat-models", name: "OpenAI-Compatible Model Provider", enabled: true, requiresCredential: true };

const state = { connected: false, providers: [], failDelayMs: 0, calls: [] };
const unavailable = { ok: false, error: { code: "host_unavailable" } };
const models = () => ({
    capabilities: CAPS,
    providers: state.providers,
    selections: {},
});
const chatConfig = () => ({ state: "unconfigured", configured: false, configFileName: "chat.json", externalConfig: false,
    endpoint: "", model: "", credentialRef: null, timeoutSeconds: 30, extra_body: {}, profiles: [] });

let win = null;
const send = (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };
const status = () => ({ connected: state.connected, error: state.connected ? null : "host_unavailable", installed: null, ready: null, pluginFeatures: [], mode: "fixture" });

const answers = {
    "kei:status": async () => ({ ok: true, status: status() }),
    "kei:models:list": async () => {
        // A request sent while the host is down fails, optionally slowly (stale-reply race).
        if (!state.connected) { if (state.failDelayMs) await sleep(state.failDelayMs); return unavailable; }
        return { ok: true, value: models() };
    },
    "kei:chat:config:get": async () => {
        if (!state.connected) { if (state.failDelayMs) await sleep(state.failDelayMs); return unavailable; }
        return { ok: true, value: chatConfig() };
    },
};

const bridgeSource = fs.readFileSync(path.join(frontend, "src", "preload", "bridge.js"), "utf8");
for (const channel of new Set([...bridgeSource.matchAll(/invoke\("([^"]+)"/g)].map(m => m[1]))) {
    ipcMain.handle(channel, async (_event, ...args) => {
        state.calls.push(channel);
        if (answers[channel]) return answers[channel](...args);
        if (channel.endsWith(":list") || channel.endsWith(":recent")) return state.connected ? { ok: true, value: [] } : unavailable;
        return unavailable;
    });
}

global.__fixture = {
    connect() {
        state.connected = true;
        // src/main/main.js host.on("connected") -> registryChanged("connected") + status broadcast.
        send("kei:entries:changed", "connected");
        send("kei:plugins:changed", "connected");
        send("kei:host:status", status());
    },
    disconnect() {
        state.connected = false;
        send("kei:host:status", status());
        send("kei:entries:changed", "disconnected");
    },
    populate() {
        state.providers = CAPS.map(capability => ({ ...PROVIDER, capability, models: [capability + "-model-a", capability + "-model-b"] }));
        send("kei:entries:changed", "plugin.enabled");
        send("kei:plugins:changed", "plugin.enabled");
        send("kei:host:status", status());
    },
    set(values) { Object.assign(state, values); },
    calls: () => [...state.calls],
};

app.whenReady().then(() => {
    win = new BrowserWindow({
        width: 1100, height: 780, show: true, frame: process.env.KEI_FIXTURE_FRAME === "1",
        webPreferences: {
            preload: path.join(frontend, "src", "preload", "bridge.js"),
            contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
            additionalArguments: ["--kei-window=admin"],
        },
    });
    if (process.env.KEI_FIXTURE_BLANK) win.loadURL("about:blank"); else win.loadFile(path.join(frontend, "src", "renderer", "admin", "admin.html"));
});
