"use strict";
// Privileged bridge for Kei's own windows only. Plugin frames never get a preload
// (nodeIntegrationInSubFrames is off), so nothing here is reachable from a plugin page.

const { contextBridge, ipcRenderer } = require("electron");

const kind = (process.argv.find(arg => arg.startsWith("--kei-window=")) || "").split("=")[1];

function subscribe(channel, callback) {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const common = {
    windowKind: kind,
    status: () => ipcRenderer.invoke("kei:status"),
    onStatus: callback => subscribe("kei:host:status", callback),
    entries: () => ipcRenderer.invoke("kei:entries"),
    onEntriesChanged: callback => subscribe("kei:entries:changed", callback),
    // Round 08: capture status for both windows; a frame's request is relayed by tag only.
    capture: {
        status: () => ipcRenderer.invoke("kei:capture:status"),
        request: (tag, enabled) => ipcRenderer.invoke("kei:capture:request", tag, enabled),
        onStatus: callback => subscribe("kei:capture:status", callback),
    },
    mcpConfirm: (tag, request) => ipcRenderer.invoke("kei:mcp:plugin-confirm", tag, request), // Round 08
    pages: {
        open: (pluginId, entryId) => ipcRenderer.invoke("kei:page:open", pluginId, entryId),
        call: (tag, message) => ipcRenderer.invoke("kei:page:call", tag, message),
        close: (tag, reason) => ipcRenderer.invoke("kei:page:close", tag, reason),
        onEvent: callback => subscribe("kei:page:event", callback),
        onClosed: callback => subscribe("kei:page:closed", callback),
    },
};

if (kind === "desktop") {
    contextBridge.exposeInMainWorld("kei", {
        ...common,
        openAdmin: section => ipcRenderer.invoke("kei:admin:open", section),
        executors: { list: () => ipcRenderer.invoke("kei:executors:list") }, // Round 07: read-only list
        models: { invoke: (capability, input) => ipcRenderer.invoke("kei:models:invoke", capability, input) },
        personas: {
            state: () => ipcRenderer.invoke("kei:personas:state"),
            setCapabilities: capabilities => ipcRenderer.invoke("kei:personas:capabilities", capabilities),
            onChanged: callback => subscribe("kei:persona:changed", callback),
        },
        window: action => ipcRenderer.invoke("kei:window", action),
        // 作業: background executor sessions (list, start, answer, cancel, dismiss finished).
        sessions: {
            list: () => ipcRenderer.invoke("kei:sessions:list"),
            submit: (executorId, input, options) => ipcRenderer.invoke("kei:sessions:submit", executorId, input, options),
            cancel: taskId => ipcRenderer.invoke("kei:sessions:cancel", taskId),
            answer: (taskId, inputId, value) => ipcRenderer.invoke("kei:sessions:answer", taskId, inputId, value),
            dismiss: taskId => ipcRenderer.invoke("kei:sessions:dismiss", taskId),
            onChanged: callback => subscribe("kei:sessions:changed", callback),
            onNotice: callback => subscribe("kei:sessions:notice", callback),
        },
        // Toolbar focus chip: snapshot + the timer's own controls, driven by main.
        focus: {
            status: () => ipcRenderer.invoke("kei:focus:status"),
            control: (action, args) => ipcRenderer.invoke("kei:focus:control", action, args),
            onState: callback => subscribe("kei:focus:state", callback),
            onNotice: callback => subscribe("kei:focus:notice", callback),
        },
        compact: {
            status: () => ipcRenderer.invoke("kei:compact:status"),
            set: (enabled, rect) => ipcRenderer.invoke("kei:compact:set", enabled, rect),
            hit: interactive => ipcRenderer.send("kei:compact:hit", interactive),
            move: (x, y) => ipcRenderer.send("kei:compact:move", x, y),
            geometry: (rect, scale) => ipcRenderer.send("kei:compact:geometry", rect, scale),
            settle: () => ipcRenderer.send("kei:compact:settle"),
            onChanged: callback => subscribe("kei:compact:changed", callback),
            onToggleRequested: callback => subscribe("kei:compact:toggle-requested", callback),
            onProbe: callback => subscribe("kei:compact:probe", callback),
        },
        presentation: {
            status: () => ipcRenderer.invoke("kei:presentation:status"),
            ready: () => ipcRenderer.invoke("kei:presentation:ready"),
            choose: slot => ipcRenderer.invoke("kei:presentation:choose", slot),
            remove: slot => ipcRenderer.invoke("kei:presentation:remove", slot),
            mute: value => ipcRenderer.invoke("kei:presentation:mute", value),
            asset: slot => ipcRenderer.invoke("kei:presentation:asset", slot),
            complete: () => ipcRenderer.invoke("kei:presentation:complete"),
            onClosing: callback => subscribe("kei:presentation:closing", callback),
        },
        captureToggle: () => ipcRenderer.invoke("kei:capture:toggle"), // Round 08
        // Round 09: chat on the trusted active conversation; reading selection relay.
        chat: {
            state: () => ipcRenderer.invoke("kei:chat:state"),
            history: () => ipcRenderer.invoke("kei:chat:history"),
            send: question => ipcRenderer.invoke("kei:chat:send", question),
            resend: requestId => ipcRenderer.invoke("kei:chat:resend", requestId),
            retry: turnId => ipcRenderer.invoke("kei:chat:retry", turnId),
            cancel: turnId => ipcRenderer.invoke("kei:chat:cancel", turnId),
            newConversation: () => ipcRenderer.invoke("kei:chat:new"),
            activate: id => ipcRenderer.invoke("kei:chat:activate", id),
            visual: (kind, turnId) => ipcRenderer.invoke("kei:chat:visual", kind, turnId),
            configState: () => ipcRenderer.invoke("kei:chat:config:get"),
            onConfigChanged: callback => subscribe("kei:chat:config-changed", callback),
            onTurn: callback => subscribe("kei:chat:turn", callback),
            onSwitched: callback => subscribe("kei:chat:switched", callback),
        },
        reading: {
            forward: (tag, selection) => ipcRenderer.invoke("kei:reading:forward", tag, selection),
            readExternal: () => ipcRenderer.invoke("kei:reading:read-external"),
            onSelected: callback => subscribe("kei:reading:selected", callback),
        },
    });
} else if (kind === "admin") {
    contextBridge.exposeInMainWorld("kei", {
        ...common,
        onFocusSection: callback => subscribe("kei:admin:focus", callback),
        chatConfig: {
            get: () => ipcRenderer.invoke("kei:chat:config:get"),
            save: payload => ipcRenderer.invoke("kei:chat:config:save", payload),
            test: payload => ipcRenderer.invoke("kei:chat:config:test", payload),
            onChanged: callback => subscribe("kei:chat:config-changed", callback),
        },
        models: {
            list: () => ipcRenderer.invoke("kei:models:list"),
            select: (capability, selection) => ipcRenderer.invoke("kei:models:select", capability, selection),
        },
        personas: {
            state: () => ipcRenderer.invoke("kei:personas:state"),
            create: payload => ipcRenderer.invoke("kei:personas:create", payload),
            update: (id, payload) => ipcRenderer.invoke("kei:personas:update", id, payload),
            restore: id => ipcRenderer.invoke("kei:personas:restore", id),
            remove: id => ipcRenderer.invoke("kei:personas:delete", id),
            setPairing: payload => ipcRenderer.invoke("kei:personas:pairing", payload),
            preview: payload => ipcRenderer.invoke("kei:personas:preview", payload),
            onChanged: callback => subscribe("kei:persona:changed", callback),
        },
        // Round 07: executor and MCP controls (admin window only; main re-validates).
        executors: {
            list: () => ipcRenderer.invoke("kei:executors:list"),
            recent: () => ipcRenderer.invoke("kei:tasks:recent"),
            events: taskId => ipcRenderer.invoke("kei:tasks:events", taskId),
            submit: (executorId, input, options) => ipcRenderer.invoke("kei:tasks:submit", executorId, input, options),
            cancel: taskId => ipcRenderer.invoke("kei:tasks:cancel", taskId),
            answer: (taskId, inputId, value) => ipcRenderer.invoke("kei:tasks:input", taskId, inputId, value),
            onEvent: callback => subscribe("kei:tasks:event", callback),
            onUpdate: callback => subscribe("kei:tasks:update", callback),
        },
        mcp: {
            list: () => ipcRenderer.invoke("kei:mcp:list"),
            save: (id, definition) => ipcRenderer.invoke("kei:mcp:save", id, definition),
            setEnabled: (id, enabled) => ipcRenderer.invoke("kei:mcp:enabled", id, enabled),
            remove: id => ipcRenderer.invoke("kei:mcp:delete", id),
            tools: (id, mode) => ipcRenderer.invoke("kei:mcp:tools", id, mode),
            call: (serverId, toolName, args) => ipcRenderer.invoke("kei:mcp:call", serverId, toolName, args),
            cancel: requestId => ipcRenderer.invoke("kei:mcp:cancel", requestId),
        },
        plugins: {
            list: () => ipcRenderer.invoke("kei:plugins:list"),
            detail: id => ipcRenderer.invoke("kei:plugins:detail", id),
            install: () => ipcRenderer.invoke("kei:plugins:install"),
            enable: (id, grants) => ipcRenderer.invoke("kei:plugins:enable", id, grants),
            disable: id => ipcRenderer.invoke("kei:plugins:disable", id),
            reload: id => ipcRenderer.invoke("kei:plugins:reload", id),
            uninstall: (id, options) => ipcRenderer.invoke("kei:plugins:uninstall", id, options),
            onChanged: callback => subscribe("kei:plugins:changed", callback),
        },
    });
}
