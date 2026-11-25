import assert from "node:assert/strict";
import { test } from "node:test";
import { ExpressionProvider, ExpressionTimeline } from "./expression.mjs";
import { createFaceMixer } from "./face.mjs";
import { FacePreview } from "./face-preview.mjs";

function clip(target = "happy") {
    return { format: "kei.expression.clip.v1", clipId: "5", fps: 10, frames: 5,
        targets: [target], tracks: [[0, 0.2, 0.4, 0.6, 0.8]] };
}

test("interpolates authored frames and expires without leaving a stale pose", () => {
    const player = new ExpressionTimeline();
    assert.equal(player.play(clip("blink"), 0), false);
    assert.equal(player.play(clip(), 0), true);
    assert.ok(Math.abs(player.sample(250).values.happy - 0.5) < .001);
    assert.equal(player.sample(400), null);
    assert.equal(player.sample(401), null);
});

test("manual expression switches from the sampled pose and restores neutral", () => {
    const preview = new FacePreview();
    preview.select("happy", 100);
    assert.deepEqual(preview.sample(225).values, { happy: .5 });
    preview.select("serious", 225);
    assert.deepEqual(preview.sample(350).values, { happy: .25, serious: .5 });
    preview.select("neutral", 350);
    assert.equal(preview.sample(600), null);
});

test("manual preset owns brows while blink and audio attenuate overlapping regions", () => {
    const names = ["happy", "keiLids.happy", "keiLips.happy", "aa", "blink"];
    const expressionMap = Object.fromEntries(names.map(name => [name, { binds: [] }]));
    const values = {};
    const mixer = createFaceMixer({ expressionMap, getExpression: name => expressionMap[name], setValue: (name, value) => { values[name] = value; } });
    mixer.apply({ smile: 0, blink: .75, mouth: .5, expressionPreview: { values: { happy: 1 } } });
    assert.deepEqual(values, { happy: 1, "keiLids.happy": .25, "keiLips.happy": .5, aa: .5, blink: .75 });
    mixer.apply({ smile: 0, blink: 0, mouth: 0 });
    assert.deepEqual(values, { happy: 0, "keiLids.happy": 0, "keiLips.happy": 0, aa: 0, blink: 0 });
    assert.equal(mixer.supported.includes("keiLips.happy"), false);
});

test("keeps mouth and blink on separate owners, rejects collisions and clears prior emotions", () => {
    const primitive = {};
    const sameAsLip = { index: 2, primitives: [primitive] };
    const named = {
        aa: { binds: [sameAsLip] }, blink: { binds: [] },
        happy: { binds: [], overrideBlink: "block" },
        customCollision: { binds: [sameAsLip] },
    };
    const manager = { expressionMap: named, getExpression: name => named[name], setValue(name, value) {
        writes.push([name, value]);
    } };
    const writes = [];
    const mixer = createFaceMixer(manager);
    mixer.apply({ smile: 0, mouth: .62, blink: .8, emotion: {
        clipId: "5", values: { happy: .5, customCollision: .4, missingBrow: 1 },
    } });
    assert.deepEqual(writes, [["happy", .5], ["aa", .62], ["blink", .8]]);
    assert.equal(named.happy.overrideBlink, "none");
    assert.deepEqual(mixer.snapshot().missing, ["customCollision", "missingBrow"]);
    writes.length = 0;
    mixer.apply({ smile: 0, mouth: .3, blink: .1 });
    assert.deepEqual(writes, [["happy", 0], ["aa", .3], ["blink", .1]]);
});


test("authored morphs use a continuous alias while the base binary preset keeps its normal path", () => {
    const original = { binds: [], isBinary: true };
    const named = { happy: original };
    const writes = [];
    const manager = { expressionMap: named, getExpression: name => named[name], setValue: (name, value) => writes.push([name, value]) };
    const mixer = createFaceMixer(manager, value => {
        assert.equal(value, original);
        return "kei_curve_1";
    });
    mixer.apply({ mouth: 0, blink: 0, smile: 0, emotion: { clipId: "0", values: { happy: .2 } } });
    assert.deepEqual(writes.slice(0, 2), [["happy", 0], ["kei_curve_1", .2]]);
    writes.length = 0;
    mixer.apply({ mouth: 0, blink: 0, smile: 1 });
    assert.deepEqual(writes.slice(0, 2), [["happy", .65], ["kei_curve_1", 0]]);
    assert.equal(original.isBinary, true);
});

test("interrupt and page revocation reject results from a stale asynchronous selection", async () => {
    const calls = [];
    let resolveSelect;
    let revoke;
    let event;
    const timeline = new ExpressionTimeline();
    const noListener = () => () => {};
    const bridge = {
        onStatus: noListener, onEntriesChanged: noListener,
        entries: async () => ({ ok: true, entries: [{ pluginId: "kei.lumenact", id: "expression-provider", slot: "character-settings" }] }),
        pages: {
            onClosed: callback => { revoke = callback; return () => {}; },
            onEvent: callback => { event = callback; return () => {}; },
            open: async () => ({ ok: true, frame: { tag: "owned" } }),
            close: async () => {},
            call: async (_tag, message) => {
                calls.push(message.action);
                if (message.action === "select") return new Promise(resolve => { resolveSelect = resolve; });
                return { ok: true, result: { state: "stopped" } };
            },
        },
    };
    const provider = new ExpressionProvider(bridge, timeline);
    await new Promise(resolve => setImmediate(resolve));
    const pending = provider.request("开心");
    provider.interrupt();
    resolveSelect({ ok: true, result: { state: "pending", jobId: "retired" } });
    assert.equal((await pending).code, "stale_selection");
    assert.ok(calls.includes("select.cancel"));
    event("other-tag", { topic: "lumenact.preview", data: { issuedAt: Date.now() + 10, type: "play", clip: clip() } });
    assert.equal(timeline.clip, null);
    event("owned", { topic: "lumenact.preview", data: { issuedAt: Date.now() + 10, type: "play", clip: clip() } });
    assert.equal(timeline.clip.clipId, "5");
    revoke("owned");
    assert.equal(provider.snapshot().connected, false);
    assert.equal(timeline.clip, null);
    provider.dispose();
});
