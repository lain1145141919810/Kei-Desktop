import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VOCABULARY_BY_ID, VOCABULARY_VERSION, synthesizeVocabulary, vocabularyCatalog } from "./vocabulary.mjs";

const location = path.resolve(process.argv[2]);
const mode = process.argv[3];
const json = async file => JSON.parse(await readFile(path.join(location, file), "utf8"));
const upstream = file => import(pathToFileURL(path.join(location, file)));
const validTuple = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);

async function library() {
    const manifest = await json("models/skills/manifest.json");
    const [classes, sources] = await Promise.all([
        Promise.all(manifest.classes.map(item => json("models/skills/" + item.file))),
        Promise.all([0, 1, 2, 3].map(index => json("models/skills/sources-" + index + ".json"))).then(parts => parts.flat()),
    ]);
    const { extraLibrary } = await upstream("service/v15_library.mjs");
    return extraLibrary(location, { ...manifest, classes, sources });
}

function rig(rest, bones, Object3D) {
    if (JSON.stringify(rest?.bones) !== JSON.stringify(bones) ||
        rest.parents?.length !== bones.length || rest.parents[0] !== -1 ||
        rest.parents.slice(1).some((parent, index) => !Number.isInteger(parent) || parent < 0 || parent > index) ||
        rest.offsets?.length !== bones.length || !rest.offsets.every(value => validTuple(value, 3) && value.every(component => Math.abs(component) <= 5)) ||
        rest.neutral?.length !== bones.length || !rest.neutral.every(value => validTuple(value, 4) && Math.abs(Math.hypot(...value) - 1) < 0.001) ||
        !validTuple(rest.baseQ, 4) || Math.abs(Math.hypot(...rest.baseQ) - 1) > 0.001 ||
        !validTuple(rest.baseP, 3) || rest.baseP.some(value => Math.abs(value) > 5)) {
        throw new Error("rig_mismatch");
    }
    const root = new Object3D();
    root.position.fromArray(rest.baseP);
    root.quaternion.fromArray(rest.baseQ);
    const nodes = [];
    bones.forEach((name, index) => {
        const node = new Object3D();
        node.name = name;
        node.position.fromArray(rest.offsets[index]);
        node.quaternion.fromArray(rest.neutral[index]);
        (nodes[rest.parents[index]] ?? root).add(node);
        nodes.push(node);
    });
    root.updateMatrixWorld(true);
    const byName = new Map(nodes.map(node => [node.name, node]));
    return { direction: 1, profile: { bone_order: bones }, node: name => byName.get(name) };
}

async function sourceTrack(selected, sources, boneCount) {
    const source = sources.find(item => item.id === selected.source);
    if (!source || !/^[\w-]+\.bin$/.test(source.file)) throw new Error("assets_missing");
    const buffer = await readFile(path.join(location, "models/trajectories", source.file));
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (buffer.length !== source.frames * boneCount * 16 || sha256 !== source.sha256) throw new Error("asset_integrity");
    const values = Float32Array.from({ length: buffer.length / 4 }, (_, index) => buffer.readFloatLE(index * 4));
    if (values.some(value => !Number.isFinite(value))) throw new Error("asset_integrity");
    return { source, sha256, values };
}

function measureMocapBeat(frames, rate, mask, variantId, side) {
    const durationMs = Math.round(((frames.length - 1) / rate) * 1000);
    // Find frame with maximum cumulative rotational displacement from frame 0
    let peakIndex = Math.max(1, Math.floor((frames.length - 1) * 0.45));
    let bestScore = -1;
    const f0 = frames[0];
    for (let i = 1; i < frames.length - 1; i++) {
        let score = 0;
        for (let b = 0; b < frames[i].length; b++) {
            const a = f0[b];
            const c = frames[i][b];
            const dot = Math.min(1, Math.abs(a[0] * c[0] + a[1] * c[1] + a[2] * c[2] + a[3] * c[3]));
            score += 2 * Math.acos(dot);
        }
        if (score > bestScore) {
            bestScore = score;
            peakIndex = i;
        }
    }
    const peakMs = Math.round((peakIndex / rate) * 1000);
    return {
        prepMs: Math.round(peakMs * 0.45),
        peakMs,
        releaseMs: Math.round(peakMs + (durationMs - peakMs) * 0.55),
        durationMs,
        variantId,
        handedness: side || "none",
        ownsHead: mask.includes("head") || mask.includes("neck"),
        category: "hastsec-mocap",
    };
}

