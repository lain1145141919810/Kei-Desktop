"use strict";
// Kei Desktop shell — trusted main process.
// Launches (or attaches to) the Kei host, keeps its credentials here, and brokers plugin
// management and page sessions for the two trusted windows (desktop and admin).

const { app, BrowserWindow, ipcMain, dialog, protocol, session, globalShortcut, clipboard, Notification } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { HostClient } = require("./host-client");
const { PageBroker, PAGE_SCHEME } = require("./page-broker");
const { WINDOW_SLOTS, PLUGIN_ID, ENTRY_ID, isPlainObject, validateEntryMetadata, isTrustedPageUrl, isAllowedFilePath, parseFrameUrl, auditScheme } = require("./page-protocol");
const { fileURLToPath } = require("node:url");
const { ExecutorService } = require("./executor-service");
const { McpService } = require("./mcp-service");
const { CaptureService, OBSERVATION_PLUGIN } = require("./capture-service");
const { ConversationStore } = require("./conversation-store");
const { windowsSelection } = require("./windows-selection");
const { ChatService } = require("./chat-service");
const { CompactWindow } = require("./compact-window");
const { FocusService } = require("./focus-service");
const { TaskSessions } = require("./task-sessions");
const { Presentation } = require("./presentation");
const { sanitizeSelection } = require("./service-validation");

app.commandLine.appendSwitch("lang", "ja");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const RENDERER_DIR = path.join(APP_ROOT, "src", "renderer");
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MODEL_CAPABILITIES = new Set(["tts", "asr", "vision", "embedding"]);

if (process.env.KEI_PROFILE_DIR) app.setPath("userData", path.resolve(process.env.KEI_PROFILE_DIR));

protocol.registerSchemesAsPrivileged([
    { scheme: PAGE_SCHEME, privileges: { standard: true, secure: true } },
]);

// ---------------------------------------------------------------- configuration

function argValue(name) {
    const prefix = `--${name}=`;
    const found = process.argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
}

function hostOptions() {
    const connectionFile = argValue("host-connection") || process.env.KEI_HOST_CONNECTION;
    if (connectionFile) return { connectionFile: path.resolve(connectionFile) };
    return {
        python: argValue("host-python") || process.env.KEI_HOST_PYTHON || (process.platform === "win32" ? "python" : "python3"),
        artifact: path.resolve(argValue("host-artifact") || process.env.KEI_HOST_ARTIFACT
            || path.join(APP_ROOT, "..", "backend-acceptance", "kei-host.pyz")),
        dataDir: path.resolve(argValue("data-dir") || process.env.KEI_DATA_DIR
            || path.join(app.getPath("userData"), "kei-host")),
        // Round 07: operator-chosen executor manifests / config (authorizes their programs).
        executorDir: (argValue("executor-dir") || process.env.KEI_EXECUTOR_DIR) ? path.resolve(argValue("executor-dir") || process.env.KEI_EXECUTOR_DIR) : undefined,
        executorConfig: (argValue("executor-config") || process.env.KEI_EXECUTOR_CONFIG) ? path.resolve(argValue("executor-config") || process.env.KEI_EXECUTOR_CONFIG) : undefined,
        chatConfig: (argValue("chat-config") || process.env.KEI_CHAT_CONFIG) ? path.resolve(argValue("chat-config") || process.env.KEI_CHAT_CONFIG) : undefined,
    };
}

// ---------------------------------------------------------------- audit log

let auditFile = null;
function audit(type, details = {}) {
    const line = JSON.stringify({ time: new Date().toISOString(), type, ...details });
    try {
        if (!auditFile) {
            const dir = path.join(app.getPath("userData"), "logs");
            fs.mkdirSync(dir, { recursive: true });
            auditFile = path.join(dir, "shell-events.log");
        }
        fs.appendFileSync(auditFile, line + "\n");
    } catch { /* logging must never break the shell */ }
    if (process.env.KEI_SHELL_TRACE === "1") console.log("[kei-shell]", line);
}

// ---------------------------------------------------------------- host + broker

const host = new HostClient(hostOptions());
const broker = new PageBroker(host, audit);
const windows = { desktop: null, admin: null };
const compact = new CompactWindow(() => windows.desktop, audit);
// Toolbar timer chip and completion notices for kei.focus (Round 12 README, "Focus timer").
const focus = new FocusService({
    host, audit,
    publish: snapshot => broadcast("kei:focus:state", snapshot),
    notify: notice => {
        const win = windows.desktop;
        if (win && !win.isDestroyed()) win.webContents.send("kei:focus:notice", notice);
        if (Notification.isSupported()) {
            try { new Notification({ title: notice.title, body: notice.body, icon: path.join(APP_ROOT, "assets", "kei-logo.png"), silent: false }).show(); } catch { /* optional */ }
        }
    },
});
const privatePresentation = path.join(APP_ROOT, "assets", "private-presentation");
const presentation = new Presentation(path.join(app.getPath("userData"), "presentation.json"), {
    opening: path.join(privatePresentation, "startup.mp4"),
    ending: path.join(privatePresentation, "shutdown.mp4"),
    voice: path.join(privatePresentation, "startup.wav"),
}, dialog, () => windows.desktop);
let closeState = null;
let closeAllowed = false;
let revealDesktop = null;
let hostState = { connected: false, error: null, status: null };
let personaVersion = 0;
let lastPersonaRevision = 0;

