import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const useLive = process.argv.includes("--live");
const useFixture = process.argv.includes("--fixture");
if (useLive === useFixture) {
    console.error("Usage: node verify-semantic-optin.mjs --live | --fixture [--app <path/to/kei-desktop>] [--out <file.json>]");
    process.exit(2);
}

function argAfter(flag) {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

const appRoot = path.resolve(argAfter("--app") ?? path.join(here, "../.."));
const frontend = path.join(appRoot, "frontend");
const hostArtifact = path.join(appRoot, "dist", "kei-host.pyz");
const python = path.resolve(here, "../../../round-09/.venv/Scripts/python.exe");
const fixtureAdapter = path.resolve(here, "../../../round-07/external-adapter/fixture.py");
const outFile = path.resolve(argAfter("--out") ?? path.join(here, "../../../round-16-17-integration", useLive ? "semantic-live-r17.json" : "semantic-fixture-r17.json"));
const screenshotDir = path.join(here, "../../../round-16-17-integration/private-kei", useLive ? "semantic-live" : "semantic-fixture");

const VALID_FACES = new Set([
    "neutral", "smallSmile", "gentle", "happy", "bashful", "surprised", "flustered",
    "shout", "sad", "serious", "thoughtful", "angry", "relaxed", "relieved", "worried", "skeptical",
]);
const VALID_MOTIONS = new Set(["none", "nod", "tilt", "shake"]);

// Sanitize provider metadata: NEVER include credentials, query strings, userinfo, or raw tokens
function describeProvider(config) {
    const parsed = new URL(config.endpoint);
    return {
        scheme: parsed.protocol.replace(":", ""),
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
        credentialEnvPresent: config.credentialRef ? Boolean(process.env[config.credentialRef]) : null,
        timeoutSeconds: config.timeoutSeconds ?? 30,
    };
}

async function resolveLiveConfig() {
    const cfgPath = process.env.KEI_LIVE_CHAT_CONFIG;
    if (cfgPath) {
        const raw = JSON.parse(await fs.readFile(cfgPath, "utf8"));
        if (!raw || typeof raw !== "object" || !raw.endpoint || !raw.model) {
            throw new Error("KEI_LIVE_CHAT_CONFIG must contain endpoint and model");
        }
        return { source: "KEI_LIVE_CHAT_CONFIG", config: raw };
    }
    if (process.env.KEI_LIVE_ENDPOINT && process.env.KEI_LIVE_MODEL) {
        const cfg = {
            endpoint: process.env.KEI_LIVE_ENDPOINT,
            model: process.env.KEI_LIVE_MODEL,
        };
        if (process.env.KEI_LIVE_CREDENTIAL_REF) cfg.credentialRef = process.env.KEI_LIVE_CREDENTIAL_REF;
        if (process.env.KEI_LIVE_TIMEOUT_SECONDS) cfg.timeoutSeconds = Number(process.env.KEI_LIVE_TIMEOUT_SECONDS);
        return { source: "KEI_LIVE_ENDPOINT+KEI_LIVE_MODEL", config: cfg };
    }
    return null;
}

if (useLive) {
    const resolved = await resolveLiveConfig();
    if (!resolved) {
        const report = {
            mode: "live",
            evidenceClass: "live-provider-unavailable",
            liveProviderValidated: false,
            liveProviderAvailable: false,
            reason: "No owner-configured live chat provider found in KEI_LIVE_CHAT_CONFIG or KEI_LIVE_ENDPOINT + KEI_LIVE_MODEL.",
            howToRun: {
                optionA: "Set KEI_LIVE_CHAT_CONFIG=<path/to/chat.json> (and any referenced credentialRef env var), then run: node kei-desktop/tools/round17/verify-semantic-optin.mjs --live",
                optionB: "Set KEI_LIVE_ENDPOINT=https://... KEI_LIVE_MODEL=<model> KEI_LIVE_CREDENTIAL_REF=<ENV_VAR_NAME> (with <ENV_VAR_NAME> set), then run: node kei-desktop/tools/round17/verify-semantic-optin.mjs --live",
            },
        };
        await fs.writeFile(outFile, JSON.stringify(report, null, 2) + "\n", "utf8");
        console.log(JSON.stringify(report, null, 2));
        process.exit(0);
    }
    if (resolved.config.credentialRef && !process.env[resolved.config.credentialRef]) {
        throw new Error(`Configured credentialRef env var '${resolved.config.credentialRef}' is not set`);
    }
}

const require = createRequire(path.join(frontend, "package.json"));
const { _electron: electron } = require("playwright-core");
const work = await fs.mkdtemp(path.join(os.tmpdir(), useLive ? "kei-r17-live-" : "kei-r17-fixture-"));
const dataDir = path.join(work, "host");
const adaptersDir = path.join(work, "adapters");

const fixtureExpected = {
    reply: { face: "relieved", motion: "nod" },
    "work-input": { face: "thoughtful", motion: "tilt" },
    "work-success": { face: "happy", motion: "nod" },
    "work-error": { face: "worried", motion: "shake" },
};
const fixtureCalls = [];
let fixtureInvalid = false;
let fixtureDeferred = null;
let server = null;
let app = null;

if (useFixture) {
    server = http.createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const { messages } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const isVisual = messages[0].content.startsWith("Choose one face");
            let body = "確認しました。次の作業へ進められます。";
            if (isVisual) {
                const input = JSON.parse(messages.at(-1).content);
                assert.deepEqual(Object.keys(input).sort(), ["context", "kind"]);
                assert.ok(fixtureExpected[input.kind]);
                if (input.kind !== "reply") {
                    assert.match(input.context, /^A local work session /);
                    assert.doesNotMatch(input.context, /synthetic-secret|synthetic-answer/);
                }
                fixtureCalls.push({ kind: input.kind });
                if (fixtureDeferred) await fixtureDeferred;
                body = fixtureInvalid
                    ? JSON.stringify({ face: "inventedFace", motion: "inventedMotion" })
                    : JSON.stringify(fixtureExpected[input.kind]);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: body } }] }));
        } catch (error) {
            console.error("[fixture server error]", error.message);
            res.writeHead(500).end();
        }
    });
}

