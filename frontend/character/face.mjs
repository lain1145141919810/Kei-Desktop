import { emotionTarget } from "./expression.mjs";

const layers = ["keiLids.", "keiLips."];
const layerName = name => layers.some(prefix => name.startsWith(prefix));

function shareMorph(first, second) {
    return first.index === second.index && Array.isArray(first.primitives) && Array.isArray(second.primitives) &&
        first.primitives.some(primitive => second.primitives.includes(primitive));
}

export function createFaceMixer(manager, continuousTarget) {
    const expression = name => manager?.getExpression(name);
    const reserved = ["aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight",
        "lookLeft", "lookRight", "lookUp", "lookDown"].flatMap(name => expression(name)?.binds ?? []);
    const supported = new Set();
    const continuous = new Map();
    for (const name of Object.keys(manager?.expressionMap ?? {})) {
        if (!emotionTarget(name) || layerName(name)) continue;
        const value = expression(name);
        if (!value || value.binds.some(bind => reserved.some(target => shareMorph(bind, target)))) continue;
        // The stage owns mouth, eyelid and gaze layers. Emotion metadata may otherwise suppress those.
        value.overrideBlink = value.overrideMouth = value.overrideLookAt = "none";
        if (value.isBinary && continuousTarget) {
            const alias = continuousTarget(value);
            if (!alias) continue;
            continuous.set(name, alias);
        }
        supported.add(name);
    }
    const regionTargets = new Map();
    for (const name of supported) {
        const targets = layers.map(prefix => prefix + name);
        const usable = targets.map(target => {
            const value = expression(target);
            if (!value || value.binds.some(bind => reserved.some(other => shareMorph(bind, other)))) return null;
            value.overrideBlink = value.overrideMouth = value.overrideLookAt = "none";
            return target;
        });
        if (usable.some(Boolean)) regionTargets.set(name, usable);
    }
    const smile = supported.has("happy") ? "happy" : "relaxed";
    const combinedBlink = Boolean(expression("blink"));
    let previous = new Set();
    let snapshot = null;
    let voicedShout = false;
    function apply(pose) {
        const used = {};
        const missing = [];
        const weights = new Map();
        if (!pose.expressionPreview && supported.has(smile)) weights.set(smile, pose.smile * 0.65);
        const values = pose.expressionPreview?.values ?? pose.emotion?.values ?? {};
        for (const [name, weight] of Object.entries(values)) {
            if (!supported.has(name)) {
                missing.push(name);
                continue;
            }
            weights.set(name, Math.max(weights.get(name) ?? 0, weight));
            used[name] = weight;
        }
        if (!(weights.get("shout") > 0)) voicedShout = false;
        else if (pose.speaking) voicedShout = true;
        for (const name of new Set([...previous, ...weights.keys()])) {
            const alias = continuous.get(name);
            const useCurve = alias && Object.hasOwn(used, name);
            manager?.setValue(name, useCurve ? 0 : weights.get(name) ?? 0);
            if (alias) manager.setValue(alias, useCurve ? weights.get(name) : 0);
            const [lids, lips] = regionTargets.get(name) ?? [];
            const strength = weights.get(name) ?? 0;
            if (lids) manager.setValue(lids, strength * (1 - pose.blink));
            if (lips) manager.setValue(lips, name === "shout" && voicedShout ? 0 : strength * (1 - pose.mouth));
        }
        previous = new Set(weights.keys());
        manager?.setValue("aa", pose.mouth);
        if (combinedBlink) manager.setValue("blink", pose.blink);
        else {
            manager?.setValue("blinkLeft", pose.blink);
            manager?.setValue("blinkRight", pose.blink);
        }
        snapshot = { clipId: pose.expressionPreview ? null : pose.emotion?.clipId ?? null, used, missing, mouth: pose.mouth, blink: pose.blink,
            weights: Object.fromEntries(weights) };
    }
    return { apply, supported: [...supported], snapshot: () => snapshot };
}