function publishPersonaChanged(payload = {}) {
    const rev = Number.isInteger(payload.revision) ? payload.revision : null;
    if (rev !== null && rev <= lastPersonaRevision) return;
    if (rev !== null) lastPersonaRevision = rev;
    personaVersion++;
    // Redacted metadata only (never raw policyText).
    broadcast("kei:persona:changed", payload);
}

function broadcast(channel, ...args) {
    for (const win of Object.values(windows)) {
        if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
    }
}

function publicStatus() {
    const status = hostState.status || {};
    return {
        connected: hostState.connected,
        error: hostState.error,
        installed: status.installed ?? null,
        ready: status.ready ?? null,
        pluginFeatures: Array.isArray(status.pluginFeatures) ? status.pluginFeatures : [],
        mode: host.describe().mode,
    };
}

async function refreshStatus() {
    try { hostState.status = await host.request("GET", "/v1/status"); } catch { /* keep last */ }
    broadcast("kei:host:status", publicStatus());
}

function registryChanged(reason) {
    broadcast("kei:entries:changed", reason);
    broadcast("kei:plugins:changed", reason);
    refreshStatus();
}

host.on("lifecycle", event => {
    audit("host.lifecycle", { event: event.type, pluginId: event.pluginId, sequence: event.sequence });
    if (event.type === "persona.changed") {
        publishPersonaChanged(event.data || {});
        return;
    }
    if (event.type === "chat.configured") {
        broadcast("kei:chat:config-changed", event.data || {});
        return;
    }
    broker.onLifecycle(event);
    capture.onLifecycle(event); // Round 08
    if (event.pluginId === "kei.focus") focus.invalidate();
    registryChanged(event.type);
});
host.on("reset", () => {
    audit("host.reset");
    lastPersonaRevision = 0;
    broker.closeAll("reset");
    capture.stop("reset"); // Round 08
    focus.invalidate();
    registryChanged("reset");
});
host.on("disconnected", reason => {
    hostState.connected = false;
    hostState.error = "host_unavailable";
    audit("host.disconnected", { reason });
    broker.closeAll("host_disconnected");
    capture.onHostLost(); // Round 08
    focus.invalidate();
    broadcast("kei:host:status", publicStatus());
    broadcast("kei:entries:changed", "disconnected");
});
host.on("connected", () => {
    hostState.connected = true;
    hostState.error = null;
    audit("host.connected");
    focus.invalidate();
    void sessions.resume();
    registryChanged("connected");
});

// ---------------------------------------------------------------- windows

function webPreferences(kind) {
    return {
        preload: path.join(APP_ROOT, "src", "preload", "bridge.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        spellcheck: false,
        ...(kind === "desktop" ? { autoplayPolicy: "no-user-gesture-required" } : {}),
        additionalArguments: [`--kei-window=${kind}`],
        // Test harness only: render without a display server (headless CI / sandbox).
        offscreen: process.env.KEI_OFFSCREEN === "1",
    };
}

function createDesktopWindow() {
    const win = new BrowserWindow({
        width: 1280, height: 720, minWidth: 960, minHeight: 600,
        title: "Kei Desktop", frame: false, backgroundColor: compact.supported() ? "#00000000" : "#0d0d10", show: false,
        transparent: compact.supported(),
        icon: path.join(APP_ROOT, "assets", "kei-logo.png"),
        webPreferences: webPreferences("desktop"),
    });
    // Keep the native surface layered while the renderer alone changes its background.
    if (process.platform === "win32" && compact.supported()) win.setOpacity(1);
    windows.desktop = win;
    let painted = false;
    let startupReady = false;
    const show = () => {
        if (!win.isDestroyed()) win.show();
        clearTimeout(startupDeadline);
        revealDesktop = null;
    };
    const startupDeadline = setTimeout(show, 3000);
    win.once("ready-to-show", () => {
        painted = true;
        if (startupReady) show();
    });
    revealDesktop = () => {
        startupReady = true;
        if (painted) show();
    };
    win.on("close", prepareClose);
    win.on("closed", () => {
        clearTimeout(startupDeadline);
        revealDesktop = null;
        windows.desktop = null;
        compact.reset();
        void capture.stop("window_closed");
    });
    win.loadFile(path.join(RENDERER_DIR, "desktop", "index.html"));
    return win;
}

const ADMIN_SECTIONS = new Set(["plugins", "executors", "mcp", "models", "personas", "health"]);

function openAdminWindow(section) {
    const focusSection = typeof section === "string" && ADMIN_SECTIONS.has(section) ? section : null;
    if (windows.admin && !windows.admin.isDestroyed()) {
        windows.admin.show();
        windows.admin.focus();
        if (focusSection) windows.admin.webContents.send("kei:admin:focus", focusSection);
        return windows.admin;
    }
    const win = new BrowserWindow({
        width: 1100, height: 780, minWidth: 720, minHeight: 520,
        title: "Kei Desktop 管理", backgroundColor: "#f3f1ec", show: false, autoHideMenuBar: true,
        icon: path.join(APP_ROOT, "assets", "kei-logo.png"),
        webPreferences: webPreferences("admin"),
    });
    windows.admin = win;
    win.once("ready-to-show", () => win.show());
    if (focusSection) {
        win.webContents.once("did-finish-load", () => {
            if (!win.isDestroyed()) win.webContents.send("kei:admin:focus", focusSection);
        });
    }
    win.on("closed", () => { windows.admin = null; });
    win.loadFile(path.join(RENDERER_DIR, "admin", "admin.html"));
    return win;
}

// ---------------------------------------------------------------- trusted IPC

// Only the main frame of one of our own windows, showing our own renderer file, may call.
const TRUSTED_PAGE = {
    desktop: pathToFileURL(path.join(RENDERER_DIR, "desktop", "index.html")).href,
    admin: pathToFileURL(path.join(RENDERER_DIR, "admin", "admin.html")).href,
};

function senderKind(event) {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return null;
    for (const [kind, win] of Object.entries(windows)) {
        if (!win || win.isDestroyed() || event.sender !== win.webContents) continue;
        const main = win.webContents.mainFrame;
        if (frame.processId !== main.processId || frame.routingId !== main.routingId) continue;
        // Round 08: exact trusted page per window kind (no prefix match, no query).
        if (!isTrustedPageUrl(frame.url, TRUSTED_PAGE[kind])) continue;
        return kind;
    }
    return null;
}

function handle(channel, kinds, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
        const kind = senderKind(event);
        if (!kind || !kinds.includes(kind)) {
            audit("ipc.denied", { channel, kind });
            return { ok: false, error: { code: "forbidden" } };
        }
        try {
            return await fn({ event, kind }, ...args);
        } catch (error) {
            return { ok: false, error: { code: error.code || "internal_error", message: error.code ? undefined : String(error.message || error) } };
        }
    });
}

