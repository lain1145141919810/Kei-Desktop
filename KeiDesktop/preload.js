const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("keiDesktop", {
    version: "0.1.0",
    openAdmin: () => ipcRenderer.send("kei:admin"),
    playLogin: () => ipcRenderer.invoke("kei:login"),
    // files are File objects from a drop; only their paths cross the bridge.
    sendChat: (text, files = []) => ipcRenderer.invoke("kei:chat-send", text, files.map(file => webUtils.getPathForFile(file))),
    say: (key) => ipcRenderer.invoke("kei:say", key),
    quick: (action, value) => ipcRenderer.invoke("kei:quick", action, value),
    setCompact: (enable) => ipcRenderer.invoke("kei:compact", enable),
    dragCompact: (phase, dx, dy) => ipcRenderer.send("kei:compact-drag", phase, dx, dy),
    hitCompact: (inside) => ipcRenderer.send("kei:compact-hit", inside),
    // enable: the state the main process wants (it has already left compact mode itself).
    onCompactToggle: (callback) => { ipcRenderer.on("kei:compact-toggle", (_event, enable) => callback(enable)); },
    reading: (action, data) => ipcRenderer.invoke("kei:reading", action, data),
    onSelection: (callback) => { ipcRenderer.on("kei:selection", (_event, data) => callback(data)); },
    history: (action, data) => ipcRenderer.invoke("kei:history", action, data),
    requestClose: () => ipcRenderer.send("kei:close"),
    stopPlayback: (turnId) => ipcRenderer.invoke("kei:stop-playback", turnId),
    finishClose: () => ipcRenderer.send("kei:closed-animation"),
    onPrepareClose: (callback) => {
        const listener = () => callback();
        ipcRenderer.on("kei:prepare-close", listener);
        return () => ipcRenderer.removeListener("kei:prepare-close", listener);
    },
});
