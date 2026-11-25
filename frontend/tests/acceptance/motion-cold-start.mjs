// DEF-02 real-shell check (Linux or Windows): N isolated cold launches of the Electron shell
// against the real host with kei.hastsec already installed and enabled, while the stage
// change that triggered the race is replayed at dom-ready. Then, in one session, deliberate
// disable/enable cycles under the same interrupt storm.
//
//   KEI_HOST_PYTHON=... KEI_HOST_ARTIFACT=... node tests/acceptance/motion-cold-start.mjs [--runs 20] [--cycles 10] [--headless]
//
// KEI_FRONTEND_DIR selects the shell to test (default: this checkout) so the same script can
// be pointed at a baseline build. Private VRM/solver assets are not needed: the check is the
// provider page lifecycle (page.open/page.close in shell-events.log and the stage snapshot).
import { _electron as electron } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(process.env.KEI_FRONTEND_DIR || path.resolve(here, "..", ".."));
const repo = path.resolve(here, "..", "..", "..");
const arg = (name, fallback) => {
    const index = process.argv.indexOf("--" + name);
    return index > 0 ? Number(process.argv[index + 1]) : fallback;
};
const RUNS = arg("runs", 20);
const CYCLES = arg("cycles", 10);
const REAL_MOTION = process.argv.includes("--real-motion");
const HAST_ROOT = process.env.KEI_HAST_ROOT;
if (REAL_MOTION && !HAST_ROOT) throw new Error("Set KEI_HAST_ROOT for real motion acceptance");
const HEADLESS = process.argv.includes("--headless");
const python = process.env.KEI_HOST_PYTHON || "python3";
const artifact = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(repo, "dist", "kei-host.pyz"));
const out = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "motion-cold-start"));
const hook = path.join(here, "motion-cold-start-hook.cjs");
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-def02-"));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const GRANTS = ["hastsec.solve", "hastsec.preview", "hastsec.settings"];

