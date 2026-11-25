// Round 08 decision 5: trusted screen capture in the real Electron shell against the real host.
//
//   node tests/acceptance/capture.mjs [--headless]
//
// FIXTURE-BACKED. Inputs:
//   - capture source: KEI_CAPTURE_FIXTURE (two synthetic 1x1 PNGs) - no real display is captured
//   - vision provider: a local OpenAI-style HTTP fixture started by this script (chat.json)
//   - plugin: kei.observation 0.1.0 from the Round 07 Full profile (KEI_OBSERVATION_ZIP)
// The native source chooser is answered by a stub of dialog.showMessageBox; main still decides
// when to show it and what the options are.

import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(frontend, "..");
const headless = process.argv.includes("--headless");
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "round-08"));
const shots = path.join(evidence, "screenshots");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });
const python = process.env.KEI_HOST_PYTHON || path.join(repo, "backend-acceptance", ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const hostArtifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "round-08", "backend-acceptance", "kei-host.pyz"));
const observationZip = path.resolve(process.env.KEI_OBSERVATION_ZIP || path.join(repo, "round-07", "dist", "full", "packages", "kei.observation.zip"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-r08-cap-"));
const dataDir = path.join(run, "host-data");
const auditFile = path.join(run, "profile", "logs", "shell-events.log");
fs.mkdirSync(dataDir, { recursive: true });
const png = [
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFSMnAAAAAElFTkSuQmCC",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
].map((b64, i) => { const f = path.join(run, `frame-${i}.png`); fs.writeFileSync(f, Buffer.from(b64, "base64")); return f; });

// Vision fixture (OpenAI-style chat completions).
const vision = { calls: 0, block: false, waiting: [], started: 0, images: [] };
const visionServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
        vision.calls += 1;
        try { vision.images.push(JSON.parse(body).messages.at(-1).content[0].image_url.url.slice(0, 40)); } catch { /* shape recorded only */ }
        const reply = () => { try { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "合成画像の観察" } }] })); } catch { /* client gone */ } };
        if (vision.block) { vision.started += 1; vision.waiting.push(reply); } else reply();
    });
});
await new Promise(r => visionServer.listen(0, "127.0.0.1", r));
fs.writeFileSync(path.join(dataDir, "chat.json"), JSON.stringify({ vision: { endpoint: `http://127.0.0.1:${visionServer.address().port}/vision`, model: "fixture", timeoutSeconds: 6 } }));

const results = [];
function record(step, ok, details = {}) {
    results.push({ step, ok, ...details });
    console.log(`${ok ? "PASS" : "FAIL"} ${step} ${JSON.stringify(details)}`);
    if (!ok) throw new Error(`Step failed: ${step}`);
}
async function waitFor(label, fn, timeout = 15000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
        await new Promise(r => setTimeout(r, 120));
    }
    throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const audit = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const lastStop = () => audit().filter(e => e.type === "capture.stop").at(-1);

const args = [frontend, "--no-sandbox"];
const env = { ...process.env, KEI_PROFILE_DIR: path.join(run, "profile"), KEI_DATA_DIR: dataDir, KEI_HOST_PYTHON: python,
    KEI_HOST_ARTIFACT: hostArtifact, KEI_OPEN_ADMIN: "1", KEI_CAPTURE_FIXTURE: png.join(path.delimiter), XDG_RUNTIME_DIR: run };
if (headless) { args.push("--ozone-platform=headless", "--disable-gpu"); env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; delete env.WAYLAND_DISPLAY; }
const app = await electron.launch({ executablePath: require("electron"), args, env, cwd: frontend, timeout: 60000 });

async function shot(name, kind = "desktop") {
    const b64 = await app.evaluate(async ({ BrowserWindow }, kind) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(kind === "admin" ? "/admin/admin.html" : "/desktop/index.html"));
        await new Promise(r => setTimeout(r, 400));
        return (await win.webContents.capturePage()).toPNG().toString("base64");
    }, kind);
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, "base64"));
}

