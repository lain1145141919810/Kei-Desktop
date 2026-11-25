// Round 07: executor controls and MCP settings in the real Electron admin window, against
// the real host (KEI_HOST_ARTIFACT, default round-07/dist/minimal/kei-host.pyz).
//
//   node tests/acceptance/executors-mcp.mjs [--headless]
//
// Fixtures (reproducible, synthetic):
//   - external adapter: round-07/external-adapter/fixture.py (KEI_ADAPTER_FIXTURE)
//   - MCP servers:      backend-acceptance/mcp_fixture.py stdio + streamable HTTP (KEI_MCP_FIXTURE)
//   - credential:       a random synthetic KEI_FIXTURE_TOKEN value generated per run
// Only substitution: dialog.showMessageBox in main (the native mutation confirmation) is
// replaced so the test can answer it; main still decides when it must be shown.

import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(frontend, "..");
const headless = process.argv.includes("--headless");
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "round-07"));
const shots = path.join(evidence, "screenshots");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });

const python = process.env.KEI_HOST_PYTHON || path.join(repo, "backend-acceptance", ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const hostArtifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "round-07", "dist", "minimal", "kei-host.pyz"));
const adapterFixture = path.resolve(process.env.KEI_ADAPTER_FIXTURE || path.join(repo, "round-07", "external-adapter", "fixture.py"));
const mcpFixture = path.resolve(process.env.KEI_MCP_FIXTURE || path.join(repo, "backend-acceptance", "mcp_fixture.py"));

const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-r07-"));
const token = "synthetic-" + crypto.randomBytes(12).toString("hex");
const adapters = path.join(run, "adapters");
fs.mkdirSync(adapters);
const manifest = (id, command, capabilities) => JSON.stringify({ id, name: "独立テスト", apiVersion: 1, command, capabilities });
fs.writeFileSync(path.join(adapters, "fixture.json"), manifest("studio.fixture", [python, adapterFixture], ["cancel", "progress", "input", "attachments", "artifacts", "followUp"]));
fs.writeFileSync(path.join(adapters, "missing.json"), manifest("studio.missing", [path.join(run, "missing-cli")], []));

const results = [];
const t0 = Date.now();
function record(group, step, ok, details = {}) {
    results.push({ group, step, ok, ms: Date.now() - t0, ...details });
    console.log(`${ok ? "PASS" : "FAIL"} [${group}] ${step}${Object.keys(details).length ? " " + JSON.stringify(details) : ""}`);
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
async function freePort() {
    return new Promise(resolve => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}
async function portOpen(port) {
    return new Promise(resolve => { const c = net.connect(port, "127.0.0.1", () => { c.end(); resolve(true); }); c.on("error", () => resolve(false)); });
}

const httpLog = path.join(run, "http.log");
const stdioLog = path.join(run, "stdio.log");
const port = await freePort();
let httpFixture = null;
async function startHttp() {
    httpFixture = spawn(python, [mcpFixture, "http", httpLog, "--port", String(port)], { env: { ...process.env, KEI_FIXTURE_TOKEN: token }, stdio: "ignore" });
    await waitFor("HTTP fixture listening", () => portOpen(port), 20000);
}
function stopHttp() { if (httpFixture) { httpFixture.kill("SIGKILL"); httpFixture = null; } }
await startHttp();

const args = [frontend, "--no-sandbox"];
const env = {
    ...process.env, KEI_PROFILE_DIR: path.join(run, "profile"), KEI_DATA_DIR: path.join(run, "host-data"),
    KEI_HOST_PYTHON: python, KEI_HOST_ARTIFACT: hostArtifact, KEI_EXECUTOR_DIR: adapters,
    KEI_FIXTURE_TOKEN: token, KEI_OPEN_ADMIN: "1", XDG_RUNTIME_DIR: run,
};
if (headless) { args.push("--ozone-platform=headless", "--disable-gpu"); env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; delete env.WAYLAND_DISPLAY; }
const app = await electron.launch({ executablePath: require("electron"), args, env, cwd: frontend, timeout: 60000 });

async function shot(name, sectionSelector) {
    const admin = await adminPage();
    if (sectionSelector) await admin.locator(sectionSelector).first().scrollIntoViewIfNeeded().catch(() => {});
    const b64 = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes("/admin/admin.html"));
        await new Promise(r => setTimeout(r, 400));
        return (await win.webContents.capturePage()).toPNG().toString("base64");
    });
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(b64, "base64"));
}
let adminCache;
async function adminPage() {
    if (adminCache) return adminCache;
    adminCache = await waitFor("admin window", async () => app.windows().find(w => w.url().includes("/admin/admin.html")), 30000);
    await adminCache.waitForLoadState("domcontentloaded");
    return adminCache;
}
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