const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");

try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(adaptersDir, { recursive: true });
    await fs.mkdir(screenshotDir, { recursive: true });

    let chatConfig;
    let providerSummary;
    if (useLive) {
        const resolved = await resolveLiveConfig();
        chatConfig = resolved.config;
        providerSummary = { source: resolved.source, ...describeProvider(chatConfig) };
    } else {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        chatConfig = {
            endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
            model: "loopback-fixture-r17",
        };
        providerSummary = { source: "loopback-fixture", ...describeProvider(chatConfig) };
    }

    await writeJson(path.join(dataDir, "chat.json"), chatConfig);
    await writeJson(path.join(adaptersDir, "fixture.json"), {
        id: "studio.fixture", name: "Round 17 synthetic work fixture", apiVersion: 1,
        command: [python, fixtureAdapter],
        capabilities: ["cancel", "input", "progress", "artifacts"],
    });

    // Deliberately pass lowercase Windows drive letter in fixture mode to verify R16 Patch 01 end-to-end!
    const launchFrontend = useFixture && process.platform === "win32"
        ? frontend.replace(/^([A-Z]):\\/, (_, d) => `${d.toLowerCase()}:\\`)
        : frontend;

    const env = {
        ...process.env,
        KEI_PROFILE_DIR: path.join(work, "profile"),
        KEI_DATA_DIR: dataDir,
        KEI_HOST_PYTHON: python,
        KEI_HOST_ARTIFACT: hostArtifact,
        KEI_EXECUTOR_DIR: adaptersDir,
    };
    for (const k of ["KEI_HOST_CONNECTION", "KEI_OPEN_ADMIN", "KEI_OFFSCREEN", "KEI_EXECUTOR_CONFIG"]) delete env[k];

    app = await electron.launch({
        executablePath: require("electron"),
        args: [launchFrontend],
        env,
        chromiumSandbox: true,
        cwd: frontend,
    });
    const page = await app.firstWindow();
    const click = selector => page.locator(selector).evaluate(btn => btn.click());

    await page.locator("#connection-text").filter({ hasText: "Kei ホスト接続済み" }).waitFor({ timeout: 30000 });
    const phase = await page.evaluate(() => document.body.dataset.presentationPhase ?? null);
    if (phase !== null) {
        await page.waitForFunction(() => !document.body.dataset.presentationPhase || document.body.dataset.presentationPhase === "idle", null, { timeout: 30000 });
    }

    const native = await app.evaluate(({ app, BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return {
            platform: process.platform,
            visible: win.isVisible(),
            offscreen: win.webContents.isOffscreen(),
            sandbox: win.webContents.getLastWebPreferences().sandbox,
            noSandbox: app.commandLine.hasSwitch("no-sandbox"),
        };
    });
    assert.ok(native.visible && !native.offscreen && native.sandbox && !native.noSandbox);

    // Wait for initial character stage (Live2D) to finish loading so model switcher buttons are enabled
    await page.locator('#character-stage canvas').waitFor({ timeout: 25000 });

    // Switch ordinary desktop to bundled Round 16 VRM!
    await click("#quick-button");
    await page.locator("[data-character-model=vrm]:enabled").waitFor({ timeout: 25000 });
    await click("[data-character-model=vrm]");
    await page.locator('#character-stage canvas[data-kind="vrm"]').waitFor({ timeout: 25000 });
    await click("#quick-button");

    const vrmMeta = await page.evaluate(() => {
        const st = window.KeiCharacterStage.get(document.querySelector("#character-stage")).snapshot();
        return {
            file: st.vrm?.file ?? null,
            sha256: st.vrm?.sha256 ?? null,
            name: st.capabilities?.name ?? null,
            expressionsCount: st.capabilities?.expressions?.length ?? 0,
            renderer: st.capabilities?.renderer ?? null,
        };
    });
    assert.equal(vrmMeta.file, "kei-pmx-r16.vrm");
    console.log("PASS Ordinary desktop loaded bundled R16 VRM:", vrmMeta);

    const stageResults = [];
    async function observeStage(kind, timeoutMs = 15000) {
        const t0 = Date.now();
        if (useFixture) {
            const exp = fixtureExpected[kind];
            await page.waitForFunction(({ kind, face, motion }) => {
                const st = window.KeiCharacterStage.get(document.querySelector("#character-stage"));
                const plan = window.KeiReactions.snapshot().plan;
                return plan?.kind === kind && plan.face === face && plan.motion === motion
                    && st.snapshot().gesture === motion
                    && (face === "neutral" || st.expressions.snapshot().face?.actual[face] > 0.28)
                    && st.motion.snapshot().render?.head?.some(a => Math.abs(a) > 0.08);
            }, { kind, ...exp }, { timeout: timeoutMs });
        } else {
            // In live mode, wait for KeiReactions.snapshot().plan to populate with valid bounded face & motion
            await page.waitForFunction(k => {
                const plan = window.KeiReactions.snapshot().plan;
                return plan?.kind === k;
            }, kind, { timeout: timeoutMs }).catch(() => {});
        }
        const snap = await page.evaluate(() => {
            const st = window.KeiCharacterStage.get(document.querySelector("#character-stage"));
            const r = window.KeiReactions.snapshot();
            const head = st.motion.snapshot().render?.head ?? null;
            const actual = st.expressions.snapshot().face?.actual ?? {};
            return {
                plan: r.plan,
                reactionFace: r.current,
                gesture: st.snapshot().gesture,
                head: head ? head.map(v => Number(v.toFixed(4))) : null,
                faceActual: r.plan?.face ? Number((actual[r.plan.face] ?? 0).toFixed(4)) : null,
            };
        });
        const latencyMs = Date.now() - t0;
        if (snap.plan) {
            assert.ok(VALID_FACES.has(snap.plan.face), `Invalid face: ${snap.plan.face}`);
            assert.ok(VALID_MOTIONS.has(snap.plan.motion), `Invalid motion: ${snap.plan.motion}`);
        }
        if (useFixture) await page.screenshot({ path: path.join(screenshotDir, `${kind}.png`) });
        const row = {
            kind,
            latencyMs,
            planReceived: Boolean(snap.plan?.kind === kind),
            plan: snap.plan,
            reactionFace: snap.reactionFace,
            gesture: snap.gesture,
            faceActual: snap.faceActual,
            headAngles: snap.head,
        };
        stageResults.push(row);
        console.log(`STAGE [${kind}]:`, JSON.stringify(row));
        return row;
    }

    // 1. Synthetic dialogue turn -> reply visual plan
    await page.locator("#composer-input").fill("テスト用の合成メッセージです。短く応答してください。");
    await page.locator("#composer-input").press("Enter");
    await observeStage("reply", useLive ? 35000 : 15000);

    // 2. Synthetic work lifecycle: ask (work-input) -> answer (work-success) -> exit (work-error)
    await click("#sessions-button");
    const panel = page.locator("#sessions-panel");
    async function submitWork(input) {
        await panel.getByText("新しい作業を頼む", { exact: true }).click();
        await page.locator("#sessions-executor").selectOption("studio.fixture");
        await page.locator("#sessions-input").fill(input);
        await panel.getByRole("button", { name: "依頼する" }).click();
        return panel.locator("article").filter({ hasText: input });
    }
    const ask = await submitWork("ask");
    const answerBox = ask.getByRole("textbox", { name: "答え" });
    await answerBox.waitFor({ timeout: 15000 });
    await observeStage("work-input", useLive ? 15000 : 12000);

    await answerBox.fill("synthetic-answer");
    await ask.getByRole("button", { name: "答える" }).click();
    await ask.filter({ hasText: "入力: synthetic-answer" }).waitFor({ timeout: 15000 });
    await observeStage("work-success", useLive ? 15000 : 12000);

    const failed = await submitWork("exit");
    await failed.filter({ hasText: "失敗" }).waitFor({ timeout: 15000 });
    await observeStage("work-error", useLive ? 15000 : 12000);
    await click("#sessions-button");

    // 3. Malformed plan check (fixture mode) + Stale-plan handling (both fixture & live modes!)
    let malformedChecked = null;
    if (useFixture) {
        fixtureInvalid = true;
        const malformed = await page.evaluate(() => window.kei.chat.visual("work-error"));
        assert.deepEqual(malformed, { state: "fallback", code: "invalid_visual_plan" });
        fixtureInvalid = false;
        malformedChecked = { passed: true, response: malformed };
    }

    let staleRejected = false;
    if (useFixture) {
        let release;
        fixtureDeferred = new Promise(resolve => { release = resolve; });
        const before = fixtureCalls.length;
        await page.evaluate(() => window.KeiReactions.work("failed"));
        for (let i = 0; i < 30 && fixtureCalls.length === before; i++) await new Promise(r => setTimeout(r, 80));
        assert.equal(fixtureCalls.length, before + 1);
        await page.evaluate(() => window.kei.chat.newConversation());
        await page.waitForFunction(() => window.KeiReactions.snapshot().plan === null);
        fixtureDeferred = null;
        release();
        await new Promise(r => setTimeout(r, 500));
        const afterPlan = await page.evaluate(() => window.KeiReactions.snapshot().plan);
        assert.equal(afterPlan, null);
        staleRejected = true;
    } else {
        // Live mode stale-plan test: trigger work-error visual call and immediately switch conversation before response returns
        await page.evaluate(async () => {
            window.KeiReactions.work("failed");
            await window.kei.chat.newConversation();
        });
        await new Promise(r => setTimeout(r, 7000));
        const afterPlan = await page.evaluate(() => window.KeiReactions.snapshot().plan);
        assert.equal(afterPlan, null, "Superseded live visual plan must not actuate after conversation switch");
        staleRejected = true;
    }
    console.log("PASS Stale-plan cancellation verified:", { staleRejected });

    const report = {
        mode: useLive ? "live" : "fixture",
        evidenceClass: useLive ? "live-provider" : "loopback-fixture-not-live",
        liveProviderValidated: useLive && stageResults.length === 4 && stageResults.every(s => s.planReceived) && staleRejected,
        timestampUtc: new Date().toISOString(),
        baseline: {
            isolatedAppRoot: path.basename(appRoot),
            lowercaseLaunchPathTested: useFixture && process.platform === "win32",
        },
        provider: providerSummary,
        nativeWindow: native,
        vrm: vrmMeta,
        stages: stageResults,
        malformedPlanRejection: malformedChecked,
        stalePlanRejected: staleRejected,
        allPassed: useFixture
            ? stageResults.every(s => s.planReceived) && staleRejected && Boolean(malformedChecked?.passed)
            : stageResults.length === 4 && stageResults.every(s => s.planReceived) && staleRejected,
    };
    await writeJson(outFile, report);
    console.log("WROTE REPORT:", outFile);
} catch (err) {
    console.error("SEMANTIC RUNNER FAILED:", err);
    process.exitCode = 1;
} finally {
    if (fixtureDeferred && server) server.closeAllConnections();
    await app?.close().catch(() => {});
    if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    await new Promise(r => setTimeout(r, 600));
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
}
