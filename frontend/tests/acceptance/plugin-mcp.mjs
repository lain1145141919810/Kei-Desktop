// Round 08 decision 1: plugin MCP writes through the trusted dialog and the host's
// request-bound one-use confirmation token. Real Electron shell + real host + real MCP SDK
// stdio transport against the maintained fixture (KEI_MCP_FIXTURE).
//
//   node tests/acceptance/plugin-mcp.mjs [--headless]
//
// Setup via the host API with the operator token: MCP server "a" (stdio fixture) with
// pluginAccess {"studio.mcp-confirm": ["echo","change"]}, the test plugin from
// tests/fixtures/mcp-confirm-plugin and studio.counter (as an unrelated plugin).
// The native dialog is answered by a stub; main decides whether it is shown.

import { _electron as electron } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(frontend, "..");
const headless = process.argv.includes("--headless");
const nativeDialog = !headless && process.platform === "win32" && process.env.KEI_NATIVE_MCP_DIALOG === "1";
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "round-08"));
fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });
const python = process.env.KEI_HOST_PYTHON || path.join(repo, "backend-acceptance", ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
const hostArtifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "round-08", "backend-acceptance", "kei-host.pyz"));
const mcpFixture = path.resolve(process.env.KEI_MCP_FIXTURE || path.join(repo, "round-08", "src", "kei-desktop", "tests", "backend_acceptance", "mcp_fixture.py"));
const counterZip = path.resolve(process.env.KEI_COUNTER_ZIP || path.join(repo, "round-08", "backend-acceptance", "studio.counter.zip"));
const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-r08-pmcp-"));
const dataDir = path.join(run, "host-data");
const stdioLog = path.join(run, "stdio.log");
const auditFile = path.join(run, "profile", "logs", "shell-events.log");

// Build the test plugin ZIP from its sources.
const pluginZip = path.join(run, "studio.mcp-confirm.zip");
const built = spawnSync(python, ["-I", "-c",
    "import sys,zipfile,pathlib\nsrc=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n  [z.write(p,p.name) for p in sorted(src.iterdir())]",
    path.join(frontend, "tests", "fixtures", "mcp-confirm-plugin"), pluginZip]);
if (built.status !== 0) throw new Error("could not build test plugin: " + built.stderr);

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
const log = () => (fs.existsSync(stdioLog) ? fs.readFileSync(stdioLog, "utf8") : "");
const calls = key => log().split(/\r?\n/).filter(l => l === `call ${key}`).length;

const args = [frontend, "--no-sandbox"];
const env = { ...process.env, KEI_PROFILE_DIR: path.join(run, "profile"), KEI_DATA_DIR: dataDir, KEI_HOST_PYTHON: python,
    KEI_HOST_ARTIFACT: hostArtifact, XDG_RUNTIME_DIR: run };
if (headless) { args.push("--ozone-platform=headless", "--disable-gpu"); env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; delete env.WAYLAND_DISPLAY; }
const app = await electron.launch({ executablePath: require("electron"), args, env, cwd: frontend, timeout: 60000 });

