import {
    Bone, Box3, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, HemisphereLight,
    FrontSide, Group, Matrix3, MeshBasicMaterial, MeshNormalMaterial, MeshStandardMaterial, OrthographicCamera,
    Scene, Skeleton, SkinnedMesh, SRGBColorSpace, TextureLoader, Uint16BufferAttribute, Vector3, WebGLRenderer,
} from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { readJson, encodeGlb, extractRest } from "./convert-kei-model-browser.mjs";
import { createFaceMixer } from "../../frontend/character/face.mjs";

const METER = 0.08;
const center = { hips: "下半身", spine: "上半身", chest: "上半身2", neck: "首", head: "頭", leftEye: "左目", rightEye: "右目" };
const lateral = { Shoulder: "肩", UpperArm: "腕", LowerArm: "ひじ", Hand: "手首", UpperLeg: "足", LowerLeg: "ひざ", Foot: "足首", Toes: "つま先" };
const fingers = { Thumb: "親指", Index: "人指", Middle: "中指", Ring: "薬指", Little: "小指" };
const expressions = {
    aa: "あ", ih: "い", ou: "う", ee: "え", oh: "お", blink: "まばたき", blinkLeft: "ウィンク", blinkRight: "ウィンク右",
};
// Calibrated against the matching coat's original Cubism expression captures.
// Brow offsets are in PMX units, lid amount is a fraction of the closed shape.
const profiles = {
    smallSmile: { source: "にこり", brow: [0.015, 0.012], lids: 0.09, mouth: [0, 0.09, 0.105, 0] },
    gentle: { source: "なごみ", brow: [0.023, -0.022], lids: 0.14, mouth: [0, 0.018, 0.059, 0] },
    happy: { source: "笑い", brow: [0.028, 0.018], lids: 1, lidStyle: "happy", mouth: [0, 0.11, 0.155, 0] },
    bashful: { source: "困る", brow: [-0.017, 0.025], lids: 0.12, mouth: [0.23, 0.19, 0.008, 0, 0.50] },
    surprised: { source: "びっくり", brow: [-0.028, 0.080], lids: -0.10, mouth: [0.72, 0.22, -0.006, 0.008, 0.49] },
    flustered: { source: "困る", brow: [-0.03, 0.056], lids: 0.04, mouth: [0.31, -0.055, -0.078, 0.002, 0.68] },
    sad: { source: "困る", brow: [0.09, -0.04], lids: 0.29, mouth: [0.04, -0.03, -0.075, 0] },
    serious: { source: "真面目", brow: [-0.11, 0.033], lids: 0.29, mouth: [0, -0.065, -0.047, 0] },
    thoughtful: { source: "じと目", brow: [0.018, -0.045], lids: 0.22, mouth: [0, -0.12, -0.020, 0] },
    shout: { source: "怒り", brow: [-0.12, 0.082], lids: 1, lidStyle: "shout", mouth: [1.04, 0.58, -0.038, 0, 0.39] },
    angry: { source: "怒り", brow: [-0.105, 0.075], lids: 0.18, mouth: [0.10, 0.02, -0.067, 0] },
    relaxed: { source: "なごみ", brow: [0.01, -0.05], lids: 0.42, mouth: [0.02, 0.01, 0.08, 0] },
    relieved: { source: "なごみ", brow: [0.045, -0.035], lids: 0.58, mouth: [0.25, 0.06, 0.107, 0, 0.52] },
    worried: { source: "困る", brow: [0.11, -0.065], lids: 0.19, mouth: [0.14, -0.10, -0.091, 0] },
    skeptical: { source: "じと目", brow: [0.062, -0.075], lids: 0.46, mouth: [0.03, -0.096, -0.048, 0] },
    eyesClosed: { source: "なごみ", brow: [0.014, -0.022], lids: 1, lidStyle: "blink", mouth: [0, 0, 0, 0] },
};
const faceMaterials = new Set(["head", "眼白", "口", "口舌", "睫眉", "眼睛", "眼珠"]);
const mouthShapes = {
    aa: [0.96, 0.28, 0, 0, 0.48], ih: [0.36, 0.19, 0.045, 0], ou: [0.58, -0.28, 0, 0.038],
    ee: [0.56, 0.14, 0.029, 0], oh: [0.82, -0.14, 0, 0.03], happy: [0.15, 0.12, 0.09, 0],
    sad: [0.08, 0, -0.040, 0], surprised: [0.43, -0.12, 0, 0.023],
};
const fromPmx = value => new Vector3(value[0], value[1], -value[2]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function pmxName(name) {
    if (Object.hasOwn(center, name)) return center[name];
    const [, side, part] = /^(left|right)(.+)$/.exec(name);
    const prefix = side === "left" ? "左" : "右";
    if (Object.hasOwn(lateral, part)) return prefix + lateral[part];
    const [, finger, joint] = /^(Thumb|Index|Middle|Ring|Little)(Metacarpal|Proximal|Intermediate|Distal)$/.exec(part);
    const fingerIndex = finger === "Thumb" ? ["Metacarpal", "Proximal", "Distal"].indexOf(joint) : ["Proximal", "Intermediate", "Distal"].indexOf(joint) + 1;
    return prefix + fingers[finger] + "０１２３"[fingerIndex];
}

function mouthDelta(shape, material, [x, y, z]) {
    if (!shape || !["head", "口", "口舌"].includes(material)) return new Vector3();
    const [opening, width, curl, pucker, arcPower] = shape;
    const dx = Math.abs(x);
    // The closed PMX seam rises at the corners. Classifying every vertex with
    // the centre seam puts the outer lower-lip vertices in the upper lip.
    const seam = 15.7184 + (arcPower === undefined ? 0 : 0.72 * Math.min(dx, 0.16) ** 2);
    const face = Math.max(0, 1 - (dx / 0.45) ** 2);
    const vertical = Math.max(0, 1 - Math.abs(y - seam) / 0.25);
    const frontal = material === "head" ? Math.max(0, Math.min(1, (-z - 0.71) / 0.22)) : 1;
    const local = face * vertical * frontal;
    const upper = Math.max(-1, Math.min(1, (y - seam) / 0.003));
    const part = material === "口舌" ? 0.68 : 1;
    const upDown = upper >= 0 ? upper * 0.095 : upper * (arcPower === undefined ? 0.151 : 0.115);
    const corner = Math.min(1, (dx / 0.27) ** 2);
    const aperture = arcPower === undefined ? 1 - 0.68 * corner :
        Math.pow(Math.max(0, 1 - (dx / 0.163) ** 2), arcPower);
    return new Vector3(x * width, (opening * upDown * aperture + curl * corner) * part, pucker)
        .multiplyScalar(local * METER);
}

// Piecewise-linear interpolation helper along sorted [x, val] samples
function interpCurve(samples, x) {
    if (x <= samples[0][0]) return samples[0][1];
    const last = samples.length - 1;
    if (x >= samples[last][0]) return samples[last][1];
    for (let i = 0; i < last; i++) {
        const [x0, v0] = samples[i];
        const [x1, v1] = samples[i + 1];
        if (x >= x0 && x <= x1) {
            const t = (x - x0) / (x1 - x0 || 1);
            return v0 + (v1 - v0) * t;
        }
    }
    return samples[last][1];
}

// Build exact topological eye rig data directly from the PMX mesh
function buildEyeRig(pmx) {
    const headMat = pmx.materials.find(m => m.name === "head");
    const lashMat = pmx.materials.find(m => m.name === "睫眉");
    if (!headMat || !lashMat) throw new Error("Kei PMX head and lash materials are required");
    const headTris = [];
    const edgeCount = new Map();
    const headAdj = new Map();
    const headVertSet = new Set();

    for (let i = headMat.start; i < headMat.start + headMat.count; i += 3) {
        const a = pmx.indices[i], b = pmx.indices[i + 1], c = pmx.indices[i + 2];
        headTris.push([a, b, c]);
        headVertSet.add(a); headVertSet.add(b); headVertSet.add(c);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const key = u < v ? `${u}_${v}` : `${v}_${u}`;
            edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
            if (!headAdj.has(u)) headAdj.set(u, new Set());
            if (!headAdj.has(v)) headAdj.set(v, new Set());
            headAdj.get(u).add(v);
            headAdj.get(v).add(u);
        }
    }

    const bAdj = new Map();
    for (const [key, cnt] of edgeCount) {
        if (cnt === 1) {
            const [u, v] = key.split("_").map(Number);
            if (!bAdj.has(u)) bAdj.set(u, []);
            if (!bAdj.has(v)) bAdj.set(v, []);
            bAdj.get(u).push(v);
            bAdj.get(v).push(u);
        }
    }

    // Identify right (x > 0) and left (x < 0) eye opening boundary loops
    function extractEyeLoop(sign) {
        const eyeB = [...bAdj.keys()].filter(v => {
            const [x, y, z] = pmx.vertices[v];
            return x * sign > 0.05 && y >= 16.0 && y <= 16.7 && z < -0.4;
        });
        const eyeSet = new Set(eyeB);
        const start = eyeB.reduce((best, v) => Math.abs(pmx.vertices[v][0]) < Math.abs(pmx.vertices[best][0]) ? v : best, eyeB[0]);
        const loop = [start];
        const seen = new Set([start]);
        let cur = start;
        while (true) {
            const nexts = (bAdj.get(cur) ?? []).filter(n => eyeSet.has(n) && !seen.has(n));
            if (!nexts.length) break;
            cur = nexts[0];
            loop.push(cur);
            seen.add(cur);
        }
        if (loop.length !== 24 || !(bAdj.get(loop.at(-1)) ?? []).includes(start) ||
            loop.some(vertex => (bAdj.get(vertex) ?? []).filter(neighbor => seen.has(neighbor)).length !== 2)) {
            throw new Error("Unexpected Kei PMX eyelid topology");
        }
        return loop;
    }

    const rightLoop = extractEyeLoop(+1);
    const leftLoop = extractEyeLoop(-1);

    // Split a loop into upper and lower curves (indexed by |x|)
    // Inner corner: smallest |x|; Outer corner: vertex with largest |x| on lower side (or y <= 16.41 & |x| > 0.84)
    const rightInner = rightLoop.reduce((a, b) => pmx.vertices[a][0] < pmx.vertices[b][0] ? a : b);
    const rightOuterTip = rightLoop.reduce((a, b) => pmx.vertices[a][0] > pmx.vertices[b][0] ? a : b);
    const rightOuterCorner = rightLoop.filter(v => pmx.vertices[v][0] > 0.84 && v !== rightOuterTip)
        .reduce((a, b) => pmx.vertices[a][0] > pmx.vertices[b][0] ? a : b);

    const sideMin = pmx.vertices[rightInner][0]; // ~0.2868
    const sideOuterCorner = pmx.vertices[rightOuterCorner][0]; // ~0.8542
    const sideMax = pmx.vertices[rightOuterTip][0]; // ~0.8642

    // Build upper and lower reference curves from rightLoop
    const midY = 16.34;
    const upperSamples = [];
    const lowerSamples = [];
    for (const v of rightLoop) {
        const [x, y, z] = pmx.vertices[v];
        if (v === rightInner) {
            upperSamples.push([x, y, z]);
            lowerSamples.push([x, y, z]);
        } else if (v === rightOuterCorner) {
            lowerSamples.push([x, y, z]);
        } else if (v === rightOuterTip) {
            upperSamples.push([x, y, z]);
        } else if (y > midY) {
            upperSamples.push([x, y, z]);
        } else {
            lowerSamples.push([x, y, z]);
        }
    }
    upperSamples.sort((a, b) => a[0] - b[0]);
    lowerSamples.sort((a, b) => a[0] - b[0]);

    const upperYCurve = upperSamples.map(([x, y]) => [x, y]);
    const upperZCurve = upperSamples.map(([x, , z]) => [x, z]);
    const lowerYCurve = lowerSamples.map(([x, y]) => [x, y]);
    const lowerZCurve = lowerSamples.map(([x, , z]) => [x, z]);

    // Determine topological ring distances around each eye loop (0..3)
    function computeRings(loop) {
        const ring = new Map();
        const q = [];
        for (const v of loop) { ring.set(v, 0); q.push(v); }
        for (let qi = 0; qi < q.length; qi++) {
            const u = q[qi];
            const d = ring.get(u);
            if (d >= 3) continue;
            for (const nb of headAdj.get(u) ?? []) {
                if (!ring.has(nb)) { ring.set(nb, d + 1); q.push(nb); }
            }
        }
        return ring;
    }

    const rightRing = computeRings(rightLoop);
    const leftRing = computeRings(leftLoop);

    // Precompute upper and lower rim normal lookup tables for continuous linear seam welding
    function buildRimPartition(loop) {
        const upper = [];
        const lower = [];
        for (const v of loop) {
            const [x, y] = pmx.vertices[v];
            const ax = Math.abs(x);
            if (ax < sideMin + 0.002) { upper.push(v); lower.push(v); }
            else if (y > 16.365) upper.push(v);
            else lower.push(v);
        }
        upper.sort((a, b) => Math.abs(pmx.vertices[a][0]) - Math.abs(pmx.vertices[b][0]));
        lower.sort((a, b) => Math.abs(pmx.vertices[a][0]) - Math.abs(pmx.vertices[b][0]));
        return { upper, lower, upperSet: new Set(upper), lowerSet: new Set(lower) };
    }

    const rightPartition = buildRimPartition(rightLoop);
    const leftPartition = buildRimPartition(leftLoop);

    // Classify every 睫眉 vertex by connected component!
    const lashAdj = new Map();
    const lashVerts = new Set();
    for (let i = lashMat.start; i < lashMat.start + lashMat.count; i += 3) {
        const a = pmx.indices[i], b = pmx.indices[i + 1], c = pmx.indices[i + 2];
        lashVerts.add(a); lashVerts.add(b); lashVerts.add(c);
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            if (!lashAdj.has(u)) lashAdj.set(u, new Set());
            if (!lashAdj.has(v)) lashAdj.set(v, new Set());
            lashAdj.get(u).add(v); lashAdj.get(v).add(u);
        }
    }
    const lashRole = new Map(); // vertexIndex -> "EYEBROW" | "MAIN_UPPER_LASH" | "UPPER_OUTER_TUFT" | "OUTER_CORNER_LASH" | "DOUBLE_EYELID_CREASE" | "LOWER_LASH"
    const vis = new Set();
    const mainUpperLashRight = [];
    for (const v of lashVerts) {
        if (vis.has(v)) continue;
        const comp = [];
        const q = [v]; vis.add(v);
        for (let qi = 0; qi < q.length; qi++) {
            comp.push(q[qi]);
            for (const nb of lashAdj.get(q[qi]) ?? []) if (!vis.has(nb)) { vis.add(nb); q.push(nb); }
        }
        const axList = comp.map(i => Math.abs(pmx.vertices[i][0]));
        const yList = comp.map(i => pmx.vertices[i][1]);
        const minAx = Math.min(...axList), maxAx = Math.max(...axList);
        const minY = Math.min(...yList), maxY = Math.max(...yList);
        let role = "MAIN_UPPER_LASH";
        if (minY > 16.65) role = "EYEBROW";
        else if (maxY < 16.27) role = "LOWER_LASH";
        else if (minAx > 0.78 && minY < 16.35) role = "OUTER_CORNER_LASH";
        else if (minAx > 0.68 && maxAx < 0.87 && minY > 16.53) role = "UPPER_OUTER_TUFT";
        else if (maxAx < 0.72 && minY > 16.50) role = "DOUBLE_EYELID_CREASE";
        for (const i of comp) {
            lashRole.set(i, role);
            if (role === "MAIN_UPPER_LASH" && pmx.vertices[i][0] > 0) mainUpperLashRight.push(i);
        }
    }

    // Smooth lower-edge reference curve of MAIN_UPPER_LASH (monotonic & noise-free from inner tip to outer wing)
    const lashBaseYCurve = [
        [0.2675, 16.3809], [0.3100, 16.4094], [0.3597, 16.4385], [0.4195, 16.4658],
        [0.4884, 16.4849], [0.5698, 16.4969], [0.6645, 16.5017], [0.7491, 16.4942],
        [0.8203, 16.4710], [0.8949, 16.4433], [0.9534, 16.4382], [1.0358, 16.4801], [1.1021, 16.5181],
    ];

    // Smooth closed seam curve functions (in PMX coordinates!)
    function seamY(side, style = "blink") {
        const u = clamp((side - sideMin) / (sideOuterCorner - sideMin), 0, 1);
        const wing = Math.max(0, (side - sideOuterCorner) / (1.102 - sideOuterCorner));
        const inner = Math.max(0, sideMin - side);
        if (style === "happy") {
            const base = 16.316 + 0.072 * Math.sin(Math.PI * u) + 0.032 * u;
            return base + 0.026 * wing - 0.12 * inner;
        }
        if (style === "shout") {
            const base = 16.298 + 0.022 * Math.sin(Math.PI * u) + 0.068 * u * u;
            return base + 0.038 * wing - 0.05 * inner;
        }
        // "blink" / "eyesClosed": calm, soft gentle downward-resting anime curve
        const base = 16.308 - 0.020 * Math.sin(Math.PI * u) + 0.046 * u * u;
        return base + 0.014 * wing - 0.05 * inner;
    }

    function seamZ(side) {
        const s = clamp(side, sideMin, sideOuterCorner);
        const u = clamp((s - sideMin) / (sideOuterCorner - sideMin), 0, 1);
        const zu = interpCurve(upperZCurve, s);
        const zl = interpCurve(lowerZCurve, s);
        // Smooth convex dome hugging the upper eyelid & clearing the entire iris cleanly
        let z = 0.78 * zu + 0.22 * zl - 0.008 * Math.sin(Math.PI * u);
        if (side < sideMin) {
            // Smoothly follow nasal bridge forward slope so inner lash tip never clips into nose skin
            z -= (sideMin - side) * 1.15;
        } else if (side > sideOuterCorner) {
            // Smoothly follow temple curvature for outer eyelash wing
            const dzdx = (interpCurve(upperZCurve, sideMax) - interpCurve(upperZCurve, 0.78)) / (sideMax - 0.78);
            z += dzdx * (side - sideOuterCorner) * 0.55;
        }
        return z;
    }

    // Compute exact PMX-space (dx, dy, dz) for EVERY affected head vertex for a given side & style
    function computeHeadEyeOffsets(sign, style) {
        const ringMap = sign > 0 ? rightRing : leftRing;
        const offsets = new Map(); // vertexIndex -> [dx, dy, dz] in PMX space

        // Ring 0: EVERY boundary vertex lands 100% EXACTLY on the 3D seam curve (water-tight seal!)
        for (const [v, r] of ringMap) {
            if (r !== 0) continue;
            const [x, y, z] = pmx.vertices[v];
            const ax = Math.abs(x);
            // Pull outer upper overhang tip (|x|=0.8642) cleanly onto outer corner (|x|=0.8542) so corner seals to a point
            const targetAx = ax > sideOuterCorner ? sideOuterCorner : ax;
            const targetX = sign * targetAx;
            const targetY = seamY(targetAx, style);
            const targetZ = seamZ(targetAx);
            offsets.set(v, [targetX - x, targetY - y, targetZ - z]);
        }

        // Ring 1: smooth topological follow from Ring 0 neighbors
        for (const [v, r] of ringMap) {
            if (r !== 1) continue;
            const [x, y, z] = pmx.vertices[v];
            const r0Nbs = [...(headAdj.get(v) ?? [])].filter(n => ringMap.get(n) === 0);
            if (!r0Nbs.length) continue;
            let sx = 0, sy = 0, sz = 0;
            for (const n of r0Nbs) {
                const d = offsets.get(n);
                sx += d[0]; sy += d[1]; sz += d[2];
            }
            sx /= r0Nbs.length; sy /= r0Nbs.length; sz /= r0Nbs.length;
            const isUpper = y > seamY(Math.abs(x), style);
            // Upper lid skin follows smoothly (~0.40) so lid stretches gently without pinching brow;
            // lower lid/cheek follows softer (~0.24, or ~0.34 for happy cheek lift!)
            const yWeight = isUpper ? 0.38 : (style === "happy" ? 0.36 : 0.22);
            const zWeight = isUpper ? 0.25 : 0.35;
            const xWeight = 0.25;
            offsets.set(v, [sx * xWeight, sy * yWeight, sz * zWeight]);
        }

        // Ring 2: gentle wide feathering so skin transitions seamlessly to brow/cheek/nose
        for (const [v, r] of ringMap) {
            if (r !== 2) continue;
            const [x, y, z] = pmx.vertices[v];
            const ax = Math.abs(x);
            const r1Nbs = [...(headAdj.get(v) ?? [])].filter(n => ringMap.get(n) === 1 && offsets.has(n));
            if (!r1Nbs.length) continue;
            let sx = 0, sy = 0, sz = 0;
            for (const n of r1Nbs) {
                const d = offsets.get(n);
                sx += d[0]; sy += d[1]; sz += d[2];
            }
            sx /= r1Nbs.length; sy /= r1Nbs.length; sz /= r1Nbs.length;
            // Taper to 0 near nose bridge and brow ridge
            const nasalFade = clamp((ax - 0.16) / 0.12, 0, 1);
            const browFade = y > 16.65 ? clamp((16.82 - y) / 0.17, 0, 1) : 1;
            const w = 0.26 * nasalFade * browFade;
            offsets.set(v, [sx * w, sy * w, sz * w * 0.5]);
        }

        return offsets;
    }

    const headOffsetsCache = new Map();
    function getHeadOffsets(mode, style) {
        const key = `${mode}:${style}`;
        if (headOffsetsCache.has(key)) return headOffsetsCache.get(key);
        const merged = new Map();
        if (mode === "blink" || mode === "blinkRight") {
            for (const [v, d] of computeHeadEyeOffsets(+1, style)) merged.set(v, d);
        }
        if (mode === "blink" || mode === "blinkLeft") {
            for (const [v, d] of computeHeadEyeOffsets(-1, style)) merged.set(v, d);
        }
        headOffsetsCache.set(key, merged);
        return merged;
    }

    // Compute smooth welded closed-pose vertex normals for head material (in VRM space!)
    function computeHeadClosedNormalDeltas(mode, style, baseVrmNormals, scale = 1) {
        const deltaArray = new Float32Array(pmx.vertices.length * 3);
        if (scale <= 0) return deltaArray; // Widening eyes (surprised lids < 0) keeps open-eye rim normals untouched
        const offsets = getHeadOffsets(mode, style);

        // Compute deformed VRM positions for head vertices at full closure (scale=1)
        const defPos = new Map();
        for (const v of headVertSet) {
            const p = pmx.vertices[v];
            const d = offsets.get(v) ?? [0, 0, 0];
            // VRM space: (x, y, -z) * METER
            defPos.set(v, new Vector3((p[0] + d[0]) * METER, (p[1] + d[1]) * METER, -(p[2] + d[2]) * METER));
        }

        // Area-weighted face normals on deformed head mesh
        // Note: convert-kei-pmx flips triangle winding (i+1, i+2) for VRM right-handed space!
        const accum = new Map();
        for (const v of headVertSet) accum.set(v, new Vector3());
        const e1 = new Vector3(), e2 = new Vector3(), fn = new Vector3();
        for (const [a, b, c] of headTris) {
            // Winding in VRM geometry is (a, c, b)
            const pa = defPos.get(a), pb = defPos.get(c), pc = defPos.get(b);
            e1.subVectors(pb, pa);
            e2.subVectors(pc, pa);
            fn.crossVectors(e1, e2); // area-weighted normal
            accum.get(a).add(fn);
            accum.get(c).add(fn);
            accum.get(b).add(fn);
        }
        const closedNorm = new Map();
        for (const [v, n] of accum) {
            closedNorm.set(v, n.lengthSq() > 1e-18 ? n.clone().normalize() : baseVrmNormals[v].clone());
        }

        // Weld normals continuously across upper & lower Ring 0 boundary using linear X interpolation!
        const activeSides = [];
        if (mode === "blink" || mode === "blinkRight") activeSides.push([rightRing, rightPartition]);
        if (mode === "blink" || mode === "blinkLeft") activeSides.push([leftRing, leftPartition]);

        function sampleRimNormal(rimVerts, ax) {
            const nxS = rimVerts.map(u => [Math.abs(pmx.vertices[u][0]), closedNorm.get(u).x]);
            const nyS = rimVerts.map(u => [Math.abs(pmx.vertices[u][0]), closedNorm.get(u).y]);
            const nzS = rimVerts.map(u => [Math.abs(pmx.vertices[u][0]), closedNorm.get(u).z]);
            return new Vector3(interpCurve(nxS, ax), interpCurve(nyS, ax), interpCurve(nzS, ax)).normalize();
        }

        for (const [ringMap, part] of activeSides) {
            // Pass 1: Weld Ring 0 upper <-> lower normals via continuous linear interpolation along |x|
            const welded = new Map();
            for (const [v, r] of ringMap) {
                if (r !== 0) continue;
                const ax = Math.abs(pmx.vertices[v][0]);
                const nUpper = sampleRimNormal(part.upper, ax);
                const nLower = sampleRimNormal(part.lower, ax);
                welded.set(v, nUpper.add(nLower).normalize());
            }
            for (const [v, n] of welded) closedNorm.set(v, n);

            // Pass 2..4: Smooth Laplacian diffusion across Ring 0 and Ring 1 anchored to Ring 2+
            for (let iter = 0; iter < 3; iter++) {
                const next = new Map();
                for (const [v, r] of ringMap) {
                    if (r > 1) continue;
                    const nbs = [...(headAdj.get(v) ?? [])];
                    const avg = closedNorm.get(v).clone().multiplyScalar(1.2);
                    for (const nb of nbs) avg.add(closedNorm.get(nb));
                    if (r === 0) {
                        const ax = Math.abs(pmx.vertices[v][0]);
                        const oppRim = part.upperSet.has(v) ? part.lower : part.upper;
                        avg.add(sampleRimNormal(oppRim, ax).multiplyScalar(1.6));
                    }
                    next.set(v, avg.normalize());
                }
                for (const [v, n] of next) closedNorm.set(v, n);
            }

            // Final exact seam lock so upper & lower Ring 0 share the exact same continuous normal curve
            const locked = new Map();
            for (const [v, r] of ringMap) {
                if (r !== 0) continue;
                const ax = Math.abs(pmx.vertices[v][0]);
                locked.set(v, sampleRimNormal(part.upper, ax).add(sampleRimNormal(part.lower, ax)).normalize());
            }
            for (const [v, n] of locked) closedNorm.set(v, n);

            // Write normal deltas ONLY for Ring 0, Ring 1, and feathered Ring 2 (so rest of face stays 100% original!)
            for (const [v, r] of ringMap) {
                if (r > 2) continue;
                const blend = r === 0 ? 1.0 : r === 1 ? 0.88 : 0.38;
                const targetN = baseVrmNormals[v].clone().lerp(closedNorm.get(v), blend).normalize();
                const dn = targetN.sub(baseVrmNormals[v]).multiplyScalar(scale);
                dn.toArray(deltaArray, v * 3);
            }
        }
        return deltaArray;
    }

    // Per-vertex position delta (in VRM space!) for eye morphs
    function eyePositionDelta(mode, style, targetIdx, material, [x, y, z]) {
        if (!["blink", "blinkLeft", "blinkRight"].includes(mode)) return null;
        if (mode === "blinkLeft" && x >= 0) return new Vector3();
        if (mode === "blinkRight" && x <= 0) return new Vector3();
        const side = Math.abs(x);

        if (material === "head") {
            const offsets = getHeadOffsets(mode, style);
            const d = offsets.get(targetIdx);
            if (!d) return new Vector3();
            // Convert PMX offset (dx, dy, dz) to VRM offset (dx, dy, -dz) * METER
            return new Vector3(d[0] * METER, d[1] * METER, -d[2] * METER);
        }

        if (material === "眼白") {
            // Pull sclera cup safely backward behind the closed eyelid (zero poke-through from front & 3/4 views!)
            const sy = seamY(side, style);
            const sz = seamZ(side);
            const minBackZ = sz + 0.095;
            const dzPmx = Math.max(0.06, minBackZ - z);
            const frontness = clamp((-z - 0.55) / 0.30, 0, 1);
            const dyPmx = (sy - y) * 0.45 * frontness;
            return new Vector3(0, dyPmx * METER, -dzPmx * METER);
        }

        if (material === "眼睛" || material === "眼珠") {
            // Keep the pink concentric iris UNDISTORTED (no vertical pancake squashing on half-closed eyes!)
            // Just recess gently backward in Z so it stays safely behind the closed eyelid at every angle!
            const dzPmx = 0.065;
            return new Vector3(0, 0, -dzPmx * METER);
        }

        if (material === "睫眉") {
            const role = lashRole.get(targetIdx);
            if (role === "EYEBROW") return new Vector3(); // NEVER pull eyebrows down during blink!
            const sy = seamY(side, style);
            const sz = seamZ(side);
            const openUpY = interpCurve(upperYCurve, clamp(side, sideMin, sideMax));
            const lashBotY = interpCurve(lashBaseYCurve, side);
            const innerTaper = clamp((side - 0.268) / 0.085, 0, 1);
            const outerTaper = clamp((1.105 - side) / 0.14, 0.25, 1);

            if (role === "MAIN_UPPER_LASH") {
                // Measure height from the lash's OWN bottom edge so the inner tip tapers cleanly with zero hook!
                const h = Math.max(0, y - lashBotY);
                const thicknessKeep = (style === "happy" ? 0.34 : 0.30) * (0.25 + 0.75 * innerTaper) * outerTaper;
                const targetY = sy + h * thicknessKeep;
                const baseZ = interpCurve(upperZCurve, clamp(side, sideMin, sideMax));
                const relief = clamp(z - baseZ, -0.055, 0.02);
                const targetZ = sz - 0.020 + relief * 0.40;
                return new Vector3(0, (targetY - y) * METER, -(targetZ - z) * METER);
            }

            if (role === "UPPER_OUTER_TUFT") {
                const h = Math.max(0, y - lashBotY);
                const targetY = sy + h * 0.30;
                const targetZ = sz - 0.024;
                return new Vector3(0, (targetY - y) * METER, -(targetZ - z) * METER);
            }

            if (role === "OUTER_CORNER_LASH") {
                // Keep outer corner lash cleanly flush with/above the seam baseline (no underside notch!)
                const h = Math.max(0, y - 16.34);
                const targetY = sy + h * 0.22;
                const targetZ = sz - 0.014;
                return new Vector3(0, (targetY - y) * METER, -(targetZ - z) * METER);
            }

            if (role === "DOUBLE_EYELID_CREASE") {
                // Smoothly descends with lid during half-blink, tucks deeply & invisibly inside head at full blink
                const targetY = sy + 0.005;
                const targetZ = sz + 0.045;
                return new Vector3(0, (targetY - y) * METER, -(targetZ - z) * METER);
            }

            if (role === "LOWER_LASH") {
                // Pull tiny lower lash ticks smoothly into the closed seam and tuck cleanly behind upper lash
                const targetY = sy;
                const targetZ = sz + 0.022;
                return new Vector3(0, (targetY - y) * METER, -(targetZ - z) * METER);
            }
        }

        return new Vector3();
    }

    return {
        lashRole,
        eyePositionDelta,
        computeHeadClosedNormalDeltas,
        rightLoop,
        leftLoop,
        seamY,
        seamZ,
    };
}

