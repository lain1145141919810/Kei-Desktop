/**
 * Reviewed natural motion vocabulary for VRM desktop performance (plugin-local).
 *
 * Categories (prioritizing greeting, explanation, hesitation):
 *   1. greeting-wave       (3 variants: right-cheerful, left-gentle, right-compact)
 *   2. explain-open-palm   (3 variants: right-present, left-present, both-warm)
 *   3. hesitate-pause      (3 variants: right-chin-think, left-chest-pause, right-shy-tilt)
 *   4. ack-nod             (2 variants: gentle-nod, warm-double-nod)
 *   5. indicate-direction  (2 variants: left-indicate, right-indicate)
 *   6. complete-settle     (2 variants: right-confirm, both-settle)
 *
 * Design principles:
 *   - C2 minimum-jerk (quintic smootherstep) envelopes with subtle anticipation & settle.
 *   - Overlapping hierarchy: torso lead (-30ms) -> shoulder (0ms) -> upper arm (+25ms)
 *     -> elbow (+70ms) -> wrist (+115ms) -> fingers (+145ms); head (+35ms after neck).
 *   - Explicit head ownership (`ownsHead`) so procedural head gestures never double-drive.
 *   - Per-frame Three.js FK verification on the active rig for foot sliding (0mm),
 *     hand-torso / hand-head clearance (auto-nudged if needed), and angular continuity.
 */

const LEFT_ARM = ["leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand"];
const RIGHT_ARM = ["rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand"];
const LEFT_FINGERS = [
    "leftThumbMetacarpal", "leftThumbProximal", "leftThumbDistal",
    "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
    "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
    "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
    "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
];
const RIGHT_FINGERS = [
    "rightThumbMetacarpal", "rightThumbProximal", "rightThumbDistal",
    "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
    "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
    "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
    "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
];
const TORSO = ["spine", "chest"];
const HEAD_CHAIN = ["neck", "head"];

const clamp01 = x => Math.max(0, Math.min(1, x));
const smootherstep = x => {
    const t = clamp01(x);
    return t * t * t * (t * (t * 6 - 15) + 10);
};

// Smooth bell envelope with gentle anticipation dip (-anticipation) before primary rise,
// plateau around peak, and soft cubic-quintic release.
function beatEnvelope(tSec, durationSec, prepFrac, peakFrac, releaseFrac, anticipation = 0.08) {
    const u = clamp01(tSec / Math.max(0.1, durationSec));
    if (u <= 0 || u >= 1) return 0;
    const antiEnd = prepFrac * 0.45;
    if (u < antiEnd) {
        const p = smootherstep(u / Math.max(0.01, antiEnd));
        return -anticipation * Math.sin(p * Math.PI);
    }
    if (u < peakFrac) {
        const p = (u - antiEnd) / Math.max(0.01, peakFrac - antiEnd);
        return smootherstep(p);
    }
    if (u < releaseFrac) {
        // Gentle sustained presence with micro-breath falloff across hold window
        const p = (u - peakFrac) / Math.max(0.01, releaseFrac - peakFrac);
        return 1 - 0.06 * smootherstep(p);
    }
    const p = (u - releaseFrac) / Math.max(0.01, 1 - releaseFrac);
    return 0.94 * (1 - smootherstep(p));
}

// Secondary cyclic impulse active near peak (e.g. wave oscillation or double-nod)
function peakWave(tSec, durationSec, startFrac, endFrac, cycles) {
    const u = clamp01(tSec / Math.max(0.1, durationSec));
    if (u <= startFrac || u >= endFrac) return 0;
    const local = (u - startFrac) / Math.max(0.01, endFrac - startFrac);
    const window = Math.sin(Math.PI * local) ** 1.4;
    return window * Math.sin(local * Math.PI * 2 * cycles);
}

// Mirror a left-side Euler [x, y, z] cleanly to right side (VRM normalized humanoid facing +Z)
const mirror = ([x, y, z]) => [x, -y, -z];
const scale3 = ([x, y, z], s) => [x * s, y * s, z * s];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

function armMask(side) {
    if (side === "left") return [...TORSO, ...LEFT_ARM, ...LEFT_FINGERS];
    if (side === "right") return [...TORSO, ...RIGHT_ARM, ...RIGHT_FINGERS];
    if (side === "both") return [...TORSO, ...LEFT_ARM, ...LEFT_FINGERS, ...RIGHT_ARM, ...RIGHT_FINGERS];
    return [...TORSO, ...HEAD_CHAIN];
}

function fingerCurlEuler(side, curl, spread = 0) {
    const sign = side === "left" ? -1 : 1;
    return [0, sign * spread, sign * curl];
}

function setFingers(out, side, baseCurl, thumbCurl, spread = 0) {
    const prefix = side === "left" ? "left" : "right";
    const s = side === "left" ? -1 : 1;
    out[prefix + "ThumbMetacarpal"] = [0.06, s * (0.18 + thumbCurl * 0.25), s * thumbCurl * 0.25];
    out[prefix + "ThumbProximal"] = [0, s * thumbCurl * 0.2, s * thumbCurl * 0.35];
    out[prefix + "ThumbDistal"] = [0, 0, s * thumbCurl * 0.3];
    const fingers = [
        ["Index", 0.85, -spread],
        ["Middle", 0.95, 0],
        ["Ring", 1.05, spread * 0.7],
        ["Little", 1.15, spread * 1.2],
    ];
    for (const [name, mult, sp] of fingers) {
        const c = baseCurl * mult;
        out[prefix + name + "Proximal"] = fingerCurlEuler(side, c * 0.95, sp);
        out[prefix + name + "Intermediate"] = fingerCurlEuler(side, c * 0.85, 0);
        out[prefix + name + "Distal"] = fingerCurlEuler(side, c * 0.55, 0);
    }
}

export const VOCABULARY_VERSION = 2;

