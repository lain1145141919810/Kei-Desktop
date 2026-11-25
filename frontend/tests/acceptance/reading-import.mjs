// Round 10: legacy reading-plan import through the kei.pdf admin page (読書プランの管理) in the
// real Electron admin window, against the real Round 07 host. Two launches share one profile
// and data dir, so restart is real.
//
//   node tests/acceptance/reading-import.mjs [--headless]
//
// SYNTHETIC DATA: Round 06 legacy-reading-plans.json (模擬資料 A/B) plus a generated 200-note
// plan. No model is called by this suite. Plugin: kei.pdf from the Round 07 Full profile.

import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(frontend, "..");
const headless = process.argv.includes("--headless");
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "round-10"));
const shots = path.join(evidence, "screenshots");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });
const python = process.env.KEI_HOST_PYTHON || path.join(repo, "backend-acceptance", ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const hostArtifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "round-07", "dist", "minimal", "kei-host.pyz"));
const packages = path.resolve(process.env.KEI_PACKAGES_DIR || path.join(repo, "round-07", "dist", "full", "packages"));
const legacyFile = path.resolve(process.env.KEI_LEGACY_PLANS || path.join(repo, "round-06", "legacy-reading-plans.json"));
const fixtures = JSON.parse(fs.readFileSync(path.resolve(process.env.KEI_BUSINESS_FIXTURES || path.join(repo, "round-06", "business-api-fixtures.json")), "utf8"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const legacySha = sha256(legacyFile);

const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-r10-"));
const dataDir = path.join(run, "host-data");
const profileDir = path.join(run, "profile");
const auditFile = path.join(profileDir, "logs", "shell-events.log");
fs.mkdirSync(dataDir, { recursive: true });

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

let app;
async function launch() {
    const args = [frontend, "--no-sandbox"];
    const env = { ...process.env, KEI_PROFILE_DIR: profileDir, KEI_DATA_DIR: dataDir, KEI_HOST_PYTHON: python, KEI_HOST_ARTIFACT: hostArtifact,
        KEI_OPEN_ADMIN: "1", XDG_RUNTIME_DIR: run };
    if (headless) { args.push("--ozone-platform=headless", "--disable-gpu"); env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; delete env.WAYLAND_DISPLAY; }
    app = await electron.launch({ executablePath: require("electron"), args, env, cwd: frontend, timeout: 60000 });
    const desktop = await waitFor("desktop window", async () => app.windows().find(w => w.url().includes("/desktop/index.html")), 30000);
    await desktop.waitForLoadState("domcontentloaded");
    await waitFor("host connected", async () => (await desktop.locator("#connection-text").textContent()) === "Kei ホスト接続済み", 30000);
    const admin = await waitFor("admin window", async () => app.windows().find(w => w.url().includes("/admin/admin.html")), 30000);
    await admin.waitForLoadState("domcontentloaded");
    return { desktop, admin };
}
async function closeApp() {
    await Promise.race([app.close().catch(() => {}), sleep(10000)]);
    try { app.process().kill("SIGKILL"); } catch { /* gone */ }
}
async function shot(name, kind) {
    const b64 = await app.evaluate(async ({ BrowserWindow }, kind) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(kind === "admin" ? "/admin/admin.html" : "/desktop/index.html"));
        await new Promise(r => setTimeout(r, 400));
        return (await win.webContents.capturePage()).toPNG().toString("base64");
    }, kind);
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, "base64"));
}
function hostApi() {
    const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    return async (method, route, body, type = "application/json") => {
        const response = await fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": type }, body });
        return (await response.json()).data;
    };
}

