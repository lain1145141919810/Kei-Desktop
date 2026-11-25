import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const frontend = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ui = fileURLToPath(new URL("./native-observation-ui.ps1", import.meta.url));
const title = "Kei Isolated Capture " + crypto.randomUUID().slice(0, 8);
const scriptedChoice = process.env.KEI_OBSERVATION_SCRIPTED_CHOICE === "1";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kei-native-observation-"));
const profile = path.join(temp, "profile");
const data = path.join(temp, "data");
const output = path.resolve(process.env.KEI_EVIDENCE_DIR ?? "evidence/native-observation");
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(data, { recursive: true });
const records = [];
let frame;
let frames = 0;
let selected = false;
const vision = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
        try {
            const parts = JSON.parse(body).messages.at(-1).content;
            assert.ok(selected && Array.isArray(parts));
            frame = parts.find(part => part.type === "image_url").image_url.url;
            frames++;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: "isolated test window" } }] }));
        } catch {
            res.writeHead(400).end();
        }
    });
});
vision.listen(0, "127.0.0.1");
await once(vision, "listening");
fs.writeFileSync(path.join(data, "chat.json"), JSON.stringify({
    vision: { endpoint: "http://127.0.0.1:" + vision.address().port + "/vision", model: "isolated-vision", timeoutSeconds: 5 },
}));

function command(...args) {
    return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-File", ui, ...args], {
        windowsHide: false, stdio: ["ignore", "pipe", "pipe"],
    });
}
function collect(process) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        process.stdout.on("data", data => { stdout += data; });
        process.stderr.on("data", data => { stderr += data; });
        process.on("error", reject);
        process.on("close", (code, signal) => code === 0 ? resolve(stdout) :
            reject(new Error((stderr || stdout).trim() || "Native control failed: " + code + " / " + signal)));
    });
}
async function waitFor(label, predicate, ms = 15000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw new Error("Timed out waiting for " + label);
}
function pass(label, details = {}) {
    records.push({ label, details });
    console.log("PASS " + label);
}
const auditFile = path.join(profile, "logs", "shell-events.log");
const audit = () => fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n")
    .filter(Boolean).map(line => JSON.parse(line)) : [];

const env = { ...process.env, KEI_PROFILE_DIR: profile, KEI_DATA_DIR: data, KEI_OPEN_ADMIN: "1" };
delete env.KEI_CAPTURE_FIXTURE;
delete env.KEI_OFFSCREEN;
const app = await electron.launch({ executablePath: require("electron"), args: [frontend], env, cwd: frontend,
    chromiumSandbox: true, timeout: 40000 });
const source = command("-Mode", "Window", "-Title", title);
let sourceReady = false;
let sourceFailure = "";
source.stdout.on("data", bytes => { sourceReady ||= bytes.toString().includes("READY"); });
source.stderr.on("data", bytes => { sourceFailure += bytes.toString(); });