let exitCode = 0;
try {
    const admin = await adminPage();
    await app.evaluate(async ({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes("/admin/")) w.setSize(1100, 900);
    });
    await waitFor("host connected", async () => (await admin.locator("#host-state").textContent()).startsWith("接続済み"), 30000);

    // ============================================================ executors
    const card = id => admin.locator(`.executor-card[data-executor-id="${id}"]`);
    await waitFor("adapters discovered", async () => (await admin.locator(".executor-card").count()) >= 4);
    const discovered = await admin.locator(".executor-card").evaluateAll(cards => cards.map(c => ({ id: c.dataset.executorId, available: c.dataset.available === "true", reason: c.querySelector(".reason")?.textContent || null })));
    const byId = Object.fromEntries(discovered.map(d => [d.id, d]));
    record("executors", "dynamic discovery: dsh, codex and registered external adapters with availability",
        Boolean(byId.dsh && byId.codex && byId["studio.fixture"]?.available && byId["studio.missing"] && !byId["studio.missing"].available), { discovered });
    const options = await admin.locator("#task-executor option").evaluateAll(os => os.map(o => ({ value: o.value, disabled: o.disabled })));
    record("executors", "selector offers only available adapters (others disabled with reason)",
        options.every(o => o.disabled === !byId[o.value].available), { options });
    await shot("r07-01-executors-discovered", "#executors");

    // Task with interactive input
    await admin.selectOption("#task-executor", "studio.fixture");
    await admin.fill("#task-input", "ask");
    await admin.click("#task-submit");
    const askCard = admin.locator('.task-card[data-executor-id="studio.fixture"]').first();
    await waitFor("waiting for input", async () => (await askCard.getAttribute("data-status")) === "waiting_for_input");
    const prompt = await askCard.locator(".task-answer .note").textContent();
    await shot("r07-02-task-waiting-for-input", ".task-card");
    await askCard.locator(".task-answer input").fill("ケイ");
    await askCard.locator(".task-answer button").click();
    await waitFor("task succeeded", async () => (await askCard.getAttribute("data-status")) === "succeeded");
    await waitFor("final event shown", async () => (await askCard.locator('.timeline li[data-type="task.succeeded"]').count()) === 1);
    const timeline = await askCard.locator(".timeline li").evaluateAll(lis => lis.map(li => ({ seq: Number(li.dataset.sequence), type: li.dataset.type })));
    const ordered = timeline.every((e, i) => i === 0 || e.seq > timeline[i - 1].seq);
    const resultText = await askCard.locator(".task-result").textContent();
    const artifacts = await askCard.locator(".result .note").textContent();
    record("executors", "submit, input request, ordered progress and result", ordered && resultText === "入力: ケイ"
        && timeline.map(e => e.type).join(",") === "task.queued,task.started,task.progress,task.input_requested,task.input_received,task.succeeded",
    { prompt, timeline, resultText, artifacts });
    await shot("r07-03-task-succeeded-with-progress", ".task-card");

    // Cancellation: requested vs confirmed
    await admin.fill("#task-input", "slow");
    await admin.click("#task-submit");
    const slowCard = admin.locator('.task-card[data-executor-id="studio.fixture"]').first();
    await waitFor("slow task running", async () => (await slowCard.getAttribute("data-status")) === "running" && (await slowCard.locator('.timeline li[data-type="task.progress"]').count()) === 1);
    const slowId = await slowCard.getAttribute("data-task-id");
    await slowCard.locator('button[data-action="cancel"]').click();
    const audit = () => read(path.join(run, "profile", "logs", "shell-events.log")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    const cancelAudit = await waitFor("cancel response recorded", async () => audit().find(e => e.type === "task.cancel" && e.taskId === slowId));
    const card2 = admin.locator(`.task-card[data-task-id="${slowId}"]`);
    await waitFor("cancel confirmed", async () => (await card2.getAttribute("data-status")) === "cancelled"
        && (await card2.locator('.timeline li[data-type="task.cancelled"]').count()) === 1);
    const cancelTimeline = await card2.locator(".timeline li").evaluateAll(lis => lis.map(li => li.dataset.type));
    const reqIdx = cancelTimeline.indexOf("task.cancel_requested"), confIdx = cancelTimeline.indexOf("task.cancelled");
    const statusBadge = await card2.locator(".task-status").textContent();
    const sideEffects = await card2.locator(".warning").allTextContents();
    record("executors", "cancellation requested (accepted, unconfirmed) is distinct from confirmed",
        cancelAudit.accepted === true && cancelAudit.confirmed === false && reqIdx >= 0 && confIdx > reqIdx && statusBadge === "中止を確認しました",
        { hostResponse: { accepted: cancelAudit.accepted, confirmed: cancelAudit.confirmed }, timeline: cancelTimeline, statusBadge, notes: sideEffects });
    await shot("r07-04-task-cancel-requested-then-confirmed", `.task-card[data-task-id="${slowId}"]`);

    // Abnormal exit and main-side rejection of unavailable adapters
    await admin.fill("#task-input", "exit");
    await admin.click("#task-submit");
    const exitCard = admin.locator('.task-card[data-executor-id="studio.fixture"]').first();
    await waitFor("exit task failed", async () => (await exitCard.getAttribute("data-status")) === "failed");
    const failure = await exitCard.locator(".error").textContent();
    const rejected = await admin.evaluate(async () => ({
        missing: await window.kei.executors.submit("studio.missing", "x"),
        unknown: await window.kei.executors.submit("studio.nothing", "x"),
    }));
    record("executors", "abnormal adapter exit shows failure; unavailable adapters are rejected in main",
        failure.includes("adapter_exited") && rejected.missing.error?.code === "cli_missing"
            && rejected.unknown.error?.code === "executor_not_found",
        { failure, rejected: Object.fromEntries(Object.entries(rejected).map(([k, v]) => [k, v.error?.code])) });

    // ============================================================ MCP
    await admin.locator("#mcp-add summary").click();
    async function addServer(fields) {
        await admin.fill("#mcp-id", fields.id);
        await admin.fill("#mcp-name", fields.name);
        await admin.selectOption("#mcp-transport", fields.transport);
        await admin.fill("#mcp-timeout", "5");
        if (fields.transport === "stdio") {
            await admin.fill("#mcp-command", fields.command);
            await admin.fill("#mcp-args", fields.args.join("\n"));
            await admin.fill("#mcp-cred-target", fields.target || "");
        } else {
            await admin.fill("#mcp-url", fields.url);
        }
        await admin.fill("#mcp-cred", fields.cred);
        await admin.fill("#mcp-readonly", "echo");
        await admin.click("#mcp-save");
        await waitFor(`server ${fields.id} saved`, async () => (await admin.locator(`.mcp-card[data-server-id="${fields.id}"]`).count()) === 1);
    }
    await addServer({ id: "a", name: "ローカル（stdio）", transport: "stdio", command: python, args: [mcpFixture, "stdio", stdioLog], cred: "KEI_FIXTURE_TOKEN", target: "FIXTURE_STDIO_TOKEN" });
    await addServer({ id: "b", name: "ローカル（HTTP）", transport: "streamable-http", url: `http://127.0.0.1:${port}/mcp`, cred: "KEI_FIXTURE_TOKEN" });
    const insecure = await admin.evaluate(() => window.kei.mcp.save("c", { name: "x", transport: "streamable-http", url: "http://example.com/mcp", credentialRef: { env: "TOKEN" } }));
    record("mcp", "add stdio and HTTP servers through the form (credential by reference only); insecure credential URL refused",
        insecure.error?.code === "insecure_credential_url", { insecure: insecure.error?.code });

    const server = id => admin.locator(`.mcp-card[data-server-id="${id}"]`);
    for (const id of ["a", "b"]) {
        await server(id).locator('button[data-action="refresh"]').click();
        await waitFor(`tools for ${id}`, async () => (await server(id).locator(".tool-table tbody tr").count()) === 2);
    }
    const toolsOf = id => server(id).locator(".tool-table tbody tr").evaluateAll(rows => rows.map(r => r.dataset.toolName));
    const toolsA = await toolsOf("a"), toolsB = await toolsOf("b");
    await waitFor("both ready", async () => (await server("a").getAttribute("data-state")) === "ready" && (await server("b").getAttribute("data-state")) === "ready");
    record("mcp", "refresh tools: both servers list echo and change", toolsA.join() === "echo,change" && toolsB.join() === "echo,change", { a: toolsA, b: toolsB });

    // Confirmation is owned by main.
    await app.evaluate(({ dialog }) => {
        globalThis.__keiConfirm = { answer: 1, asked: [] };
        dialog.showMessageBox = async (_window, options) => { globalThis.__keiConfirm.asked.push(options.message); return { response: globalThis.__keiConfirm.answer }; };
    });
    const callTool = async (id, tool, argsJson) => {
        const row = server(id).locator(`.tool-table tbody tr[data-tool-name="${tool}"]`);
        await row.locator(".tool-args").fill(argsJson);
        const before = await server(id).locator(".call-entry").count();
        await row.locator('button[data-action="call"]').click();
        await waitFor(`call ${id}/${tool}`, async () => (await server(id).locator(".call-entry").count()) > before);
        return server(id).locator(".call-entry").first().evaluate(e => ({ ...e.dataset, text: e.querySelector(".call-text").textContent, head: e.querySelector(".mono").textContent }));
    };
    const echoA = await callTool("a", "echo", "{}");
    const echoB = await callTool("b", "echo", "{}");
    const asked0 = await app.evaluate(() => globalThis.__keiConfirm.asked.length);
    record("mcp", "same tool name on two servers stays distinguishable by (serverId, toolName)",
        echoA.ok === "true" && echoA.serverId === "a" && echoA.text.includes('"server":"stdio"')
        && echoB.ok === "true" && echoB.serverId === "b" && echoB.text.includes('"server":"http"') && echoA.requestId !== echoB.requestId && asked0 === 0,
    { a: echoA.head, aServer: "stdio", b: echoB.head, bServer: "http", readOnlyPrompted: asked0 });
    await shot("r07-05-mcp-two-servers-same-tool", "#mcp");

    const denied = await callTool("a", "change", '{"key":"change-denied"}');
    const bypass = await admin.evaluate(() => window.kei.mcp.call("a", "change", { key: "change-bypass", confirmed: true }));
    await app.evaluate(() => { globalThis.__keiConfirm.answer = 0; });
    const allowed = await callTool("a", "change", '{"key":"change-allowed"}');
    const asked = await app.evaluate(() => globalThis.__keiConfirm.asked);
    const log = read(stdioLog);
    record("mcp", "mutation needs native confirmation in main; renderer cannot bypass; request ID retained",
        denied.ok === "false" && denied.text === "実行をキャンセルしました。" && Boolean(denied.requestId)
        && bypass.error?.code === "user_cancelled" && allowed.ok === "true"
        && !log.includes("call change-denied") && !log.includes("call change-bypass") && log.includes("call change-allowed") && asked.length === 3,
    { denied: { requestId: denied.requestId, code: "user_cancelled" }, bypass: bypass.error?.code, allowed: allowed.requestId, dialogs: asked.length });

    // Diagnostics and reconnect
    stopHttp();
    await server("b").locator('button[data-action="refresh"]').click();
    await waitFor("HTTP offline shown", async () => (await server("b").getAttribute("data-state")) === "offline"
        && (await server("b").locator(".diagnostic").count()) === 1 && (await server("b").locator(".tool-error").count()) === 1);
    const diag = await server("b").locator(".diagnostic").textContent();
    const toolError = await server("b").locator(".tool-error").textContent();
    const stillA = await callTool("a", "echo", '{"key":"a-while-b-down"}');
    record("mcp", "connection error visible after HTTP stops; stdio unaffected", stillA.ok === "true" && diag.includes("mcp_transport_error"), { diagnostic: diag, toolError });
    await shot("r07-06-mcp-http-offline-diagnostics", '.mcp-card[data-server-id="b"]');

    await startHttp();
    await server("b").locator('button[data-action="reconnect"]').click();
    await waitFor("HTTP ready after reconnect", async () => (await server("b").getAttribute("data-state")) === "ready" && (await server("b").locator(".tool-table tbody tr").count()) === 2, 25000);
    const echoB2 = await callTool("b", "echo", '{"key":"b-after-reconnect"}');
    record("mcp", "reconnect restores the HTTP server", echoB2.ok === "true" && echoB2.text.includes('"server":"http"'));
    await shot("r07-07-mcp-http-reconnected", '.mcp-card[data-server-id="b"]');

    // Disable / enable
    await server("a").locator('button[data-action="toggle"]').click();
    await waitFor("a disabled", async () => (await server("a").getAttribute("data-state")) === "disabled");
    await server("a").locator('button[data-action="refresh"]').click();
    await waitFor("disabled error", async () => (await server("a").locator(".tool-error").count()) === 1);
    const disabledError = await server("a").locator(".tool-error").textContent();
    await shot("r07-08-mcp-server-disabled", '.mcp-card[data-server-id="a"]');
    await server("a").locator('button[data-action="toggle"]').click();
    await waitFor("a enabled", async () => (await server("a").getAttribute("data-enabled")) === "true");
    await server("a").locator('button[data-action="refresh"]').click();
    await waitFor("a tools again", async () => (await server("a").locator(".tool-table tbody tr").count()) === 2);
    record("mcp", "disable then enable a server", disabledError.includes("mcp_server_disabled"), { disabledError });

    // Credentials stay in main / host
    const adminHtml = await admin.content();
    const desktop = app.windows().find(w => w.url().includes("/desktop/"));
    const desktopHtml = desktop ? await desktop.content() : "";
    const auditText = read(path.join(run, "profile", "logs", "shell-events.log"));
    const leaked = [adminHtml, desktopHtml, auditText].some(t => t.includes(token));
    const desktopMcp = desktop ? await desktop.evaluate(() => typeof window.kei.mcp) : "n/a";
    record("security", "credential value never reaches renderers or logs; MCP/task actions absent from desktop bridge",
        !leaked && desktopMcp === "undefined", { tokenFoundInRendererOrLog: leaked, desktopBridgeMcp: desktopMcp });
} catch (error) {
    exitCode = 1;
    console.error(error);
    results.push({ step: "unexpected error", ok: false, error: String(error.message || error) });
    try { await shot("r07-zz-failure"); } catch { /* best effort */ }
} finally {
    try {
        const auditText = read(path.join(run, "profile", "logs", "shell-events.log")).split(run).join("<temp>").split(token).join("<REDACTED>");
        fs.writeFileSync(path.join(evidence, "logs", "shell-events.executors-mcp.log"), auditText);
    } catch { /* none */ }
    stopHttp();
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 10000))]);
    try { app.process().kill("SIGKILL"); } catch { /* gone */ }
    fs.writeFileSync(path.join(evidence, "acceptance-executors-mcp.json"), JSON.stringify({
        when: new Date().toISOString(), headless, platform: `${os.type()} ${os.release()}`,
        hostArtifact: path.relative(repo, hostArtifact), hostSha256: crypto.createHash("sha256").update(fs.readFileSync(hostArtifact)).digest("hex"), adapterFixture: path.relative(repo, adapterFixture), mcpFixture: path.relative(repo, mcpFixture),
        results,
    }, null, 2));
    console.log(exitCode ? "FAIL executors-mcp acceptance" : "PASS executors-mcp acceptance");
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(exitCode);
}