function hostBoundary(bytes, sendBody) {
    const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    const prefix = '{"sessionId":"unused","action":"legacy.import","arguments":{"padding":"';
    const suffix = '"}}';
    return new Promise((resolve, reject) => {
        const request = http.request(connection.url + "/v1/pages/call", {
            method: "POST",
            headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", "Content-Length": bytes },
            timeout: 5000,
        }, response => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", chunk => { body += chunk; });
            response.on("end", () => {
                try { resolve({ status: response.statusCode, code: JSON.parse(body).error?.code }); }
                catch (error) { reject(error); }
            });
        });
        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("Host body check timed out")));
        request.end(sendBody ? prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix : undefined);
    });
}

// The admin page (読書プランの管理), mounted in the admin window's 拡張ページ.
async function openAdminPage(admin) {
    const entry = admin.locator("#admin-entries .side-entry", { hasText: "読書プランの管理" });
    await waitFor("admin entry 読書プランの管理", async () => (await entry.count()) === 1, 20000);
    await entry.click();
    const page = admin.frameLocator("#plugin-page-body iframe.plugin-frame");
    await waitFor("admin page", async () => (await page.locator("h1").textContent({ timeout: 3000 })) === "読書プランの管理");
    return page;
}
// Calls through the page's own scoped channel (same broker path the page's buttons use).
const pageCall = (page, action, args) => page.locator("body").evaluate((_b, [action, args]) => new Promise(resolve => {
    const id = "t" + Math.random().toString(36).slice(2);
    addEventListener("message", function on({ data }) {
        if (data?.type === "kei:result" && data.id === id) { removeEventListener("message", on); resolve(data.ok ? data.result : { error: data.error }); }
    });
    parent.postMessage({ type: "kei:call", id, action, arguments: args }, "*");
}), [action, args]);
const listText = page => page.locator("#plans li").allTextContents();
const outputText = page => page.locator("#result").textContent();
async function submitImport(page, text) {
    await page.locator("body").evaluate((_b, text) => { document.getElementById("legacy").value = text; }, text);
    if (headless) await page.locator("#import").evaluate(form => form.requestSubmit());
    else await page.locator("#import button[type=submit], #import button:not([type])").click();
}

// A fully populated 200-note plan at kei.pdf's field maximums (excerpt 240, question 300
// characters). The request (~0.3 MiB of UTF-8) is well above the shell's former 64 KiB
// page-message cap and under the host's 2 MiB /v1/pages/call limit.
const fill = (prefix, length) => (prefix + "あいうえおかきくけこさしすせそ".repeat(30)).slice(0, length);
const bigPlan = {
    id: "legacy-200-notes", title: "模擬資料 C（200件のメモ）", totalPages: 400, pagesPerDay: 5, currentPage: 200,
    created: 1760000000000, updated: 1760000200000,
    log: Array.from({ length: 40 }, (_, i) => ({ day: `2025-09-${String((i % 28) + 1).padStart(2, "0")}`, from: i * 5, to: i * 5 + 5 })),
    notes: Array.from({ length: 200 }, (_, i) => ({ ts: 1760000000000 + i, page: i + 1, question: fill(`合成した質問 ${i + 1}：`, 300), excerpt: fill(`合成した抜粋 ${i + 1}：`, 240) })),
};
const bigText = JSON.stringify([bigPlan]);
// Eight such plans in one batch exceed 2 MiB.
const tooBigText = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ ...bigPlan, id: `legacy-too-big-${i}` })));