const ANY = ["desktop", "admin"];
const ADMIN = ["admin"];

function sanitizeEntry(entry) {
    // Round 08: malformed host metadata is dropped (returns null), never passed through.
    const valid = validateEntryMetadata(entry);
    return valid ? { pluginId: valid.pluginId, id: valid.id, title: valid.title, slot: valid.slot, order: valid.order, icon: valid.icon } : null;
}

function sanitizePlugin(p) {
    return {
        id: p.id, name: p.name, version: p.version, apiVersion: p.apiVersion,
        permissions: Array.isArray(p.permissions) ? p.permissions : [],
        enabled: Boolean(p.enabled),
        grants: Array.isArray(p.grants) ? p.grants : [],
        effectiveGrants: Array.isArray(p.effectiveGrants) ? p.effectiveGrants : undefined,
        lastError: p.lastError ?? null,
        diagnostic: p.diagnostic ?? null,
        compatibility: p.compatibility ?? undefined,
        declaredEntries: Array.isArray(p.declaredEntries) ? p.declaredEntries.map(sanitizeEntry).filter(Boolean) : undefined,
        activeEntries: Array.isArray(p.activeEntries) ? p.activeEntries.map(sanitizeEntry).filter(Boolean) : undefined,
    };
}

function checkPluginId(id) {
    if (typeof id !== "string" || !PLUGIN_ID.test(id)) {
        const error = new Error("invalid plugin id"); error.code = "invalid_request"; throw error;
    }
}

handle("kei:status", ANY, async () => ({ ok: true, status: publicStatus() }));

const PERSONA_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function checkPersonaId(id) {
    if (typeof id !== "string" || !PERSONA_ID_RE.test(id)) {
        const error = new Error("invalid persona id"); error.code = "invalid_persona_id"; throw error;
    }
}

handle("kei:personas:state", ANY, async () => ({ ok: true, value: await host.request("GET", "/v1/personas") }));
handle("kei:personas:create", ADMIN, async (_ctx, payload) => {
    if (!isPlainObject(payload)) return { ok: false, error: { code: "invalid_persona" } };
    const value = await host.request("POST", "/v1/personas", payload);
    audit("persona.create", { personaId: value?.persona?.id ?? null });
    publishPersonaChanged({ revision: value?.state?.revision, reason: "created", activePersonaId: value?.state?.activePersonaId ?? null });
    return { ok: true, value };
});
handle("kei:personas:update", ADMIN, async (_ctx, id, payload) => {
    checkPersonaId(id);
    if (!isPlainObject(payload)) return { ok: false, error: { code: "invalid_persona" } };
    const value = await host.request("PUT", `/v1/personas/${id}`, payload);
    audit("persona.update", { personaId: id });
    publishPersonaChanged({ revision: value?.state?.revision, reason: "updated", activePersonaId: value?.state?.activePersonaId ?? null });
    return { ok: true, value };
});
handle("kei:personas:restore", ADMIN, async (_ctx, id) => {
    checkPersonaId(id);
    const value = await host.request("POST", `/v1/personas/${id}/restore`, {});
    audit("persona.restore", { personaId: id });
    publishPersonaChanged({ revision: value?.state?.revision, reason: "restored", activePersonaId: value?.state?.activePersonaId ?? null });
    return { ok: true, value };
});
handle("kei:personas:delete", ADMIN, async (_ctx, id) => {
    checkPersonaId(id);
    const value = await host.request("DELETE", `/v1/personas/${id}`, {});
    audit("persona.delete", { personaId: id });
    publishPersonaChanged({ revision: value?.state?.revision, reason: "deleted", activePersonaId: value?.state?.activePersonaId ?? null });
    return { ok: true, value };
});
handle("kei:personas:pairing", ADMIN, async (_ctx, payload) => {
    if (!isPlainObject(payload)) return { ok: false, error: { code: "invalid_pairing" } };
    const value = await host.request("PUT", "/v1/personas/pairing", payload);
    audit("persona.pairing", { modelKey: payload.modelKey ?? null, personaId: payload.personaId ?? null });
    publishPersonaChanged({ revision: value?.revision, reason: "paired", activeModel: value?.activeModel ?? null, activePersonaId: value?.activePersonaId ?? null });
    return { ok: true, value };
});
handle("kei:personas:preview", ADMIN, async (_ctx, payload) => {
    if (!isPlainObject(payload)) return { ok: false, error: { code: "invalid_preview" } };
    const value = await host.request("POST", "/v1/personas/preview", payload);
    audit("persona.preview", { modelKey: value?.modelKey ?? null, mode: value?.mode ?? null });
    return { ok: true, value };
});
handle("kei:personas:capabilities", ["desktop"], async (_ctx, payload) => {
    if (!isPlainObject(payload)) return { ok: false, error: { code: "invalid_capabilities" } };
    const value = await host.request("PUT", "/v1/personas/capabilities", payload);
    audit("persona.capabilities", { modelKey: value?.activeModel ?? null, supportsBodyMotion: Boolean(value?.activeCapabilities?.supportsBodyMotion) });
    if (Number.isInteger(value?.revision) && value.revision > lastPersonaRevision) {
        publishPersonaChanged({ revision: value.revision, reason: "capabilities", activeModel: value?.activeModel ?? null, activePersonaId: value?.activePersonaId ?? null });
    }
    return { ok: true, value };
});

