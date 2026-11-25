"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { segmentSpeech, latencyRecord } = require("../../src/renderer/desktop/speech-plan.js");

test("first complete sentence is synthesized alone; later sentences still merge up to 60 chars", () => {
    const text = "はい、おはようございます。今日もよろしくお願いします。資料は三つあります。順番に説明しますね。";
    const parts = segmentSpeech(text);
    assert.equal(parts[0], "はい、おはようございます。");
    assert.equal(parts[1], "今日もよろしくお願いします。資料は三つあります。順番に説明しますね。");
    assert.equal(parts.join(""), text);
});

test("segmentation never invents, drops or reorders public text", () => {
    for (const text of ["早上好", "这个方案（第二版）更稳妥。", "我有点紧张", "只朗读一次。", "Hello there! How are you? Fine.",
        "一行目\n二行目。三行目！", "a".repeat(900)]) {
        const parts = segmentSpeech(text);
        assert.ok(parts.length >= 1 && parts.length <= 12);
        const normalized = text.replace(/\s+/g, " ");
        if (text.length < 400) assert.equal(parts.join("").replace(/\s+/g, ""), normalized.replace(/\s+/g, ""));
        for (const part of parts) assert.ok(part.length <= 400);
    }
    assert.deepEqual(segmentSpeech(""), []);
    assert.deepEqual(segmentSpeech("   "), []);
    assert.deepEqual(segmentSpeech(null), []);
});

test("latency record reports each wait relative to submit and tolerates missing marks", () => {
    const r = latencyRecord({ requestId: "r1", submittedAt: 1000, replyAt: 3500, firstRequestAt: 3502, firstPcmAt: 3900, firstSoundAt: 3960, segments: 3, firstSegmentChars: 13, outcome: "scheduled" });
    assert.deepEqual(r, { requestId: "r1", providerWaitMs: 2500, firstApprovedSentenceMs: 2500, firstTtsRequestMs: 2502,
        firstPcmMs: 2900, firstSoundMs: 2960, ttsFirstPcmMs: 398, segments: 3, firstSegmentChars: 13, outcome: "scheduled" });
    const partial = latencyRecord({ replyAt: 10 });
    assert.equal(partial.providerWaitMs, null);
    assert.equal(partial.firstPcmMs, null);
});