function browDelta(eyeRig, profile, targetIdx, material, [x], authored) {
    if (material !== "睫眉" || eyeRig.lashRole.get(targetIdx) !== "EYEBROW") return new Vector3();
    const outward = Math.max(0, Math.min(1, (Math.abs(x) - 0.22) / 0.66));
    const [inner, outer] = profile.brow;
    const skew = profile.source === "じと目" && x < 0 ? -0.02 : 0;
    return authored.multiplyScalar(0.32).add(new Vector3(0, (inner + (outer - inner) * outward + skew) * METER, 0));
}

function transferFace(geometry, pmx, positions, reference) {
    const fbx = new FBXLoader().parse(reference, "");
    fbx.scale.multiplyScalar(0.01);
    fbx.updateMatrixWorld(true);
    const src = fbx.getObjectByName("face");
    const sourcePositions = src.geometry.getAttribute("position");
    const sourceUv = src.geometry.getAttribute("uv");
    const frame = new Matrix3().setFromMatrix4(src.matrixWorld);
    const sourceHead = fbx.getObjectByName("Head").getWorldPosition(new Vector3());
    const pmxHead = positions[pmx.bones.findIndex(bone => bone.name === "頭")];
    const align = pmxHead.clone().sub(sourceHead);
    const points = Array.from({ length: sourcePositions.count }, (_, i) =>
        new Vector3().fromBufferAttribute(sourcePositions, i).applyMatrix4(src.matrixWorld).add(align));
    const groups = new Map();
    for (const group of src.geometry.groups) {
        const name = src.material[group.materialIndex].name;
        if (!groups.has(name)) groups.set(name, []);
        const groupIndices = groups.get(name);
        for (let i = group.start; i < group.start + group.count; i++) groupIndices.push(src.geometry.index?.getX(i) ?? i);
    }
    const candidates = new Map();
    for (const material of pmx.materials.filter(item => faceMaterials.has(item.name))) {
        for (let i = material.start; i < material.start + material.count; i++) {
            const vi = pmx.indices[i];
            if (!candidates.has(vi)) candidates.set(vi, material.name);
        }
    }
    const matches = new Map();
    const dist = [];
    for (const [target, material] of candidates) {
        const point = new Vector3().fromBufferAttribute(geometry.getAttribute("position"), target);
        const [u, v] = pmx.uvs[target];
        let min = Infinity, index;
        for (const j of groups.get(material) ?? []) {
            const uvx = u - sourceUv.getX(j), uvy = v - (1 - sourceUv.getY(j));
            const positional = point.distanceToSquared(points[j]);
            const score = positional + (uvx * uvx + uvy * uvy) * 0.023;
            if (score < min) { min = score; index = j; }
        }
        if (index !== undefined && point.distanceTo(points[index]) < 0.015) {
            matches.set(target, index);
            dist.push(point.distanceTo(points[index]));
        }
    }

    const eyeRig = buildEyeRig(pmx);
    const baseVrmNormals = pmx.normals.map(value => fromPmx(value).normalize());
    // Share one single Float32BufferAttribute across all zero-normal morphs so GLTFExporter caches and embeds it once!
    const zeroNormalAttr = new Float32BufferAttribute(new Float32Array(pmx.vertices.length * 3), 3);
    const sharedNormalAttrs = new Map();

    const applied = {};
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [];
    geometry.morphAttributes.normal = [];

    function writeMorph(name, source, deltaFor, normalAttr = null) {
        const srcAttr = src.geometry.morphAttributes.position[src.morphTargetDictionary[source]];
        if (!srcAttr) throw new Error("FBX morph missing: " + source);
        const output = new Float32Array(pmx.vertices.length * 3);
        let moved = 0, sourceMoved = 0, maxMeters = 0;
        for (const [target, material] of candidates) {
            const origin = matches.get(target);
            const fbxDelta = origin === undefined ? new Vector3() : new Vector3().fromBufferAttribute(srcAttr, origin).applyMatrix3(frame);
            if (fbxDelta.length() > 0.00005) sourceMoved++;
            const delta = deltaFor(target, material, pmx.vertices[target], fbxDelta);
            if (delta.length() > 0.00005) moved++;
            maxMeters = Math.max(maxMeters, delta.length());
            delta.toArray(output, target * 3);
        }
        if (moved < 3) throw new Error("Facial morph has too few usable PMX vertices: " + name);
        const normAttr = normalAttr ?? zeroNormalAttr;
        let normalMoved = 0;
        if (normAttr !== zeroNormalAttr) {
            const arr = normAttr.array;
            for (let i = 0; i < arr.length; i += 3) {
                if (Math.hypot(arr[i], arr[i + 1], arr[i + 2]) > 0.001) normalMoved++;
            }
        }
        applied[name] = { source: sourceMoved ? source : null, moved, normalMoved, maxMeters };
        const posAttr = new Float32BufferAttribute(output, 3);
        posAttr.name = name;
        geometry.morphAttributes.position.push(posAttr);
        geometry.morphAttributes.normal.push(normAttr);
    }

    function getNormalAttr(mode, style, scale) {
        if (scale < 0.16) return zeroNormalAttr;
        const key = `${mode}:${style}:${scale.toFixed(3)}`;
        if (!sharedNormalAttrs.has(key)) {
            const attr = new Float32BufferAttribute(eyeRig.computeHeadClosedNormalDeltas(mode, style, baseVrmNormals, scale), 3);
            attr.name = key;
            sharedNormalAttrs.set(key, attr);
        }
        return sharedNormalAttrs.get(key);
    }

    for (const [name, source] of Object.entries(expressions)) {
        const isEyeMorph = ["blink", "blinkLeft", "blinkRight"].includes(name);
        const normalAttr = isEyeMorph ? getNormalAttr(name, "blink", 1) : zeroNormalAttr;
        writeMorph(name, source, (target, material, vertex, original) => {
            if (isEyeMorph) return eyeRig.eyePositionDelta(name, "blink", target, material, vertex);
            return (name === "aa" ? new Vector3() : original).add(mouthDelta(mouthShapes[name], material, vertex));
        }, normalAttr);
    }

    for (const [name, profile] of Object.entries(profiles)) {
        writeMorph(name, profile.source, (target, material, vertex, original) =>
            browDelta(eyeRig, profile, target, material, vertex, original), zeroNormalAttr);
        const lidStyle = profile.lidStyle ?? "blink";
        const lidNormAttr = getNormalAttr("blink", lidStyle, profile.lids);
        writeMorph("keiLids." + name, "まばたき", (target, material, vertex) =>
            eyeRig.eyePositionDelta("blink", lidStyle, target, material, vertex).multiplyScalar(profile.lids), lidNormAttr);
        if (profile.mouth.some(Boolean)) {
            writeMorph("keiLips." + name, profile.source, (target, material, vertex) => mouthDelta(profile.mouth, material, vertex), zeroNormalAttr);
        }
    }

    dist.sort((a, b) => a - b);
    return { candidates: candidates.size, matched: matches.size, medianMeters: dist[Math.floor(dist.length / 2)],
        p95Meters: dist[Math.floor(dist.length * 0.95)], morphs: applied };
}

