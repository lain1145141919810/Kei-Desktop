// Round 26 fixture comparison (no live services): submit -> first sound for fixed replies
// under a fixed provider + TTS latency model, baseline voice.js scheduling vs Round 26.
//
//   node tests/bench/voice-latency-fixture.mjs [--json]
//
// Model (fixture assumptions, not live measurements; constants from the Round 25 evidence):
//   provider wait  = 2500 ms (J-01 real greeting 2501 ms, non-streaming chat completions)
//   TTS(chars)     = base + perChar * chars   warm: 180 + 9/char   cold: 1150 + 17/char
//                    (calibrated so an 8-char line gives 254 ms warm / 1288 ms cold as in I-01)
//   decode+schedule = 15 ms, playback lead = 50 ms, spoken audio = 125 ms per char
// One TTS request is in flight at a time in both strategies (single-worker GSV/Aqua).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { segmentSpeech } = require("../../src/renderer/desktop/speech-plan.js");

// Verbatim from baseline 217dd17 frontend/src/renderer/desktop/voice.js `sentences()`.
function baselineSentences(text) {
    const parts = text.replace(/\s+/g, " ").match(/[^。！？!?\n]+[。！？!?]*/g) || [text];
    const out = [];
    for (const part of parts) {
        const piece = part.trim();
        if (!piece) continue;
        if (out.length && (out.at(-1) + piece).length <= 60) out[out.length - 1] += piece;
        else out.push(piece.slice(0, 400));
    }
    return out.slice(0, 12);
}

const FIXTURES = [
    "はい、おはようございます。今日もよろしくお願いします。",
    "小窓のまま挨拶しますね。何かあれば呼んでください。",
    "すごいですね、よく頑張りました！その調子で続けましょう。次は資料の二ページ目を一緒に見ていきましょう。",
    "这个方案（第二版）更稳妥。我建议先在测试环境验证，再逐步推广到所有用户。",
    "了解しました。三つの点を確認します。まず接続、次に設定、最後に音声です。順番に進めますね。",
];
const PROVIDER_MS = 2500, DECODE_MS = 15, LEAD_MS = 50, AUDIO_MS_PER_CHAR = 125;
const PROFILES = { warm: { base: 180, perChar: 9 }, cold: { base: 1150, perChar: 17 } };

function simulate(text, segment, pipelined, profile) {
    const pieces = segment(text);
    const tts = (chars, i) => (i === 0 ? profile.base : PROFILES.warm.base) + (i === 0 ? profile.perChar : PROFILES.warm.perChar) * chars;
    let t = PROVIDER_MS;           // approved reply available
    let requestAt = t;
    let audioEnd = null;
    let firstPcm = null, firstSound = null, gapMs = 0;
    for (let i = 0; i < pieces.length; i++) {
        const pcmAt = requestAt + tts(pieces[i].length, i);
        const scheduledAt = pcmAt + DECODE_MS;
        const start = Math.max(scheduledAt + LEAD_MS, audioEnd ?? 0);
        if (audioEnd !== null && start > audioEnd) gapMs += start - audioEnd;
        if (i === 0) { firstPcm = pcmAt; firstSound = start; }
        audioEnd = start + pieces[i].length * AUDIO_MS_PER_CHAR;
        requestAt = pipelined ? pcmAt : scheduledAt; // next request: at PCM (R26) or after decode (baseline)
    }
    return { segments: pieces.length, firstChars: pieces[0].length, firstPcmMs: firstPcm, firstSoundMs: firstSound, gapMs: Math.round(gapMs), endMs: Math.round(audioEnd) };
}

const rows = [];
for (const [name, profile] of Object.entries(PROFILES)) {
    for (const text of FIXTURES) {
        const before = simulate(text, baselineSentences, false, profile);
        const after = simulate(text, segmentSpeech, true, profile);
        rows.push({ profile: name, text: text.slice(0, 18) + "…", before, after, firstSoundSavedMs: before.firstSoundMs - after.firstSoundMs });
    }
}
if (process.argv.includes("--json")) console.log(JSON.stringify({ model: { PROVIDER_MS, DECODE_MS, LEAD_MS, AUDIO_MS_PER_CHAR, PROFILES }, rows }, null, 2));
else {
    console.log("profile | fixture | segs b→a | 1st chars b→a | first sound ms b→a | saved | gaps ms b→a");
    for (const r of rows) {
        console.log(`${r.profile} | ${r.text} | ${r.before.segments}→${r.after.segments} | ${r.before.firstChars}→${r.after.firstChars} | ` +
            `${r.before.firstSoundMs}→${r.after.firstSoundMs} | ${r.firstSoundSavedMs} | ${r.before.gapMs}→${r.after.gapMs}`);
    }
}
