// DEF-02 regression suite: MotionProvider connection lifecycle against a deterministic fake
// kei.hastsec provider (no Electron, host or private VRM needed). Each cold start builds a
// fresh bridge + provider, so runs are isolated from one another.
import assert from "node:assert/strict";
import test from "node:test";
import { MotionProvider, MotionTimeline } from "./motion.mjs";
import { FakeMotionBridge, flush } from "./fake-motion-bridge.mjs";

const RIG = { id: "fake-rig", bones: ["rightUpperArm"] };
const FAST = { retryDelaysMs: [4, 8, 12, 16, 20], stableMs: 40 };

function mountProvider(bridge, { rig = () => RIG } = {}) {
    const timeline = new MotionTimeline();
    const provider = new MotionProvider(bridge, timeline, rig, () => null, FAST);
    // Stand-in for the stage's render loop: clips only finish when sampled.
    const ticker = setInterval(() => timeline.sample(performance.now()), 5);
    const dispose = provider.dispose.bind(provider);
    provider.dispose = () => { clearInterval(ticker); dispose(); };
    return { provider, timeline };
}

// Wait for the provider to reach a resting state (not connecting/retrying).
async function settle(provider, limitMs = 400) {
    const end = performance.now() + limitMs;
    while (performance.now() < end) {
        await flush(5);
        const s = provider.snapshot();
        const conn = s.connection?.state;
        if (!provider.refreshing && conn !== "connecting" && conn !== "retrying") {
            await flush(5);
            return provider.snapshot();
        }
    }
    return provider.snapshot();
}

// Seeded PRNG so the 20 cold starts are reproducible.
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("DEF-02: 20 isolated cold starts with pre-enabled kei.hastsec connect and play first motion without reload", async () => {
    const random = rng(26);
    const results = [];
    for (let run = 0; run < 20; run++) {
        const openMs = 3 + Math.floor(random() * 4);            // 3–6 ms page.open latency
        const changeAfterOpenMs = 2 + Math.floor(random() * 3); // stage-change 2–4 ms after open request
        const bridge = new FakeMotionBridge({ entriesMs: Math.floor(random() * 3), openMs });
        let overlapped = null;
        const origOpen = bridge.pages.open;
        let provider;
        bridge.pages.open = (...args) => {
            const requestedAt = performance.now();
            const pending = origOpen(...args);
            // kei:stage-character-changed -> reactions.invalidatePlan() -> motion.interrupt()
            setTimeout(() => {
                overlapped = bridge.openTags.length === 0;
                provider.interrupt({ smooth: false });
            }, changeAfterOpenMs);
            void pending.then(() => { bridge.openLatency = performance.now() - requestedAt; });
            return pending;
        };
        ({ provider } = mountProvider(bridge));
        const snap = await settle(provider);
        const first = await provider.request({ motion: "greeting-wave" });
        const userCloses = bridge.log.filter(e => e.type === "page.close" && e.reason === "user").length;
        results.push({ run, openMs, changeAfterOpenMs, overlapped, connected: snap.connected,
            state: snap.state, first: first.state, openPages: bridge.openTags.length, userCloses });
        provider.dispose();
    }
    const failed = results.filter(r => !r.connected || r.first !== "ready" || r.openPages !== 1 || r.userCloses !== 0);
    const overlapping = results.filter(r => r.overlapped).length;
    console.log(`# cold-start runs=20 overlappingInterrupt=${overlapping} disconnected=${failed.length}`);
    for (const r of results) console.log("# " + JSON.stringify(r));
    assert.ok(overlapping >= 6, "the race window must actually be exercised");
    assert.deepEqual(failed, []);
});