async function solve(catalog, request) {
    const start = performance.now();
    const speed = request.speed ?? 1;
    const strength = request.strength ?? 1;
    if (!Number.isFinite(speed) || speed < 0.6 || speed > 2 || !Number.isFinite(strength) || strength <= 0 || strength > 1) {
        throw new Error("invalid_intent");
    }

    // 1. Check plugin-local reviewed natural motion vocabulary first
    if (VOCABULARY_BY_ID.has(request.motion)) {
        const THREE = await upstream("node_modules/three/build/three.module.js");
        const controller = rig(request.rig, catalog.bones, THREE.Object3D);
        return synthesizeVocabulary(request, controller, catalog.bones, THREE);
    }

    // 2. Fallback to upstream HAST-SEC mocap library (with variant rotation across skills[])
    const entry = catalog.classes.find(item => item.key === request.motion && item.mask.length);
    if (!entry || !entry.skills.length) throw new Error("unknown_motion");
    const [{ Object3D, Quaternion, Euler }, { controllerV9 }, { beatLayers }, config] = await Promise.all([
        upstream("node_modules/three/build/three.module.js"),
        upstream("motion/v9/controller.mjs"),
        upstream("motion/beat_layers.mjs"),
        json("configs/v9_control.json"),
    ]);
    const bones = catalog.bones;
    const controller = rig(request.rig, bones, Object3D);
    const skillIndex = Number.isInteger(request.variantIndex)
        ? ((request.variantIndex % entry.skills.length) + entry.skills.length) % entry.skills.length
        : 0;
    const selected = entry.skills[skillIndex];
    const { source, sha256, values } = await sourceTrack(selected, catalog.sources, bones.length);
    const solver = controllerV9(controller, { config: { ...config, arm_collision_enabled: true, cached_derivative: true } });
    const layer = beatLayers(bones, new Map([[source.id, values]]));
    const base = request.rig.neutral.map(value => value.slice());
    for (const [name, angle] of [["leftUpperArm", -1.1], ["rightUpperArm", 1.1]]) {
        base[bones.indexOf(name)] = new Quaternion().setFromEuler(new Euler(0, 0, angle)).toArray();
    }
    const rate = config.solver_rate;
    const fixedStep = 1 / rate;
    layer.add({ ...entry, skills: [selected] }, { speed, strength, hold: 0 }, base);
    const frames = [];
    const durations = [];
    let maxBoneError = 0;
    let maxRangeError = 0;
    for (let index = 0; index <= rate * 9; index++) {
        const dt = index === 0 ? 0 : fixedStep;
        const rotations = layer.sample(base, dt);
        const leg = entry.part === "leg" && layer.state().tracks[0]?.weight > 0.1;
        const result = solver.step({ rotations, root: request.rig.offsets[0], swingFoot: leg ? entry.side + "Foot" : null }, dt);
        if (result.last.requires_pause) throw new Error("solve_unstable");
        maxBoneError = Math.max(maxBoneError, result.last.bone_error_m);
        maxRangeError = Math.max(maxRangeError, result.last.range_error_deg);
        durations.push(result.last.elapsed_ms);
        frames.push(entry.mask.map(joint => result.rotations[joint].map(value => Number(value.toFixed(7)))));
        if (!layer.active()) break;
    }
    durations.sort((a, b) => a - b);
    const maskNames = entry.mask.map(index => bones[index]);
    const variantId = `skill-${skillIndex}`;
    const beat = measureMocapBeat(frames, rate, maskNames, variantId, entry.side);
    return {
        state: "ready",
        clip: { version: 1, motion: entry.key, rate, mask: maskNames, frames, beat },
        diagnostics: {
            sourceId: source.id, sourceSHA256: sha256, sourceStart: selected.start, sourceEnd: selected.end,
            variantId, handedness: entry.side || "none", ownsHead: beat.ownsHead,
            stepMs: fixedStep * 1000, solveMs: performance.now() - start,
            medianMs: durations[Math.floor(durations.length / 2)], p95Ms: durations[Math.floor(durations.length * 0.95)],
            maxBoneErrorM: maxBoneError, maxRangeErrorDegrees: maxRangeError,
        },
    };
}

async function prewarmBatch(catalog, request) {
    const started = performance.now();
    const THREE = await upstream("node_modules/three/build/three.module.js");
    const items = Array.isArray(request.items) ? request.items.slice(0, 32) : [];
    const results = [];
    for (const item of items) {
        if (!VOCABULARY_BY_ID.has(item.motion)) continue;
        const controller = rig(request.rig, catalog.bones, THREE.Object3D);
        results.push({
            motion: item.motion,
            variant: item.variant ?? "auto",
            variantIndex: item.variantIndex ?? 0,
            speed: item.speed ?? 1,
            strength: item.strength ?? 0.9,
            solved: synthesizeVocabulary(item, controller, catalog.bones, THREE),
        });
    }
    return { state: "ready", elapsedMs: Number((performance.now() - started).toFixed(2)), results };
}

try {
    const catalog = await library();
    if (mode === "library") {
        const vocab = vocabularyCatalog();
        const hastMotions = catalog.classes.filter(item => item.mask.length).map(item => ({
            id: item.key,
            title: item.canonical || item.key,
            category: item.part || "arm",
            handedness: item.side ? [item.side] : [],
            variants: item.skills.map((_s, idx) => ({ id: `skill-${idx}`, handedness: item.side || "none" })),
            ownsHead: item.mask.some(index => catalog.bones[index] === "head" || catalog.bones[index] === "neck"),
            mask: item.mask.map(index => catalog.bones[index]),
        }));
        console.log(JSON.stringify({
            state: "ready",
            bones: catalog.bones,
            vocabularyVersion: VOCABULARY_VERSION,
            motions: [...vocab, ...hastMotions],
        }));
    } else if (mode === "prewarm") {
        let input = "";
        process.stdin.setEncoding("utf8");
        for await (const part of process.stdin) {
            input += part;
            if (Buffer.byteLength(input) > 64 * 1024) throw new Error("invalid_intent");
        }
        console.log(JSON.stringify(await prewarmBatch(catalog, JSON.parse(input))));
    } else {
        let input = "";
        process.stdin.setEncoding("utf8");
        for await (const part of process.stdin) {
            input += part;
            if (Buffer.byteLength(input) > 32 * 1024) throw new Error("invalid_intent");
        }
        console.log(JSON.stringify(await solve(catalog, JSON.parse(input))));
    }
} catch (error) {
    const known = new Set(["rig_mismatch", "unknown_motion", "invalid_intent", "assets_missing", "asset_integrity", "solve_unstable"]);
    if (process.env.KEI_HAST_DEBUG === "1") console.error(error);
    console.log(JSON.stringify({ state: "fallback", code: known.has(error.message) ? error.message : "solver_unavailable" }));
}
