const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("keiAdmin", {
    storage: body => ipcRenderer.invoke("kei:storage", body),
    executors: body => ipcRenderer.invoke('kei:executors', body),
    bilibili: body => ipcRenderer.invoke('kei:bilibili', body),
    voice: (action, value) => ipcRenderer.invoke("kei:voice", action, value),
    health: () => ipcRenderer.invoke("kei:admin-health"),
    logs: () => ipcRenderer.invoke("kei:admin-logs"),
    companion: (action, data) => ipcRenderer.invoke('kei:companion', action, data),
    onSelection: (callback) => ipcRenderer.on('kei:selection', (_event, data) => callback(data)),
});