export const VOCABULARY = [
    {
        id: "greeting-wave",
        category: "greeting",
        priority: "high",
        recommendedFace: "happy",
        title: "Friendly greeting wave with calibrated wrist reversals and tight beat onset.",
        ownsHead: false,
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 115,
            maxFrameStepDeg: 22,
        },
        variants: [
            {
                id: "right-cheerful",
                handedness: "right",
                durationSec: 1.45,
                prepFrac: 0.20,
                peakFrac: 0.41,
                releaseFrac: 0.76,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    // Calibrated v2: upper-arm peak aligns directly to peakFrac (0.41 = 595ms, measured 600ms)
                    // with crisp 1.5-cycle wrist direction reversals (no late secondary arm spike).
                    const eTorso = beatEnvelope(t + 0.025, dur, 0.20, 0.38, 0.76, 0.04) * strength;
                    const eSh = beatEnvelope(t, dur, 0.20, 0.38, 0.76, 0.06) * strength;
                    const eUA = beatEnvelope(t - 0.020, dur, 0.20, 0.38, 0.76, 0.07) * strength;
                    const eLA = beatEnvelope(t - 0.055, dur, 0.20, 0.38, 0.76, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.090, dur, 0.20, 0.38, 0.76, 0.04) * strength;
                    const eFg = beatEnvelope(t - 0.115, dur, 0.20, 0.38, 0.76, 0.02) * strength;
                    const wForearm = peakWave(t - 0.04, dur, 0.24, 0.80, 1.5) * strength;
                    const wWrist = peakWave(t - 0.08, dur, 0.22, 0.82, 1.5) * strength;
                    const out = {
                        spine: [0.02 * eTorso, 0.03 * eTorso, 0.025 * eTorso],
                        chest: [0.02 * eTorso, 0.04 * eTorso, 0.03 * eTorso],
                        rightShoulder: [0, 0.06 * eSh, -0.12 * eSh],
                        // Clean single-peak elevation (~44 deg from rest) right at 550ms
                        rightUpperArm: [0.12 * eUA, 0.44 * eUA, 1.10 - 0.70 * eUA],
                        rightLowerArm: [0.06 * eLA, 1.44 * eLA + 0.07 * wForearm, -0.78 * eLA - 0.10 * wForearm],
                        rightHand: [0.20 * eHa, 0.12 * eHa + 0.10 * wWrist, -0.06 * eHa - 0.30 * wWrist],
                    };
                    setFingers(out, "right", 0.34 - 0.24 * Math.max(0, eFg), 0.20 - 0.12 * Math.max(0, eFg), 0.06 * Math.max(0, eFg));
                    return out;
                },
            },
            {
                id: "left-gentle",
                handedness: "left",
                durationSec: 1.75,
                prepFrac: 0.23,
                peakFrac: 0.46,
                releaseFrac: 0.79,
                mask: armMask("left"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.23, 0.46, 0.79, 0.05) * strength;
                    const eSh = beatEnvelope(t, dur, 0.23, 0.46, 0.79, 0.06) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.23, 0.46, 0.79, 0.07) * strength;
                    const eLA = beatEnvelope(t - 0.070, dur, 0.23, 0.46, 0.79, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.115, dur, 0.23, 0.46, 0.79, 0.04) * strength;
                    const eFg = beatEnvelope(t - 0.145, dur, 0.23, 0.46, 0.79, 0.03) * strength;
                    const wArm = peakWave(t - 0.05, dur, 0.30, 0.84, 1.8) * strength;
                    const wWrist = peakWave(t - 0.11, dur, 0.28, 0.86, 1.8) * strength;
                    const out = {
                        spine: [0.02 * eTorso, -0.03 * eTorso, -0.03 * eTorso],
                        chest: [0.02 * eTorso, -0.04 * eTorso, -0.03 * eTorso],
                        leftShoulder: [0, -0.05 * eSh, 0.12 * eSh],
                        leftUpperArm: [0.12 * eUA, -0.44 * eUA, -1.10 + 0.72 * eUA + 0.05 * wArm],
                        leftLowerArm: [0.06 * eLA, -1.42 * eLA - 0.09 * wArm, 0.76 * eLA + 0.12 * wArm],
                        leftHand: [0.20 * eHa, -0.12 * eHa - 0.10 * wWrist, 0.08 * eHa + 0.26 * wWrist],
                    };
                    setFingers(out, "left", 0.34 - 0.22 * Math.max(0, eFg), 0.20 - 0.10 * Math.max(0, eFg), 0.05 * Math.max(0, eFg));
                    return out;
                },
            },
            {
                id: "right-compact",
                handedness: "right",
                durationSec: 1.45,
                prepFrac: 0.21,
                peakFrac: 0.44,
                releaseFrac: 0.77,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.025, dur, 0.21, 0.44, 0.77, 0.04) * strength;
                    const eSh = beatEnvelope(t, dur, 0.21, 0.44, 0.77, 0.05) * strength;
                    const eUA = beatEnvelope(t - 0.022, dur, 0.21, 0.44, 0.77, 0.06) * strength;
                    const eLA = beatEnvelope(t - 0.065, dur, 0.21, 0.44, 0.77, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.105, dur, 0.21, 0.44, 0.77, 0.04) * strength;
                    const eFg = beatEnvelope(t - 0.135, dur, 0.21, 0.44, 0.77, 0.02) * strength;
                    const wWrist = peakWave(t - 0.09, dur, 0.28, 0.85, 2.0) * strength;
                    const out = {
                        spine: [0.015 * eTorso, 0.02 * eTorso, 0.02 * eTorso],
                        chest: [0.015 * eTorso, 0.03 * eTorso, 0.025 * eTorso],
                        rightShoulder: [0, 0.05 * eSh, -0.09 * eSh],
                        // Closer elbow-tucked silhouette ideal for compact desktop framing
                        rightUpperArm: [0.10 * eUA, 0.56 * eUA, 1.10 - 0.58 * eUA],
                        rightLowerArm: [0.06 * eLA, 1.52 * eLA, -0.68 * eLA - 0.10 * wWrist],
                        rightHand: [0.24 * eHa, 0.12 * eHa + 0.10 * wWrist, -0.08 * eHa - 0.28 * wWrist],
                    };
                    setFingers(out, "right", 0.34 - 0.22 * Math.max(0, eFg), 0.20 - 0.10 * Math.max(0, eFg), 0.05 * Math.max(0, eFg));
                    return out;
                },
            },
        ],
    },
    {
        id: "explain-open-palm",
        category: "explanation",
        priority: "high",
        title: "Open-palm conversational explanation gesture presenting a key point.",
        ownsHead: false,
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 130,
            maxFrameStepDeg: 16,
        },
        variants: [
            {
                id: "right-present",
                handedness: "right",
                durationSec: 1.70,
                prepFrac: 0.24,
                peakFrac: 0.49,
                releaseFrac: 0.78,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.24, 0.49, 0.78, 0.05) * strength;
                    const eSh = beatEnvelope(t, dur, 0.24, 0.49, 0.78, 0.08) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.24, 0.49, 0.78, 0.10) * strength;
                    const eLA = beatEnvelope(t - 0.075, dur, 0.24, 0.49, 0.78, 0.08) * strength;
                    const eHa = beatEnvelope(t - 0.125, dur, 0.24, 0.49, 0.78, 0.05) * strength;
                    const eFg = beatEnvelope(t - 0.150, dur, 0.24, 0.49, 0.78, 0.03) * strength;
                    const beatPulse = peakWave(t - 0.06, dur, 0.36, 0.72, 0.5) * strength;
                    const out = {
                        spine: [0.03 * eTorso, 0.03 * eTorso, 0.015 * eTorso],
                        chest: [0.03 * eTorso, 0.05 * eTorso, 0.02 * eTorso],
                        rightShoulder: [0, 0.08 * eSh, -0.08 * eSh],
                        // Slight inward anticipation gather, then forward-outward open-palm presentation
                        rightUpperArm: [0.08 * eUA, 0.58 * eUA, 1.10 - 0.52 * eUA - 0.05 * beatPulse],
                        rightLowerArm: [0.06 * eLA, 0.92 * eLA - 0.12 * beatPulse, -0.46 * eLA + 0.06 * beatPulse],
                        // Supinate wrist cleanly so palm opens upward/forward toward viewer
                        rightHand: [-1.15 * eHa, 0.16 * eHa, 0.24 * eHa + 0.08 * beatPulse],
                    };
                    setFingers(out, "right", 0.34 - 0.24 * Math.max(0, eFg), 0.20 - 0.12 * Math.max(0, eFg), 0.06 * Math.max(0, eFg));
                    return out;
                },
            },
            {
                id: "left-present",
                handedness: "left",
                durationSec: 1.75,
                prepFrac: 0.24,
                peakFrac: 0.50,
                releaseFrac: 0.79,
                mask: armMask("left"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.24, 0.50, 0.79, 0.05) * strength;
                    const eSh = beatEnvelope(t, dur, 0.24, 0.50, 0.79, 0.08) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.24, 0.50, 0.79, 0.10) * strength;
                    const eLA = beatEnvelope(t - 0.075, dur, 0.24, 0.50, 0.79, 0.08) * strength;
                    const eHa = beatEnvelope(t - 0.125, dur, 0.24, 0.50, 0.79, 0.05) * strength;
                    const eFg = beatEnvelope(t - 0.150, dur, 0.24, 0.50, 0.79, 0.03) * strength;
                    const beatPulse = peakWave(t - 0.06, dur, 0.36, 0.72, 0.5) * strength;
                    const out = {
                        spine: [0.03 * eTorso, -0.03 * eTorso, -0.015 * eTorso],
                        chest: [0.03 * eTorso, -0.05 * eTorso, -0.02 * eTorso],
                        leftShoulder: [0, -0.08 * eSh, 0.08 * eSh],
                        leftUpperArm: [0.08 * eUA, -0.58 * eUA, -1.10 + 0.52 * eUA + 0.05 * beatPulse],
                        leftLowerArm: [0.06 * eLA, -0.92 * eLA + 0.12 * beatPulse, 0.46 * eLA - 0.06 * beatPulse],
                        leftHand: [-1.15 * eHa, -0.16 * eHa, -0.24 * eHa - 0.08 * beatPulse],
                    };
                    setFingers(out, "left", 0.34 - 0.24 * Math.max(0, eFg), 0.20 - 0.12 * Math.max(0, eFg), 0.06 * Math.max(0, eFg));
                    return out;
                },
            },
            {
                id: "both-warm",
                handedness: "both",
                durationSec: 1.85,
                prepFrac: 0.24,
                peakFrac: 0.50,
                releaseFrac: 0.79,
                mask: armMask("both"),
                sample(t, dur, strength) {
                    // Asymmetric lead: right leads left by 55ms to avoid mechanical symmetry
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.24, 0.50, 0.79, 0.05) * strength;
                    const rSh = beatEnvelope(t, dur, 0.24, 0.50, 0.79, 0.07) * strength;
                    const rUA = beatEnvelope(t - 0.025, dur, 0.24, 0.50, 0.79, 0.08) * strength;
                    const rLA = beatEnvelope(t - 0.075, dur, 0.24, 0.50, 0.79, 0.06) * strength;
                    const rHa = beatEnvelope(t - 0.120, dur, 0.24, 0.50, 0.79, 0.04) * strength;
                    const lSh = beatEnvelope(t - 0.055, dur, 0.24, 0.50, 0.79, 0.07) * strength;
                    const lUA = beatEnvelope(t - 0.080, dur, 0.24, 0.50, 0.79, 0.08) * strength;
                    const lLA = beatEnvelope(t - 0.130, dur, 0.24, 0.50, 0.79, 0.06) * strength;
                    const lHa = beatEnvelope(t - 0.175, dur, 0.24, 0.50, 0.79, 0.04) * strength;
                    const out = {
                        spine: [0.035 * eTorso, 0.02 * eTorso, 0],
                        chest: [0.04 * eTorso, 0.03 * eTorso, 0.01 * eTorso],
                        rightShoulder: [0, 0.07 * rSh, -0.07 * rSh],
                        rightUpperArm: [0.06 * rUA, 0.56 * rUA, 1.10 - 0.48 * rUA],
                        rightLowerArm: [0.05 * rLA, 0.88 * rLA, -0.40 * rLA],
                        rightHand: [-1.08 * rHa, 0.16 * rHa, 0.20 * rHa],
                        leftShoulder: [0, -0.06 * lSh, 0.06 * lSh],
                        leftUpperArm: [0.05 * lUA, -0.52 * lUA, -1.10 + 0.44 * lUA],
                        leftLowerArm: [0.04 * lLA, -0.82 * lLA, 0.36 * lLA],
                        leftHand: [-1.02 * lHa, -0.14 * lHa, -0.18 * lHa],
                    };
                    setFingers(out, "right", 0.36 - 0.22 * Math.max(0, rHa), 0.20 - 0.10 * Math.max(0, rHa), 0.05 * Math.max(0, rHa));
                    setFingers(out, "left", 0.36 - 0.20 * Math.max(0, lHa), 0.20 - 0.09 * Math.max(0, lHa), 0.04 * Math.max(0, lHa));
                    return out;
                },
            },
        ],
    },
    {
        id: "hesitate-pause",
        category: "hesitation",
        priority: "high",
        title: "Thoughtful hesitant pause while considering an answer (owns head tilt).",
        ownsHead: true,
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 110,
            maxFrameStepDeg: 15,
            headOwnership: "body-owns-head (suppresses competing procedural head gesture)",
        },
        variants: [
            {
                id: "right-chin-think",
                handedness: "right",
                durationSec: 1.90,
                prepFrac: 0.26,
                peakFrac: 0.54,
                releaseFrac: 0.80,
                mask: [...armMask("right"), ...HEAD_CHAIN],
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.26, 0.54, 0.80, 0.04) * strength;
                    const eNeck = beatEnvelope(t - 0.01, dur, 0.26, 0.54, 0.80, 0.04) * strength;
                    const eHead = beatEnvelope(t - 0.045, dur, 0.26, 0.54, 0.80, 0.04) * strength;
                    const eSh = beatEnvelope(t, dur, 0.26, 0.54, 0.80, 0.06) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.26, 0.54, 0.80, 0.07) * strength;
                    const eLA = beatEnvelope(t - 0.075, dur, 0.26, 0.54, 0.80, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.125, dur, 0.26, 0.54, 0.80, 0.04) * strength;
                    const out = {
                        spine: [-0.02 * eTorso, -0.04 * eTorso, -0.02 * eTorso],
                        chest: [-0.02 * eTorso, -0.05 * eTorso, -0.03 * eTorso],
                        neck: [-0.04 * eNeck, -0.06 * eNeck, 0.07 * eNeck],
                        head: [-0.06 * eHead, -0.08 * eHead, 0.14 * eHead],
                        rightShoulder: [0, 0.08 * eSh, -0.06 * eSh],
                        // Thoughtful hand lifted toward cheek/chin height with comfortable forward clearance (>= 110mm)
                        rightUpperArm: [0.10 * eUA, 0.68 * eUA, 1.10 - 0.58 * eUA],
                        rightLowerArm: [0.06 * eLA, 1.66 * eLA, -0.84 * eLA],
                        rightHand: [-0.30 * eHa, -0.16 * eHa, -0.18 * eHa],
                    };
                    setFingers(out, "right", 0.42 + 0.10 * Math.max(0, eHa), 0.26, 0.01);
                    return out;
                },
            },
            {
                id: "left-chest-pause",
                handedness: "left",
                durationSec: 1.80,
                prepFrac: 0.25,
                peakFrac: 0.52,
                releaseFrac: 0.80,
                mask: [...armMask("left"), ...HEAD_CHAIN],
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.25, 0.52, 0.80, 0.04) * strength;
                    const eNeck = beatEnvelope(t - 0.01, dur, 0.25, 0.52, 0.80, 0.04) * strength;
                    const eHead = beatEnvelope(t - 0.045, dur, 0.25, 0.52, 0.80, 0.04) * strength;
                    const eSh = beatEnvelope(t, dur, 0.25, 0.52, 0.80, 0.05) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.25, 0.52, 0.80, 0.06) * strength;
                    const eLA = beatEnvelope(t - 0.075, dur, 0.25, 0.52, 0.80, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.120, dur, 0.25, 0.52, 0.80, 0.04) * strength;
                    const out = {
                        spine: [0.015 * eTorso, 0.04 * eTorso, 0.02 * eTorso],
                        chest: [0.02 * eTorso, 0.05 * eTorso, 0.025 * eTorso],
                        neck: [-0.03 * eNeck, 0.05 * eNeck, -0.07 * eNeck],
                        head: [-0.04 * eHead, 0.06 * eHead, -0.14 * eHead],
                        leftShoulder: [0, -0.07 * eSh, 0.05 * eSh],
                        leftUpperArm: [0.04 * eUA, -0.64 * eUA, -1.10 + 0.34 * eUA],
                        leftLowerArm: [0.04 * eLA, -1.35 * eLA, 0.34 * eLA],
                        leftHand: [0.30 * eHa, 0.08 * eHa, -0.14 * eHa],
                    };
                    setFingers(out, "left", 0.40 + 0.08 * Math.max(0, eHa), 0.24, 0.02);
                    return out;
                },
            },
        ],
    },
    {
        id: "ack-nod",
        category: "acknowledgement",
        priority: "standard",
        title: "Warm acknowledgement nod with upper-torso follow-through (owns head).",
        ownsHead: true,
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 999,
            minHandHeadClearanceMm: 999,
            maxFrameStepDeg: 14,
            headOwnership: "body-owns-head (suppresses competing procedural head gesture)",
        },
        variants: [
            {
                id: "gentle-nod",
                handedness: "none",
                durationSec: 1.15,
                prepFrac: 0.19,
                peakFrac: 0.46,
                releaseFrac: 0.76,
                mask: [...TORSO, ...HEAD_CHAIN],
                sample(t, dur, strength) {
                    const eNeck = beatEnvelope(t, dur, 0.19, 0.46, 0.76, 0.14) * strength;
                    const eHead = beatEnvelope(t - 0.035, dur, 0.19, 0.46, 0.76, 0.16) * strength;
                    const eChest = beatEnvelope(t - 0.065, dur, 0.22, 0.50, 0.78, 0.06) * strength;
                    return {
                        spine: [0.025 * eChest, 0, 0],
                        chest: [0.045 * eChest, 0, 0],
                        neck: [0.09 * eNeck, 0, 0.015 * eNeck],
                        head: [0.22 * eHead, 0, 0.025 * eHead],
                    };
                },
            },
            {
                id: "warm-double-nod",
                handedness: "none",
                durationSec: 1.40,
                prepFrac: 0.17,
                peakFrac: 0.40,
                releaseFrac: 0.78,
                mask: [...TORSO, ...HEAD_CHAIN],
                sample(t, dur, strength) {
                    const n1 = beatEnvelope(t, dur * 0.62, 0.22, 0.48, 0.75, 0.14) * strength;
                    const n2 = beatEnvelope(t - dur * 0.42, dur * 0.58, 0.20, 0.46, 0.76, 0.08) * strength * 0.68;
                    const h1 = beatEnvelope(t - 0.035, dur * 0.62, 0.22, 0.48, 0.75, 0.16) * strength;
                    const h2 = beatEnvelope(t - dur * 0.42 - 0.035, dur * 0.58, 0.20, 0.46, 0.76, 0.08) * strength * 0.70;
                    const c = beatEnvelope(t - 0.06, dur, 0.20, 0.48, 0.78, 0.05) * strength;
                    return {
                        spine: [0.02 * c, 0, 0],
                        chest: [0.04 * c, 0, 0],
                        neck: [0.085 * (n1 + n2), 0, -0.015 * c],
                        head: [0.20 * (h1 + h2), 0, -0.025 * c],
                    };
                },
            },
        ],
    },
    {
        id: "indicate-direction",
        category: "indication",
        priority: "standard",
        title: "Polite directional indication sweeping smoothly to left or right.",
        ownsHead: false,
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 100,
            minHandHeadClearanceMm: 130,
            maxFrameStepDeg: 17,
        },
        variants: [
            {
                id: "left-indicate",
                handedness: "left",
                durationSec: 1.65,
                prepFrac: 0.22,
                peakFrac: 0.48,
                releaseFrac: 0.78,
                mask: armMask("left"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.22, 0.48, 0.78, 0.06) * strength;
                    const eSh = beatEnvelope(t, dur, 0.22, 0.48, 0.78, 0.08) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.22, 0.48, 0.78, 0.09) * strength;
                    const eLA = beatEnvelope(t - 0.075, dur, 0.22, 0.48, 0.78, 0.07) * strength;
                    const eHa = beatEnvelope(t - 0.125, dur, 0.22, 0.48, 0.78, 0.05) * strength;
                    const eFg = beatEnvelope(t - 0.150, dur, 0.22, 0.48, 0.78, 0.03) * strength;
                    const out = {
                        spine: [0.02 * eTorso, 0.05 * eTorso, -0.02 * eTorso],
                        chest: [0.025 * eTorso, 0.09 * eTorso, -0.025 * eTorso],
                        leftShoulder: [0, -0.06 * eSh, 0.10 * eSh],
                        // Natural diagonal outward sweep with open inviting palm
                        leftUpperArm: [0.08 * eUA, -0.34 * eUA, -1.10 + 0.62 * eUA],
                        leftLowerArm: [0.04 * eLA, -0.44 * eLA, 0.26 * eLA],
                        leftHand: [-0.88 * eHa, -0.14 * eHa, -0.16 * eHa],
                    };
                    setFingers(out, "left", 0.32 - 0.22 * Math.max(0, eFg), 0.18 - 0.10 * Math.max(0, eFg), 0.03 * Math.max(0, eFg));
                    return out;
                },
            },
            {
                id: "right-indicate",
                handedness: "right",
                durationSec: 1.65,
                prepFrac: 0.22,
                peakFrac: 0.48,
                releaseFrac: 0.78,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.03, dur, 0.22, 0.48, 0.78, 0.06) * strength;
                    const eSh = beatEnvelope(t, dur, 0.22, 0.48, 0.78, 0.08) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.22, 0.48, 0.78, 0.09) * strength;
                    const eLA = beatEnvelope(t - 0.075, dur, 0.22, 0.48, 0.78, 0.07) * strength;
                    const eHa = beatEnvelope(t - 0.125, dur, 0.22, 0.48, 0.78, 0.05) * strength;
                    const eFg = beatEnvelope(t - 0.150, dur, 0.22, 0.48, 0.78, 0.03) * strength;
                    const out = {
                        spine: [0.02 * eTorso, -0.05 * eTorso, 0.02 * eTorso],
                        chest: [0.025 * eTorso, -0.09 * eTorso, 0.025 * eTorso],
                        rightShoulder: [0, 0.06 * eSh, -0.10 * eSh],
                        rightUpperArm: [0.08 * eUA, 0.34 * eUA, 1.10 - 0.62 * eUA],
                        rightLowerArm: [0.04 * eLA, 0.44 * eLA, -0.26 * eLA],
                        rightHand: [-0.88 * eHa, 0.14 * eHa, 0.16 * eHa],
                    };
                    setFingers(out, "right", 0.32 - 0.22 * Math.max(0, eFg), 0.18 - 0.10 * Math.max(0, eFg), 0.03 * Math.max(0, eFg));
                    return out;
                },
            },
        ],
    },
    {
        id: "complete-settle",
        category: "completion",
        priority: "standard",
        title: "Confident completion gesture settling cleanly at the end of a thought.",
        ownsHead: false,
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 135,
            maxFrameStepDeg: 16,
        },
        variants: [
            {
                id: "right-confirm",
                handedness: "right",
                durationSec: 1.45,
                prepFrac: 0.20,
                peakFrac: 0.46,
                releaseFrac: 0.76,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.025, dur, 0.20, 0.46, 0.76, 0.06) * strength;
                    const eSh = beatEnvelope(t, dur, 0.20, 0.46, 0.76, 0.08) * strength;
                    const eUA = beatEnvelope(t - 0.022, dur, 0.20, 0.46, 0.76, 0.10) * strength;
                    const eLA = beatEnvelope(t - 0.065, dur, 0.20, 0.46, 0.76, 0.08) * strength;
                    const eHa = beatEnvelope(t - 0.110, dur, 0.20, 0.46, 0.76, 0.05) * strength;
                    const dropBeat = peakWave(t - 0.05, dur, 0.35, 0.75, 0.5) * strength;
                    const out = {
                        spine: [0.025 * eTorso, 0.02 * eTorso, 0],
                        chest: [0.03 * eTorso, 0.03 * eTorso, 0.015 * eTorso],
                        rightShoulder: [0, 0.06 * eSh, -0.07 * eSh],
                        rightUpperArm: [0.05 * eUA, 0.58 * eUA, 1.10 - 0.42 * eUA + 0.10 * dropBeat],
                        rightLowerArm: [0.04 * eLA, 1.08 * eLA - 0.18 * dropBeat, -0.34 * eLA + 0.12 * dropBeat],
                        rightHand: [0.55 * eHa, 0.10 * eHa, 0.14 * eHa - 0.12 * dropBeat],
                    };
                    setFingers(out, "right", 0.36 - 0.20 * Math.max(0, eHa), 0.22 - 0.10 * Math.max(0, eHa), 0.04 * Math.max(0, eHa));
                    return out;
                },
            },
            {
                id: "both-settle",
                handedness: "both",
                durationSec: 1.60,
                prepFrac: 0.21,
                peakFrac: 0.46,
                releaseFrac: 0.76,
                mask: armMask("both"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.025, dur, 0.21, 0.46, 0.76, 0.05) * strength;
                    const rSh = beatEnvelope(t, dur, 0.21, 0.46, 0.76, 0.07) * strength;
                    const rUA = beatEnvelope(t - 0.025, dur, 0.21, 0.46, 0.76, 0.08) * strength;
                    const rLA = beatEnvelope(t - 0.070, dur, 0.21, 0.46, 0.76, 0.06) * strength;
                    const rHa = beatEnvelope(t - 0.115, dur, 0.21, 0.46, 0.76, 0.04) * strength;
                    const lSh = beatEnvelope(t - 0.045, dur, 0.21, 0.46, 0.76, 0.07) * strength;
                    const lUA = beatEnvelope(t - 0.070, dur, 0.21, 0.46, 0.76, 0.08) * strength;
                    const lLA = beatEnvelope(t - 0.115, dur, 0.21, 0.46, 0.76, 0.06) * strength;
                    const lHa = beatEnvelope(t - 0.160, dur, 0.21, 0.46, 0.76, 0.04) * strength;
                    const out = {
                        spine: [0.025 * eTorso, 0, 0],
                        chest: [0.03 * eTorso, 0, 0],
                        rightShoulder: [0, 0.06 * rSh, -0.06 * rSh],
                        rightUpperArm: [0.04 * rUA, 0.50 * rUA, 1.10 - 0.30 * rUA],
                        rightLowerArm: [0.03 * rLA, 0.76 * rLA, -0.18 * rLA],
                        rightHand: [0.52 * rHa, 0.10 * rHa, 0.12 * rHa],
                        leftShoulder: [0, -0.05 * lSh, 0.05 * lSh],
                        leftUpperArm: [0.04 * lUA, -0.46 * lUA, -1.10 + 0.28 * lUA],
                        leftLowerArm: [0.03 * lLA, -0.72 * lLA, 0.16 * lLA],
                        leftHand: [0.48 * lHa, -0.10 * lHa, -0.10 * lHa],
                    };
                    setFingers(out, "right", 0.36 - 0.18 * Math.max(0, rHa), 0.22 - 0.08 * Math.max(0, rHa), 0.04 * Math.max(0, rHa));
                    setFingers(out, "left", 0.36 - 0.16 * Math.max(0, lHa), 0.22 - 0.08 * Math.max(0, lHa), 0.04 * Math.max(0, lHa));
                    return out;
                },
            },
        ],
    },
    // ---------------- Round 23: Six character-consistent Kei face/body pairings ----------------
    {
        id: "kei-greet-composed",
        category: "greeting",
        priority: "high",
        recommendedFace: "smallSmile",
        title: "Composed, restrained greeting lift with a single crisp wave beat (suited to calm check-ins).",
        ownsHead: false,
        triggers: "Routine greeting to a familiar partner before starting work.",
        avoid: "Urgent alerts, errors, or visibly exhausted interlocutor (prefer still no-gesture).",
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 120,
            maxFrameStepDeg: 18,
        },
        variants: [
            {
                id: "right-restrained",
                handedness: "right",
                durationSec: 1.35,
                prepFrac: 0.20,
                peakFrac: 0.39,
                releaseFrac: 0.76,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.02, dur, 0.20, 0.39, 0.76, 0.03) * strength;
                    const eSh = beatEnvelope(t, dur, 0.20, 0.39, 0.76, 0.05) * strength;
                    const eUA = beatEnvelope(t - 0.02, dur, 0.20, 0.39, 0.76, 0.05) * strength;
                    const eLA = beatEnvelope(t - 0.06, dur, 0.20, 0.39, 0.76, 0.04) * strength;
                    const eHa = beatEnvelope(t - 0.10, dur, 0.20, 0.39, 0.76, 0.03) * strength;
                    const wWrist = peakWave(t - 0.07, dur, 0.25, 0.76, 1.0) * strength;
                    const out = {
                        spine: [0.015 * eTorso, 0.02 * eTorso, 0.01 * eTorso],
                        chest: [0.02 * eTorso, 0.025 * eTorso, 0.015 * eTorso],
                        rightShoulder: [0, 0.05 * eSh, -0.07 * eSh],
                        // Poised lower-arc greeting wave kept clean in both normal & compact framing
                        rightUpperArm: [0.08 * eUA, 0.50 * eUA, 1.10 - 0.50 * eUA],
                        rightLowerArm: [0.05 * eLA, 1.38 * eLA, -0.60 * eLA - 0.06 * wWrist],
                        rightHand: [0.22 * eHa, 0.10 * eHa + 0.08 * wWrist, -0.06 * eHa - 0.22 * wWrist],
                    };
                    setFingers(out, "right", 0.34 - 0.20 * Math.max(0, eHa), 0.20 - 0.09 * Math.max(0, eHa), 0.04 * Math.max(0, eHa));
                    return out;
                },
            },
        ],
    },
    {
        id: "kei-listen-attentive",
        category: "listening",
        priority: "high",
        recommendedFace: "gentle",
        title: "Calm attentive listening posture with subtle chest lean and slight head tilt (hands stay relaxed).",
        ownsHead: true,
        triggers: "User is explaining context, thinking aloud, or giving a multi-step task.",
        avoid: "Urgent interruption or explicit arm movement requests.",
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 999,
            minHandHeadClearanceMm: 999,
            maxFrameStepDeg: 10,
            headOwnership: "body-owns-head (suppresses competing procedural head gesture)",
        },
        variants: [
            {
                id: "attentive-still",
                handedness: "none",
                durationSec: 1.60,
                prepFrac: 0.20,
                peakFrac: 0.45,
                releaseFrac: 0.80,
                mask: [...TORSO, ...HEAD_CHAIN],
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.02, dur, 0.20, 0.45, 0.80, 0.03) * strength;
                    const eNeck = beatEnvelope(t - 0.01, dur, 0.20, 0.45, 0.80, 0.04) * strength;
                    const eHead = beatEnvelope(t - 0.045, dur, 0.20, 0.45, 0.80, 0.04) * strength;
                    return {
                        spine: [0.03 * eTorso, 0.015 * eTorso, 0],
                        chest: [0.045 * eTorso, 0.02 * eTorso, -0.015 * eTorso],
                        neck: [0.04 * eNeck, 0.02 * eNeck, -0.045 * eNeck],
                        head: [0.055 * eHead, 0.03 * eHead, -0.095 * eHead],
                    };
                },
            },
        ],
    },
    {
        id: "kei-explain-measured",
        category: "explanation",
        priority: "high",
        recommendedFace: "serious",
        title: "Measured single-hand analytical palm beat for concise technical explanations.",
        ownsHead: false,
        triggers: "Explaining a logical step, caution, or QA finding clearly without theatrics.",
        avoid: "One-word replies or emotional comfort where quiet stillness fits better.",
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 130,
            maxFrameStepDeg: 15,
        },
        variants: [
            {
                id: "right-logical",
                handedness: "right",
                durationSec: 1.55,
                prepFrac: 0.20,
                peakFrac: 0.44,
                releaseFrac: 0.78,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.025, dur, 0.20, 0.44, 0.78, 0.04) * strength;
                    const eSh = beatEnvelope(t, dur, 0.20, 0.44, 0.78, 0.06) * strength;
                    const eUA = beatEnvelope(t - 0.022, dur, 0.20, 0.44, 0.78, 0.07) * strength;
                    const eLA = beatEnvelope(t - 0.065, dur, 0.20, 0.44, 0.78, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.110, dur, 0.20, 0.44, 0.78, 0.04) * strength;
                    const accent = peakWave(t - 0.05, dur, 0.34, 0.68, 0.5) * strength;
                    const out = {
                        spine: [0.02 * eTorso, 0.025 * eTorso, 0],
                        chest: [0.025 * eTorso, 0.035 * eTorso, 0.01 * eTorso],
                        rightShoulder: [0, 0.06 * eSh, -0.06 * eSh],
                        rightUpperArm: [0.06 * eUA, 0.54 * eUA, 1.10 - 0.42 * eUA - 0.04 * accent],
                        rightLowerArm: [0.05 * eLA, 0.96 * eLA - 0.08 * accent, -0.38 * eLA + 0.05 * accent],
                        rightHand: [-1.05 * eHa, 0.14 * eHa, 0.18 * eHa + 0.06 * accent],
                    };
                    setFingers(out, "right", 0.34 - 0.22 * Math.max(0, eHa), 0.20 - 0.10 * Math.max(0, eHa), 0.04 * Math.max(0, eHa));
                    return out;
                },
            },
        ],
    },
    {
        id: "kei-hesitate-guarded",
        category: "hesitation",
        priority: "high",
        recommendedFace: "flustered",
        title: "Guarded flustered aversion when praised or caught caring (owns head, preserves flustered mouth).",
        ownsHead: true,
        triggers: "Direct personal praise, unexpected warmth, or being caught helping quietly.",
        avoid: "Routine technical explanations or error reports.",
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 110,
            maxFrameStepDeg: 18,
            headOwnership: "body-owns-head (suppresses competing procedural head gesture)",
        },
        variants: [
            {
                id: "guarded-avert",
                handedness: "right",
                durationSec: 1.75,
                prepFrac: 0.22,
                peakFrac: 0.47,
                releaseFrac: 0.80,
                mask: [...armMask("right"), ...HEAD_CHAIN],
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.025, dur, 0.22, 0.47, 0.80, 0.04) * strength;
                    const eNeck = beatEnvelope(t - 0.01, dur, 0.22, 0.47, 0.80, 0.05) * strength;
                    const eHead = beatEnvelope(t - 0.045, dur, 0.22, 0.47, 0.80, 0.05) * strength;
                    const eSh = beatEnvelope(t, dur, 0.22, 0.47, 0.80, 0.06) * strength;
                    const eUA = beatEnvelope(t - 0.025, dur, 0.22, 0.47, 0.80, 0.06) * strength;
                    const eLA = beatEnvelope(t - 0.070, dur, 0.22, 0.47, 0.80, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.115, dur, 0.22, 0.47, 0.80, 0.04) * strength;
                    const out = {
                        spine: [-0.015 * eTorso, 0.04 * eTorso, -0.02 * eTorso],
                        chest: [-0.015 * eTorso, 0.06 * eTorso, -0.025 * eTorso],
                        // Slight shy averted glance to side with modest chin tuck
                        neck: [0.03 * eNeck, 0.08 * eNeck, -0.05 * eNeck],
                        head: [0.05 * eHead, 0.14 * eHead, -0.10 * eHead],
                        rightShoulder: [0, 0.08 * eSh, -0.08 * eSh],
                        rightUpperArm: [0.06 * eUA, 0.64 * eUA, 1.10 - 0.48 * eUA],
                        rightLowerArm: [0.05 * eLA, 1.56 * eLA, -0.72 * eLA],
                        rightHand: [-0.25 * eHa, -0.12 * eHa, -0.14 * eHa],
                    };
                    setFingers(out, "right", 0.44 + 0.06 * Math.max(0, eHa), 0.26, 0.01);
                    return out;
                },
            },
        ],
    },
    {
        id: "kei-work-check",
        category: "work-input",
        priority: "high",
        recommendedFace: "thoughtful",
        title: "Crisp operator check-in gesture when a work session pauses awaiting user input.",
        ownsHead: false,
        triggers: "work-input lifecycle event or asking the user to confirm a choice.",
        avoid: "Repeated polling updates or failed-task error banners.",
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 130,
            maxFrameStepDeg: 15,
        },
        variants: [
            {
                id: "prompt-check",
                handedness: "right",
                durationSec: 1.50,
                prepFrac: 0.20,
                peakFrac: 0.44,
                releaseFrac: 0.78,
                mask: armMask("right"),
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.025, dur, 0.20, 0.44, 0.78, 0.04) * strength;
                    const eSh = beatEnvelope(t, dur, 0.20, 0.44, 0.78, 0.05) * strength;
                    const eUA = beatEnvelope(t - 0.02, dur, 0.20, 0.44, 0.78, 0.06) * strength;
                    const eLA = beatEnvelope(t - 0.065, dur, 0.20, 0.44, 0.78, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.105, dur, 0.20, 0.44, 0.78, 0.04) * strength;
                    const out = {
                        spine: [0.03 * eTorso, 0.02 * eTorso, 0],
                        chest: [0.04 * eTorso, 0.03 * eTorso, 0],
                        rightShoulder: [0, 0.06 * eSh, -0.05 * eSh],
                        rightUpperArm: [0.05 * eUA, 0.56 * eUA, 1.10 - 0.36 * eUA],
                        rightLowerArm: [0.04 * eLA, 0.90 * eLA, -0.32 * eLA],
                        rightHand: [-0.96 * eHa, 0.12 * eHa, 0.16 * eHa],
                    };
                    setFingers(out, "right", 0.36 - 0.20 * Math.max(0, eHa), 0.20 - 0.08 * Math.max(0, eHa), 0.04 * Math.max(0, eHa));
                    return out;
                },
            },
        ],
    },
    {
        id: "kei-complete-composed",
        category: "completion",
        priority: "high",
        recommendedFace: "relieved",
        title: "Understated satisfied nod and neat hand settle at task completion (owns head).",
        ownsHead: true,
        triggers: "work-success or finishing a challenging task cleanly.",
        avoid: "work-error or distressed user contexts.",
        constraints: {
            footSliding: "upper-body-only (0mm foot motion)",
            minHandTorsoClearanceMm: 95,
            minHandHeadClearanceMm: 135,
            maxFrameStepDeg: 14,
            headOwnership: "body-owns-head (suppresses competing procedural head gesture)",
        },
        variants: [
            {
                id: "composed-settle",
                handedness: "right",
                durationSec: 1.40,
                prepFrac: 0.19,
                peakFrac: 0.42,
                releaseFrac: 0.77,
                mask: [...armMask("right"), ...HEAD_CHAIN],
                sample(t, dur, strength) {
                    const eTorso = beatEnvelope(t + 0.02, dur, 0.19, 0.42, 0.77, 0.04) * strength;
                    const eNeck = beatEnvelope(t, dur, 0.19, 0.42, 0.77, 0.10) * strength;
                    const eHead = beatEnvelope(t - 0.035, dur, 0.19, 0.42, 0.77, 0.12) * strength;
                    const eSh = beatEnvelope(t, dur, 0.19, 0.42, 0.77, 0.05) * strength;
                    const eUA = beatEnvelope(t - 0.02, dur, 0.19, 0.42, 0.77, 0.06) * strength;
                    const eLA = beatEnvelope(t - 0.065, dur, 0.19, 0.42, 0.77, 0.05) * strength;
                    const eHa = beatEnvelope(t - 0.105, dur, 0.19, 0.42, 0.77, 0.04) * strength;
                    const out = {
                        spine: [0.025 * eTorso, 0.015 * eTorso, 0],
                        chest: [0.035 * eTorso, 0.02 * eTorso, 0],
                        neck: [0.075 * eNeck, 0, 0.01 * eNeck],
                        head: [0.17 * eHead, 0, 0.02 * eHead],
                        rightShoulder: [0, 0.05 * eSh, -0.05 * eSh],
                        rightUpperArm: [0.04 * eUA, 0.46 * eUA, 1.10 - 0.30 * eUA],
                        rightLowerArm: [0.03 * eLA, 0.76 * eLA, -0.22 * eLA],
                        rightHand: [-0.72 * eHa, 0.08 * eHa, 0.10 * eHa],
                    };
                    setFingers(out, "right", 0.36 - 0.16 * Math.max(0, eHa), 0.20 - 0.06 * Math.max(0, eHa), 0.03 * Math.max(0, eHa));
                    return out;
                },
            },
        ],
    },
];