let model, room, graphics, camera, comparisonMixer;

window.convert = async () => {
    const [pmx, profile, reference] = await Promise.all([
        readJson("/pmx-geometry.json"), readJson("/skeleton.json"), fetch("/input.fbx").then(response => response.arrayBuffer()),
    ]);
    const canonical = Object.fromEntries(profile.bone_order.map(name => [name, pmxName(name)]));
    const ids = new Map(pmx.bones.map((bone, i) => [bone.name, i]));
    const names = new Map(Object.entries(canonical).map(([name, original]) => [ids.get(original), name]));
    if (names.has(undefined) || names.size !== profile.bone_order.length) throw new Error("Canonical PMX mapping is incomplete");
    const ground = pmx.vertices.reduce((min, vertex) => Math.min(min, vertex[1] * METER), Infinity);
    const meters = values => fromPmx(values).multiplyScalar(METER).sub(new Vector3(0, ground, 0));
    const positions = pmx.bones.map(bone => meters(bone.position));
    const root = new Group();
    const bones = positions.map((position, i) => {
        const bone = new Bone();
        bone.name = pmx.bones[i].name;
        if (names.has(i)) bone.userData.humanoid = names.get(i);
        return bone;
    });
    bones.forEach((bone, i) => {
        const parentIndex = i === ids.get(canonical.spine) ? ids.get(canonical.hips) : pmx.bones[i].parent;
        (bones[parentIndex] ?? root).add(bone);
        bone.position.copy(positions[i]);
        if (parentIndex >= 0) bone.position.sub(positions[parentIndex]);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(pmx.vertices.flatMap(value => meters(value).toArray()), 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(pmx.normals.flatMap(value => fromPmx(value).normalize().toArray()), 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(pmx.uvs.flat(), 2));
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute(pmx.joints.flat(), 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(pmx.weights.flat(), 4));
    const indices = pmx.indices.slice();
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    geometry.setIndex(indices);
    pmx.materials.forEach((material, i) => geometry.addGroup(material.start, material.count, i));
    const transferred = transferFace(geometry, pmx, positions, reference);

    const loader = new TextureLoader();
    const images = new Map();
    const materialNames = new Map();
    const materials = await Promise.all(pmx.materials.map(async item => {
        materialNames.set(item.name, item);
        if (item.texture && !images.has(item.texture)) {
            images.set(item.texture, loader.loadAsync("/texture/" + encodeURIComponent(item.texture.split("/").at(-1))).then(image => {
                image.flipY = false;
                image.colorSpace = SRGBColorSpace;
                return image;
            }));
        }
        const map = item.texture ? await images.get(item.texture) : null;
        return new MeshStandardMaterial({
            name: item.name, color: new Color().fromArray(item.diffuse), opacity: item.diffuse[3], map, roughness: 0.95, metalness: 0,
            side: item.flags & 1 ? DoubleSide : FrontSide, alphaTest: 0.09,
        });
    }));
    const mesh = new SkinnedMesh(geometry, materials);
    mesh.name = "Kei PMX surface";
    root.add(mesh);
    root.updateMatrixWorld(true);
    mesh.normalizeSkinWeights();
    mesh.bind(new Skeleton(bones));
    const exported = await new GLTFExporter().parseAsync(root, { binary: true, trs: true, maxTextureSize: 2048 });
    const jsonSize = new DataView(exported).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(exported, 20, jsonSize)));
    const humanBones = {};
    let surfaceIndex;
    json.nodes.forEach((node, index) => {
        if (node.extras?.humanoid) {
            humanBones[node.extras.humanoid] = { node: index };
            delete node.extras.humanoid;
        }
        if (node.name === mesh.name) surfaceIndex = index;
    });
    const morphs = geometry.morphAttributes.position.map(attribute => attribute.name);
    const preset = {};
    const custom = {};
    const standard = new Set([...Object.keys(expressions), "happy", "angry", "sad", "relaxed", "surprised"]);
    morphs.forEach((name, index) => {
        (standard.has(name) ? preset : custom)[name] = { morphTargetBinds: [{ node: surfaceIndex, index, weight: 1 }] };
    });
    const range = { inputMaxValue: 90, outputScale: 12 };
    json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "VRMC_vrm", "VRMC_materials_mtoon"])];
    json.extensions = {
        ...json.extensions, VRMC_vrm: {
            specVersion: "1.0",
            meta: {
                name: "Kei (private PMX expression rebuild r16)", version: "local-pmx-4", authors: ["阿琳剑圣", "银月风尘"],
                copyrightInformation: "Local noncommercial conversion from Kei PMX and FBX. Original PMX terms apply. No redistribution.",
                licenseUrl: "https://vrm.dev/licenses/1.0/",
                avatarPermission: "onlySeparatelyLicensedPerson", commercialUsage: "personalNonProfit", allowRedistribution: false,
                modification: "allowModification", creditNotation: "required",
            },
            humanoid: { humanBones },
            lookAt: { type: "bone", offsetFromHeadBone: [0, 0.065, 0.024], rangeMapHorizontalInner: range,
                rangeMapHorizontalOuter: range, rangeMapVerticalDown: range, rangeMapVerticalUp: range },
            expressions: { preset, custom },
        },
    };
    json.materials.forEach(material => {
        const source = materialNames.get(material.name);
        const shade = source.name === "head" ? 0.86 : source.name === "tf" ? 0.70 : 0.76;
        // Match the reference diffuse range under the actual desktop light rig.
        const exposure = 0.56;
        const oral = source.name === "口" || source.name === "口舌";
        const [red, green, blue] = oral ? [0.92, 0.77, 0.76] : [exposure, exposure, exposure];
        material.pbrMetallicRoughness.baseColorFactor = [red, green, blue, source.diffuse[3]];
        material.extensions = { ...material.extensions,
            VRMC_materials_mtoon: {
                specVersion: "1.0", shadeColorFactor: [shade * red, shade * green, (shade + 0.04) * blue],
                shadeMultiplyTexture: material.pbrMetallicRoughness.baseColorTexture,
                shadingShiftFactor: 0.04, shadingToonyFactor: 0.40, giEqualizationFactor: 0.70,
                outlineWidthMode: "none",
            },
        };
    });
    // Compact dense NORMAL morph target accessors into standard glTF 2.0 sparse / zero-init accessors
    // so all 55 morph targets keep exact welded closed-eye normals with ~45 MB VRM size (instead of ~82 MB).
    function compactMorphNormalAccessors(gltfJson, binChunk) {
        const rawBin = new Uint8Array(binChunk.buffer, binChunk.byteOffset + 8, new DataView(binChunk.buffer, binChunk.byteOffset, 8).getUint32(0, true));
        const normalAccIndices = new Set();
        for (const m of gltfJson.meshes ?? []) {
            for (const prim of m.primitives ?? []) {
                for (const tgt of prim.targets ?? []) {
                    if (tgt.NORMAL !== undefined) normalAccIndices.add(tgt.NORMAL);
                }
            }
        }
        const replacedViews = new Set();
        const extraChunks = [];
        let extraOffset = 0;
        const align4 = n => (n + 3) & ~3;

        for (const accIdx of normalAccIndices) {
            const acc = gltfJson.accessors[accIdx];
            if (acc.bufferView === undefined || acc.sparse || acc.type !== "VEC3" || acc.componentType !== 5126) continue;
            const bv = gltfJson.bufferViews[acc.bufferView];
            if (bv.buffer !== 0 || (bv.byteStride !== undefined && bv.byteStride !== 12) ||
                (acc.byteOffset ?? 0) + acc.count * 12 > bv.byteLength) continue;
            replacedViews.add(acc.bufferView);
            const byteStart = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
            const floats = new Float32Array(rawBin.buffer, rawBin.byteOffset + byteStart, acc.count * 3);
            const nzIdx = [];
            const nzVal = [];
            let minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0;
            for (let i = 0; i < acc.count; i++) {
                const x = floats[i * 3], y = floats[i * 3 + 1], z = floats[i * 3 + 2];
                if (x !== 0 || y !== 0 || z !== 0) {
                    nzIdx.push(i);
                    nzVal.push(x, y, z);
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                }
            }
            delete acc.bufferView;
            delete acc.byteOffset;
            acc.min = [minX, minY, minZ];
            acc.max = [maxX, maxY, maxZ];
            if (nzIdx.length > 0) {
                const idxBytes = new Uint8Array(new Uint32Array(nzIdx).buffer);
                const valBytes = new Uint8Array(new Float32Array(nzVal).buffer);
                const idxBv = { buffer: 0, _extraOffset: extraOffset, byteLength: idxBytes.byteLength };
                extraChunks.push(idxBytes);
                extraOffset = align4(extraOffset + idxBytes.byteLength);
                const valBv = { buffer: 0, _extraOffset: extraOffset, byteLength: valBytes.byteLength };
                extraChunks.push(valBytes);
                extraOffset = align4(extraOffset + valBytes.byteLength);
                const idxBvIndex = gltfJson.bufferViews.length;
                gltfJson.bufferViews.push(idxBv);
                const valBvIndex = gltfJson.bufferViews.length;
                gltfJson.bufferViews.push(valBv);
                acc.sparse = {
                    count: nzIdx.length,
                    indices: { bufferView: idxBvIndex, byteOffset: 0, componentType: 5125 },
                    values: { bufferView: valBvIndex, byteOffset: 0 },
                };
            }
        }

        // A dense view can still back other attributes, images, or sparse data.
        for (const acc of gltfJson.accessors ?? []) {
            replacedViews.delete(acc.bufferView);
            replacedViews.delete(acc.sparse?.indices.bufferView);
            replacedViews.delete(acc.sparse?.values.bufferView);
        }
        for (const img of gltfJson.images ?? []) replacedViews.delete(img.bufferView);
        // Rebuild compact binary buffer dropping only unreferenced dense NORMAL views.
        const keptViewMap = new Map();
        const newBufferViews = [];
        const parts = [];
        let cursor = 0;
        for (let i = 0; i < gltfJson.bufferViews.length; i++) {
            if (replacedViews.has(i)) continue;
            const bv = gltfJson.bufferViews[i];
            keptViewMap.set(i, newBufferViews.length);
            if (bv._extraOffset !== undefined) {
                const chunk = extraChunks.shift();
                newBufferViews.push({ buffer: 0, byteOffset: cursor, byteLength: chunk.byteLength });
                parts.push(chunk);
                cursor = align4(cursor + chunk.byteLength);
            } else {
                const slice = rawBin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
                const copy = { ...bv, byteOffset: cursor };
                newBufferViews.push(copy);
                parts.push(slice);
                cursor = align4(cursor + slice.byteLength);
            }
        }
        // Remap all bufferView indices in accessors, images, and sparse descriptors
        for (const acc of gltfJson.accessors ?? []) {
            if (acc.bufferView !== undefined) acc.bufferView = keptViewMap.get(acc.bufferView);
            if (acc.sparse) {
                acc.sparse.indices.bufferView = keptViewMap.get(acc.sparse.indices.bufferView);
                acc.sparse.values.bufferView = keptViewMap.get(acc.sparse.values.bufferView);
            }
        }
        for (const img of gltfJson.images ?? []) {
            if (img.bufferView !== undefined) img.bufferView = keptViewMap.get(img.bufferView);
        }
        gltfJson.bufferViews = newBufferViews;
        gltfJson.buffers[0].byteLength = cursor;
        const binWithHeader = new Uint8Array(8 + cursor);
        const dv = new DataView(binWithHeader.buffer);
        dv.setUint32(0, cursor, true);
        dv.setUint32(4, 0x004e4942, true); // "BIN\0"
        let pos = 8;
        for (const p of parts) {
            binWithHeader.set(p, pos);
            pos = 8 + align4(pos - 8 + p.byteLength);
        }
        return binWithHeader;
    }

    const compactBin = compactMorphNormalAccessors(json, new Uint8Array(exported, 20 + jsonSize));
    const output = encodeGlb(json, compactBin);
    const load = new GLTFLoader();
    load.register(parser => new VRMLoaderPlugin(parser));
    model = (await load.parseAsync(output, "")).userData.vrm;
    // Validate through the exact same VRMUtils pipeline as desktop runtime!
    VRMUtils.removeUnnecessaryVertices(model.scene);
    VRMUtils.combineSkeletons(model.scene);
    if (!model || Object.keys(model.humanoid.humanBones).length !== 53
        || Object.keys(model.expressionManager.expressionMap).length !== morphs.length) throw new Error("Converted PMX VRM validation failed");

    // Verify morphAttributes.normal survived export + VRM load + removeUnnecessaryVertices!
    let normalMorphTargetsCount = 0;
    model.scene.traverse(obj => {
        if (obj.isMesh && obj.geometry?.morphAttributes?.normal) {
            normalMorphTargetsCount = Math.max(normalMorphTargetsCount, obj.geometry.morphAttributes.normal.length);
        }
    });

    const rest = extractRest(model, profile.bone_order);
    window.resultVrm = output;
    return { bones: profile.bone_order, boneMapping: canonical, rest, expressions: morphs, transferred,
        normalMorphTargetsCount,
        textureCount: json.images.length, textures: [...images.keys()], materials: pmx.materials,
        meshVertices: pmx.vertices.length, meshFaces: pmx.indices.length / 3, springJoints: model.springBoneManager?.joints.size ?? 0,
        appearanceSource: "pmx/kei.pmx", facialMorphSource: "r16 topological eyelid closure, welded normal morphs, component-aware lashes, and PMX lip deltas" };
};

