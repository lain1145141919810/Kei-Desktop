/**
 * Speech-clock phrase alignment and cue beat scheduling.
 *
 * Aligns a planned gesture's target spoken phrase against actual TTS segments on
 * the WebAudio PlaybackClock, explicitly reporting whether timing came from
 * synthesis marks or measured audio-envelope mora estimation.
 */

const PUNCT_RE = /[\s\u3000、。，．！？!?…・「」『』（）()[\]【】―—\-~～:：;；"'`]/g;

export function normalizeText(text) {
    return String(text || "").normalize("NFKC").toLowerCase().replace(PUNCT_RE, "");
}

function charWeight(ch) {
    if (/[、，,;:：；]/.test(ch)) return 2.4;
    if (/[。．！？!?…]/.test(ch)) return 3.6;
    if (/\s/.test(ch)) return 0.6;
    if (/[っッー]/.test(ch)) return 0.85;
    if (/[ゃゅょャュョぁぃぅぇぉァィゥェォ]/.test(ch)) return 0.45;
    if (/[\u4e00-\u9fff]/.test(ch)) return 1.55; // Kanji average ~1.5-2 morae
    if (/[\u3040-\u30ff]/.test(ch)) return 1.0;  // Hiragana / Katakana = 1 mora
    return 0.65; // ASCII / Latin characters
}

function cumulativeWeights(text) {
    const out = new Float64Array(text.length + 1);
    let total = 0;
    for (let i = 0; i < text.length; i++) {
        total += charWeight(text[i]);
        out[i + 1] = total;
    }
    return out;
}

/**
 * Extract measured active speech bursts [startSec, endSec] from a 10ms RMS envelope.
 */
export function extractSpeechWindows(levels, stepSec = 0.01) {
    if (!levels || !levels.length) return { activeStart: 0, activeEnd: 0, windows: [] };
    let peak = 0;
    for (let i = 0; i < levels.length; i++) {
        if (levels[i] > peak) peak = levels[i];
    }
    const duration = levels.length * stepSec;
    if (peak < 0.008) {
        return { activeStart: 0, activeEnd: duration, windows: [{ start: 0, end: duration }] };
    }
    const threshold = Math.max(0.012, peak * 0.08);
    const raw = [];
    let open = -1;
    for (let i = 0; i < levels.length; i++) {
        if (levels[i] >= threshold && open < 0) open = i;
        else if (levels[i] < threshold && open >= 0) {
            raw.push({ start: open * stepSec, end: i * stepSec });
            open = -1;
        }
    }
    if (open >= 0) raw.push({ start: open * stepSec, end: duration });

    // Merge short gaps (< 120ms) into continuous speech bursts
    const merged = [];
    for (const w of raw) {
        if (merged.length && w.start - merged[merged.length - 1].end < 0.12) {
            merged[merged.length - 1].end = w.end;
        } else {
            merged.push({ ...w });
        }
    }
    if (!merged.length) return { activeStart: 0, activeEnd: duration, windows: [{ start: 0, end: duration }] };
    return {
        activeStart: Number(merged[0].start.toFixed(3)),
        activeEnd: Number(merged[merged.length - 1].end.toFixed(3)),
        windows: merged.map(w => ({ start: Number(w.start.toFixed(3)), end: Number(w.end.toFixed(3)) })),
    };
}

function mapFractionToActiveAudio(fraction, segment) {
    const f = Math.max(0, Math.min(1, fraction));
    const windows = Array.isArray(segment.speechWindows) && segment.speechWindows.length
        ? segment.speechWindows
        : [{ start: segment.activeStart ?? 0, end: segment.activeEnd ?? Math.max(0.1, (segment.end - segment.start)) }];
    let totalActive = 0;
    for (const w of windows) totalActive += Math.max(0.01, w.end - w.start);
    let target = f * totalActive;
    for (const w of windows) {
        const span = Math.max(0.01, w.end - w.start);
        if (target <= span) return segment.start + w.start + target;
        target -= span;
    }
    const last = windows[windows.length - 1];
    return segment.start + last.end;
}

function bigrams(norm) {
    const set = new Set();
    if (norm.length <= 1) {
        if (norm) set.add(norm);
        return set;
    }
    for (let i = 0; i < norm.length - 1; i++) set.add(norm.slice(i, i + 2));
    return set;
}

/**
 * Locate targetPhrase in segment texts with exact, normalized, and paraphrase-fuzzy matching.
 */
function matchPhraseInText(text, phrase) {
    if (!phrase || !text) return null;
    // 1. Exact substring match
    const exact = text.indexOf(phrase);
    if (exact >= 0) {
        return { startIdx: exact, endIdx: exact + phrase.length, matchType: "exact", confidence: 1.0 };
    }
    // 2. Punctuation/whitespace-normalized match with index map back to raw text
    const normPhrase = normalizeText(phrase);
    if (!normPhrase) return null;
    const rawMap = [];
    let normText = "";
    for (let i = 0; i < text.length; i++) {
        const piece = text[i].normalize("NFKC").toLowerCase().replace(PUNCT_RE, "");
        for (const ch of piece) {
            normText += ch;
            rawMap.push(i);
        }
    }
    const normHit = normText.indexOf(normPhrase);
    if (normHit >= 0) {
        return {
            startIdx: rawMap[normHit],
            endIdx: rawMap[Math.min(rawMap.length - 1, normHit + normPhrase.length - 1)] + 1,
            matchType: "normalized",
            confidence: 0.96,
        };
    }
    // 3. Paraphrase-fuzzy sliding window via character bigram + unigram overlap
    const pBi = bigrams(normPhrase);
    const pUni = new Set([...normPhrase]);
    const winLen = Math.max(2, Math.min(normText.length, normPhrase.length));
    let best = null;
    for (let i = 0; i <= normText.length - Math.min(2, winLen); i++) {
        const end = Math.min(normText.length, i + winLen);
        const slice = normText.slice(i, end);
        const sBi = bigrams(slice);
        let biHits = 0;
        for (const bg of pBi) if (sBi.has(bg)) biHits++;
        let uniHits = 0;
        const sUni = new Set([...slice]);
        for (const u of pUni) if (sUni.has(u)) uniHits++;
        const biScore = pBi.size ? biHits / pBi.size : 0;
        const uniScore = pUni.size ? uniHits / pUni.size : 0;
        const score = 0.65 * biScore + 0.35 * uniScore;
        if (score >= 0.42 && (!best || score > best.confidence)) {
            best = {
                startIdx: rawMap[i],
                endIdx: rawMap[Math.min(rawMap.length - 1, end - 1)] + 1,
                matchType: "paraphrase-fuzzy",
                confidence: Number(score.toFixed(2)),
            };
        }
    }
    return best;
}

/**
 * Align a gesture cue's target phrase to scheduled AudioContext segments.
 *
 * Each segment: { segmentId, text, start, end, activeStart?, activeEnd?, speechWindows?, marks? }
 */
export function alignPhraseToSegments(segments, targetPhrase, cueIndex = 0, totalCues = 1, timing = "peak") {
    if (!Array.isArray(segments) || !segments.length) return null;
    const utteranceStart = segments[0].start;

    let chosenSeg = null;
    let match = null;

    if (targetPhrase && typeof targetPhrase === "string" && targetPhrase.trim()) {
        for (const seg of segments) {
            const candidate = matchPhraseInText(seg.text || "", targetPhrase.trim());
            if (candidate && (!match || candidate.confidence > match.confidence)) {
                match = candidate;
                chosenSeg = seg;
                if (candidate.matchType === "exact") break;
            }
        }
    }

    // Check optional synthesis word/phrase marks if a TTS provider supplies them
    if (chosenSeg && Array.isArray(chosenSeg.marks) && chosenSeg.marks.length && match) {
        const mark = chosenSeg.marks.find(m => m.offset <= match.startIdx && match.startIdx < m.offset + m.length)
            || chosenSeg.marks.find(m => normalizeText(m.text) === normalizeText(targetPhrase));
        if (mark && Number.isFinite(mark.startSec)) {
            const markEnd = Number.isFinite(mark.endSec) ? mark.endSec : mark.startSec + 0.2;
            const anchorSec = timing === "onset" ? mark.startSec : timing === "release" ? markEnd : (mark.startSec + markEnd) * 0.5;
            const targetAudioSec = chosenSeg.start + anchorSec;
            return {
                segmentId: chosenSeg.segmentId,
                targetAudioSec,
                targetRelMs: Number(((targetAudioSec - utteranceStart) * 1000).toFixed(1)),
                matchType: match.matchType,
                confidence: match.confidence,
                timingSource: "synthesis-marks",
                isEstimate: false,
            };
        }
    }

    if (chosenSeg && match) {
        const text = chosenSeg.text || "";
        const weights = cumulativeWeights(text);
        const totalW = Math.max(0.001, weights[text.length]);
        const startFrac = weights[match.startIdx] / totalW;
        const endFrac = weights[Math.min(text.length, match.endIdx)] / totalW;
        const anchorFrac = timing === "onset" ? startFrac
            : timing === "release" ? endFrac
            : startFrac + (endFrac - startFrac) * 0.45;
        const targetAudioSec = mapFractionToActiveAudio(anchorFrac, chosenSeg);
        return {
            segmentId: chosenSeg.segmentId,
            targetAudioSec,
            targetRelMs: Number(((targetAudioSec - utteranceStart) * 1000).toFixed(1)),
            matchType: match.matchType,
            confidence: match.confidence,
            timingSource: "measured-audio-envelope-estimate",
            isEstimate: true,
        };
    }

    // Fallback when phrase was omitted or did not appear in currently scheduled segments:
    // distribute cues naturally across the utterance's active audio span.
    const posFrac = totalCues <= 1 ? 0.22 : (0.18 + (cueIndex / Math.max(1, totalCues - 1)) * 0.56);
    const segIdx = Math.min(segments.length - 1, Math.floor(posFrac * segments.length));
    const seg = segments[segIdx];
    const localFrac = segments.length === 1 ? posFrac : 0.35;
    const targetAudioSec = mapFractionToActiveAudio(localFrac, seg);
    return {
        segmentId: seg.segmentId,
        targetAudioSec,
        targetRelMs: Number(((targetAudioSec - utteranceStart) * 1000).toFixed(1)),
        matchType: targetPhrase ? "fallback-unmatched" : "positional-default",
        confidence: 0,
        timingSource: "measured-audio-envelope-estimate",
        isEstimate: true,
    };
}

/**
 * Decide exact start time on the audio clock (or skip if too late) for a cue.
 */
export function computeCueSchedule({
    targetAudioSec,
    beat,
    nowAudioSec,
    timing = "peak",
    earliestAudioSec = null,
    maxLateMs = 260,
    maxTrimMs = 180,
}) {
    const peakSec = (beat?.peakMs ?? 650) / 1000;
    const prepSec = (beat?.prepMs ?? 250) / 1000;
    const releaseSec = (beat?.releaseMs ?? 1100) / 1000;
    const anchorOffsetSec = timing === "onset" ? prepSec : timing === "release" ? releaseSec : peakSec;

    const idealStartSec = targetAudioSec - anchorOffsetSec;
    const floorSec = earliestAudioSec !== null ? Math.max(nowAudioSec, earliestAudioSec) : nowAudioSec;

    if (floorSec <= idealStartSec) {
        return {
            action: "schedule",
            startAudioSec: idealStartSec,
            delayMs: Math.round((idealStartSec - nowAudioSec) * 1000),
            trimStartMs: 0,
            expectedPeakAudioSec: idealStartSec + peakSec,
            skipReason: null,
        };
    }

    const lateMs = (floorSec - idealStartSec) * 1000;
    // Also check if the target phrase itself has already passed beyond maxLateMs
    const pastTargetMs = (floorSec - targetAudioSec) * 1000;
    if (pastTargetMs > maxLateMs || lateMs > maxLateMs + maxTrimMs + 220) {
        return {
            action: "skip_late",
            startAudioSec: null,
            delayMs: 0,
            trimStartMs: 0,
            expectedPeakAudioSec: null,
            skipReason: pastTargetMs > maxLateMs ? "target_phrase_passed" : "cue_too_late",
        };
    }

    // Start immediately (or at earliestAudioSec) and smoothly trim a small slice of early prep
    // so the expressive peak still lands tightly near targetAudioSec!
    const trimStartMs = Math.min(maxTrimMs, Math.max(0, Math.round(lateMs * 0.65)));
    return {
        action: floorSec > nowAudioSec + 0.01 ? "schedule" : "start_now",
        startAudioSec: floorSec,
        delayMs: Math.max(0, Math.round((floorSec - nowAudioSec) * 1000)),
        trimStartMs,
        expectedPeakAudioSec: floorSec + Math.max(0.05, peakSec - trimStartMs / 1000),
        skipReason: null,
    };
}
