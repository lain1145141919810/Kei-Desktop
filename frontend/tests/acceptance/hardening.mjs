// Round 08 decision 4: release hardening, exercised in the real Electron shell against the
// real host. Setup (installing and enabling studio.counter) uses the host API directly with
// the operator token from the test data dir; every check then goes through the shell.
//
//   node tests/acceptance/hardening.mjs [--headless]

import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(frontend, "..");
const headless = process.argv.includes("--headless");
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "round-08"));
fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });
const python = process.env.KEI_HOST_PYTHON || path.join(repo, "backend-acceptance", ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const hostArtifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "round-08", "backend-acceptance", "kei-host.pyz"));
const counterZip = path.resolve(process.env.KEI_COUNTER_ZIP || path.join(repo, "round-08", "backend-acceptance", "studio.counter.zip"));
const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-r08-hard-"));
const dataDir = path.join(run, "host-data");
const auditFile = path.join(run, "profile", "logs", "shell-events.log");

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
const audit = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const args = [frontend, "--no-sandbox"];
const env = { ...process.env, KEI_PROFILE_DIR: path.join(run, "profile"), KEI_DATA_DIR: dataDir, KEI_HOST_PYTHON: python,
    KEI_HOST_ARTIFACT: hostArtifact, KEI_OPEN_ADMIN: "1", XDG_RUNTIME_DIR: run };
if (headless) { args.push("--ozone-platform=headless", "--disable-gpu"); env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; delete env.WAYLAND_DISPLAY; }
const app = await electron.launch({ executablePath: require("electron"), args, env, cwd: frontend, timeout: 60000 });