window.loadComparison = async version => {
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const replacement = (await loader.parseAsync(await fetch("/compare/" + version).then(r => r.arrayBuffer()), "")).userData.vrm;
    VRMUtils.removeUnnecessaryVertices(replacement.scene);
    VRMUtils.combineSkeletons(replacement.scene);
    if (room) { room.remove(model.scene); room.add(replacement.scene); }
    model = replacement;
    comparisonMixer = createFaceMixer(model.expressionManager);
};

function ensureScene() {
    if (!room) {
        room = new Scene();
        room.background = new Color("#646464");
        room.add(model.scene, new HemisphereLight(0xffffff, 0xb7c2e0, 2.2));
        const light = new DirectionalLight(0xfff4e6, 2.2);
        light.position.set(2, 3, 4);
        room.add(light);
        graphics = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        graphics.setPixelRatio(1);
        document.body.style.cssText = "margin:0;overflow:hidden";
        document.body.append(graphics.domElement);
        camera = new OrthographicCamera();
    }
}

window.preview = (kind, width, height, expression = null, mouth = 0, blink = 0, speaking = false, angle = 0) => {
    ensureScene();
    const bounds = new Box3().setFromObject(model.scene);
    const heightWorld = bounds.max.y - bounds.min.y;
    const close = kind === "face" || kind === "eye-zoom";
    const zoom = kind === "eye-zoom";
    const centerY = zoom ? 1.298 : close ? 1.31 : (bounds.min.y + bounds.max.y) / 2 - 0.009;
    const span = zoom ? 0.145 : close ? 0.31 : heightWorld * 1.015;
    const halfW = span * (width / height) / 2;
    Object.assign(camera, { left: -halfW, right: halfW, top: span / 2, bottom: -span / 2, near: 0.1, far: 20 });
    const centerX = zoom ? (angle > 0.1 ? 0.024 : 0.0) : close ? 0.0 : 0.078;
    camera.position.set(centerX + 3.2 * Math.sin(angle), centerY + (zoom ? 0.015 : close ? 0.075 : 0.16), 3.2 * Math.cos(angle));
    camera.lookAt(centerX, centerY, 0);
    camera.updateProjectionMatrix();
    graphics.setSize(width, height);
    if (comparisonMixer) comparisonMixer.apply({ expressionPreview: expression ? { values: { [expression]: 1 } } : null,
        mouth, blink, speaking, smile: 0 });
    else for (const name of Object.keys(model.expressionManager.expressionMap)) {
        let v = 0;
        if (expression && [expression, "keiLids." + expression, "keiLips." + expression].includes(name)) v = 1;
        if (name === "blink" && blink > 0) v = blink;
        if (name === "aa" && mouth > 0) v = mouth;
        model.expressionManager.setValue(name, v);
    }
    model.update(0);
    graphics.render(room, camera);
    return comparisonMixer && graphics.domElement.toDataURL("image/jpeg", .89).split(",")[1];
};

