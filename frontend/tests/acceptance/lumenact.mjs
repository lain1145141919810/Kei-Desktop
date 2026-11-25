import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import { previewAudio } from "../../character/playback.mjs";

const require = createRequire(import.meta.url);
const frontend = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR ?? "evidence/lumenact");
const zip = path.resolve(process.env.KEI_LUMENACT_ZIP);
const resourceRoot = path.resolve(process.env.KEI_LUMENACT_RESOURCES);
const run = fs.mkdtempSync(path.join(os.tmpdir(), "kei-r09-lumenact-"));
fs.mkdirSync(evidence, { recursive: true });
const env = { ...process.env, KEI_PROFILE_DIR: path.join(run, "profile"), KEI_DATA_DIR: path.join(run, "host") };
delete env.KEI_OFFSCREEN;
const app = await electron.launch({
    executablePath: require("electron"), args: [frontend], env, cwd: frontend, chromiumSandbox: true, timeout: 45000,
});
const checks = [];
const sound = Buffer.from(previewAudio()).toString("base64");
function pass(name, detail) {
    checks.push({ name, detail });
    console.log("PASS " + name);
}
const stageState = () => window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot();

try {
    const desktop = await app.firstWindow();
    await desktop.waitForFunction(() => document.querySelector("#connection-text")?.textContent === "Kei ホスト接続済み");
    await desktop.waitForFunction(() => document.querySelector("#character-stage")?.dataset.renderer === "live2d");
    await desktop.locator("#quick-button").click();
    await desktop.locator("[data-character-model=vrm]").click();
    await desktop.waitForFunction(() => document.querySelector("#character-stage")?.dataset.renderer === "vrm");
    const adminPromise = app.waitForEvent("window");
    await desktop.locator("#admin-button").click();
    const admin = await adminPromise;
    await admin.locator("#install").waitFor();
    const windowState = await app.evaluate(({ app, BrowserWindow }) => ({
        platform: process.platform, noSandbox: app.commandLine.hasSwitch("no-sandbox"),
        windows: BrowserWindow.getAllWindows().map(w => ({
            visible: w.isVisible(), offscreen: w.webContents.isOffscreen(),
            sandbox: w.webContents.getLastWebPreferences().sandbox,
        })),
    }));
    assert.equal(windowState.platform, "win32");
    assert.equal(windowState.noSandbox, false);
    assert.equal(windowState.windows.length, 2);
    assert.ok(windowState.windows.every(w => w.visible && !w.offscreen && w.sandbox));
    pass("native Windows desktop and admin windows with Chromium sandbox", windowState);

    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, zip);
    await admin.locator("#install").click();
    const card = admin.locator('.plugin-card[data-plugin-id="kei.lumenact"]');
    await card.locator('button[data-action="enable"]').waitFor();
    assert.equal(await card.getAttribute("data-enabled"), "false");
    for (const scope of ["select", "preview", "settings"]) await card.locator('input[value="lumenact.' + scope + '"]').check();
    await card.locator('button[data-action="enable"]').click();
    const entry = admin.locator('#admin-entries button[data-plugin-id="kei.lumenact"][data-entry-id="expression-admin"]');
    await entry.click();
    const page = admin.frameLocator("#plugin-page-body iframe.plugin-frame");
    await page.locator("#availability").waitFor();
    await page.locator("#clip option[value='0']").waitFor({ state: "attached" });
    await desktop.waitForFunction(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot().provider.connected);
    pass("install ZIP, grant separate scopes and open Japanese admin preview");

    await desktop.bringToFront();
    const noWeights = await desktop.evaluate(() =>
        window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.request("开心地微笑"));
    assert.deepEqual(noWeights, { state: "fallback", code: "assets_missing" });
    assert.equal((await desktop.evaluate(stageState)).face.clipId, null);
    pass("missing weights leave the baseline VRM face active");

    await admin.bringToFront();
    await page.locator("#clip").selectOption("5");
    await page.getByRole("button", { name: "プレビューを再生" }).click();
    await page.locator("#result").filter({ hasText: /#5.*fixed/ }).waitFor();
    await desktop.bringToFront();
    await desktop.waitForFunction(() => {
        const f = window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot().face;
        return f?.clipId === "5" && f.actual.surprised > .15;
    });
    const fixed = await desktop.evaluate(stageState);
    assert.equal(fixed.provider.selection.selector, "fixed");
    await desktop.screenshot({ path: path.join(evidence, "01-authored-curve-seed-san.png") });
    pass("admin launches a packaged original surprise curve on the real VRM morph", fixed);

    await admin.bringToFront();
    await page.locator("#stop").click();
    await desktop.bringToFront();
    await desktop.waitForFunction(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot().face?.clipId === null);
    pass("admin stop clears the current expression");

    await admin.bringToFront();
    await page.locator("#settings summary").click();
    await page.locator("#resource-root").fill(resourceRoot);
    await page.locator("#mapping").fill(JSON.stringify({
        happy: ["mouth_smile_1", "eye_cool_L"], unavailableBrow: ["eyebrow_up_L"],
    }));
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.locator("#settings-status").filter({ hasText: /再読み込み/ }).waitFor();
    await card.locator('button[data-action="reload"]').click();
    await page.locator("#preview").waitFor({ state: "detached" });
    await entry.click();
    await page.locator("#clip option[value='0']").waitFor({ state: "attached" });
    await desktop.bringToFront();
    await desktop.waitForFunction(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot().provider.connected);
    const selection = await desktop.evaluate(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions
        .request("开心地微笑，温和友好", "你好，见到你真开心。"));
    assert.equal(selection.state, "ready", JSON.stringify(selection));
    assert.equal(selection.selection.selector, "onnx");
    assert.equal(selection.selection.model, "RBT3-Lumen-38M-v6");
    assert.equal(selection.selection.label, "微笑");
    pass("admin settings persist and the real ONNX selects an authored smile", selection);

    const mixed = await desktop.evaluate(async encoded => {
        const api = window.KeiCharacterStage.get(document.querySelector("#character-stage"));
        // Start before the next baseline blink so the authored emotion, mouth and blink overlap.
        await new Promise(resolve => {
            function tick(now) {
                if (now % 3600 >= 2050 && now % 3600 <= 2450) resolve();
                else requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        });
        const lease = api.playback.begin("round09-mix");
        const enqueue = ["a", "b", "c", "d"].map(segmentId =>
            api.playback.segment({ ...lease, segmentId, audio: Uint8Array.fromBase64(encoded).buffer, subtitle: "LumenAct + Web Audio" }));
        const chosen = await api.expressions.request("开心地微笑，温和友好", "你好，见到你真开心。");
        await Promise.all(enqueue);
        const trace = await new Promise(resolve => {
            const rows = [];
            const deadline = performance.now() + 2850;
            function tick(now) {
                const frame = api.expressions.snapshot().face;
                const audio = api.playback.sample();
                if (frame?.clipId && audio) rows.push({ now, frame, audio });
                if (now >= deadline || rows.some(row =>
                    row.frame.actual.happy > .1 && row.frame.actual.aa > .1 && row.frame.actual.blink > .1)) resolve(rows);
                else requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        });
        return { lease, chosen, trace };
    }, sound);
    fs.writeFileSync(path.join(evidence, "face-trace.json"), JSON.stringify(mixed, null, 2) + "\n");
    const simultaneous = mixed.trace.find(row => row.frame.actual.happy > .1 && row.frame.actual.aa > .1 && row.frame.actual.blink > .1);
    assert.ok(simultaneous, "No same-frame actual morph values for emotion, phoneme and blink");
    assert.ok(simultaneous.frame.missing.includes("unavailableBrow"));
    assert.ok(Math.abs(simultaneous.frame.actual.aa - simultaneous.audio.value) < .0001);
    assert.equal(simultaneous.audio.clock, "getOutputTimestamp");
    await desktop.screenshot({ path: path.join(evidence, "02-onnx-smile-and-subtitle.png") });
    pass("real GPU face morphs combine LumenAct, live mouth audio and blink with missing-channel fallback", simultaneous);

    const interrupted = await desktop.evaluate(lease => {
        const api = window.KeiCharacterStage.get(document.querySelector("#character-stage"));
        return api.playback.interrupt(lease);
    }, mixed.lease);
    assert.equal(interrupted, true);
    await desktop.waitForFunction(() => {
        const f = window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot().face;
        return f?.clipId === null && f.actual.aa === 0;
    });
    const late = await desktop.evaluate(async () => {
        const source = window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions;
        const pending = source.request("惊讶震惊");
        source.interrupt();
        return await pending;
    });
    assert.deepEqual(late, { state: "fallback", code: "stale_selection" });
    pass("audio interruption and stale asynchronous results clear or cannot reapply expressions");

    const active = await desktop.evaluate(() => window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions
        .request("开心地微笑，温和友好", "你好，见到你真开心。"));
    assert.equal(active.state, "ready");
    await admin.bringToFront();
    await card.locator('button[data-action="disable"]').click();
    await desktop.bringToFront();
    await desktop.waitForFunction(() => {
        const s = window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot();
        return !s.provider.connected && s.face?.clipId === null;
    });
    await admin.bringToFront();
    await card.locator('button[data-action="uninstall"]').click();
    await card.locator('button[data-action="uninstall-confirm"]').click();
    await card.waitFor({ state: "detached" });
    await entry.waitFor({ state: "detached" });
    await desktop.bringToFront();
    const canvas = await desktop.locator(".character-canvas").boundingBox();
    await desktop.mouse.click(canvas.x + canvas.width * .35, canvas.y + canvas.height * .50);
    await desktop.waitForFunction(() => {
        const f = window.KeiCharacterStage.get(document.querySelector("#character-stage")).expressions.snapshot().face;
        return f?.clipId === null && f.weights.happy > .5;
    });
    pass("disable and uninstall revoke the curve session and leave the base pointer smile working", await desktop.evaluate(stageState));
} finally {
    fs.writeFileSync(path.join(evidence, "acceptance.json"), JSON.stringify({ checks }, null, 2) + "\n");
    await app.close();
}
