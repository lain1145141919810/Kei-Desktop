"use strict";
// Round 26: how an approved spoken reply is cut into TTS segments, shared by voice.js and the
// unit tests. Input is always the host's validated `spokenReply` for a completed turn (stage
// directions, hidden fields and history already removed); nothing here sees model fragments.
//
// Latency: the first segment is the first complete sentence on its own, so the first PCM no
// longer waits for up to 60 characters of merged text. Later sentences are still merged up to
// 60 characters to keep the request count (and the single-worker TTS queue) small.
(function (root) {
    const MAX_SEGMENTS = 12;
    const MERGE_LIMIT = 60;
    const PIECE_LIMIT = 400;

    function segmentSpeech(text) {
        if (typeof text !== "string" || !text.trim()) return [];
        const parts = text.replace(/\s+/g, " ").match(/[^。！？!?\n]+[。！？!?]*/g) || [text];
        const out = [];
        for (const part of parts) {
            const piece = part.trim();
            if (!piece) continue;
            // Segment 0 is never merged; later sentences merge exactly as before Round 26.
            if (out.length > 1 && (out.at(-1) + piece).length <= MERGE_LIMIT) out[out.length - 1] += piece;
            else out.push(piece.slice(0, PIECE_LIMIT));
        }
        return out.slice(0, MAX_SEGMENTS);
    }

    // Per-turn latency ledger: submit -> approved reply -> first TTS request -> first PCM ->
    // first scheduled sound. All values are ms relative to `submittedAt` (performance.now()).
    function latencyRecord({ requestId = null, submittedAt = null, replyAt, firstRequestAt = null,
        firstPcmAt = null, firstSoundAt = null, segments = 0, firstSegmentChars = 0, outcome = "pending" }) {
        const rel = value => (Number.isFinite(value) && Number.isFinite(submittedAt) ? Number((value - submittedAt).toFixed(1)) : null);
        return {
            requestId,
            providerWaitMs: rel(replyAt),
            firstApprovedSentenceMs: rel(replyAt),
            firstTtsRequestMs: rel(firstRequestAt),
            firstPcmMs: rel(firstPcmAt),
            firstSoundMs: rel(firstSoundAt),
            ttsFirstPcmMs: Number.isFinite(firstPcmAt) && Number.isFinite(firstRequestAt) ? Number((firstPcmAt - firstRequestAt).toFixed(1)) : null,
            segments,
            firstSegmentChars,
            outcome,
        };
    }

    const api = Object.freeze({ segmentSpeech, latencyRecord, MAX_SEGMENTS, MERGE_LIMIT });
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.KeiSpeechPlan = api;
})(typeof window === "object" ? window : globalThis);
