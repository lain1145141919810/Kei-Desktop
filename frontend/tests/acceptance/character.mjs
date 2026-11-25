import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { previewAudio } from "../../character/playback.mjs";

const require = createRequire(import.meta.url);
const frontend = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR ?? "evidence/character");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kei-character-acceptance-"));
const results = [];
const errors = [];
const consoleMessages = [];
fs.mkdirSync(evidence, { recursive: true });
const env = {
    ...process.env, KEI_PROFILE_DIR: path.join(temp, "profile"), KEI_DATA_DIR: path.join(temp, "host"),
};
delete env.KEI_OFFSCREEN;
const app = await electron.launch({
    executablePath: require("electron"),
    args: [frontend], env, cwd: frontend, chromiumSandbox: true, timeout: 40_000,
});

function record(label, detail = {}) {
    results.push({ label, ...detail });
    console.log("PASS " + label);
}

const snapshot = () => window.KeiCharacterStage.get(document.querySelector("#character-stage")).snapshot();
const wav1 = Buffer.from(previewAudio()).toString("base64");
const wav2 = Buffer.from(previewAudio(350)).toString("base64");

let page;
try {
    page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
        if (["error", "warning"].includes(message.type()) && consoleMessages.length < 100) {
            consoleMessages.push(message.text());
        }
    });
    const waitModel = kind => page.waitForFunction(kind => {
        const state = window.KeiCharacterStage?.get(document.querySelector("#character-stage"))?.snapshot();
        return state?.model === kind && state.frames > 1 && state.loops === 1;
    }, kind, { timeout: 15_000 });
    const select = kind => page.locator('[data-character-model="' + kind + '"]').click();
    const shot = name => page.screenshot({ path: path.join(evidence, name + ".png") });
    await waitModel("live2d");
    const windowInfo = await app.evaluate(async ({ app, BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const gpu = await app.getGPUInfo("basic");
        return {
            visible: win.isVisible(), offscreen: win.webContents.isOffscreen(),
            sandbox: win.webContents.getLastWebPreferences().sandbox,
            noSandbox: app.commandLine.hasSwitch("no-sandbox"), electron: process.versions.electron,
            chromium: process.versions.chrome, platform: process.platform, gpu,
            featureStatus: app.getGPUFeatureStatus(),
        };
    });
    assert.equal(windowInfo.platform, "win32");
    assert.ok(windowInfo.visible && !windowInfo.offscreen && windowInfo.sandbox && !windowInfo.noSandbox);
    record("native visible Windows Electron window and renderer sandbox", windowInfo);

    const first = await page.evaluate(snapshot);
    assert.ok(first.capabilities.parameters.includes("ParamMouthOpenY"));
    await shot("01-live2d-local");
    record("original Live2D model initializes with a mouth channel", first);

    const fallback = await page.evaluate(async () => {
        const api = window.KeiCharacterStage.get(document.querySelector("#character-stage"));
        const before = document.querySelector(".character-canvas");
        const bad = Uint8Array.from([0, 1, 2, 3]).buffer;
        const accepted = await api.select("vrm", bad);
        return { accepted, sameCanvas: before === document.querySelector(".character-canvas"), ...api.snapshot() };
    });
    assert.equal(fallback.accepted, false);
    assert.equal(fallback.sameCanvas, true);
    assert.equal(fallback.model, "live2d");
    record("invalid VRM leaves the Live2D canvas and loop active", fallback);

    await page.locator("#quick-button").click();
    await select("vrm");
    await waitModel("vrm");
    const vrm = await page.evaluate(snapshot);
    assert.ok(vrm.capabilities.bones.includes("head"));
    assert.ok(vrm.capabilities.expressions.includes("aa") && vrm.capabilities.expressions.includes("blink"));
    assert.ok(vrm.capabilities.lookAt && vrm.capabilities.springBone);
    await shot("02-vrm-seed-san");
    record("VRM1 loads a humanoid, mouth and blink morphs, gaze and springs", vrm);

    await page.locator("[data-character-compact]").click();
    await page.locator("body.native-compact").waitFor();
    await shot("03-compact-stage");
    await page.getByRole("button", { name: "元のサイズ" }).click();
    await page.locator("body.native-compact").waitFor({ state: "detached" });
    await page.locator("#quick-button").click();
    await page.locator("[data-character-cg]").click();
    await page.waitForFunction(() => {
        const state = window.KeiCharacterStage.get(document.querySelector("#character-stage")).snapshot();
        return state.cg && state.loops === 0 && document.querySelector(".character-canvas").hidden;
    });
    assert.equal(await page.locator("#scene-background").isVisible(), true);
    await shot("04-cg");
    await page.locator("[data-character-cg]").click();
    await waitModel("vrm");
    record("native compact window and CG toggle preserve the renderer selection");

    const switching = [];
    for (const kind of ["live2d", "vrm", "live2d", "vrm", "live2d"]) {
        await select(kind);
        await waitModel(kind);
        const state = await page.evaluate(snapshot);
        assert.equal(state.canvas, 1);
        assert.equal(state.loops, 1);
        assert.equal(state.listeners, first.listeners);
        assert.equal(state.created - state.disposed, 1);
        assert.equal(state.drawsFailed, 0);
        switching.push(state);
    }
    record("repeated switching leaves one canvas and loop and stable listeners", { switching });

    await page.locator("#quick-button").click();
    await page.evaluate(() => {
        document.querySelector("#character-stage").addEventListener("kei:stage-hit", event => {
            window.lastStageHit = event.detail;
        }, { once: true });
    });
    const canvas = await page.locator(".character-canvas").boundingBox();
    await page.mouse.click(canvas.x + canvas.width * 0.32, canvas.y + canvas.height * 0.49);
    await page.waitForFunction(() => window.lastStageHit?.renderer === "live2d");
    record("pointer hit reaches the current character stage", await page.evaluate(() => window.lastStageHit));

    await page.locator("#quick-button").click();
    await page.locator("[data-character-audio=sample]").click();
    await page.waitForFunction(() => document.querySelector(".character-subtitle").textContent === "音声プレビュー 1");
    await shot("05-playback-subtitle");
    const timings = await page.evaluate(async ({ wav1, wav2 }) => {
        const playback = window.KeiCharacterStage.get(document.querySelector("#character-stage")).playback;
        const audio = encoded => Uint8Array.fromBase64(encoded).buffer;
        const ids = playback.begin("round-08-known-pcm");
        const first = await playback.segment({ ...ids, segmentId: "a", audio: audio(wav1), subtitle: "一" });
        const second = await playback.segment({ ...ids, segmentId: "b", audio: audio(wav2), subtitle: "二" });
        const trace = [];
        await new Promise(resolve => {
            const end = performance.now() + 2100;
            const frame = now => {
                const sample = playback.sample();
                if (sample) trace.push({ now, ...sample });
                if (now >= end) resolve();
                else requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        });
        const nextFrame = predicate => new Promise((resolve, reject) => {
            const deadline = performance.now() + 2000;
            function tick() {
                if (predicate()) resolve();
                else if (performance.now() > deadline) reject(new Error("Timed out waiting for playback sample"));
                else requestAnimationFrame(tick);
            }
            tick();
        });
        const gesture = playback.begin("same-turn");
        await playback.segment({ ...gesture, segmentId: "same-segment", audio: audio(wav1) });
        const frame = { ...gesture, segmentId: "same-segment", seq: 2, positionMs: 220, value: 0.6 };
        const tagged = playback.frame(frame);
        const duplicate = playback.frame(frame);
        const legacy = {
            type: "tts.mouth", turn_id: gesture.turnId,
            payload: { segment_id: "same-segment", seq: 3, position_ms: 250, value: 0.35 },
        };
        const legacyTagged = playback.legacy(legacy, gesture);
        await nextFrame(() => playback.sample()?.positionMs > 90);
        const late = playback.frame({ ...frame, seq: 4, positionMs: 10 });
        const wrongSegment = playback.frame({ ...frame, seq: 4, segmentId: "wrong" });
        const wrongTurn = playback.frame({ ...frame, seq: 4, turnId: "wrong" });
        const interrupted = playback.interrupt(gesture);
        const afterInterrupt = playback.sample();
        const replay = playback.begin("same-turn");
        await playback.segment({ ...replay, segmentId: frame.segmentId, audio: audio(wav2) });
        const oldPlayback = playback.frame({ ...frame, seq: 999 });
        const oldInterrupt = playback.disconnect(gesture);
        const legacyStale = playback.legacy(legacy, gesture);
        await nextFrame(() => playback.sample()?.playbackId === replay.playbackId);
        const replaySample = playback.sample();
        const disconnect = playback.disconnect(replay);
        return {
            first, second, trace, metrics: playback.metrics(), checks: {
                tagged, duplicate, legacyTagged, late, wrongSegment, wrongTurn, interrupted, afterInterrupt,
                replayDifferent: gesture.playbackId !== replay.playbackId, oldPlayback, oldInterrupt, legacyStale,
                replaySample: Boolean(replaySample), disconnect, afterDisconnect: playback.sample(),
            },
        };
    }, { wav1, wav2 });
    const onsets = ["a", "b"].map(segmentId => {
        const firstVisual = timings.trace.find(frame => frame.segmentId === segmentId && frame.value > 0.08);
        assert.ok(firstVisual, "Mouth envelope missing for segment " + segmentId);
        return {
            segmentId, firstVisualMs: firstVisual.positionMs, expectedSignalAttackMs: 45,
            offsetFromSignalAttackMs: firstVisual.positionMs - 45, clock: firstVisual.clock,
        };
    });
    assert.ok(Math.abs(timings.second.start - timings.first.end) < 0.001);
    const firstOutput = timings.trace.find(row => row.segmentId === "a");
    for (const onset of onsets) assert.ok(Math.abs(onset.offsetFromSignalAttackMs) < 100);
    assert.deepEqual(timings.checks, {
        tagged: true, duplicate: false, legacyTagged: true, late: false, wrongSegment: false, wrongTurn: false,
        interrupted: true, afterInterrupt: null, replayDifferent: true, oldPlayback: false, oldInterrupt: false,
        legacyStale: false, replaySample: true, disconnect: true, afterDisconnect: null,
    });
    fs.writeFileSync(path.join(evidence, "timing-trace.json"), JSON.stringify({
        ...timings, onsets, submittedToFirstOutputSampleMs: firstOutput.now - timings.first.submittedAt,
    }, null, 2) + "\n");
    record("actual Web Audio output clock drives both segments, interruption and replay safeguards", {
        onsets, frameSamples: timings.trace.length, metrics: timings.metrics,
    });

    await select("vrm");
    await waitModel("vrm");
    await page.reload();
    await waitModel("vrm");
    record("VRM selection is restored after Electron renderer reload");
    const disposal = await page.evaluate(async () => {
        const stage = document.querySelector("#character-stage");
        const api = window.KeiCharacterStage.get(stage);
        await api.dispose();
        return api.snapshot();
    });
    assert.equal(disposal.canvas, 0);
    assert.equal(disposal.loops, 0);
    assert.equal(disposal.listeners, 0);
    assert.equal(disposal.created, disposal.disposed);
    record("teardown frees its last canvas, render loop and listeners", disposal);
    assert.deepEqual(errors, []);
} catch (error) {
    const failure = await page?.evaluate(() => ({
        state: window.KeiCharacterStage?.get(document.querySelector("#character-stage"))?.snapshot(),
        status: document.querySelector("#character-controls [role=status]")?.textContent,
    })).catch(() => null);
    console.error(JSON.stringify({ failure, consoleMessages }, null, 2));
    throw error;
} finally {
    fs.writeFileSync(path.join(evidence, "acceptance.json"), JSON.stringify({ results, errors, consoleMessages }, null, 2) + "\n");
    await app.close();
}