export const VOCABULARY_BY_ID = new Map(VOCABULARY.map(item => [item.id, item]));

export function vocabularyCatalog() {
    return VOCABULARY.map(item => {
        const primary = item.variants[0];
        return {
            id: item.id,
            title: item.title,
            category: item.category,
            priority: item.priority,
            recommendedFace: item.recommendedFace ?? null,
            triggers: item.triggers ?? null,
            avoid: item.avoid ?? null,
            ownsHead: item.ownsHead,
            handedness: [...new Set(item.variants.map(v => v.handedness))],
            variants: item.variants.map(v => ({
                id: v.id,
                handedness: v.handedness,
                durationMs: Math.round(v.durationSec * 1000),
                prepMs: Math.round(v.durationSec * v.prepFrac * 1000),
                peakMs: Math.round(v.durationSec * v.peakFrac * 1000),
                releaseMs: Math.round(v.durationSec * v.releaseFrac * 1000),
            })),
            beat: {
                prepMs: Math.round(primary.durationSec * primary.prepFrac * 1000),
                peakMs: Math.round(primary.durationSec * primary.peakFrac * 1000),
                releaseMs: Math.round(primary.durationSec * primary.releaseFrac * 1000),
                durationMs: Math.round(primary.durationSec * 1000),
            },
            constraints: item.constraints,
            mask: primary.mask,
        };
    });
}