let exitCode = 0;
try {
    const desktop = await waitFor("desktop window", async () => app.windows().find(w => w.url().includes("/desktop/index.html")), 30000);
    await waitFor("host connected", async () => (await desktop.locator("#connection-text").textContent()) === "Kei ホスト接続済み", 30000);

    const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    const hostCall = async (method, route, body, type = "application/json") => {
        const response = await fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": type }, body });
        return response.json();
    };
    await hostCall("PUT", "/v1/mcp/servers/a", JSON.stringify({ name: "ローカル（stdio）", transport: "stdio", command: python, args: [mcpFixture, "stdio", stdioLog],
        readOnlyTools: ["echo"], timeoutSeconds: 10, pluginAccess: { "studio.mcp-confirm": ["echo", "change"] } }));
    await hostCall("POST", "/v1/plugins/install", fs.readFileSync(pluginZip), "application/zip");
    await hostCall("POST", "/v1/plugins/studio.mcp-confirm/enable", JSON.stringify({ grants: ["mcp.call", "test.bridge"] }));
    await hostCall("POST", "/v1/plugins/install", fs.readFileSync(counterZip), "application/zip");
    await hostCall("POST", "/v1/plugins/studio.counter/enable", JSON.stringify({ grants: ["counter.read", "counter.write"] }));

    await app.evaluate(({ dialog }, usesNativeDialog) => {
        const realDialog = dialog.showMessageBox.bind(dialog);
        globalThis.__dialog = { answer: 1, asked: [] };
        dialog.showMessageBox = async (owner, options) => {
            globalThis.__dialog.asked.push({ title: options.title, message: options.message });
            return usesNativeDialog ? realDialog(owner, options) : { response: globalThis.__dialog.answer };
        };
    }, nativeDialog);
    const asked = () => app.evaluate(() => globalThis.__dialog.asked.length);
    const answer = n => app.evaluate((_e, n) => { globalThis.__dialog.answer = n; }, n);

    const openPlugin = async title => {
        if (await desktop.locator("#extension-panel").isHidden()) await desktop.click("#extension-button");
        const entry = desktop.locator("#extension-list .menu-item", { hasText: title });
        await waitFor(`entry ${title}`, async () => (await entry.count()) === 1);
        await entry.click();
        return waitFor(`frame ${title}`, async () => desktop.frames().find(f => f.url().startsWith("kei-page://frame/")), 10000);
    };
    // The page's own script context posts messages exactly as plugin code would.
    const ask = (frame, message) => frame.evaluate(m => new Promise(resolve => {
        const id = "m" + Math.random().toString(16).slice(2);
        const listener = ({ source, data }) => {
            if (source === parent && data?.type === "kei:result" && data.id === id) { removeEventListener("message", listener); resolve(data); }
        };
        addEventListener("message", listener);
        parent.postMessage({ ...m, id }, "*");
        setTimeout(() => resolve({ timeout: true }), 15000);
    }), message);
    const bridge = (frame, toolName, key, extra = {}) => ask(frame, { type: "kei:call", action: "bridge",
        arguments: { serverId: "a", toolName, requestId: `req-${key}-${crypto.randomUUID().slice(0, 8)}`, arguments: { key }, ...extra } });
    const code = r => r.ok ? r.result?.error?.code ?? null : r.error?.code;
    async function confirm(frame, key, button) {
        await answer(button);
        const reply = ask(frame, { type: "kei:mcp-confirm", serverId: "a", toolName: "change", arguments: { key } });
        if (!nativeDialog) return reply;
        const helper = fileURLToPath(new URL("./native-observation-ui.ps1", import.meta.url));
        const pid = await app.evaluate(() => process.pid);
        const clicked = new Promise((resolve, reject) => {
            const process = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-File", helper,
                "-Mode", "Choose", "-OwnerPid", String(pid), "-Title", "プラグインからの MCP 実行の確認",
                "-ButtonId", String(100 + button)], { windowsHide: false });
            let diagnostic = "";
            process.stderr.on("data", bytes => { diagnostic += bytes.toString(); });
            process.on("error", reject);
            process.on("close", status => status === 0 ? resolve() : reject(new Error(diagnostic || "No native MCP dialog response")));
        });
        const [response] = await Promise.all([reply, clicked]);
        return response;
    }

    let frame = await openPlugin("MCP 確認テスト");

    const noToken = await bridge(frame, "change", "no-token");
    const boolOnly = await bridge(frame, "change", "bool-only", { confirmation: true, confirmed: true });
    record("D1 without a host token the mutation is refused; a page-supplied boolean grants nothing",
        code(noToken) === "confirmation_required" && code(boolOnly) === "confirmation_required" && calls("no-token") === 0 && calls("bool-only") === 0,
        { noToken: code(noToken), booleanOnly: code(boolOnly), dialogsShown: await asked() });

    const declined = await confirm(frame, "declined", 1);
    record("D2 the trusted dialog is shown in main; declining issues no token",
        declined.ok === false && declined.error.code === "user_cancelled" && (await asked()) === 1, { result: declined.error.code });

    const granted = await confirm(frame, "approved", 0);
    const token = granted.result?.confirmation;
    const used = await bridge(frame, "change", "approved", { confirmation: token });
    const reused = await bridge(frame, "change", "approved", { confirmation: token });
    record("D3 approval yields a one-use token: first call runs, reuse is refused",
        typeof token === "string" && used.ok && !code(used) && used.result?.result?.structuredContent?.server === "stdio" && code(reused) === "confirmation_required" && calls("approved") === 1,
        { firstCall: "ok", reuse: code(reused), fixtureExecutions: calls("approved"), dialogsShown: await asked() });

    const otherToken = (await confirm(frame, "bound-a", 0)).result?.confirmation;
    const swapped = await bridge(frame, "change", "bound-b", { confirmation: otherToken });
    record("D4 the token is bound to the confirmed arguments", code(swapped) === "confirmation_required" && calls("bound-b") === 0, { result: code(swapped) });

    const before = await asked();
    const readOnly = await ask(frame, { type: "kei:mcp-confirm", serverId: "a", toolName: "echo", arguments: { key: "ro" } });
    const readCall = await bridge(frame, "echo", "ro");
    const notAllowed = await ask(frame, { type: "kei:mcp-confirm", serverId: "a", toolName: "unknown", arguments: {} });
    const noServer = await ask(frame, { type: "kei:mcp-confirm", serverId: "zz", toolName: "change", arguments: {} });
    record("D5 read-only tools need no dialog; tools/servers outside pluginAccess are refused without a dialog",
        readOnly.ok && readOnly.result.readOnly === true && readOnly.result.confirmation === null && readCall.ok && !code(readCall)
        && code(notAllowed) === "mcp_scope_denied" && code(noServer) === "mcp_scope_denied" && (await asked()) === before,
        { readOnly: readOnly.result, outsideAccess: code(notAllowed), unknownServer: code(noServer) });

    // Another plugin's page cannot obtain a token for studio.mcp-confirm's access.
    await desktop.click("#plugin-sheet-close");
    frame = await openPlugin("カウンター");
    const foreign = await ask(frame, { type: "kei:mcp-confirm", serverId: "a", toolName: "change", arguments: { key: "foreign" }, pluginId: "studio.mcp-confirm" });
    record("D6 the plugin identity comes from the frame, not the message: another plugin is refused",
        code(foreign) === "mcp_scope_denied" && (await asked()) === before, { result: code(foreign) });
} catch (error) {
    exitCode = 1;
    console.error(error);
    results.push({ step: "unexpected error", ok: false, error: String(error.message || error) });
} finally {
    try { fs.writeFileSync(path.join(evidence, "logs", "shell-events.plugin-mcp.log"), fs.readFileSync(auditFile, "utf8").split(run).join("<temp>")); } catch { /* none */ }
    await Promise.race([app.close().catch(() => {}), sleep(10000)]);
    try { app.process().kill("SIGKILL"); } catch { /* gone */ }
    fs.writeFileSync(path.join(evidence, "acceptance-plugin-mcp.json"), JSON.stringify({
        when: new Date().toISOString(), headless, dialogMode: nativeDialog ? "native-windows" : "fixture",
        hostArtifact: path.relative(repo, hostArtifact),
        hostSha256: crypto.createHash("sha256").update(fs.readFileSync(hostArtifact)).digest("hex"),
        mcpFixture: path.relative(repo, mcpFixture), results,
    }, null, 2));
    console.log(exitCode ? "FAIL plugin-mcp acceptance" : "PASS plugin-mcp acceptance");
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(exitCode);
}