test("rapid renderer/stage switching during open keeps exactly one provider page", async () => {
    const bridge = new FakeMotionBridge({ openMs: 12 });
    let rigAvailable = true;
    const { provider } = mountProvider(bridge, { rig: () => (rigAvailable ? RIG : null) });
    for (let i = 0; i < 12; i++) {
        await flush(1);
        rigAvailable = i % 2 === 0;          // VRM <-> Live2D
        provider.interrupt({ smooth: i % 3 === 0 });
        if (i % 4 === 0) bridge.emitEntriesChanged("plugin.reloaded");
    }
    rigAvailable = false;
    const snap = await settle(provider);
    assert.equal(snap.connected, true);
    assert.equal(bridge.openTags.length, 1);
    assert.equal((await provider.request({ motion: "greeting-wave" })).code, "rig_mismatch");
    rigAvailable = true;
    assert.equal((await provider.request({ motion: "greeting-wave" })).state, "ready");
    provider.dispose();
    assert.equal(bridge.openTags.length, 0);
});

test("deliberate disable while page.open is in flight ends disconnected and never reopens", async () => {
    const bridge = new FakeMotionBridge({ openMs: 15 });
    const { provider } = mountProvider(bridge);
    await flush(6);
    bridge.disable();
    const snap = await settle(provider);
    await flush(60);
    assert.equal(snap.connected, false);
    assert.equal(provider.snapshot().state, "unavailable");
    assert.equal(bridge.openTags.length, 0);
    const opensAfterDisable = bridge.log.filter(e => e.type === "page.open.request").length;
    await flush(60);
    assert.equal(bridge.log.filter(e => e.type === "page.open.request").length, opensAfterDisable);
    bridge.enable();
    const back = await settle(provider);
    assert.equal(back.connected, true);
    assert.equal((await provider.request({ motion: "greeting-wave" })).state, "ready");
    provider.dispose();
});

test("revocation of a connected provider closes it without automatic reopen", async () => {
    const bridge = new FakeMotionBridge();
    const { provider } = mountProvider(bridge);
    assert.equal((await settle(provider)).connected, true);
    bridge.enabled = false;
    bridge.closeFromMain(bridge.openTags[0], "plugin.uninstalled");
    bridge.emitEntriesChanged("plugin.uninstalled");
    await settle(provider);
    await flush(80);
    assert.equal(provider.snapshot().connected, false);
    assert.equal(bridge.log.filter(e => e.type === "page.open.request").length, 1);
    provider.dispose();
});

test("dispose while page.open is in flight closes the late page", async () => {
    const bridge = new FakeMotionBridge({ openMs: 10 });
    const { provider } = mountProvider(bridge);
    await flush(4);
    provider.dispose();
    await flush(30);
    assert.equal(bridge.openTags.length, 0);
    assert.equal(provider.snapshot().connected, false);
});

test("host disconnect during open, then reconnect, yields one live page", async () => {
    const bridge = new FakeMotionBridge({ openMs: 10 });
    const { provider } = mountProvider(bridge);
    await flush(4);
    bridge.emitStatus(false);
    await settle(provider);
    assert.equal(provider.snapshot().connected, false);
    bridge.emitStatus(true);
    const snap = await settle(provider);
    assert.equal(snap.connected, true);
    assert.equal(bridge.openTags.length, 1);
    provider.dispose();
});

test("plugin enabled while the first entries() call is in flight is not lost", async () => {
    const bridge = new FakeMotionBridge({ entriesMs: 8, enabled: false });
    const { provider } = mountProvider(bridge);
    await flush(2);
    bridge.enable(); // fires onEntriesChanged while refresh() is still awaiting entries()
    const snap = await settle(provider);
    assert.equal(snap.connected, true);
    provider.dispose();
});

test("transient open failures recover with bounded backoff and visible status", async () => {
    const bridge = new FakeMotionBridge({ openFailures: ["host_unavailable", "invalid_response"] });
    const { provider } = mountProvider(bridge);
    const seen = new Set();
    const end = performance.now() + 300;
    while (performance.now() < end && !provider.snapshot().connected) {
        seen.add(provider.snapshot().connection?.state);
        await flush(1);
    }
    const snap = await settle(provider);
    assert.equal(snap.connected, true);
    assert.ok(seen.has("retrying"), "retry state must be visible while recovering");
    assert.equal(bridge.log.filter(e => e.type === "page.open.request").length, 3);
    provider.dispose();
});

