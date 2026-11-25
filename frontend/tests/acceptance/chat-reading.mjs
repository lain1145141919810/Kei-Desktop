// Round 09: Japanese chat and PDF reading in the real Electron shell against the real
// Round 07 host. Two launches share one profile and data dir, so restart is real.
//
//   node tests/acceptance/chat-reading.mjs [--headless]
//
// FIXTURE MODEL: a local OpenAI-style Chat Completions server started here (chat.json); it
// answers "fixture:<question>" or "fixture selection:<selected text>" and records requests.
// SYNTHETIC SELECTION: text typed into the trusted paste box, or KEI_SELECTION_FIXTURE read
// by the same trusted path as Ctrl+Alt+Q. Plugins: kei.pdf and kei.observation from the
// Round 07 Full profile. Native dialogs are answered by stubs.

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
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "round-09"));
const shots = path.join(evidence, "screenshots");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });
const python = process.env.KEI_HOST_PYTHON || path.join(repo, "backend-acceptance", ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const hostArtifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "round-07", "dist", "minimal", "kei-host.pyz"));
const packages = path.resolve(process.env.KEI_PACKAGES_DIR || path.join(repo, "round-07", "dist", "full", "packages"));
const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-r09-"));
const dataDir = path.join(run, "host-data");
const profileDir = path.join(run, "profile");
const auditFile = path.join(profileDir, "logs", "shell-events.log");
fs.mkdirSync(dataDir, { recursive: true });
const selectionFile = path.join(run, "selection.txt");
const capturePng = path.join(run, "frame.png");
fs.writeFileSync(capturePng, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFSMnAAAAAElFTkSuQmCC", "base64"));

// ---------------------------------------------------------------- model fixture
const model = { requests: [], hold: false, waiting: [], failNext: false, vision: 0 };
const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        if (req.url === "/vision") { model.vision += 1; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "合成画像の観察" } }] })); return; }
        const messages = payload.messages || [];
        const last = messages.at(-1)?.content ?? "";
        model.requests.push({ messages, last });
        let reply = `fixture:${last}`;
        try { const parsed = JSON.parse(last); if (parsed.user_selected_context) reply = `fixture selection:${parsed.user_selected_context.text}`; } catch { /* plain question */ }
        const respond = () => {
            if (model.failNext) { model.failNext = false; res.writeHead(500); res.end("{}"); return; }
            try { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] })); } catch { /* client gone */ }
        };
        if (model.hold) model.waiting.push(respond); else respond();
    });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
fs.writeFileSync(path.join(dataDir, "chat.json"), JSON.stringify({
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, model: "fixture", timeoutSeconds: 20,
    vision: { endpoint: `http://127.0.0.1:${port}/vision`, model: "fixture", timeoutSeconds: 6 },
}));
const releaseModel = () => { model.hold = false; model.waiting.splice(0).forEach(f => f()); };

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
        KEI_OPEN_ADMIN: "1", KEI_SELECTION_FIXTURE: selectionFile, KEI_CAPTURE_FIXTURE: capturePng, XDG_RUNTIME_DIR: run };
    if (headless) { args.push("--ozone-platform=headless", "--disable-gpu"); env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; delete env.WAYLAND_DISPLAY; }
    app = await electron.launch({ executablePath: require("electron"), args, env, cwd: frontend, timeout: 60000 });
    const desktop = await waitFor("desktop window", async () => app.windows().find(w => w.url().includes("/desktop/index.html")), 30000);
    await desktop.waitForLoadState("domcontentloaded");
    await waitFor("host connected", async () => (await desktop.locator("#connection-text").textContent()) === "Kei ホスト接続済み", 30000);
    await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async (_w, o) => ({ response: Math.max(0, o.buttons.findIndex(b => b.includes("フィクスチャ"))) });
    });
    return desktop;
}
async function closeApp() {
    await Promise.race([app.close().catch(() => {}), sleep(10000)]);
    try { app.process().kill("SIGKILL"); } catch { /* gone */ }
}
async function shot(name) {
    const b64 = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("/desktop/index.html"));
        await new Promise(r => setTimeout(r, 400));
        return (await win.webContents.capturePage()).toPNG().toString("base64");
    });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, "base64"));
}
function hostApi() {
    const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    return async (method, route, body, type = "application/json") => {
        const response = await fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": type }, body });
        return (await response.json()).data;
    };
}