async function startHost(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const descriptor = path.join(dataDir, "connection.json");
    fs.rmSync(descriptor, { force: true });
    const child = spawn(python, [artifact, "--data-dir", dataDir, "--port", "0"], { stdio: ["ignore", "ignore", "pipe"] });
    for (let i = 0; i < 200 && !fs.existsSync(descriptor); i++) await sleep(50);
    const { url, token } = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    const request = async (method, route, body, type = "application/json") => {
        const response = await fetch(url + route, {
            method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": type } : {}) },
            body: body ? (type === "application/json" ? JSON.stringify(body) : body) : undefined,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(route + " " + JSON.stringify(data.error ?? data));
        return data.data;
    };
    return { child, request };
}

async function seedProfile() {
    const seed = path.join(root, "seed");
    const zip = path.join(root, "kei.hastsec.zip");
    execFileSync(python, ["-m", "kei_sdk.pack", path.join(repo, "plugins", "hastsec"), zip], { cwd: repo });
    const host = await startHost(path.join(seed, "host"));
    try {
        await host.request("POST", "/v1/plugins/install", fs.readFileSync(zip), "application/zip");
        if (REAL_MOTION) await host.request("PUT", "/v1/plugins/kei.hastsec/config", {
            values: { resource_root: path.resolve(HAST_ROOT), node_executable: "", git_executable: "" },
        });
        await host.request("POST", "/v1/plugins/kei.hastsec/enable", { grants: GRANTS });
        const entries = await host.request("GET", "/v1/entries");
        if (!entries.some(e => e.pluginId === "kei.hastsec" && e.id === "motion-provider")) throw new Error("motion-provider entry missing");
    } finally {
        host.child.kill();
        await new Promise(resolve => host.child.once("exit", resolve));
    }
    return seed;
}

function shellEvents(profile) {
    const file = path.join(profile, "logs", "shell-events.log");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
        .filter(e => (e.type === "page.open" || e.type === "page.close") && e.pluginId === "kei.hastsec");
}

async function launch(dir, extraEnv = {}) {
    const env = {
        ...process.env, KEI_PROFILE_DIR: path.join(dir, "profile"), KEI_DATA_DIR: path.join(dir, "host"),
        KEI_HOST_PYTHON: python, KEI_HOST_ARTIFACT: artifact,
        ...extraEnv,
    };
    const app = await electron.launch({ executablePath: require("electron"), args: ["-r", hook, frontend, ...(process.platform === "win32" ? [] : ["--no-sandbox"]), ...(HEADLESS ? ["--ozone-platform=headless", "--disable-gpu"] : [])], env, cwd: frontend, chromiumSandbox: process.platform === "win32", timeout: 40_000 });
    const page = await app.firstWindow();
    return { app, page };
}

const stageProvider = () => window.KeiCharacterStage?.get(document.querySelector("#character-stage"))?.motion?.snapshot()?.provider ?? null;

const seed = await seedProfile();
const summary = { frontend: path.basename(path.dirname(frontend)) + "/" + path.basename(frontend), artifact: path.basename(artifact), headless: HEADLESS, platform: process.platform, runs: [], cycles: null };
let disconnected = 0;
for (let run = 0; run < RUNS; run++) {
    const dir = path.join(root, "run-" + run);
    fs.cpSync(seed, dir, { recursive: true });
    const started = Date.now();
    const { app, page } = await launch(dir);
    let provider = null;
    let cold = null;
    let events = [];
    let firstMotion = null;
    try {
        await page.waitForFunction(() => window.__keiColdStart, null, { timeout: 15_000 });
        // Settle: storm (1.5 s) plus margin for any bounded retry.
        await page.waitForFunction(() => {
            const c = window.__keiColdStart;
            return c && performance.now() > 0 && c.trace.length && Date.now() - c.startedAt > 4000;
        }, null, { timeout: 20_000, polling: 100 });
        provider = await page.evaluate(stageProvider);
        cold = await page.evaluate(() => window.__keiColdStart);
        if (REAL_MOTION) {
            try {
                const open = selector => page.locator(selector).evaluate(button => button.click());
                await open("#quick-button");
                await open("[data-character-model=vrm]");
                await page.waitForFunction(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).snapshot().model === "vrm");
                await open("#quick-button");
                await page.waitForFunction(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).motion.snapshot().provider.readiness === "ready");
                const result = await page.evaluate(async () => {
                    const motion = window.KeiCharacterStage.get(document.querySelector("#character-stage")).motion;
                    const started = performance.now();
                    const reply = await motion.request({ motion: "greeting-wave" });
                    return { state: reply.state, code: reply.code ?? null, requestMs: performance.now() - started };
                });
                firstMotion = { ...result, rendered: false };
                if (result.state === "ready") {
                    await page.waitForFunction(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).motion.snapshot().render?.active?.motion === "greeting-wave");
                    firstMotion.rendered = true;
                }
                provider = await page.evaluate(stageProvider);
            } catch (error) {
                firstMotion = { ...firstMotion, rendered: false, error: String(error.message).split("\n")[0] };
            }
        }
    } finally {
        // Read the audit log before shutdown so shutdown closes are not counted.
        events = shellEvents(path.join(dir, "profile")).filter(e => e.entryId === "motion-provider");
        await app.close().catch(() => {});
    }
    const opens = events.filter(e => e.type === "page.open");
    const closes = events.filter(e => e.type === "page.close");
    const firstOpen = opens[0] ? Date.parse(opens[0].time) : null;
    const closeAfterOpenMs = firstOpen && closes[0] ? Date.parse(closes[0].time) - firstOpen : null;
    const ok = Boolean(provider?.connected) && (!REAL_MOTION || firstMotion?.rendered === true);
    if (!ok) disconnected++;
    const row = {
        run, ok, firstMotion, connected: Boolean(provider?.connected), state: provider?.state ?? null,
        readiness: provider?.readiness ?? null, connection: provider?.connection ?? null,
        interrupts: cold?.interrupts ?? null, firstConnectedMs: cold?.firstConnectedMs ?? null,
        opens: opens.length, closesBeforeShutdown: closes.map(e => e.reason),
        firstCloseAfterOpenMs: closeAfterOpenMs, trace: cold?.trace ?? [], launchMs: Date.now() - started,
    };
    summary.runs.push(row);
    console.log(`${ok ? "PASS" : "FAIL"} cold-start ${run + 1}/${RUNS} connected=${row.connected} state=${row.state} ` +
        `firstMotion=${row.firstMotion?.rendered ?? "not-requested"} opens=${row.opens} earlyCloses=${JSON.stringify(row.closesBeforeShutdown)} closeAfterOpenMs=${closeAfterOpenMs}`);
}