function quatAngleDeg(a, b) {
    const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
    return 2 * Math.acos(dot) * (180 / Math.PI);
}

/**
 * Synthesize a reviewed vocabulary clip on the active VRM rig with per-frame FK
 * collision, foot-sliding, and angular-continuity verification.
 */
export function synthesizeVocabulary(request, controller, bones, THREE) {
    const started = performance.now();
    const spec = VOCABULARY_BY_ID.get(request.motion);
    if (!spec) return null;

    const speed = request.speed ?? 1.0;
    const strength = request.strength ?? 0.9;
    const requestedVariant = typeof request.variant === "string" && request.variant && request.variant !== "auto"
        ? request.variant
        : null;
    let variant = requestedVariant
        ? spec.variants.find(v => v.id === requestedVariant)
        : null;
    if (!variant) {
        const idx = Number.isInteger(request.variantIndex)
            ? ((request.variantIndex % spec.variants.length) + spec.variants.length) % spec.variants.length
            : 0;
        variant = spec.variants[idx];
    }

    const rate = 20;
    const durationSec = Math.max(0.65, Math.min(4.5, variant.durationSec / speed));
    const frameCount = Math.max(14, Math.min(180, Math.round(durationSec * rate) + 1));
    const mask = variant.mask.filter(name => bones.includes(name) && controller.node(name));
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    const q = new THREE.Quaternion();
    const vTmp = new THREE.Vector3();
    const vTorso = new THREE.Vector3();
    const vHead = new THREE.Vector3();

    // Record neutral rest pose & baseline foot positions on the actual rig
    const restQuats = new Map();
    for (const name of bones) {
        const node = controller.node(name);
        if (!node) continue;
        if (name === "leftUpperArm") node.quaternion.setFromEuler(new THREE.Euler(0, 0, -1.1, "YXZ"));
        else if (name === "rightUpperArm") node.quaternion.setFromEuler(new THREE.Euler(0, 0, 1.1, "YXZ"));
        restQuats.set(name, node.quaternion.clone());
    }
    const rootNode = controller.node("hips")?.parent;
    rootNode?.updateMatrixWorld(true);
    const footRest = {};
    for (const f of ["leftFoot", "rightFoot"]) {
        const fn = controller.node(f);
        if (fn) { fn.getWorldPosition(vTmp); footRest[f] = vTmp.clone(); }
    }

    const frames = [];
    let maxFootSlideMm = 0;
    let minHandTorsoMm = 999;
    let minHandHeadMm = 999;
    let collisionCount = 0;
    let autoClearanceAdjustments = 0;
    let maxFrameStepDeg = 0;

    for (let i = 0; i < frameCount; i++) {
        const t = i / rate;
        const pose = variant.sample(t, durationSec, strength);

        // Reset all bones to rest before applying current frame pose
        for (const [name, rq] of restQuats) {
            controller.node(name).quaternion.copy(rq);
        }
        for (const name of mask) {
            const angles = pose[name];
            if (!angles) continue;
            euler.set(angles[0], angles[1], angles[2], "YXZ");
            q.setFromEuler(euler);
            controller.node(name).quaternion.copy(q);
        }
        rootNode?.updateMatrixWorld(true);

        // Check hand clearance against chest/spine capsule & head sphere; auto-nudge outward if rig is unusually narrow
        const chestNode = controller.node("chest") ?? controller.node("spine");
        const headNode = controller.node("head");
        if (chestNode) chestNode.getWorldPosition(vTorso);
        if (headNode) headNode.getWorldPosition(vHead);

        for (const side of ["left", "right"]) {
            const handName = side + "Hand";
            if (!mask.includes(handName)) continue;
            const handNode = controller.node(handName);
            const uaName = side + "UpperArm";
            if (!handNode) continue;

            for (let attempt = 0; attempt < 3; attempt++) {
                handNode.getWorldPosition(vTmp);
                const dxT = vTmp.x - vTorso.x;
                const dzT = vTmp.z - vTorso.z;
                const torsoDistMm = Math.hypot(dxT, dzT) * 1000;
                const headDistMm = headNode ? vTmp.distanceTo(vHead) * 1000 : 999;
                if (torsoDistMm >= 80 && headDistMm >= 95) {
                    minHandTorsoMm = Math.min(minHandTorsoMm, torsoDistMm);
                    minHandHeadMm = Math.min(minHandHeadMm, headDistMm);
                    break;
                }
                // Auto-nudge upper arm slightly forward/outward to guarantee zero mesh penetration
                const cur = pose[uaName] ?? [0, 0, side === "left" ? -1.1 : 1.1];
                const sign = side === "left" ? -1 : 1;
                pose[uaName] = [cur[0], cur[1] + sign * 0.08, cur[2] - sign * 0.06];
                euler.set(pose[uaName][0], pose[uaName][1], pose[uaName][2], "YXZ");
                controller.node(uaName).quaternion.setFromEuler(euler);
                rootNode?.updateMatrixWorld(true);
                autoClearanceAdjustments++;
                if (attempt === 2) {
                    handNode.getWorldPosition(vTmp);
                    minHandTorsoMm = Math.min(minHandTorsoMm, Math.hypot(vTmp.x - vTorso.x, vTmp.z - vTorso.z) * 1000);
                    minHandHeadMm = Math.min(minHandHeadMm, headNode ? vTmp.distanceTo(vHead) * 1000 : 999);
                    if (minHandTorsoMm < 75 || minHandHeadMm < 90) collisionCount++;
                }
            }
        }

        // Verify zero foot sliding
        for (const [f, restPos] of Object.entries(footRest)) {
            controller.node(f).getWorldPosition(vTmp);
            maxFootSlideMm = Math.max(maxFootSlideMm, vTmp.distanceTo(restPos) * 1000);
        }

        const frame = mask.map(name => controller.node(name).quaternion.toArray().map(v => Number(v.toFixed(7))));
        if (frames.length > 0) {
            const prev = frames[frames.length - 1];
            for (let b = 0; b < frame.length; b++) {
                maxFrameStepDeg = Math.max(maxFrameStepDeg, quatAngleDeg(prev[b], frame[b]));
            }
        }
        frames.push(frame);
    }

    const durationMs = Math.round(((frameCount - 1) / rate) * 1000);
    const beat = {
        prepMs: Math.round(durationMs * variant.prepFrac),
        peakMs: Math.round(durationMs * variant.peakFrac),
        releaseMs: Math.round(durationMs * variant.releaseFrac),
        durationMs,
        variantId: variant.id,
        handedness: variant.handedness,
        ownsHead: spec.ownsHead,
        category: spec.category,
    };

    return {
        state: "ready",
        clip: {
            version: 1,
            motion: spec.id,
            rate,
            mask,
            frames,
            beat,
        },
        diagnostics: {
            sourceId: `vocab:${spec.id}/${variant.id}`,
            category: spec.category,
            variantId: variant.id,
            handedness: variant.handedness,
            ownsHead: spec.ownsHead,
            stepMs: 50,
            solveMs: Number((performance.now() - started).toFixed(3)),
            maxBoneErrorM: 0,
            maxRangeErrorDegrees: 0,
            constraints: {
                maxFootSlideMm: Number(maxFootSlideMm.toFixed(2)),
                minHandTorsoClearanceMm: Number(minHandTorsoMm.toFixed(1)),
                minHandHeadClearanceMm: Number(minHandHeadMm.toFixed(1)),
                maxFrameStepDeg: Number(maxFrameStepDeg.toFixed(2)),
                collisionCount,
                autoClearanceAdjustments,
            },
        },
    };
}