handle("kei:models:list", ADMIN, async () => ({ ok: true, value: await host.request("GET", "/v1/models") }));
handle("kei:models:select", ADMIN, async (_ctx, capability, selection) => {
    if (!MODEL_CAPABILITIES.has(capability) || !isPlainObject(selection)) return { ok: false, error: { code: "model_selection_invalid" } };
    return { ok: true, value: await host.request("PUT", `/v1/models/selection/${capability}`, selection) };
});
handle("kei:models:invoke", ["desktop"], async (_ctx, capability, input) => {
    if (!MODEL_CAPABILITIES.has(capability) || !isPlainObject(input)) return { ok: false, error: { code: "model_input_invalid" } };
    const body = { input };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 2 * 1024 * 1024) {
        return { ok: false, error: { code: "body_too_large" } };
    }
    return { ok: true, value: await host.request("POST", `/v1/models/invoke/${capability}`, body) };
});

handle("kei:entries", ANY, async ({ kind }) => {
    if (!hostState.connected) return { ok: true, entries: [] };
    const entries = await host.request("GET", "/v1/entries");
    const valid = (Array.isArray(entries) ? entries : []).map(sanitizeEntry).filter(Boolean);
    return { ok: true, entries: valid.filter(e => WINDOW_SLOTS[kind].includes(e.slot)) };
});

handle("kei:page:open", ANY, async ({ event, kind }, pluginId, entryId) => {
    checkPluginId(pluginId);
    if (typeof entryId !== "string" || !ENTRY_ID.test(entryId)) return { ok: false, error: { code: "invalid_request" } };
    return broker.open(event.sender, kind, pluginId, entryId);
});

handle("kei:page:call", ANY, async ({ event }, tag, message) => {
    if (typeof tag !== "string") return { ok: false, error: { code: "page_closed" } };
    return broker.call(event.sender, tag, message);
});

handle("kei:page:close", ANY, async ({ event }, tag, reason) => ({ ok: broker.closeOwnedBy(event.sender, String(tag), reason === "navigated" ? "navigated" : "user") }));

handle("kei:admin:open", ["desktop"], async (_ctx, section) => { openAdminWindow(section); return { ok: true }; });

handle("kei:chat:config:get", ANY, async () => ({ ok: true, value: await host.request("GET", "/v1/chat/config") }));
handle("kei:chat:config:save", ADMIN, async (_ctx, payload) => {
    if (!isPlainObject(payload)) return { ok: false, error: { code: "invalid_chat_config" } };
    const value = await host.request("PUT", "/v1/chat/config", payload);
    audit("chat.config.save", { configured: Boolean(value?.configured), state: value?.state ?? null, isLocalEndpoint: Boolean(value?.isLocalEndpoint), hasCredentialRef: Boolean(value?.credentialRef) });
    broadcast("kei:chat:config-changed", { configured: Boolean(value?.configured), state: value?.state ?? null });
    return { ok: true, value };
});
handle("kei:chat:config:test", ADMIN, async (_ctx, payload) => {
    if (payload !== undefined && !isPlainObject(payload)) return { ok: false, error: { code: "invalid_chat_config" } };
    const value = await host.request("POST", "/v1/chat/config/test", payload || {});
    audit("chat.config.test", { ok: Boolean(value?.ok), code: value?.code ?? null, latencyMs: value?.latencyMs ?? null, isLocalEndpoint: Boolean(value?.isLocalEndpoint) });
    return { ok: true, value };
});

handle("kei:focus:status", ["desktop"], async () => ({ ok: true, focus: focus.status() }));
handle("kei:focus:control", ["desktop"], async (_ctx, action, args) =>
    typeof action === "string" ? focus.control(action, args && typeof args === "object" ? args : {}) : { ok: false, error: { code: "invalid_request" } });
handle("kei:compact:status", ["desktop"], async () => compact.status());
handle("kei:compact:set", ["desktop"], async (_ctx, enabled, rect) =>
    typeof enabled === "boolean" ? compact.set(enabled, rect) : compact.status());
ipcMain.on("kei:compact:hit", (event, interactive) => {
    if (senderKind(event) === "desktop" && typeof interactive === "boolean") compact.hit(interactive);
});
ipcMain.on("kei:compact:geometry", (event, rect, scale) => {
    if (senderKind(event) === "desktop") compact.updateGeometry(rect, scale);
});
ipcMain.on("kei:compact:settle", event => {
    if (senderKind(event) === "desktop") compact.settle();
});
ipcMain.on("kei:compact:move", (event, x, y) => {
    if (senderKind(event) === "desktop") compact.move(x, y);
});

