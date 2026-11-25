"use strict";

const { BrowserWindow, desktopCapturer, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const directory = path.join(__dirname, "../renderer/capture");
const documentUrl = pathToFileURL(path.join(directory, "capture.html")).href;
const scriptUrl = pathToFileURL(path.join(directory, "capture.js")).href;
const partition = "kei-selected-capture";
const owners = new Set();
let configured = false;

function prepareSession() {
    if (configured) return;
    configured = true;
    const isolated = session.fromPartition(partition);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({
        cancel: !owners.has(details.webContentsId) || ![documentUrl, scriptUrl].includes(details.url),
    }));
    const permits = (contents, permission) => owners.has(contents?.id) && contents.getURL() === documentUrl &&
        (permission === "media" || permission === "display-capture");
    isolated.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(permits(contents, permission) && !details?.mediaTypes?.includes("audio")));
    isolated.setPermissionCheckHandler((contents, permission, _origin, details) =>
        permits(contents, permission) && details?.mediaType !== "audio");
    isolated.setDisplayMediaRequestHandler((_request, callback) => callback(null));
}

function openSelectedCapture(source, { signal, parentWindow }) {
    if (!/^(screen|window):-?\d+:\d+$/.test(source.id)) throw new Error("Unsupported capture source");
    if (signal.aborted) throw new Error("Capture cancelled");
    prepareSession();
    const view = new BrowserWindow({
        show: false, width: 32, height: 32, parent: parentWindow || undefined,
        webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
    });
    const id = view.webContents.id;
    owners.add(id);
    let timer;
    let closed = false;
    let abortReady;
    const stopped = new Promise((_, reject) => { abortReady = reject; });
    function close() {
        if (closed) return;
        closed = true;
        abortReady(new Error("Selected capture was cancelled"));
        clearTimeout(timer);
        owners.delete(id);
        signal.removeEventListener("abort", close);
        if (!view.isDestroyed()) view.destroy();
    }
    signal.addEventListener("abort", close, { once: true });
    view.once("closed", () => {
        owners.delete(id);
        signal.removeEventListener("abort", close);
        abortReady(new Error("Selected capture window was closed"));
    });
    const opened = view.loadURL(documentUrl).then(() =>
        view.webContents.executeJavaScript("window.openSelectedSource(" + JSON.stringify(source.id) + ")"));
    const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Selected source did not deliver video")), 6500);
    });
    return {
        ready: Promise.race([opened, deadline, stopped]).finally(() => clearTimeout(timer)),
        async frame() {
            if (view.isDestroyed()) return null;
            const sources = await desktopCapturer.getSources({
                types: [source.kind === "display" ? "screen" : "window"],
                thumbnailSize: { width: 0, height: 0 },
            });
            if (view.isDestroyed() || !sources.some(item => item.id === source.id)) return null;
            return view.webContents.executeJavaScript("window.readSelectedFrame()");
        },
        close,
    };
}

module.exports = { openSelectedCapture };