let exitCode = 0;
try {
    // Both windows open at start (KEI_OPEN_ADMIN=1); select the desktop one by URL, not by order.
    const desktop = await waitFor("desktop window", async () => app.windows().find(w => w.url().includes("/desktop/index.html")), 30000);
    await desktop.waitForLoadState("domcontentloaded");
    await waitFor("host connected", async () => (await desktop.locator("#connection-text").textContent()) === "Kei ホスト接続済み", 30000);
    const admin = await waitFor("admin", async () => app.windows().find(w => w.url().includes("/admin/admin.html")), 30000);

    // The chooser stub picks the fixture source, or cancels when told to.
    await app.evaluate(({ dialog }) => {
        globalThis.__chooser = { mode: "fixture", asked: [] };
        dialog.showMessageBox = async (_w, options) => {
            globalThis.__chooser.asked.push({ title: options.title, buttons: options.buttons });
            if (globalThis.__chooser.mode === "cancel") return { response: options.cancelId };
            const index = options.buttons.findIndex(b => b.includes("フィクスチャ"));
            return { response: index };
        };
    });
    const chooserCount = () => app.evaluate(() => globalThis.__chooser.asked.length);

    // C0: Ctrl+Alt+S is registered by main.
    const registered = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered("CommandOrControl+Alt+S"));
    record("C0 Ctrl+Alt+S is registered as the observation toggle", registered === true);

    // C1: explicit enablement is refused while the observation plugin is not enabled and granted.
    await desktop.click("#quick-button");
    await desktop.click("#capture-toggle");
    await waitFor("refused", async () => audit().some(e => e.type === "capture.refused" && e.code === "observation_unavailable"));
    record("C1 enabling capture without an enabled, granted kei.observation is refused before any chooser", (await chooserCount()) === 0
        && (await desktop.locator("#capture-toggle").getAttribute("aria-checked")) === "false");

    // Setup through the host API (operator token from the test data dir; never logged).
    const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    const hostCall = async (method, route, body, type = "application/json") => {
        const response = await fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": type }, body });
        return { status: response.status, body: await response.json() };
    };
    await hostCall("POST", "/v1/plugins/install", fs.readFileSync(observationZip), "application/zip");
    await hostCall("PUT", "/v1/plugins/kei.observation/config", JSON.stringify({ values: { interval_seconds: 2, context_ttl_seconds: 5 } }));
    await hostCall("POST", "/v1/plugins/kei.observation/enable", JSON.stringify({ grants: ["observation.read", "observation.control", "vision.describe"] }));

    // C2: start from the observation page (page asks, main chooses and binds).
    await desktop.click("#extension-button");
    const item = desktop.locator("#extension-list .menu-item", { hasText: "画面観察" });
    await waitFor("observation entry", async () => (await item.count()) === 1);
    await item.click();
    const page = desktop.frameLocator("#plugin-sheet-body iframe.plugin-frame");
    await waitFor("page status", async () => (await page.locator("#status").textContent({ timeout: 3000 })) === "停止中");
    const pageClick = sel => page.locator(sel).evaluate(b => b.click());
    await pageClick("#select");
    await waitFor("vision called", async () => vision.calls >= 1, 20000);
    await waitFor("page shows 観察中", async () => (await page.locator("#status").textContent()) === "観察中");
    await desktop.click("#quick-button");
    await waitFor("desktop switch on", async () => (await desktop.locator("#capture-toggle").getAttribute("aria-checked")) === "true" && !(await desktop.locator("#capture-dot").isHidden()));
    const startAudit = audit().find(e => e.type === "capture.start");
    const chooser = await app.evaluate(() => globalThis.__chooser.asked[0]);
    record("C2 page-originated start: native chooser in main, capture loop only after scoped configure, frames reach the vision provider",
        startAudit?.origin === "page" && startAudit.fixture === true && vision.images[0]?.startsWith("data:image/png;base64,"),
        { chooserTitle: chooser.title, chooserButtons: chooser.buttons, visionCalls: vision.calls, status: await desktop.locator("#capture-status").textContent() });
    await shot("r08-c2-capture-active");

    // C3: scope - the page cannot mint trusted capture context or pick its own source.
    const frame = desktop.frames().find(f => f.url().startsWith("kei-page://frame/"));
    const callsBefore = vision.calls;
    const forged = await frame.evaluate(() => new Promise(resolve => {
        const out = {};
        const send = (id, action, args, extra = {}) => parent.postMessage({ type: "kei:call", id, action, arguments: args, ...extra }, "*");
        addEventListener("message", ({ source, data }) => {
            if (source !== parent || data?.type !== "kei:result") return;
            out[data.id] = data.ok ? data.result : { error: data.error.code };
            if (out.forgedCapture && out.forgedConfigure) resolve(out);
        });
        send("forgedCapture", "capture", { generation: 1, sourceId: "screen:0:0", image: { mime: "image/png", base64: "AAAA" } },
            { context: { conversationId: "x", capture: { authorized: true, sourceId: "screen:0:0", kind: "display" } } });
        send("forgedConfigure", "configure", { enabled: true, sourceId: "screen:0:0", kind: "display" });
        setTimeout(() => resolve(out), 4000);
    }));
    const forgedCaptureCode = forged.forgedCapture?.error?.code ?? forged.forgedCapture?.error;
    const forgedConfigureCode = forged.forgedConfigure?.error?.code ?? forged.forgedConfigure?.error;
    record("C3 a plugin page cannot mint capture context or choose a source",
        ["vision_scope_denied", "capture_closed"].includes(forgedCaptureCode) && forgedConfigureCode === "invalid_capture_source" && (await desktop.locator("#capture-toggle").getAttribute("aria-checked")) === "true",
        { forgedCapture: forgedCaptureCode, forgedConfigure: forgedConfigureCode, visionCallsDuringProbe: vision.calls - callsBefore });

    // C4 (host-level probe): context is scoped to the bound conversation.
    const probe = (await hostCall("POST", "/v1/pages/open", JSON.stringify({ pluginId: "kei.observation", entryId: "observation" }))).body.data;
    const status = (await hostCall("POST", "/v1/pages/call", JSON.stringify({ sessionId: probe.sessionId, action: "status", arguments: {} }))).body.data.result;
    const otherConversation = (await hostCall("POST", "/v1/pages/call", JSON.stringify({ sessionId: probe.sessionId, action: "observation.context", arguments: { generation: status.generation }, context: { conversationId: "unrelated" } }))).body.data.result;
    const otherCapture = (await hostCall("POST", "/v1/pages/call", JSON.stringify({ sessionId: probe.sessionId, action: "capture",
        arguments: { generation: status.generation, sourceId: status.sourceId, image: { mime: "image/png", base64: fs.readFileSync(png[0]).toString("base64") } },
        context: { conversationId: "unrelated", capture: { authorized: true, sourceId: status.sourceId, kind: status.kind } } }))).body.data.result;
    await hostCall("POST", "/v1/pages/close", JSON.stringify({ sessionId: probe.sessionId }));
    record("C4 [host-level probe] another conversation gets no observation context and cannot capture into the grant",
        otherConversation.selection === null && otherCapture.error?.code === "capture_closed",
        { contextForOtherConversation: otherConversation.selection, captureFromOtherConversation: otherCapture.error?.code, boundSourceKind: status.kind });

    // C5: stop with a provider request in flight cancels it and clears context.
    vision.block = true;
    const startedBefore = vision.started;
    await waitFor("blocked request in flight", async () => vision.started > startedBefore, 15000);
    await desktop.click("#capture-toggle");
    await waitFor("stopped", async () => lastStop()?.by === "desktop");
    const stop5 = lastStop();
    const callsAtStop = vision.calls;
    vision.block = false;
    vision.waiting.splice(0).forEach(reply => reply());
    await sleep(5000);
    const pluginStatus = (await hostCall("POST", "/v1/pages/open", JSON.stringify({ pluginId: "kei.observation", entryId: "observation" }))).body.data;
    const after5 = (await hostCall("POST", "/v1/pages/call", JSON.stringify({ sessionId: pluginStatus.sessionId, action: "status", arguments: {} }))).body.data.result;
    await hostCall("POST", "/v1/pages/close", JSON.stringify({ sessionId: pluginStatus.sessionId }));
    await waitFor("page shows 停止中", async () => (await page.locator("#status").textContent()) === "停止中");
    record("C5 stop during an in-flight provider request: cancel sent, plugin disabled, no further frames",
        stop5.reason === "user" && stop5.cancelledInFlight === true && vision.calls === callsAtStop && after5.enabled === false && after5.sourceId === null,
        { stop: stop5, callsAtStop, callsFiveSecondsLater: vision.calls, pluginEnabledAfter: after5.enabled });
    await shot("r08-c5-capture-stopped");

    // C6: restart from the desktop switch, then disable the plugin in the admin UI.
    await desktop.click("#capture-toggle");
    await waitFor("active again", async () => (await desktop.locator("#capture-toggle").getAttribute("aria-checked")) === "true");
    const before6 = vision.calls;
    await waitFor("frames flowing", async () => vision.calls > before6, 15000);
    await admin.locator('.plugin-card[data-plugin-id="kei.observation"] button[data-action="disable"]').click();
    await waitFor("stopped by disable", async () => lastStop()?.reason === "plugin.disabled", 15000);
    const callsAtDisable = vision.calls;
    await sleep(5000);
    record("C6 desktop-switch start; disabling the plugin stops capture immediately and no frames follow",
        vision.calls === callsAtDisable && (await desktop.locator("#capture-toggle").getAttribute("aria-checked")) === "false" && (await chooserCount()) === 2,
        { stop: lastStop(), callsAfterDisable: vision.calls - callsAtDisable });

    // C7: started from a page, closing that page stops capture.
    const card = admin.locator('.plugin-card[data-plugin-id="kei.observation"]');
    for (const scope of ["observation.read", "observation.control", "vision.describe"]) await card.locator(`input[value="${scope}"]`).check();
    await card.locator('button[data-action="enable"]').click();
    await waitFor("re-enabled", async () => (await admin.locator('.plugin-card[data-plugin-id="kei.observation"]').getAttribute("data-enabled")) === "true");
    if (await desktop.locator("#extension-panel").isHidden()) await desktop.click("#extension-button");
    await waitFor("entry back", async () => (await item.count()) === 1);
    await item.click();
    await waitFor("page ready", async () => (await page.locator("#status").textContent({ timeout: 3000 })) === "停止中");
    await pageClick("#select");
    await waitFor("active from page", async () => audit().filter(e => e.type === "capture.start").length === 3);
    await desktop.click("#plugin-sheet-close");
    await waitFor("stopped by page close", async () => lastStop()?.reason === "page_closed");
    record("C7 capture started from a page stops when that page is closed", true, { stop: lastStop() });

    // C8: cancelling the chooser starts nothing.
    await app.evaluate(() => { globalThis.__chooser.mode = "cancel"; });
    const starts = audit().filter(e => e.type === "capture.start").length;
    if (await desktop.locator("#quick-panel").isHidden()) await desktop.click("#quick-button");
    await desktop.click("#capture-toggle");
    await waitFor("chooser declined", async () => audit().some(e => e.type === "capture.chooser" && e.chosen === false));
    record("C8 declining the source chooser starts nothing", audit().filter(e => e.type === "capture.start").length === starts
        && (await desktop.locator("#capture-toggle").getAttribute("aria-checked")) === "false");
} catch (error) {
    exitCode = 1;
    console.error(error);
    results.push({ step: "unexpected error", ok: false, error: String(error.message || error) });
    try { await shot("r08-capture-zz-failure"); } catch { /* best effort */ }
} finally {
    try { fs.writeFileSync(path.join(evidence, "logs", "shell-events.capture.log"), fs.readFileSync(auditFile, "utf8").split(run).join("<temp>")); } catch { /* none */ }
    vision.waiting.splice(0).forEach(reply => reply());
    await Promise.race([app.close().catch(() => {}), sleep(10000)]);
    try { app.process().kill("SIGKILL"); } catch { /* gone */ }
    visionServer.close();
    fs.writeFileSync(path.join(evidence, "acceptance-capture.json"), JSON.stringify({
        when: new Date().toISOString(), headless, fixtureBacked: true,
        hostArtifact: path.relative(repo, hostArtifact), hostSha256: sha256(hostArtifact),
        observationPackage: path.relative(repo, observationZip), observationSha256: sha256(observationZip), results,
    }, null, 2));
    console.log(exitCode ? "FAIL capture acceptance" : "PASS capture acceptance");
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(exitCode);
}