// Disable/enable cycles in one session while the interrupt storm keeps running.
if (CYCLES > 0) {
    const dir = path.join(root, "cycles");
    fs.cpSync(seed, dir, { recursive: true });
    const { app, page } = await launch(dir, { KEI_STORM_MS: String(5000 + CYCLES * 1500) });
    const cycles = [];
    let events = [];
    try {
        await page.waitForFunction(() => window.__keiColdStart, null, { timeout: 15_000 });
        const descriptorFile = path.join(dir, "host", "connection.json");
        for (let i = 0; i < 200 && !fs.existsSync(descriptorFile); i++) await sleep(50);
        const descriptor = JSON.parse(fs.readFileSync(descriptorFile, "utf8"));
        const call = async (route, body) => {
            const response = await fetch(descriptor.url + route, {
                method: "POST", headers: { Authorization: "Bearer " + descriptor.token, "Content-Type": "application/json" },
                body: JSON.stringify(body ?? {}),
            });
            if (!response.ok) throw new Error(route + " returned HTTP " + response.status);
        };
        await page.waitForFunction(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).motion.snapshot().provider.connected === true);
        async function awaitConnection(expected) {
            const start = Date.now();
            await page.waitForFunction(connected => window.KeiCharacterStage.get(document.querySelector("#character-stage")).motion.snapshot().provider.connected === connected,
                expected, {timeout:8000}).catch(() => {});
            return { ...await page.evaluate(stageProvider), observedAfterMs: Date.now() - start };
        }
        for (let i = 0; i < CYCLES; i++) {
            await call("/v1/plugins/kei.hastsec/disable");
            const off = await awaitConnection(false);
            await call("/v1/plugins/kei.hastsec/enable", { grants: GRANTS });
            const on = await awaitConnection(true);
            cycles.push({ i, afterDisable: { connected: off?.connected, state: off?.state, observedAfterMs: off.observedAfterMs },
                afterEnable: { connected: on?.connected, state: on?.state, observedAfterMs: on.observedAfterMs } });
        }
    } finally {
        events = shellEvents(path.join(dir, "profile")).filter(e => e.entryId === "motion-provider");
        await app.close().catch(() => {});
    }
    const ok = cycles.every(c => c.afterDisable.connected === false && c.afterEnable.connected === true);
    summary.cycles = { ok, cycles, opens: events.filter(e => e.type === "page.open").length,
        closeReasons: events.filter(e => e.type === "page.close").map(e => e.reason) };
    console.log(`${ok ? "PASS" : "FAIL"} disable/enable under interrupt storm: ${cycles.filter(c => c.afterDisable.connected === false && c.afterEnable.connected === true).length}/${CYCLES}`);
}

summary.disconnected = disconnected;
fs.writeFileSync(path.join(out, "motion-cold-start.json"), JSON.stringify(summary, null, 2));
console.log(`SUMMARY cold starts: ${summary.runs.filter(row => row.connected).length}/${RUNS} connected; ${summary.runs.filter(row => row.firstMotion?.rendered).length} first motions observed; evidence ${path.join(out, "motion-cold-start.json")}`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(disconnected || (summary.cycles && !summary.cycles.ok) ? 1 : 0);