handle("kei:presentation:status", ["desktop"], async () => ({ ok: true, value: presentation.status() }));
handle("kei:presentation:ready", ["desktop"], async () => {
    revealDesktop?.();
    return { ok: true };
});
handle("kei:presentation:choose", ["desktop"], async (_ctx, slot) => ({ ok: true, value: await presentation.choose(slot) }));
handle("kei:presentation:remove", ["desktop"], async (_ctx, slot) =>
    ["opening", "ending", "voice"].includes(slot) ? { ok: true, value: presentation.patch({ [slot]: null }) } : { ok: false });
handle("kei:presentation:mute", ["desktop"], async (_ctx, muted) =>
    typeof muted === "boolean" ? { ok: true, value: presentation.patch({ muted }) } : { ok: false });
handle("kei:presentation:asset", ["desktop"], async (_ctx, slot) =>
    ({ ok: true, value: typeof slot === "string" ? await presentation.read(slot) : null }));
handle("kei:presentation:complete", ["desktop"], async () => {
    if (closeState) finishClose();
    return { ok: true };
});

handle("kei:window", ["desktop"], async (_ctx, action) => {
    const win = windows.desktop;
    if (action === "minimize") win?.minimize();
    else if (action === "close") app.quit();
    return { ok: true };
});

handle("kei:plugins:list", ADMIN, async () => {
    const plugins = await host.request("GET", "/v1/plugins");
    return { ok: true, plugins: plugins.map(sanitizePlugin) };
});

handle("kei:plugins:detail", ADMIN, async (_ctx, id) => {
    checkPluginId(id);
    return { ok: true, plugin: sanitizePlugin(await host.request("GET", `/v1/plugins/${id}`)) };
});