let exitCode = 0;
let desktop;
try {
    desktop = await launch();
    const conv = () => desktop.evaluate(() => document.body.dataset.conversationId);
    const turnsUI = () => desktop.locator("#backlog-body .log-turn").evaluateAll(n => n.map(e => ({ status: e.dataset.status, requestId: e.dataset.requestId, turnId: e.dataset.turnId, text: e.textContent })));
    const openBacklog = async () => { if (!(await desktop.evaluate(() => document.body.classList.contains("backlog-open")))) await desktop.click("#backlog-button"); };
    const closeBacklog = async () => { if (await desktop.evaluate(() => document.body.classList.contains("backlog-open"))) await desktop.click("#backlog-close"); };
    const say = async text => { await desktop.fill("#composer-input", text); await desktop.press("#composer-input", "Enter"); };

    // ================================================================ chat
    const convA = await waitFor("conversation id", conv);
    await say("こんにちは");
    await waitFor("reply shown", async () => (await desktop.locator("#subtitle-chinese").textContent()) === "fixture:こんにちは");
    await openBacklog();
    const t1 = (await turnsUI())[0];
    record("S1 send: the composer posts to the core conversation API and the reply is shown (fixture model)",
        t1?.status === "completed" && model.requests.length === 1, { conversation: "A", turn: t1?.status, providerRequests: model.requests.length });
    await closeBacklog();
    await shot("r09-01-chat-reply");

    model.hold = true;
    await say("長い質問");
    await waitFor("cancel visible", async () => !(await desktop.locator("#composer-cancel").isHidden()));
    await waitFor("provider received it", async () => model.waiting.length === 1);
    await desktop.click("#composer-cancel");
    await openBacklog();
    await waitFor("cancelled", async () => (await turnsUI()).some(t => t.status === "cancelled"));
    model.waiting.splice(0); model.hold = false; // the held reply is never delivered
    const cancelAudit = audit().find(e => e.type === "chat.cancel");
    record("S2 cancel: an active turn is cancelled through the API and shown as 中止しました", Boolean(cancelAudit?.accepted),
        { hostAccepted: cancelAudit?.accepted, uiStatus: "cancelled" });
    await shot("r09-02-chat-cancelled-in-history");

    const before = { provider: model.requests.length, turns: (await turnsUI()).length };
    const resent = await desktop.evaluate(id => window.kei.chat.resend(id), t1.requestId);
    await sleep(800);
    const after = { provider: model.requests.length, turns: (await turnsUI()).length };
    record("S3a exact retry: re-submitting a requestId returns the stored turn, no new turn, no provider call",
        resent.ok && resent.turn.turnId === t1.turnId && after.provider === before.provider && after.turns === before.turns,
        { sameTurn: resent.turn.turnId === t1.turnId, providerCalls: [before.provider, after.provider], uiTurns: [before.turns, after.turns] });

    model.failNext = true;
    await say("失敗する質問");
    await waitFor("failed", async () => (await turnsUI()).some(t => t.status === "failed"));
    const failed = (await turnsUI()).find(t => t.status === "failed");
    await desktop.locator(`.log-turn[data-turn-id="${failed.turnId}"] button[data-action="retry"]`).click();
    await waitFor("retry completed", async () => (await turnsUI()).filter(t => t.text.includes("失敗する質問")).every(t => t.status === "completed"));
    const shown = (await turnsUI()).filter(t => t.text.includes("失敗する質問"));
    const hostTurnsA = await hostApi()("GET", `/v1/chat/turns?conversationId=${convA}`);
    record("S3b retry after a provider error: the question appears once in the UI with its successful retry",
        shown.length === 1 && shown[0].status === "completed" && hostTurnsA.filter(t => t.question === "失敗する質問").length === 2,
        { uiEntries: shown.length, hostAttempts: hostTurnsA.filter(t => t.question === "失敗する質問").map(t => t.status) });
    await closeBacklog();

    // ================================================================ PDF reading
    const api = hostApi();
    await api("POST", "/v1/plugins/install", fs.readFileSync(path.join(packages, "kei.pdf.zip")), "application/zip");
    await api("POST", "/v1/plugins/kei.pdf/enable", JSON.stringify({ grants: ["pdf.read", "pdf.write", "pdf.migrate", "chat.ask"] }));
    await api("POST", "/v1/plugins/install", fs.readFileSync(path.join(packages, "kei.observation.zip")), "application/zip");
    await api("PUT", "/v1/plugins/kei.observation/config", JSON.stringify({ values: { interval_seconds: 2, context_ttl_seconds: 5 } }));
    await api("POST", "/v1/plugins/kei.observation/enable", JSON.stringify({ grants: ["observation.read", "observation.control", "vision.describe"] }));

    await desktop.click("#reading-button");
    const page = () => desktop.frameLocator("#reading-frame iframe.plugin-frame");
    await waitFor("reading page", async () => (await page().locator("h1").textContent({ timeout: 3000 })) === "読書");
    // locator.evaluate calls fn(element, arg): callbacks that need an argument take (_body, arg).
    const inFrame = (fn, arg) => page().locator("body").evaluate(fn, arg);
    await inFrame(() => { document.getElementById("name").value = "合成テスト本"; document.getElementById("total").value = "200"; document.getElementById("pace").value = "10"; document.querySelector("#new button").click(); });
    await waitFor("plan created", async () => (await page().locator("#plans option").count()) === 2);
    const planId = await waitFor("new plan selected", async () => (await page().locator("#plans").inputValue()) || null);

    const providerBefore = model.requests.length;
    await desktop.fill("#reading-passage", "   \n ");
    await desktop.click("#reading-forward");
    const uiBlock = await desktop.locator("#reading-status").textContent();
    const tag = await desktop.locator("#reading-frame iframe.plugin-frame").getAttribute("data-kei-frame");
    const mainBlock = await desktop.evaluate(t => window.kei.reading.forward(t, { text: " \t " }), tag);
    const pluginBlock = await inFrame(() => new Promise(resolve => {
        addEventListener("message", ({ data }) => { if (data?.type === "kei:result" && data.id === "ws") resolve(data.ok ? data.result : { error: data.error }); });
        parent.postMessage({ type: "kei:call", id: "ws", action: "selection.ask", arguments: { requestId: "ws-1", question: "空", selection: { text: "   ", source: null, page: null } } }, "*");
    }));
    record("P1 empty selection is rejected (renderer, main and plugin) and the model is never called",
        uiBlock.includes("空白") && mainBlock.error?.code === "empty_selection" && Boolean(pluginBlock.error) && model.requests.length === providerBefore,
        { renderer: uiBlock, main: mainBlock.error?.code, plugin: pluginBlock.error?.code || pluginBlock.error?.message, providerCalls: model.requests.length - providerBefore });

    const textA = "明示的に選択した文章A（合成）";
    fs.writeFileSync(selectionFile, textA);
    await desktop.click("#reading-read-external");
    await waitFor("excerpt filled", async () => (await page().locator("#excerpt").inputValue()) === textA);
    const synthetic = await desktop.locator("#reading-status").textContent();
    await inFrame((_body, id) => { document.getElementById("question").value = "ここは何ですか"; document.getElementById("plans").value = id; document.querySelector("#ask button").click(); }, planId);
    await waitFor("answer A", async () => (await page().locator("#answer").textContent()) === `fixture selection:${textA}`);
    const lastA = JSON.parse(model.requests.at(-1).last);
    await inFrame((_body, id) => { document.getElementById("plans").value = id; document.getElementById("page").value = "30"; document.querySelector("#progress button").click(); }, planId);
    await waitFor("progress saved", async () => (await inFrame(() => [...document.getElementById("plans").options].map(o => o.textContent).join("|"))).includes("30/200"));
    record("P2 explicit selected-text Q&A: the synthetic selection reaches the model as user_selected_context (fixture model); progress saved",
        lastA.user_selected_context.text === textA && lastA.question === "ここは何ですか" && synthetic.includes("合成"),
        { selection: "synthetic (KEI_SELECTION_FIXTURE via the Ctrl+Alt+Q path)", providerSaw: lastA.user_selected_context, status: synthetic });
    await shot("r09-03-reading-selection-answer");

    // ================================================================ two conversations
    await desktop.click("#reading-close");
    await openBacklog();
    await desktop.click("#backlog-new");
    const convB = await waitFor("new conversation", async () => { const c = await conv(); return c !== convA && c; });
    await closeBacklog();
    await desktop.click("#reading-button");
    await waitFor("reading page reopened", async () => (await page().locator("h1").textContent({ timeout: 3000 })) === "読書");
    const reopened = audit().some(e => e.type === "page.close" && e.pluginId === "kei.pdf" && e.reason === "conversation_changed");
    const textB = "会話Bだけの文章（合成）";
    await desktop.fill("#reading-passage", textB);
    await desktop.click("#reading-forward");
    await waitFor("excerpt B", async () => (await page().locator("#excerpt").inputValue()) === textB);
    await inFrame(() => { document.getElementById("question").value = "Bの質問"; document.querySelector("#ask button").click(); });
    await waitFor("answer B", async () => (await page().locator("#answer").textContent()) === `fixture selection:${textB}`);
    const reqB = model.requests.at(-1);
    const hostA = await api("GET", `/v1/chat/turns?conversationId=${convA}`);
    const hostB = await api("GET", `/v1/chat/turns?conversationId=${convB}`);
    const selA = hostA.filter(t => t.selection).map(t => t.selection.text);
    const selB = hostB.filter(t => t.selection).map(t => t.selection.text);
    record("C1 two conversations: each selected passage is stored and sent only in its own conversation",
        reopened && JSON.stringify(selA) === JSON.stringify([textA]) && JSON.stringify(selB) === JSON.stringify([textB])
        && !JSON.stringify(reqB.messages).includes(textA) && !JSON.stringify(reqB.messages).includes("こんにちは"),
        { conversationA: selA, conversationB: selB, providerHistoryForB: reqB.messages.length, readingPageReopenedOnSwitch: reopened });

    // Late result: a B question in flight when the user switches back to A.
    model.hold = true;
    await inFrame(() => { document.getElementById("question").value = "遅れて届く質問"; document.querySelector("#ask button").click(); });
    await waitFor("in flight", async () => model.waiting.length === 1);
    await desktop.click("#reading-close");
    await openBacklog();
    await desktop.click("#backlog-all");
    await desktop.locator(`.backlog-item[data-conversation-id="${convA}"]`).click();
    await waitFor("back in A", async () => (await conv()) === convA);
    releaseModel();
    await waitFor("B turn finished on host", async () => (await api("GET", `/v1/chat/turns?conversationId=${convB}`)).some(t => t.question === "遅れて届く質問" && t.status === "completed"));
    await sleep(1200);
    const uiA = await turnsUI();
    // The late selection.ask itself must have been discarded by main (not just any page close).
    const discarded = await waitFor("late result discarded", async () => audit().some(e => e.type === "page.call.discarded" && e.action === "selection.ask"));
    record("C2 switching conversations discards late results: B's late answer is stored in B and never shown in A",
        !uiA.some(t => t.text.includes("遅れて届く質問")) && !(await desktop.locator("#subtitle-chinese").textContent()).includes("遅れて") && discarded,
        { aTurnsShown: uiA.length, lateAnswerInA: false, pageClosedOrDiscarded: discarded });
    await shot("r09-04-history-conversation-a");
    await closeBacklog();

    // Capture is bound to the conversation: a switch cancels it.
    await desktop.click("#quick-button");
    await desktop.click("#capture-toggle");
    await waitFor("capture on", async () => (await desktop.locator("#capture-toggle").getAttribute("aria-checked")) === "true");
    await waitFor("frames flowing", async () => model.vision >= 1, 15000);
    await desktop.click("#quick-button");
    await openBacklog();
    await desktop.click("#backlog-new");
    const convC = await waitFor("conversation C", async () => { const c = await conv(); return c !== convA && c !== convB && c; });
    await waitFor("capture stopped", async () => audit().some(e => e.type === "capture.stop" && e.reason === "conversation_changed"));
    const visionAtSwitch = model.vision;
    await sleep(4500);
    record("C3 switching conversation cancels the previous capture; no frames follow (fixture capture source)",
        model.vision === visionAtSwitch, { stop: audit().filter(e => e.type === "capture.stop").at(-1), framesAfterSwitch: model.vision - visionAtSwitch });
    await closeBacklog();

    // A turn in progress when the app quits.
    model.hold = true;
    await say("再起動中の質問");
    await waitFor("held", async () => model.waiting.length === 1);
    await closeApp();
    model.waiting.splice(0); model.hold = false;

    // ================================================================ restart
    desktop = await launch();
    const restoredId = await waitFor("conversation id", conv);
    await openBacklog();
    await waitFor("history restored", async () => (await turnsUI()).length === 1);
    const interrupted = (await turnsUI())[0];
    await desktop.locator(`.log-turn[data-turn-id="${interrupted.turnId}"] button[data-action="retry"]`).click();
    await waitFor("retried after restart", async () => (await turnsUI()).length === 1 && (await turnsUI())[0].status === "completed");
    record("R1 resume after restart: the active conversation is restored; the interrupted turn shows chat_host_restarted and retries once",
        restoredId === convC && interrupted.status === "failed" && interrupted.text.includes("chat_host_restarted"),
        { activeRestored: restoredId === convC, interrupted: interrupted.status });
    await desktop.click("#backlog-all");
    await desktop.locator(`.backlog-item[data-conversation-id="${convA}"]`).click();
    await waitFor("A restored", async () => (await turnsUI()).some(t => t.text.includes("こんにちは")));
    const restoredA = await turnsUI();
    await closeBacklog();
    await desktop.click("#reading-button");
    await waitFor("reading page", async () => (await page().locator("h1").textContent({ timeout: 3000 })) === "読書");
    const plan = await inFrame((_body, id) => new Promise(resolve => {
        addEventListener("message", ({ data }) => { if (data?.type === "kei:result" && data.id === "get") resolve(data.result); });
        parent.postMessage({ type: "kei:call", id: "get", action: "plans.get", arguments: { id } }, "*");
    }), planId);
    record("R2 after restart: conversation A history, the plan's progress (30/200) and the selection note are kept",
        restoredA.length >= 3 && plan.currentPage === 30 && plan.notes.some(n => n.excerpt === textA && n.question === "ここは何ですか"),
        { historyA: restoredA.map(t => t.status), currentPage: plan.currentPage, notes: plan.notes.map(n => ({ excerpt: n.excerpt, question: n.question, page: n.page })) });
    await shot("r09-05-after-restart-reading");
} catch (error) {
    exitCode = 1;
    console.error(error);
    results.push({ step: "unexpected error", ok: false, error: String(error.message || error) });
    try { await shot("r09-zz-failure"); } catch { /* best effort */ }
} finally {
    try { fs.writeFileSync(path.join(evidence, "logs", "shell-events.chat-reading.log"), fs.readFileSync(auditFile, "utf8").split(run).join("<temp>")); } catch { /* none */ }
    releaseModel();
    if (app) await closeApp();
    server.close();
    fs.writeFileSync(path.join(evidence, "acceptance-chat-reading.json"), JSON.stringify({
        when: new Date().toISOString(), headless, fixtureModel: true, syntheticSelection: true,
        hostArtifact: path.relative(repo, hostArtifact), hostSha256: sha256(hostArtifact),
        pdfPackageSha256: sha256(path.join(packages, "kei.pdf.zip")), results,
    }, null, 2));
    console.log(exitCode ? "FAIL chat-reading acceptance" : "PASS chat-reading acceptance");
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(exitCode);
}
