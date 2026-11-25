import test from "node:test";
import assert from "node:assert/strict";
import { alignPhraseToSegments, computeCueSchedule, extractSpeechWindows } from "./speech-sync.mjs";

test("extractSpeechWindows trims leading/trailing silence and merges brief consonant gaps", () => {
    const levels = new Float32Array(200); // 2.0s at 10ms
    for (let i = 15; i < 60; i++) levels[i] = 0.5;   // 0.15s - 0.60s
    for (let i = 65; i < 120; i++) levels[i] = 0.6;  // 0.65s - 1.20s (50ms gap -> merged)
    for (let i = 145; i < 180; i++) levels[i] = 0.4; // 1.45s - 1.80s (250ms pause -> separate burst)
    const result = extractSpeechWindows(levels, 0.01);
    assert.equal(result.activeStart, 0.15);
    assert.equal(result.activeEnd, 1.8);
    assert.equal(result.windows.length, 2);
    assert.deepEqual(result.windows[0], { start: 0.15, end: 1.2 });
    assert.deepEqual(result.windows[1], { start: 1.45, end: 1.8 });
});

test("alignPhraseToSegments matches exact, normalized, and paraphrased phrases accurately", () => {
    const segments = [
        {
            segmentId: "s0",
            text: "おはよう！まず最初の大事なポイントはね、声と動きがぴったり合うことなんだよ。",
            start: 10.0,
            end: 14.5,
            activeStart: 0.12,
            activeEnd: 4.2,
            speechWindows: [{ start: 0.12, end: 4.2 }],
        },
    ];
    const greet = alignPhraseToSegments(segments, "おはよう", 0, 2, "peak");
    assert.equal(greet.matchType, "exact");
    assert.equal(greet.timingSource, "measured-audio-envelope-estimate");
    assert.equal(greet.isEstimate, true);
    assert.ok(greet.targetRelMs > 120 && greet.targetRelMs < 650, `unexpected greeting time ${greet.targetRelMs}`);

    const keyPoint = alignPhraseToSegments(segments, "大事なポイントはね", 1, 2, "peak");
    assert.equal(keyPoint.matchType, "exact");
    assert.ok(keyPoint.targetRelMs > greet.targetRelMs + 500, "second phrase must land later than greeting");

    // Paraphrased phrase ("大切なポイント" vs "大事なポイントはね") still aligns cleanly
    const paraphrased = alignPhraseToSegments(segments, "大切なポイント", 1, 2, "peak");
    assert.equal(paraphrased.matchType, "paraphrase-fuzzy");
    assert.ok(Math.abs(paraphrased.targetRelMs - keyPoint.targetRelMs) < 500);
});

test("alignPhraseToSegments prefers synthesis marks when a TTS provider supplies them", () => {
    const segments = [
        {
            segmentId: "s0",
            text: "おはよう、元気？",
            start: 5.0,
            end: 6.5,
            marks: [{ text: "おはよう", offset: 0, length: 4, startSec: 0.1, endSec: 0.5 }],
        },
    ];
    const aligned = alignPhraseToSegments(segments, "おはよう", 0, 1, "peak");
    assert.equal(aligned.timingSource, "synthesis-marks");
    assert.equal(aligned.isEstimate, false);
    assert.equal(Number(aligned.targetAudioSec.toFixed(2)), 5.3);
});

test("computeCueSchedule schedules future cues, trims slightly late cues, and skips stale cues", () => {
    const beat = { prepMs: 360, peakMs: 740, releaseMs: 1280, durationMs: 1650 };

    // 1. Plenty of lead time -> schedules exact preparation onset so peak lands dead-on target
    const future = computeCueSchedule({ targetAudioSec: 12.0, beat, nowAudioSec: 10.5 });
    assert.equal(future.action, "schedule");
    assert.equal(Number(future.startAudioSec.toFixed(3)), 11.26);
    assert.equal(Number(future.expectedPeakAudioSec.toFixed(3)), 12.0);

    // 2. Slightly late by 140ms -> starts immediately with small prep trim
    const tight = computeCueSchedule({ targetAudioSec: 11.1, beat, nowAudioSec: 10.5 });
    assert.equal(tight.action, "start_now");
    assert.ok(tight.trimStartMs > 0 && tight.trimStartMs <= 180);

    // 3. Target phrase already passed by 400ms -> skips stale cue cleanly
    const stale = computeCueSchedule({ targetAudioSec: 10.1, beat, nowAudioSec: 10.5 });
    assert.equal(stale.action, "skip_late");
    assert.equal(stale.skipReason, "target_phrase_passed");
});