let exitCode = 0;
try {
    let { desktop, admin } = await launch();
    const api = hostApi();
    await api("POST", "/v1/plugins/install", fs.readFileSync(path.join(packages, "kei.pdf.zip")), "application/zip");
    await api("POST", "/v1/plugins/kei.pdf/enable", JSON.stringify({ grants: ["pdf.read", "pdf.write", "pdf.migrate", "chat.ask"] }));
    let page = await openAdminPage(admin);

    // L1 import through the page's textarea and 読み込む button.
    const legacyText = fs.readFileSync(legacyFile, "utf8");
    const legacy = JSON.parse(legacyText);
    await submitImport(page, legacyText);
    await waitFor("imported", async () => (await outputText(page)) === "取り込み：2");
    await waitFor("listed", async () => (await listText(page)).length === 2);
    const keep = await pageCall(page, "plans.get", { id: "legacy-keep" });
    const firstImport = audit().find(e => e.type === "page.call" && e.action === "legacy.import");
    record("L1 legacy import in 読書プランの管理: both plans added; IDs, progress, log and notes preserved",
        keep.id === "legacy-keep" && keep.currentPage === 5 && keep.notes.length === 1 && keep.notes[0].excerpt === legacy[0].notes[0].excerpt
        && firstImport?.migrationId === fixtures.legacyImport.migrationId && firstImport?.duplicate === false,
        { output: await outputText(page), list: await listText(page), keep: { id: keep.id, currentPage: keep.currentPage, notes: keep.notes.length, log: keep.log?.length },
          migrationIdLogged: firstImport?.migrationId, matchesRound06Fixture: firstImport?.migrationId === fixtures.legacyImport.migrationId });
    await shot("r10-01-admin-legacy-imported", "admin");

    // L2 repeating the exact batch is idempotent.
    await submitImport(page, legacyText);
    await waitFor("repeat handled", async () => (await outputText(page)) === "取り込み：0");
    const repeat = audit().filter(e => e.type === "page.call" && e.action === "legacy.import").at(-1);
    record("L2 repeating the exact import is idempotent: 0 added, same migration ID, still 2 plans",
        (await listText(page)).length === 2 && repeat.duplicate === true && repeat.migrationId === firstImport.migrationId,
        { output: await outputText(page), plans: (await listText(page)).length, duplicate: repeat.duplicate });

    // L3 the user changes an imported plan in the desktop 読書 page, then rolls back the import.
    await desktop.click("#reading-button");
    const reading = desktop.frameLocator("#reading-frame iframe.plugin-frame");
    await waitFor("reading page", async () => (await reading.locator("h1").textContent({ timeout: 3000 })) === "読書");
    await reading.locator("body").evaluate(() => { document.getElementById("plans").value = "legacy-keep"; document.getElementById("page").value = "8"; document.querySelector("#progress button").click(); });
    await waitFor("progress edited", async () => (await reading.locator("#plans").evaluate(s => [...s.options].map(o => o.textContent).join("|"))).includes("8/20"));
    await desktop.click("#reading-close");
    if (headless) await page.locator("#rollback").evaluate(b => b.click());
    else await page.locator("#rollback").click();
    await waitFor("rolled back", async () => (await outputText(page)).startsWith("取り消し"));
    const afterRollback = await listText(page);
    const kept = await pageCall(page, "plans.get", { id: "legacy-keep" });
    const removed = await pageCall(page, "plans.get", { id: "legacy-rollback" });
    record("L3 rollback removes only the untouched imported plan; the plan the user edited (8/20) is preserved",
        (await outputText(page)) === `取り消し：${fixtures.rollback.removed}、保持：${fixtures.rollback.preserved}`
        && afterRollback.length === 1 && kept.currentPage === 8 && kept.notes.length === 1 && Boolean(removed?.error || removed === null),
        { output: await outputText(page), list: afterRollback, keptPage: kept.currentPage, removedLookup: removed?.error?.code ?? removed });
    await shot("r10-02-admin-rollback", "admin");

    // L4 a fully populated 200-note plan (~0.5 MiB request) imports; an over-limit file is refused cleanly.
    await submitImport(page, bigText);
    await waitFor("big imported", async () => (await outputText(page)) === "取り込み：1", 20000);
    const big = await pageCall(page, "plans.get", { id: bigPlan.id });
    const transmitted = audit().filter(e => e.type === "page.call" && e.action === "legacy.import").at(-1)?.requestBytes;
    const before = (await listText(page)).length;
    await submitImport(page, tooBigText);
    await waitFor("too big refused", async () => (await outputText(page)) !== "取り込み：1");
    const refused = await outputText(page);
    const rejected = audit().filter(e => e.type === "page.call.rejected").at(-1);
    const overLimitArgs = Buffer.byteLength(JSON.stringify({ plans: JSON.parse(tooBigText) }), "utf8");
    record("L4 a 200-note plan above 64 KiB imports (Round 10 limit fix); a request over 2 MiB is refused in the shell with a Japanese message",
        big.notes.length === 200 && big.currentPage === 200 && transmitted > 65536 && transmitted < 2 * 1024 * 1024
        && overLimitArgs > 2 * 1024 * 1024 && refused.includes("大きすぎ") && rejected?.code === "message_too_large" && (await listText(page)).length === before,
        { transmittedBodyBytes: transmitted, notes: big.notes.length, refusedArgumentsBytes: overLimitArgs, refused, shellCode: rejected?.code });

    // ---------------------------------------------------------------- restart
    await closeApp();
    ({ desktop, admin } = await launch());
    page = await openAdminPage(admin);
    await waitFor("restored list", async () => (await listText(page)).length === 2);
    const keepR = await pageCall(page, "plans.get", { id: "legacy-keep" });
    const bigR = await pageCall(page, "plans.get", { id: bigPlan.id });
    record("L5 after restart: the edited legacy plan (8/20, note kept) and the 200-note plan persist; the source file is unchanged",
        keepR.currentPage === 8 && keepR.notes[0].excerpt === legacy[0].notes[0].excerpt && bigR.notes.length === 200 && sha256(legacyFile) === legacySha,
        { list: await listText(page), sourceSha256: legacySha });
    await shot("r10-03-admin-after-restart", "admin");

    const limit = 2 * 1024 * 1024;
    const acceptedSize = await hostBoundary(limit, true);
    // The host decides from Content-Length, before it reads an oversized body.
    const refusedSize = await hostBoundary(limit + 1, false);
    const smallPlans = Array.from({ length: 201 }, (_, i) => ({ ...legacy[0], id: `over-plan-limit-${i}` }));
    // The supported iframe caller exposes plugin business errors in the action result.
    const refusedPlans = await pageCall(page, "legacy.import", { plans: smallPlans });
    record("L6 host accepts exactly 2 MiB for parsing and refuses the next byte; the PDF plugin refuses 201 plans under the byte limit",
        acceptedSize.status === 410 && acceptedSize.code === "page_closed"
        && refusedSize.status === 413 && refusedSize.code === "body_too_large"
        && refusedPlans?.error?.code === "invalid_reading_request" && (await listText(page)).length === 2,
        { atLimitBytes: limit, atLimit: acceptedSize, overLimitBytes: limit + 1, overLimit: refusedSize,
          plans: smallPlans.length, argumentsBytes: Buffer.byteLength(JSON.stringify({ plans: smallPlans }), "utf8"), pluginCode: refusedPlans?.error?.code });
} catch (error) {
    exitCode = 1;
    console.error(error);
    results.push({ step: "unexpected error", ok: false, error: String(error.message || error) });
    try { await shot("r10-zz-failure", "admin"); } catch { /* best effort */ }
} finally {
    try { fs.writeFileSync(path.join(evidence, "logs", "shell-events.reading-import.log"), fs.readFileSync(auditFile, "utf8").split(run).join("<temp>")); } catch { /* none */ }
    if (app) await closeApp();
    fs.writeFileSync(path.join(evidence, "acceptance-reading-import.json"), JSON.stringify({
        when: new Date().toISOString(), headless, syntheticData: true, modelCalls: 0,
        hostArtifact: path.relative(repo, hostArtifact), hostSha256: sha256(hostArtifact),
        pdfPackageSha256: sha256(path.join(packages, "kei.pdf.zip")), legacySource: path.relative(repo, legacyFile), legacySha256: legacySha, results,
    }, null, 2));
    console.log(exitCode ? "FAIL reading-import acceptance" : "PASS reading-import acceptance");
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(exitCode);
}