let exitCode = 0;
try {
    // Both windows open at start (KEI_OPEN_ADMIN=1); select the desktop one by URL, not by order.
    const desktop = await waitFor("desktop window", async () => app.windows().find(w => w.url().includes("/desktop/index.html")), 30000);
    await desktop.waitForLoadState("domcontentloaded");
    await waitFor("host connected", async () => (await desktop.locator("#connection-text").textContent()) === "Kei ホスト接続済み", 30000);
    const admin = await waitFor("admin", async () => app.windows().find(w => w.url().includes("/admin/admin.html")), 30000);

    // Setup through the host API (operator token from the test data dir; never logged).
    const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    const hostCall = async (method, route, body, type = "application/json") => {
        const response = await fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": type }, body });
        return response.json();
    };
    await hostCall("POST", "/v1/plugins/install", fs.readFileSync(counterZip), "application/zip");
    await hostCall("POST", "/v1/plugins/studio.counter/enable", JSON.stringify({ grants: ["counter.read", "counter.write"] }));
    await desktop.click("#extension-button");
    await waitFor("menu item", async () => (await desktop.locator("#extension-list .menu-item").count()) === 1);
    await desktop.locator("#extension-list .menu-item").click();
    const frameOutput = () => desktop.frameLocator("#plugin-sheet-body iframe.plugin-frame").locator("output").textContent({ timeout: 3000 });
    await waitFor("page shows 0", async () => (await frameOutput()) === "0");

    // H1: file: limited to renderer/assets.
    const outside = pathToFileURL(path.join(frontend, "src", "main", "main.js")).href;
    const traversal = pathToFileURL(path.join(frontend, "src", "renderer")).href + "/../main/host-client.js";
    const inside = pathToFileURL(path.join(frontend, "src", "renderer", "shared", "theme.js")).href;
    const loads = await desktop.evaluate(async urls => {
        const violations = [];
        document.addEventListener("securitypolicyviolation", e => violations.push(e.blockedURI));
        const load = url => new Promise(resolve => {
            const s = document.createElement("script");
            s.src = url; s.onload = () => resolve("loaded"); s.onerror = () => resolve("blocked");
            document.head.append(s);
        });
        const out = {};
        for (const [key, url] of Object.entries(urls)) out[key] = await load(url);
        await new Promise(r => setTimeout(r, 200));
        return { ...out, cspViolations: violations.length };
    }, { outside, traversal, inside, etc: "file:///etc/hostname" });
    const denied = audit().filter(e => e.type === "file.denied").map(e => e.url);
    record("H1 file: requests outside the renderer/assets trees are refused by main; renderer files still load",
        loads.outside === "blocked" && loads.traversal === "blocked" && loads.etc === "blocked" && loads.inside === "loaded"
        && denied.some(u => u.endsWith("/src/main/main.js")) && denied.some(u => u.includes("host-client.js")) && denied.some(u => u.includes("/etc/hostname")),
        { loads, mainDeniedCount: denied.length });

    // H2: replaying the page URL in a second iframe of the same window.
    const pageUrl = await desktop.locator("#plugin-sheet-body iframe.plugin-frame").getAttribute("src");
    await desktop.evaluate(url => { const f = document.createElement("iframe"); f.id = "replay"; f.setAttribute("sandbox", "allow-scripts"); f.src = url; document.body.append(f); }, pageUrl);
    await sleep(1500);
    const replayFrameUrl = desktop.frames().find(f => f.name() === "" && f.parentFrame() === desktop.mainFrame() && f !== desktop.mainFrame() && !f.url().startsWith("kei-page:"))?.url() ?? null;
    const keiFrames = desktop.frames().filter(f => f.url().startsWith("kei-page:")).length;
    const replayDenied = audit().some(e => e.type === "frame-navigation.denied" && e.url === pageUrl);
    await desktop.frameLocator("#plugin-sheet-body iframe.plugin-frame").getByRole("button", { name: "＋1" }).evaluate(b => b.click());
    await waitFor("original page still works", async () => (await frameOutput()) === "1");
    record("H2 a served one-shot page cannot be replayed into a second iframe; the original keeps working",
        replayDenied && keiFrames === 1, { replayFrameUrl, keiFrames, replayDenied });

    // H3: a page opened for the desktop window cannot be bound by the admin window.
    const opened = await desktop.evaluate(() => window.kei.pages.open("studio.counter", "desktop-counter"));
    await admin.evaluate(url => { const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-scripts"); f.src = url; document.body.append(f); }, opened.frame.url);
    await sleep(1500);
    const crossDenied = audit().some(e => e.type === "frame-navigation.denied" && e.url === opened.frame.url);
    const adminKeiFrames = admin.frames().filter(f => f.url().startsWith("kei-page:")).length;
    await desktop.evaluate(url => { const f = document.createElement("iframe"); f.id = "own"; f.setAttribute("sandbox", "allow-scripts"); f.src = url; document.body.append(f); }, opened.frame.url);
    const ownLoaded = await waitFor("own window loads it", async () => desktop.frames().some(f => f.url() === opened.frame.url));
    record("H3 a one-shot page is bound to its issuing window: another window is refused, the issuing window succeeds",
        crossDenied && adminKeiFrames === 0 && Boolean(ownLoaded), { crossDenied, adminKeiFrames });

    // H4: a kei:call posted by the trusted window itself (non-null origin, not a plugin frame) is ignored.
    const callsBefore = audit().filter(e => e.type === "page.call").length;
    await desktop.evaluate(() => window.postMessage({ type: "kei:call", id: "forged", action: "increment", arguments: {} }, "*"));
    await sleep(800);
    const callsAfter = audit().filter(e => e.type === "page.call").length;
    record("H4 messages that do not come from a plugin frame with the opaque origin are ignored", callsAfter === callsBefore && (await frameOutput()) === "1",
        { pageCallsBefore: callsBefore, pageCallsAfter: callsAfter });

    // H5: a plugin page cannot nest a kei-page frame (plugin CSP frame-src 'none').
    const frame = desktop.frames().find(f => f.url() === pageUrl);
    const nested = await frame.evaluate(url => new Promise(resolve => {
        const f = document.createElement("iframe"); f.src = url; document.body.append(f);
        setTimeout(() => resolve(document.querySelectorAll("iframe").length), 800);
    }), opened.frame.url).catch(e => `error: ${e.message}`);
    const nestedLoaded = desktop.frames().filter(f => f.url() === opened.frame.url).length;
    record("H5 plugin pages cannot load kei-page frames", nestedLoaded === 1, { nestedIframesCreated: nested, keiPageLoadsOfThatUrl: nestedLoaded });

    // H6 (Round 09): allow-forms lets packaged pages receive submit events. A real submission
    // (here to a local server owned by this test) must never be sent; if the frame changes
    // document, the shell closes the page as navigated.
    const hits = [];
    const target = http.createServer((req, res) => { hits.push(req.method + " " + req.url); res.end("x"); });
    await new Promise(r => target.listen(0, "127.0.0.1", r));
    const auditBefore = audit().length;
    const handlerRan = await frame.evaluate(url => new Promise(resolve => {
        const form = document.createElement("form");
        form.action = url; form.method = "post";
        form.addEventListener("submit", () => resolve(true));
        document.body.append(form);
        form.requestSubmit();
        setTimeout(() => resolve(false), 500);
    }), `http://127.0.0.1:${target.address().port}/steal`).catch(() => "context-destroyed");
    await sleep(2000);
    target.close();
    const newEntries = audit().slice(auditBefore);
    const closedAsNavigated = newEntries.some(e => e.type === "page.close" && e.reason === "navigated");
    const pageGone = !desktop.frames().some(f => f.url() === pageUrl);
    record("H6 plugin forms fire their submit handler, but a real submission is never sent; a document change closes the page",
        handlerRan === true && hits.length === 0 && (!pageGone || closedAsNavigated),
        { submitHandlerRan: handlerRan, requestsReceivedByTarget: hits.length, pageClosedAsNavigated: closedAsNavigated });
} catch (error) {
    exitCode = 1;
    console.error(error);
    results.push({ step: "unexpected error", ok: false, error: String(error.message || error) });
} finally {
    try {
        fs.writeFileSync(path.join(evidence, "logs", "shell-events.hardening.log"), fs.readFileSync(auditFile, "utf8").split(run).join("<temp>"));
    } catch { /* none */ }
    await Promise.race([app.close().catch(() => {}), sleep(10000)]);
    try { app.process().kill("SIGKILL"); } catch { /* gone */ }
    fs.writeFileSync(path.join(evidence, "acceptance-hardening.json"), JSON.stringify({
        when: new Date().toISOString(), headless, hostArtifact: path.relative(repo, hostArtifact),
        hostSha256: crypto.createHash("sha256").update(fs.readFileSync(hostArtifact)).digest("hex"), results,
    }, null, 2));
    console.log(exitCode ? "FAIL hardening acceptance" : "PASS hardening acceptance");
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(exitCode);
}