// The package is chosen with the OS chooser here in main; the renderer never supplies a path.
handle("kei:plugins:install", ADMIN, async () => {
    const result = await dialog.showOpenDialog(windows.admin, {
        title: "プラグインをインストール",
        buttonLabel: "インストール",
        filters: [{ name: "Kei プラグイン (ZIP)", extensions: ["zip"] }],
        properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
    const file = result.filePaths[0];
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, error: { code: "invalid_archive" } };
    if (stat.size > MAX_PACKAGE_BYTES) return { ok: false, error: { code: "package_too_large" } };
    const bytes = fs.readFileSync(file);
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return { ok: false, error: { code: "invalid_archive" } };
    const plugin = await host.request("POST", "/v1/plugins/install", bytes);
    audit("plugin.install", { pluginId: plugin.id, version: plugin.version, file: path.basename(file) });
    registryChanged("installed");
    return { ok: true, plugin: sanitizePlugin(plugin) };
});

handle("kei:plugins:enable", ADMIN, async (_ctx, id, grants) => {
    checkPluginId(id);
    if (!Array.isArray(grants) || !grants.every(g => typeof g === "string" && g.length <= 128)) {
        return { ok: false, error: { code: "invalid_grants" } };
    }
    const plugin = await host.request("POST", `/v1/plugins/${id}/enable`, { grants: [...new Set(grants)] });
    audit("plugin.enable", { pluginId: id, grants });
    registryChanged("enabled");
    return { ok: true, plugin: sanitizePlugin(plugin) };
});

handle("kei:plugins:disable", ADMIN, async (_ctx, id) => {
    checkPluginId(id);
    const plugin = await host.request("POST", `/v1/plugins/${id}/disable`, {});
    broker.closePlugin(id, "plugin.disabled");
    capture.onLifecycle({ type: "plugin.disabled", pluginId: id }); // Round 08: stop at once
    audit("plugin.disable", { pluginId: id });
    registryChanged("disabled");
    return { ok: true, plugin: sanitizePlugin(plugin) };
});

handle("kei:plugins:reload", ADMIN, async (_ctx, id) => {
    checkPluginId(id);
    broker.closePlugin(id, "plugin.reloaded");
    capture.onLifecycle({ type: "plugin.reloaded", pluginId: id }); // Round 08
    const plugin = await host.request("POST", `/v1/plugins/${id}/reload`, {});
    audit("plugin.reload", { pluginId: id });
    registryChanged("reloaded");
    return { ok: true, plugin: sanitizePlugin(plugin) };
});

handle("kei:plugins:uninstall", ADMIN, async (_ctx, id, options) => {
    checkPluginId(id);
    const retainData = isPlainObject(options) ? options.retainData !== false : true;
    const openPages = broker.openCount(id);
    broker.closePlugin(id, "plugin.uninstalled");
    capture.onLifecycle({ type: "plugin.uninstalled", pluginId: id }); // Round 08
    const result = await host.request("DELETE", `/v1/plugins/${id}`, { retainData });
    audit("plugin.uninstall", { pluginId: id, retainData: Boolean(result.retainData ?? retainData), openPagesClosed: openPages });
    registryChanged("uninstalled");
    return { ok: true, result: { id: result.id ?? id, retainData: Boolean(result.retainData ?? retainData), openPagesClosed: openPages } };
});

// ---------------------------------------------------------------- Round 07: executors and MCP
// Executor listing is shared. The trusted desktop uses the 作業 session routes.
// Task administration and general MCP controls use the admin window.

// Background 作業 sessions observe every executor broadcast (Round 12 design pass).
let sessions = null;
const executors = new ExecutorService(host, { broadcast: (channel, ...args) => { broadcast(channel, ...args); sessions?.observe(channel, ...args); }, audit });
const SESSION_TEXT = {
    succeeded: ["作業が終わりました", title => title],
    failed: ["作業がうまくいきませんでした", (title, detail) => `${title}（${detail || "error"}）`],
    cancelled: ["作業を中止しました", title => title],
    input: ["作業から確認があります", (title, detail) => detail || title],
};
sessions = new TaskSessions({
    executors, audit, file: path.join(app.getPath("userData"), "task-sessions.json"),
    publish: snapshot => { const win = windows.desktop; if (win && !win.isDestroyed()) win.webContents.send("kei:sessions:changed", snapshot); },
    notify: notice => {
        const win = windows.desktop;
        if (win && !win.isDestroyed()) win.webContents.send("kei:sessions:notice", notice);
        const [title, body] = SESSION_TEXT[notice.kind] || SESSION_TEXT.succeeded;
        if (Notification.isSupported()) {
            try { new Notification({ title, body: String(body(notice.title, notice.detail)).slice(0, 200), icon: path.join(APP_ROOT, "assets", "kei-logo.png") }).show(); } catch { /* optional */ }
        }
    },
});
const mcp = new McpService(host, { audit, adminWindow: () => windows.admin });
mcp.desktopWindow = () => windows.desktop; // Round 08: plugin confirmations may come from desktop pages

handle("kei:executors:list", ANY, async () => executors.list());
handle("kei:tasks:recent", ADMIN, async () => executors.recent());
// Desktop 作業 panel: the same validated executor path, scoped to sessions.
handle("kei:sessions:list", ["desktop"], async () => ({ ok: true, value: sessions.snapshot() }));
handle("kei:sessions:submit", ["desktop"], async (_ctx, executorId, input, options) => sessions.submit(executorId, input, options));
handle("kei:sessions:cancel", ["desktop"], async (_ctx, taskId) => sessions.cancel(taskId));
handle("kei:sessions:answer", ["desktop"], async (_ctx, taskId, inputId, value) => sessions.answer(taskId, inputId, value));
handle("kei:sessions:dismiss", ["desktop"], async (_ctx, taskId) => typeof taskId === "string" ? sessions.dismiss(taskId) : { ok: false, error: { code: "invalid_request" } });
handle("kei:tasks:events", ADMIN, async (_ctx, taskId) => executors.events(taskId));
handle("kei:tasks:submit", ADMIN, async (_ctx, executorId, input, options) => executors.submit(executorId, input, options));
handle("kei:tasks:cancel", ADMIN, async (_ctx, taskId) => executors.cancel(taskId));
handle("kei:tasks:input", ADMIN, async (_ctx, taskId, inputId, value) => executors.answer(taskId, inputId, value));

handle("kei:mcp:list", ADMIN, async () => mcp.list());
handle("kei:mcp:save", ADMIN, async (_ctx, id, definition) => mcp.save(id, definition));
handle("kei:mcp:enabled", ADMIN, async (_ctx, id, enabled) => mcp.setEnabled(id, enabled));
handle("kei:mcp:delete", ADMIN, async (_ctx, id) => mcp.remove(id));
handle("kei:mcp:tools", ADMIN, async (_ctx, id, mode) => mcp.tools(id, ["list", "refresh", "reconnect"].includes(mode) ? mode : "list"));
handle("kei:mcp:call", ADMIN, async (_ctx, serverId, toolName, args) => mcp.call(serverId, toolName, args));
handle("kei:mcp:cancel", ADMIN, async (_ctx, requestId) => mcp.cancel(requestId));

// ---------------------------------------------------------------- Round 08: trusted screen capture
// Decision 5. The current conversation is owned by main; plugin pages never supply it.
// Round 09: one persisted, trusted active conversation for chat, PDF pages and capture.
const conversations = new ConversationStore(path.join(app.getPath("userData"), "conversations.json"));
broker.conversation = () => conversations.active;
const capture = new CaptureService(host, { audit, broadcast, parentWindow: () => windows.desktop, conversation: () => conversations.active });
broker.onFrameClosed = frame => capture.onFrameClosed(frame);

// Round 08 decision 1: relayed kei:mcp-confirm from a plugin page (pluginId from the frame record).
handle("kei:mcp:plugin-confirm", ANY, async ({ event }, tag, request) => {
    const frame = typeof tag === "string" ? broker.ownFrame(event.sender, tag) : null;
    if (!frame || !isPlainObject(request)) return { ok: false, error: { code: "page_closed" } };
    let name = frame.pluginId;
    try { name = (await host.request("GET", `/v1/plugins/${frame.pluginId}`)).name || name; } catch { /* keep id */ }
    return mcp.confirmForPlugin(frame.pluginId, name, request.serverId, request.toolName, request.arguments);
});

// ---------------------------------------------------------------- Round 09: chat and reading
// A conversation switch cancels the previous capture first, then closes pages bound to the
// previous conversation so their late results are discarded.
let selectionRequest = 0;
let conversationVersion = 0;
broker.conversationVersion = () => conversationVersion;
const chat = new ChatService(host, conversations, {
    broadcast, audit,
    async onSwitch(previous) {
        selectionRequest++;
        conversationVersion++;
        const stopped = capture.onConversationChanged();
        broker.closeConversation(previous, "conversation_changed");
        await stopped;
    },
});
const DESKTOP = ["desktop"];
handle("kei:chat:state", DESKTOP, async () => chat.state());
handle("kei:chat:history", DESKTOP, async () => chat.history());
handle("kei:chat:send", DESKTOP, async (_ctx, question) => chat.send(question));
handle("kei:chat:resend", DESKTOP, async (_ctx, requestId) => chat.resend(requestId));
handle("kei:chat:retry", DESKTOP, async (_ctx, turnId) => chat.retry(turnId));
handle("kei:chat:cancel", DESKTOP, async (_ctx, turnId) => chat.cancel(turnId));
handle("kei:chat:new", DESKTOP, async () => chat.newConversation());
handle("kei:chat:activate", DESKTOP, async (_ctx, id) => chat.activate(id));
handle("kei:chat:visual", DESKTOP, async (_ctx, kind, turnId) => {
    if (!["reply", "work-input", "work-success", "work-error"].includes(kind) ||
        (kind === "reply" && (typeof turnId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(turnId)))) {
        return { state: "fallback", code: "invalid_visual_context" };
    }
    const expectedConversation = conversations.active;
    const expectedVersion = conversationVersion;
    const expectedPersona = personaVersion;
    try {
        const result = await host.request("POST", "/v1/chat/visual", {
            kind,
            turnId: kind === "reply" ? turnId : undefined,
            conversationId: kind === "reply" ? expectedConversation : undefined,
        });
        if (conversationVersion !== expectedVersion || conversations.active !== expectedConversation) {
            return { state: "fallback", code: "conversation_changed" };
        }
        if (personaVersion !== expectedPersona) {
            return { state: "fallback", code: "persona_changed" };
        }
        return result;
    } catch { return { state: "fallback", code: "visual_unavailable" }; }
});

const READING_PLUGIN = "kei.pdf";
const READING_ENTRIES = new Set(["reading", "selection"]);
// The trusted renderer asks main to vet a selection for one of its own kei.pdf frames bound
// to the active conversation; only then does it post kei:selection to that frame.
handle("kei:reading:forward", DESKTOP, async ({ event }, tag, selection) => {
    const frame = typeof tag === "string" ? broker.ownFrame(event.sender, tag) : null;
    if (!frame || frame.pluginId !== READING_PLUGIN || !READING_ENTRIES.has(frame.entryId)) return { ok: false, error: { code: "reading_unavailable" } };
    if (frame.conversationId !== conversations.active) return { ok: false, error: { code: "conversation_changed" } };
    const checked = sanitizeSelection(selection);
    if (checked.error) { audit("reading.selection.rejected", { code: checked.error }); return { ok: false, error: { code: checked.error } }; }
    audit("reading.selection", { conversationId: frame.conversationId, entryId: frame.entryId, chars: checked.selection.text.length, source: checked.selection.source, page: checked.selection.page });
    return { ok: true, selection: checked.selection };
});

// Ctrl+Alt+Q: read the user's current selection in another application, before focus moves.
// Linux: the X11/Wayland PRIMARY selection. KEI_SELECTION_FIXTURE (tests only) supplies
// synthetic text instead. The Windows UI Automation adapter is integrated by Windows Codex.
async function readExternalSelection() {
    if (process.env.KEI_SELECTION_FIXTURE) {
        let text = "";
        try { text = fs.readFileSync(process.env.KEI_SELECTION_FIXTURE, "utf8"); } catch { /* empty */ }
        return { text, source: "合成した選択（テスト用）", page: null, synthetic: true };
    }
    if (process.platform === "linux") return { text: clipboard.readText("selection"), source: "選択中の文章（Ctrl+Alt+Q）", page: null };
    if (process.platform === "win32") return windowsSelection();
    return { error: "selection_unsupported" };
}
async function readingShortcut(reveal = false) {
    const win = windows.desktop;
    if (!win || win.isDestroyed()) return;
    const request = ++selectionRequest;
    const conversationId = conversations.active;
    const raw = await readExternalSelection();
    if (selectionRequest !== request || conversations.active !== conversationId || windows.desktop !== win || win.isDestroyed()) return;
    const checked = raw.error ? { error: raw.error } : sanitizeSelection(raw);
    audit("reading.shortcut", { ok: !checked.error, code: checked.error ?? null, synthetic: Boolean(raw.synthetic), chars: raw.text?.length ?? 0 });
    if (reveal && !checked.error) {
        compact.set(false);
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
    win.webContents.send("kei:reading:selected", { ...checked, conversationId, synthetic: Boolean(raw.synthetic) });
}

// The same trusted path as Ctrl+Alt+Q, from the reading sheet's explicit button.
handle("kei:reading:read-external", DESKTOP, async () => { await readingShortcut(); return { ok: true }; });

handle("kei:capture:status", ANY, async () => ({ ok: true, status: capture.status() }));
// Explicit enablement from the desktop window's own 画面観察 control.
handle("kei:capture:toggle", ["desktop"], async () => capture.toggle({ type: "desktop" }));
// Relayed kei:capture-request from an observation page: the page may ask, main decides.
handle("kei:capture:request", ANY, async ({ event }, tag, enabled) => {
    const frame = typeof tag === "string" ? broker.ownFrame(event.sender, tag) : null;
    if (!frame || frame.pluginId !== OBSERVATION_PLUGIN || typeof enabled !== "boolean") {
        audit("capture.request.denied", { pluginId: frame?.pluginId ?? null });
        return { ok: false, error: { code: "vision_scope_denied" } };
    }
    return enabled ? capture.start({ type: "page", tag }) : capture.stop("user", { type: "page", tag });
});

// ---------------------------------------------------------------- hardening

function installHardening() {
    const ses = session.defaultSession;
    // Round 08: file: is limited to the shell's own renderer and asset trees (after resolving
    // symlinks); kei-page: only answers the bound subframe; blob:/data: stay in-memory.
    const fileRoots = [RENDERER_DIR, path.join(APP_ROOT, "assets")].map(root => {
        try { return fs.realpathSync(root); } catch { return root; }
    });
    const fileAllowed = raw => {
        try {
            const resolved = path.resolve(fileURLToPath(raw));
            const real = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
            return isAllowedFilePath(resolved, [RENDERER_DIR, path.join(APP_ROOT, "assets")]) && isAllowedFilePath(real, fileRoots);
        } catch { return false; }
    };
    ses.webRequest.onBeforeRequest((details, callback) => {
        let scheme = "";
        try { scheme = new URL(details.url).protocol; } catch { /* invalid */ }
        let allowed;
        if (scheme === "file:") {
            allowed = fileAllowed(details.url);
            if (!allowed) audit("file.denied", { scheme: auditScheme(details.url) });
        } else if (scheme === `${PAGE_SCHEME}:`) {
            allowed = broker.authorizeRequest(details);
        } else {
            allowed = scheme === "devtools:" || scheme === "data:" || scheme === "blob:";
            if (!allowed) audit("network.denied", { scheme: auditScheme(details.url) });
        }
        callback({ cancel: !allowed });
    });
    ses.on("will-download", event => { event.preventDefault(); audit("download.denied"); });
    ses.setPermissionRequestHandler((_wc, permission, callback) => { audit("permission.denied", { permission }); callback(false); });
    ses.setPermissionCheckHandler(() => false);

    protocol.handle(PAGE_SCHEME, request => {
        const served = broker.serve(request.url);
        if (!served) return new Response("", { status: 404, headers: { "content-type": "text/plain" } });
        return new Response(served.body, { status: 200, headers: served.headers });
    });

    app.on("web-contents-created", (_event, contents) => {
        contents.setWindowOpenHandler(({ url }) => { audit("popup.denied", { scheme: auditScheme(url) }); return { action: "deny" }; });
        contents.on("will-attach-webview", event => event.preventDefault());
        contents.on("will-navigate", event => {
            // Our windows never navigate their main frame after the initial load.
            event.preventDefault();
            audit("navigation.denied", { scheme: auditScheme(event.url) });
        });
        contents.on("will-frame-navigate", details => {
            if (details.isMainFrame) return;
            if (broker.bindFrame(contents, details.url, details.frame)) return;
            details.preventDefault();
            // A plugin frame trying to leave its document is treated as a closed page.
            const current = parseFrameUrl(details.frame?.url || "");
            if (current) broker.close(current, "navigated");
            audit("frame-navigation.denied", { scheme: auditScheme(details.url) });
        });
        contents.on("render-process-gone", () => broker.closeWebContents(contents.id, "renderer_gone"));
        contents.on("destroyed", () => broker.closeWebContents(contents.id, "window_closed"));
        contents.on("did-start-navigation", details => {
            if (details.isMainFrame && !details.isSameDocument) broker.closeWebContents(contents.id, "window_reloaded");
        });
    });
}

// ---------------------------------------------------------------- lifecycle

function finishClose() {
    if (closeAllowed) return;
    clearTimeout(closeState);
    closeState = null;
    closeAllowed = true;
    setTimeout(() => app.quit(), 0);
}

function prepareClose(event) {
    const win = windows.desktop;
    if (closeAllowed || !win || win.isDestroyed() || !presentation.status().assets.ending.available) return;
    event.preventDefault();
    if (closeState) return;
    compact.set(false);
    if (win.isMinimized()) win.restore();
    closeState = setTimeout(finishClose, 7000);
    win.webContents.send("kei:presentation:closing");
}

app.on("before-quit", prepareClose);

app.whenReady().then(async () => {
    installHardening();
    audit("shell.start", { host: host.describe(), electron: process.versions.electron, platform: process.platform });
    createDesktopWindow();
    if (process.env.KEI_OPEN_ADMIN === "1") openAdminWindow();
    // Round 08: the legacy Ctrl+Alt+S observation toggle (decision 5).
    const shortcut = globalShortcut.register("CommandOrControl+Alt+S", () => capture.toggle({ type: "shortcut" }));
    audit("shortcut.register", { accelerator: "CommandOrControl+Alt+S", ok: shortcut });
    // Round 09: the legacy reading shortcut.
    const readingKey = globalShortcut.register("CommandOrControl+Alt+Q", () => void readingShortcut(true));
    audit("shortcut.register", { accelerator: "CommandOrControl+Alt+Q", ok: readingKey });
    if (compact.supported()) {
        // Ctrl+Alt+K is the v0.3.2 「ケイだけにする」 key; Ctrl+Alt+M stays for Round 11 users.
        for (const accelerator of ["CommandOrControl+Alt+K", "CommandOrControl+Alt+M"]) {
            const key = globalShortcut.register(accelerator, () => compact.toggle());
            audit("shortcut.register", { accelerator, ok: key });
        }
    }
    try {
        hostState.status = await host.start();
        hostState.connected = true;
        hostState.error = null;
        audit("host.ready", { installed: hostState.status.installed, epoch: hostState.status.epoch });
        chat.resumeAfterStart().catch(() => {}); // Round 09: resubmit unconfirmed sends (same requestId)
        focus.start();
        void sessions.resume();
    } catch (error) {
        hostState.error = error.code || "host_unavailable";
        audit("host.failed", { code: hostState.error, message: error.message });
    }
    registryChanged("startup");
});

let quitting = false;
app.on("will-quit", event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    focus.stop();
    broker.closeAll("shutdown");
    // Defer: quitting again inside the same will-quit turn can be ignored by Electron.
    capture.stop("shutdown").catch(() => {}).finally(() =>
        host.stop().finally(() => setTimeout(() => app.quit(), 0)));
});

app.on("window-all-closed", () => app.quit());