// Diagnostic rendering modes matching the 8-panel eyelid diagnostic suite + MToon CG mode!
window.renderEyelidDiagnostic = (mode, width, height, expression = "eyesClosed", blink = 0, angle = 0) => {
    ensureScene();
    room.background = new Color("#8a8395");
    const meshes = [];
    model.scene.traverse(obj => { if (obj.isMesh) meshes.push(obj); });
    const saved = meshes.map(m => ({ mesh: m, material: m.material, visible: m.visible }));
    const savedToon = (model.materials ?? []).filter(m => m.isMToonMaterial).map(m => ({
        m, toony: m.shadingToonyFactor, shift: m.shadingShiftFactor, shade: m.shadeColorFactor.clone(),
    }));
    const lights = room.children.filter(c => c.isLight);
    const savedIntensities = lights.map(l => l.intensity);
    const disposables = [];

    try {
        if (mode === "toon-cg") {
            for (const { m, shade } of savedToon) {
                m.shadingToonyFactor = 0.91;
                m.shadingShiftFactor = -0.065;
                m.shadeColorFactor.copy(shade).multiplyScalar(0.86);
            }
            for (const l of lights) if (l.isHemisphereLight) l.intensity = 1.65;
        } else if (mode !== "lit-full") {
            const headOnly = mode.includes("head-only") || mode.includes("notex-head") || mode.includes("normals-head");
            const unlit = mode.includes("unlit");
            const noTex = mode.includes("notex");
            const normals = mode.includes("normals");
            for (const m of meshes) {
                const mats = Array.isArray(m.material) ? m.material : [m.material];
                const newMats = mats.map(orig => {
                    const name = orig.name ?? "";
                    if (headOnly && ["眼白", "眼睛", "眼珠", "睫眉"].includes(name)) {
                        const hidden = new MeshBasicMaterial({ visible: false });
                        disposables.push(hidden);
                        return hidden;
                    }
                    if (normals) {
                        const nm = new MeshNormalMaterial({ side: orig.side });
                        disposables.push(nm);
                        return nm;
                    }
                    if (unlit) {
                        const um = new MeshBasicMaterial({
                            map: noTex ? null : orig.map,
                            color: orig.color ? orig.color.clone() : new Color(1, 1, 1),
                            side: orig.side,
                            alphaTest: orig.alphaTest ?? 0.09,
                        });
                        disposables.push(um);
                        return um;
                    }
                    if (noTex) {
                        const cloned = orig.clone();
                        cloned.map = null;
                        if (cloned.shadeMultiplyTexture !== undefined) cloned.shadeMultiplyTexture = null;
                        cloned.needsUpdate = true;
                        disposables.push(cloned);
                        return cloned;
                    }
                    return orig;
                });
                m.material = Array.isArray(m.material) ? newMats : newMats[0];
            }
        }

        window.preview("eye-zoom", width, height, expression, 0, blink, false, angle);
    } finally {
        for (const s of saved) { s.mesh.material = s.material; s.mesh.visible = s.visible; }
        for (const t of savedToon) {
            t.m.shadingToonyFactor = t.toony;
            t.m.shadingShiftFactor = t.shift;
            t.m.shadeColorFactor.copy(t.shade);
        }
        lights.forEach((l, i) => { l.intensity = savedIntensities[i]; });
        for (const d of disposables) d.dispose();
        room.background = new Color("#646464");
    }
};
