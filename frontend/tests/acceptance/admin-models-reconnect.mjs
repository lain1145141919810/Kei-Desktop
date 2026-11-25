// DEF-01 real-shell check: Admin opened at launch (KEI_OPEN_ADMIN=1) before the host binds.
// A wrapper delays the host's Python start so the race is deterministic. Verifies, with no
// click on 今すぐ更新: the モデル list and chat-config card leave the "cannot connect" state on
// their own (empty profile), the populated state after a provider plugin is enabled, the
// disconnected state when the host stops, and that keyboard focus stays on the same control
// across automatic refreshes.
//
//   KEI_HOST_PYTHON=... KEI_HOST_ARTIFACT=... node tests/acceptance/admin-models-reconnect.mjs [--headless] [--runs 5] [--admin-at-launch]
import { _electron as electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(process.env.KEI_FRONTEND_DIR || path.resolve(here, "..", ".."));
const repo = path.resolve(here, "..", "..", "..");
const HEADLESS = process.argv.includes("--headless");
// KEI_OPEN_ADMIN=1 is the literal field path. In the Linux sandbox used for Round 26 Electron
// 44 crashes when two windows open at startup (baseline too), so the default opens Admin from
// the desktop window before the host binds, which is the same race.
const ADMIN_AT_LAUNCH = process.argv.includes("--admin-at-launch");
const runsIndex = process.argv.indexOf("--runs");
const RUNS = runsIndex > 0 ? Number(process.argv[runsIndex + 1]) : 5;
const python = process.env.KEI_HOST_PYTHON || "python3";
const artifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "dist", "kei-host.pyz"));
const out = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "admin-models"));
const DELAY = Number(process.env.KEI_HOST_DELAY_S || 3);
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-def01-"));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CANNOT_LIST = "Kei ホストに接続できないため、モデルを表示できません。";
const CANNOT_CHAT = "Kei ホストに接続できないため、会話モデル設定を読み込めません。";

const slowArtifact = path.join(root, "slow-host.py");
fs.writeFileSync(slowArtifact, [
    "import os, runpy, sys, time",
    "from pathlib import Path",
    "time.sleep(" + JSON.stringify(DELAY) + ")",
    "folder = Path(sys.argv[sys.argv.index('--data-dir') + 1])",
    "folder.mkdir(parents=True, exist_ok=True)",
    "(folder / 'fixture-process.pid').write_text(str(os.getpid()), encoding='ascii')",
    "runpy.run_path(" + JSON.stringify(artifact) + ", run_name='__main__')",
].join("\n"));
const providerZip = path.join(root, "kei.openai-compat-models.zip");
execFileSync(python, ["-m", "kei_sdk.pack", path.join(repo, "plugins", "openai-compat-models"), providerZip], { cwd: repo });