try {
    await waitFor("dedicated test source", () => {
        if (source.exitCode !== null) throw new Error(sourceFailure || "Dedicated test source exited");
        return sourceReady;
    });
    const desktop = app.windows().find(window => window.url().includes("/desktop/index.html")) ?? await app.firstWindow();
    await desktop.waitForFunction(() => document.querySelector("#connection-text")?.textContent === "Kei ホスト接続済み");
    const connection = JSON.parse(fs.readFileSync(path.join(data, "connection.json"), "utf8"));
    async function request(method, route, body) {
        const response = await fetch(connection.url + route, {
            method, body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
            headers: { Authorization: "Bearer " + connection.token,
                "Content-Type": Buffer.isBuffer(body) ? "application/zip" : "application/json" },
        });
        assert.ok(response.ok, route + " returned " + response.status);
        return (await response.json()).data;
    }
    await request("POST", "/v1/plugins/install", fs.readFileSync(process.env.KEI_OBSERVATION_ZIP));
    await request("POST", "/v1/plugins/kei.observation/enable", { grants: ["observation.read", "observation.control", "vision.describe"] });
    await app.evaluate(({ desktopCapturer, dialog }, { testTitle, scriptedChoice }) => {
        const enumerate = desktopCapturer.getSources.bind(desktopCapturer);
        desktopCapturer.getSources = async options => {
            if (options.thumbnailSize?.width !== 0 || options.thumbnailSize?.height !== 0) throw new Error("Pixel enumeration refused");
            return (await enumerate(options)).filter(source => source.name === testTitle);
        };
        if (scriptedChoice) dialog.showMessageBox = async (_parent, options) => {
            const response = options.buttons.indexOf("ウィンドウ：" + testTitle);
            return { response: response === -1 ? options.cancelId : response };
        };
    }, { testTitle: title, scriptedChoice });
    const osPath = await app.evaluate(({ app, globalShortcut, BrowserWindow }) => {
        const desktop = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes("/desktop/index.html"));
        desktop.focus();
        return { pid: process.pid, platform: process.platform, registered: globalShortcut.isRegistered("CommandOrControl+Alt+S"),
            visible: desktop.isVisible(), offscreen: desktop.webContents.isOffscreen(),
            sandbox: !app.commandLine.hasSwitch("no-sandbox") && desktop.webContents.getLastWebPreferences().sandbox };
    });
    assert.ok(osPath.platform === "win32" && osPath.visible && !osPath.offscreen && osPath.sandbox, JSON.stringify(osPath));
    const origin = osPath.registered ? "shortcut" : "desktop";
    selected = true;
    if (osPath.registered) await collect(command("-Mode", "Shortcut", "-OwnerPid", String(osPath.pid)));
    else {
        console.log("SKIP actual Ctrl+Alt+S dispatch: the native accelerator is already owned");
        await desktop.locator("#quick-button").click();
        await desktop.locator("#capture-toggle").click();
    }
    if (!scriptedChoice) {
        assert.match(await collect(command("-Mode", "Choose", "-OwnerPid", String(osPath.pid),
            "-Title", "画面観察", "-ButtonId", "100")), /SELECTED/);
    }
    await waitFor("actual video in loopback vision fixture", () => /^data:image\/jpeg;base64,/.test(frame ?? ""), 18000);
    assert.ok(audit().some(event => event.type === "capture.start" && event.origin === origin &&
        event.kind === "window" && event.fixture === false));
    const marker = await app.evaluate(({ nativeImage }, dataUrl) => {
        const image = nativeImage.createFromDataURL(dataUrl).resize({ width: 64, height: 40 });
        const pixels = image.toBitmap();
        let green = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset + 1] > 145 && pixels[offset + 2] < 95 && pixels[offset] < 145) green++;
        }
        return { width: 64, height: 40, distinctiveGreenPixels: green, total: pixels.length / 4 };
    }, frame);
    assert.ok(marker.distinctiveGreenPixels / marker.total > .62, JSON.stringify(marker));
    pass("JPEG from the explicitly selected Windows test window", {
        origin, chooser: scriptedChoice ? "fixture" : "native-windows", marker, frames,
    });

    const admin = app.windows().find(window => window.url().includes("/admin/"));
    const count = frames;
    assert.equal((await admin.evaluate(() => window.kei.plugins.disable("kei.observation"))).ok, true);
    await waitFor("capture stop", () => audit().some(event => event.type === "capture.stop" && event.reason === "plugin.disabled"));
    await new Promise(resolve => setTimeout(resolve, 4300));
    assert.equal(frames, count);
    const runtimeWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .filter(window => window.webContents.getURL().endsWith("/capture/capture.html")).length);
    assert.equal(runtimeWindows, 0);
    pass("disable closes the selected media stream and prevents later frames");
} finally {
    fs.writeFileSync(path.join(output, "acceptance-native-observation.json"), JSON.stringify({ records }, null, 2) + "\n");
    fs.writeFileSync(path.join(output, "capture-audit.json"), JSON.stringify(audit().filter(entry =>
        entry.type.startsWith("capture.") || entry.type === "shortcut.register"), null, 2) + "\n");
    source.kill();
    await app.close();
    vision.close();
}