test("persistent open failure stops after the retry budget and resumes on the next registry change", async () => {
    const bridge = new FakeMotionBridge({ openFailures: Array(20).fill("host_unavailable") });
    const { provider } = mountProvider(bridge);
    await flush(200);
    const snap = await settle(provider);
    assert.equal(snap.connected, false);
    assert.equal(snap.connection.state, "failed");
    assert.equal(snap.connection.lastError, "host_unavailable");
    assert.equal(bridge.log.filter(e => e.type === "page.open.request").length, 1 + FAST.retryDelaysMs.length);
    bridge.openFailures = [];
    bridge.emitEntriesChanged("plugin.reloaded");
    assert.equal((await settle(provider)).connected, true);
    provider.dispose();
});

test("unexpected provider page loss with the entry still enabled reconnects once", async () => {
    const bridge = new FakeMotionBridge();
    const { provider } = mountProvider(bridge);
    assert.equal((await settle(provider)).connected, true);
    bridge.closeFromMain(bridge.openTags[0], "page_closed");
    const snap = await settle(provider);
    assert.equal(snap.connected, true);
    assert.equal(bridge.openTags.length, 1);
    assert.equal((await provider.request({ motion: "greeting-wave" })).state, "ready");
    provider.dispose();
});

test("a page closed by main before open() resolves is not adopted", async () => {
    const bridge = new FakeMotionBridge({ openMs: 6 });
    const origOpen = bridge.pages.open;
    let first = true;
    bridge.pages.open = async (...args) => {
        const reply = await origOpen(...args);
        if (first && reply.ok) {
            first = false;
            bridge.closeFromMain(reply.frame.tag, "reset"); // kei:page:closed overtakes the invoke reply
        }
        return reply;
    };
    const { provider } = mountProvider(bridge);
    const snap = await settle(provider);
    assert.equal(snap.connected, true);
    assert.equal(bridge.openTags.length, 1);
    assert.equal((await provider.request({ motion: "greeting-wave" })).state, "ready");
    provider.dispose();
});

test("interrupt still cancels playback and in-flight solves without touching the connection", async () => {
    const bridge = new FakeMotionBridge();
    const { provider, timeline } = mountProvider(bridge);
    await settle(provider);
    const started = await provider.request({ motion: "greeting-wave" });
    assert.equal(started.state, "ready");
    assert.ok(timeline.clip);
    provider.interrupt();
    assert.equal(timeline.clip, null);
    assert.equal(await started.done, "cancelled");
    assert.equal(provider.snapshot().connected, true);
    assert.equal(bridge.openTags.length, 1);
    provider.dispose();
});

// ---- Round 26 item 4/5: plan binding to the live catalog and visible library status.

test("readiness reports loading, then ready once the kei.hastsec catalog answers", async () => {
    const bridge = new FakeMotionBridge();
    const states = [];
    const provider = new MotionProvider(bridge, new MotionTimeline(), () => RIG, () => null,
        { ...FAST, onState: snap => states.push(snap.readiness) });
    await settle(provider);
    await flush(10);
    assert.equal(provider.snapshot().readiness, "ready");
    assert.equal(provider.snapshot().library.motions, 3);
    assert.ok(states.includes("connecting") && states.includes("loading") && states.at(-1) === "ready", states.join(","));
    provider.dispose();
});