async function hostRequest(dataDir, method, route, body, type = "application/json") {
    const { url, token } = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    const response = await fetch(url + route, {
        method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": type } : {}) },
        body: body ? (type === "application/json" ? JSON.stringify(body) : body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(route + " " + JSON.stringify(data.error ?? data));
    return data.data;
}

const read = () => ({
    summary: document.getElementById("model-summary")?.textContent ?? "",
    list: document.getElementById("model-list")?.textContent ?? "",
    cards: document.querySelectorAll("#model-list .model-card").length,
    options: document.querySelectorAll("#model-list option[value]:not([value=''])").length,
    chat: document.getElementById("chat-config-current")?.textContent ?? "",
    focus: document.activeElement ? [document.activeElement.closest(".model-card")?.dataset.capability ?? null, document.activeElement.dataset?.role ?? null] : null,
});

const rows = [];
for (let run = 0; run < RUNS; run++) {
    const dir = path.join(root, "run-" + run);
    const dataDir = path.join(dir, "host");
    const env = { ...process.env, KEI_PROFILE_DIR: path.join(dir, "profile"), KEI_DATA_DIR: dataDir,
        KEI_HOST_PYTHON: python, KEI_HOST_ARTIFACT: slowArtifact, ...(ADMIN_AT_LAUNCH ? { KEI_OPEN_ADMIN: "1" } : {}) };
    const app = await electron.launch({ executablePath: require("electron"),
        args: [frontend, ...(process.platform === "win32" ? [] : ["--no-sandbox"]), ...(HEADLESS ? ["--ozone-platform=headless", "--disable-gpu"] : [])],
        env, cwd: frontend, chromiumSandbox: process.platform === "win32", timeout: 40_000 });
    const row = { run };
    try {
        if (!ADMIN_AT_LAUNCH) {
            // Same race without KEI_OPEN_ADMIN: open 管理 → モデル from the desktop while the
            // delayed host is still unbound (see --admin-at-launch for the literal env path).
            const desktop = await app.firstWindow();
            await desktop.waitForFunction(() => Boolean(window.kei?.openAdmin), null, { timeout: 15_000 });
            row.openedBeforeHost = !(await desktop.evaluate(async () => (await window.kei.status())?.status?.connected));
            await desktop.evaluate(() => window.kei.openAdmin("models"));
        }
        let admin = null;
        for (let i = 0; i < 100 && !admin; i++) {
            admin = app.windows().find(w => w.url().includes("admin.html")) ?? null;
            if (!admin) await sleep(100);
        }
        if (!admin) throw new Error("admin window did not open");
        await admin.waitForLoadState("domcontentloaded");
        await admin.locator('a[data-section="models"]').click();
        // 1. Before the host binds: the honest "cannot connect" state must show.
        await admin.waitForFunction(([a, b]) =>
            document.getElementById("model-list").textContent.includes(a) &&
            document.getElementById("chat-config-current").textContent.includes(b), [CANNOT_LIST, CANNOT_CHAT], { timeout: 10_000 });
        row.beforeHost = await admin.evaluate(read);
        // 2. Host binds; no click on 今すぐ更新. Empty profile -> cards, no providers.
        const t0 = Date.now();
        await admin.waitForFunction(([a, b]) =>
            document.querySelectorAll("#model-list .model-card").length > 0 &&
            !document.getElementById("chat-config-current").textContent.includes(b) &&
            !document.getElementById("model-list").textContent.includes(a), [CANNOT_LIST, CANNOT_CHAT], { timeout: DELAY * 1000 + 15_000 });
        row.recoveredAfterMs = Date.now() - t0;
        row.empty = await admin.evaluate(read);
        // 3. Keyboard focus on the TTS provider select, then populate through the host API.
        await admin.locator('.model-card[data-capability="tts"] [data-role="select"]').focus();
        await admin.keyboard.press("Tab");
        await admin.keyboard.press("Shift+Tab");
        const focusBefore = await admin.evaluate(read);
        const installed = await hostRequest(dataDir, "POST", "/v1/plugins/install", fs.readFileSync(providerZip), "application/zip");
        await hostRequest(dataDir, "POST", `/v1/plugins/${installed.id}/enable`, {
            grants: ["model.provide.tts", "model.provide.asr", "model.provide.vision", "model.provide.embedding"] });
        await admin.waitForFunction(() => [...document.querySelectorAll("#model-list option[value]")].some(o => o.value && !o.disabled), null, { timeout: 15_000 });
        row.populated = await admin.evaluate(read);
        row.focusKept = JSON.stringify(focusBefore.focus) === JSON.stringify(row.populated.focus);
        // 4. Host stops: last cards stay (focus kept), summary says it is waiting.
        const pid = Number(fs.readFileSync(path.join(dataDir, "fixture-process.pid"), "ascii"));
        process.kill(pid, "SIGTERM");
        await admin.waitForFunction(() => document.getElementById("model-summary").textContent.includes("接続待ち"), null, { timeout: 15_000 }).catch(() => {});
        row.disconnected = await admin.evaluate(read);
        row.focusKeptOnDisconnect = JSON.stringify(focusBefore.focus) === JSON.stringify(row.disconnected.focus);
    } catch (error) {
        row.error = String(error.message).split("\n")[0];
    } finally {
        await app.close().catch(() => {});
    }
    row.ok = !row.error && row.openedBeforeHost !== false && row.beforeHost?.list.includes(CANNOT_LIST) && row.empty?.cards === 4 && row.empty?.options === 0
        && row.populated?.options > 0 && row.focusKept && row.disconnected?.summary.includes("接続待ち")
        && row.disconnected?.cards === 4 && row.focusKeptOnDisconnect;
    rows.push(row);
    console.log(`${row.ok ? "PASS" : "FAIL"} admin-models run ${run + 1}/${RUNS} recoveredAfterMs=${row.recoveredAfterMs ?? "-"} ` +
        `empty=${row.empty?.cards ?? "-"}cards/${row.empty?.options ?? "-"}opts populated=${row.populated?.options ?? "-"}opts ` +
        `focusKept=${row.focusKept ?? "-"} disconnected="${row.disconnected?.summary ?? "-"}" focusKeptOnDisconnect=${row.focusKeptOnDisconnect ?? "-"}` +
        (row.error ? " error=" + row.error : ""));
}
fs.writeFileSync(path.join(out, "admin-models-reconnect.json"), JSON.stringify({ headless: HEADLESS, adminAtLaunch: ADMIN_AT_LAUNCH, delaySeconds: DELAY, rows }, null, 2));
const passed = rows.filter(r => r.ok).length;
console.log(`SUMMARY admin-models reconnect: ${passed}/${RUNS}`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(passed === RUNS ? 0 : 1);
