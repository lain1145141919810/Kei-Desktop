import { Box3, TextureLoader, SRGBColorSpace, MeshStandardMaterial, DoubleSide, Vector3, Quaternion } from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";

const center = { hips: "Hips", spine: "Spine", chest: "Chest", neck: "Neck", head: "Head", leftEye: "LeftEye", rightEye: "RightEye" };
const sides = { Shoulder: "Shoulder", UpperArm: "Upper_arm", LowerArm: "Lower_arm", Hand: "Hand",
    UpperLeg: "Upper_leg", LowerLeg: "Lower_leg", Foot: "Foot", Toes: "Toe",
    ThumbMetacarpal: "Thumb_Proximal", ThumbProximal: "Thumb_Intermediate", ThumbDistal: "Thumb_Distal" };
const morphNames = {
    aa: "あ", ih: "い", ou: "う", ee: "え", oh: "お", blink: "まばたき", blinkLeft: "ウィンク", blinkRight: "ウィンク右",
    happy: "笑い", angry: "怒り", sad: "困る", relaxed: "なごみ", surprised: "びっくり",
};

function boneName(name) {
    if (Object.hasOwn(center, name)) return center[name];
    const [, side, part] = /^(left|right)(.+)$/.exec(name);
    const source = sides[part] ?? part.replace(/^(Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/, "$1_$2");
    return source + (side === "left" ? "L" : "R");
}

export function readJson(url) {
    return fetch(url).then(response => {
        if (!response.ok) throw new Error("Cannot read " + url);
        return response.json();
    });
}

export function encodeGlb(json, data) {
    const string = new TextEncoder().encode(JSON.stringify(json));
    const padded = Math.ceil(string.byteLength / 4) * 4;
    const output = new Uint8Array(20 + padded + data.byteLength);
    const view = new DataView(output.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, output.byteLength, true);
    view.setUint32(12, padded, true);
    view.setUint32(16, 0x4e4f534a, true);
    output.fill(0x20, 20, 20 + padded);
    output.set(string, 20);
    output.set(data, 20 + padded);
    return output.buffer;
}

export function extractRest(vrm, bones) {
    vrm.humanoid.resetNormalizedPose();
    vrm.scene.updateMatrixWorld(true);
    const normalized = bones.map(name => vrm.humanoid.getNormalizedBoneNode(name));
    const indices = new Map(normalized.map((node, index) => [node, index]));
    const parents = normalized.map(node => {
        let parent = node.parent;
        while (parent && !indices.has(parent)) parent = parent.parent;
        return indices.get(parent) ?? -1;
    });
    const offsets = normalized.map((node, index) => parents[index] === -1
        ? node.position.toArray() : normalized[parents[index]].worldToLocal(node.getWorldPosition(new Vector3())).toArray());
    return {
        bones, parents, offsets, neutral: normalized.map(node => node.quaternion.toArray()),
        baseQ: normalized[0].parent.getWorldQuaternion(new Quaternion()).toArray(),
        baseP: normalized[0].parent.getWorldPosition(new Vector3()).toArray(),
    };
}

export async function convertFbx() {
    const [source, pmx, profile] = await Promise.all([
        fetch("/input.fbx").then(response => response.arrayBuffer()), readJson("/pmx.json"), readJson("/skeleton.json"),
    ]);
    const model = new FBXLoader().parse(source, "");
    // The FBX expresses scene lengths in centimeters. glTF/VRM uses meters.
    model.scale.multiplyScalar(0.01);
    model.updateMatrixWorld(true);
    model.position.y -= new Box3().setFromObject(model).min.y;
    model.updateMatrixWorld(true);
    const pmxMaterials = new Map(pmx.materials.map(material => [material.name, pmx.textures[material.texture]?.split("/").at(-1)]));
    const mappings = new Map(profile.bone_order.map(name => [boneName(name), name]));
    const seen = new Set();
    const meshes = [];
    model.traverse(object => {
        const name = object.isBone && object.parent?.name !== object.name && mappings.get(object.name);
        if (name) {
            if (seen.has(name)) throw new Error("Duplicate canonical bone " + name);
            seen.add(name);
            object.userData.keiBone = name;
        }
        if (object.isSkinnedMesh) meshes.push(object);
    });
    if (seen.size !== profile.bone_order.length) throw new Error("Missing FBX bones " + profile.bone_order.filter(name => !seen.has(name)).join(", "));
    const textures = new Map();
    const loader = new TextureLoader();
    const used = new Map();
    async function materialFor(original) {
        if (used.has(original.name)) return used.get(original.name);
        const textureName = pmxMaterials.get(original.name);
        if (!textureName) throw new Error("Missing atlas assignment for " + original.name);
        if (!textures.has(textureName)) {
            textures.set(textureName, loader.loadAsync("/texture/" + encodeURIComponent(textureName)).then(texture => {
                texture.name = textureName;
                texture.colorSpace = SRGBColorSpace;
                return texture;
            }));
        }
        const loading = textures.get(textureName).then(map => new MeshStandardMaterial({
            name: original.name, map, roughness: 0.93, metalness: 0, side: DoubleSide, alphaTest: 0.045,
        }));
        used.set(original.name, loading);
        return loading;
    }
    await Promise.all(meshes.map(async mesh => {
        mesh.material = Array.isArray(mesh.material) ? await Promise.all(mesh.material.map(materialFor)) : await materialFor(mesh.material);
    }));
    const exported = await new GLTFExporter().parseAsync(model, { binary: true, trs: true, onlyVisible: true, maxTextureSize: 2048 });
    const jsonSize = new DataView(exported).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(exported, 20, jsonSize)));
    const humanBones = {};
    const expressions = {};
    json.nodes.forEach((node, index) => {
        if (node.extras?.keiBone) {
            humanBones[node.extras.keiBone] = { node: index };
            delete node.extras.keiBone;
        }
        if (node.mesh === undefined || node.name !== "face") return;
        const morphs = json.meshes[node.mesh].extras.targetNames;
        for (const [name, source] of Object.entries(morphNames)) {
            const morph = morphs.indexOf(source);
            if (morph < 0) throw new Error("Missing face morph " + source);
            expressions[name] = { morphTargetBinds: [{ node: index, index: morph, weight: 1 }] };
        }
    });
    const range = { inputMaxValue: 90, outputScale: 12 };
    json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "VRMC_vrm"])];
    json.extensions = {
        ...json.extensions, VRMC_vrm: {
            specVersion: "1.0",
            meta: {
                name: "Kei (private local conversion)", version: "local-1", authors: ["阿琳剑圣", "银月风尘"],
                copyrightInformation: "Local conversion from Kei FBX. PMX source terms apply. No redistribution or commercial use.",
                licenseUrl: "https://vrm.dev/licenses/1.0/",
                avatarPermission: "onlyAuthor", commercialUsage: "personalNonProfit", allowRedistribution: false, modification: "allowModification",
                allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, allowPoliticalOrReligiousUsage: false,
                allowAntisocialOrHateUsage: false, creditNotation: "required",
            },
            humanoid: { humanBones },
            lookAt: { type: "bone", offsetFromHeadBone: [0, 0.06, 0],
                rangeMapHorizontalInner: range, rangeMapHorizontalOuter: range, rangeMapVerticalDown: range, rangeMapVerticalUp: range },
            expressions: { preset: expressions },
        },
    };
    const output = encodeGlb(json, new Uint8Array(exported, 20 + jsonSize));
    const reader = new GLTFLoader();
    reader.register(parser => new VRMLoaderPlugin(parser));
    const built = await reader.parseAsync(output, "");
    const vrm = built.userData.vrm;
    if (!vrm || Object.keys(vrm.humanoid.humanBones).length !== profile.bone_order.length) throw new Error("Converted rig failed VRM 1.0 validation");
    const rest = extractRest(vrm, profile.bone_order);
    window.resultVrm = output;
    return { bones: profile.bone_order, rest,
        boneMapping: Object.fromEntries(profile.bone_order.map(name => [name, boneName(name)])),
        expressions: Object.keys(vrm.expressionManager.expressionMap), textureCount: json.images.length,
        textureMapping: Object.fromEntries(pmxMaterials), meshes: meshes.length, springs: vrm.springBoneManager?.joints.size ?? 0,
        source: "fbx/kei.fbx", meta: vrm.meta };
}

window.convert = convertFbx;
