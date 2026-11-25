import assert from "node:assert/strict";
import { test } from "node:test";
import { PlaybackClock, previewAudio } from "./playback.mjs";

function setup() {
    const sources = [];
    const context = {
        state: "running",
        currentTime: 0,
        destination: {},
        baseLatency: 0.01,
        outputLatency: 0.02,
        resume: async () => {},
        close: async () => { context.state = "closed"; },
        decodeAudioData: async () => ({
            duration: 1, sampleRate: 1000, length: 1000, numberOfChannels: 1,
            getChannelData: () => new Float32Array(1000).fill(0.25),
        }),
        createBufferSource() {
            const source = {
                connect() {}, disconnect() { this.disconnected = true; },
                start(time) { this.startTime = time; }, stop() { this.stopped = true; },
            };
            sources.push(source);
            return source;
        },
    };
    const clock = new PlaybackClock(() => context);
    return { clock, context, sources };
}

test("schedules consecutive decoded segments and samples the output clock", async () => {
    const { clock, context, sources } = setup();
    const ids = clock.begin("message");
    const first = await clock.enqueue({ ...ids, segmentId: "one", audio: previewAudio() });
    const second = await clock.enqueue({ ...ids, segmentId: "two", audio: previewAudio() });
    assert.equal(first.end, second.start);
    assert.equal(sources[0].startTime, first.start);
    assert.equal(clock.sample(), null);
    context.currentTime = first.start + 0.12;
    assert.equal(clock.sample().segmentId, "one");
    assert.ok(Math.abs(clock.sample().positionMs - 90) < 0.01);
    assert.equal(clock.sample().clock, "currentTime-minus-latency");
    context.currentTime = second.start + 0.05;
    assert.equal(clock.sample().segmentId, "two");
    clock.dispose();
    assert.equal(context.state, "closed");
});

test("drops duplicate, late, wrong-segment and pre-replay frames", async () => {
    const { clock, context, sources } = setup();
    const ids = clock.begin("same-turn");
    const input = { segmentId: "s", audio: previewAudio() };
    const first = await clock.enqueue({ ...ids, ...input });
    const frame = { ...ids, segmentId: "s", seq: 2, positionMs: 100, value: 0.2 };
    assert.equal(clock.acceptFrame(frame), true);
    assert.equal(clock.acceptFrame(frame), false);
    assert.equal(clock.acceptFrame({ ...frame, seq: 3, segmentId: "other" }), false);
    context.currentTime = first.start + 0.145;
    assert.equal(clock.sample().value, 0.2);
    assert.equal(clock.acceptFrame({ ...frame, seq: 3 }), false);
    assert.equal(clock.interrupt(ids), true);
    assert.equal(sources[0].stopped, true);
    assert.equal(sources[0].disconnected, true);
    const replay = clock.begin(ids.turnId);
    assert.notEqual(ids.playbackId, replay.playbackId);
    await clock.enqueue({ ...replay, ...input });
    assert.equal(clock.acceptFrame({ ...frame, seq: 999 }), false);
    assert.equal(clock.interrupt(ids), false);
    assert.equal(clock.interrupt(replay), true);
});

test("an interrupted decode cannot schedule audio for a new lease", async () => {
    const { clock, context, sources } = setup();
    let finish;
    let started;
    const decoding = new Promise(resolve => { started = resolve; });
    context.decodeAudioData = () => {
        started();
        return new Promise(resolve => { finish = resolve; });
    };
    const ids = clock.begin("message");
    const job = clock.enqueue({ ...ids, segmentId: "one", audio: previewAudio() });
    await decoding;
    clock.interrupt(ids);
    clock.begin("message");
    finish({});
    assert.equal(await job, null);
    assert.equal(sources.length, 0);
});

test("silent narration is rejected before opening an output source", async () => {
    const { clock, context, sources } = setup();
    const decode = context.decodeAudioData;
    context.decodeAudioData = async () => ({
        ...await decode(), getChannelData: () => new Float32Array(1000),
    });
    const ids = clock.begin("silent");
    await assert.rejects(clock.enqueue({ ...ids, segmentId: "quiet", audio: previewAudio(), requireAudible: true }),
        { code: "audio_silent" });
    assert.equal(sources.length, 0);
});