test("an unconfigured motion library is reported distinctly and recovers after plugin reload", async () => {
    const bridge = new FakeMotionBridge({ catalog: { state: "unconfigured", code: "hastsec_root_missing" } });
    const { provider } = mountProvider(bridge);
    await settle(provider);
    await flush(10);
    let snap = provider.snapshot();
    assert.equal(snap.connected, true);
    assert.equal(snap.readiness, "library_unavailable");
    assert.equal(snap.library.code, "hastsec_root_missing");
    bridge.catalog = { state: "ready", motions: [{ id: "greeting-wave" }] };
    bridge.emitEntriesChanged("plugin.reloaded");
    await settle(provider);
    await flush(10);
    assert.equal(provider.snapshot().readiness, "ready");
    provider.dispose();
});

test("unknown motion IDs are rejected before solving and never cancel the current clip", async () => {
    const bridge = new FakeMotionBridge();
    const { provider, timeline } = mountProvider(bridge);
    await settle(provider);
    await flush(10);
    assert.equal((await provider.request({ motion: "greeting-wave" })).state, "ready");
    const solvesBefore = bridge.log.filter(e => e.type === "solve").length;
    assert.equal((await provider.request({ motion: "made-up-wave" })).code, "unknown_motion");
    assert.ok(timeline.clip, "the playing clip must survive a rejected request");
    assert.equal(bridge.log.filter(e => e.type === "solve").length, solvesBefore);
    provider.dispose();
});

test("a plan mixing unknown and known steps plays the known steps and reports the unknown ones", async () => {
    const bridge = new FakeMotionBridge();
    const { provider } = mountProvider(bridge);
    await settle(provider);
    await flush(10);
    const skipped = [];
    const result = await provider.playSequence(
        [{ motion: "not-in-catalog" }, { motion: "greeting-wave" }],
        { onStepSkipped: (i, step, s) => skipped.push(s.reason) },
    );
    assert.equal(result.state, "completed");
    assert.deepEqual(result.completedSteps.map(s => s.motion), ["greeting-wave"]);
    assert.deepEqual(result.skippedSteps.map(s => [s.index, s.reason]), [[0, "unknown_motion"]]);
    assert.equal(result.totalSteps, 2);
    assert.deepEqual(skipped, ["unknown_motion"]);
    const allUnknown = await provider.playSyncedSequence([{ motion: "x" }, { motion: "y" }], {});
    assert.equal(allUnknown.code, "unknown_motion");
    assert.equal(allUnknown.skippedSteps.length, 2);
    provider.dispose();
});

test("an explicitly empty body plan plays nothing and leaves current motion untouched", async () => {
    const bridge = new FakeMotionBridge();
    const { provider, timeline } = mountProvider(bridge);
    await settle(provider);
    await flush(10);
    await provider.request({ motion: "greeting-wave" });
    const solves = bridge.log.filter(e => e.type === "solve").length;
    assert.equal((await provider.playSyncedSequence([], { speechEnabled: true })).code, "invalid_intent");
    assert.equal((await provider.playSequence([])).code, "invalid_intent");
    assert.ok(timeline.clip);
    assert.equal(bridge.log.filter(e => e.type === "solve").length, solves);
    provider.dispose();
});

test("a cue whose phrase has already been spoken is skipped, not played late over speech", async () => {
    const bridge = new FakeMotionBridge();
    const { provider, timeline } = mountProvider(bridge);
    await settle(provider);
    await flush(10);
    const segments = [{ segmentId: "s0", text: "はい、おはようございます。", start: 1.0, end: 2.6, duration: 1.6, activeStart: 1.05, activeEnd: 2.5 }];
    const result = await provider.playSyncedSequence([{ motion: "greeting-wave", phrase: "おはよう" }], {
        speechEnabled: true, getAudioTime: () => 9.0, getSegments: () => segments,
        isSynthesizing: () => false, isSpeechStopped: () => false,
    });
    assert.equal(result.state, "completed");
    assert.equal(result.completedSteps.length, 0);
    assert.equal(result.skippedSteps.length, 1);
    assert.match(result.skippedSteps[0].reason, /late|passed/);
    assert.equal(timeline.clip, null);
    provider.dispose();
});
