import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMExpression, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { createFaceMixer } from "./face.mjs";
import { MOTION_BONES } from "./motion.mjs";

function verifyGlb(binary) {
    if (!(binary instanceof ArrayBuffer)) throw new Error("VRM アセットが設定されていません");
    const data = new DataView(binary);
    if (data.byteLength < 20 || data.getUint32(0, true) !== 0x46546c67 ||
        data.getUint32(4, true) !== 2 || data.getUint32(8, true) !== data.byteLength ||
        data.getUint32(16, true) !== 0x4e4f534a) throw new Error("Invalid VRM container");
    const length = data.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, length)));
    if (!json.extensions?.VRMC_vrm && !json.extensions?.VRM) throw new Error("Missing VRM extension");
    if ([...(json.buffers ?? []), ...(json.images ?? [])].some(part => "uri" in part)) {
        throw new Error("VRM model resources must be embedded");
    }
}

function disposeVrm(scene) {
    const images = new Set();
    function add(value) {
        if (value?.isTexture && value.image instanceof ImageBitmap) images.add(value.image);
    }
    scene.traverse(node => {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
            if (!material) continue;
            Object.values(material).forEach(add);
            for (const uniform of Object.values(material.uniforms ?? {})) add(uniform.value);
        }
    });
    VRMUtils.deepDispose(scene);
    for (const image of images) image.close();
}

function motionRig(vrm) {
    if (vrm.meta.metaVersion !== "1") return null;
    const nodes = MOTION_BONES.map(name => vrm.humanoid.getNormalizedBoneNode(name));
    if (nodes.some(node => !node)) return null;
    const indices = new Map(nodes.map((node, index) => [node, index]));
    const parents = nodes.map(node => {
        let parent = node.parent;
        while (parent && !indices.has(parent)) parent = parent.parent;
        return indices.get(parent) ?? -1;
    });
    const neutral = nodes.map(node => node.quaternion.toArray());
    const offsets = nodes.map((node, index) => {
        const parent = nodes[parents[index]];
        return parent ? parent.worldToLocal(node.getWorldPosition(new THREE.Vector3())).toArray() : node.position.toArray();
    });
    return { bones: MOTION_BONES, parents, offsets, neutral,
        baseQ: nodes[0].parent.getWorldQuaternion(new THREE.Quaternion()).toArray(),
        baseP: nodes[0].parent.getWorldPosition(new THREE.Vector3()).toArray() };
}

export async function loadVrm(canvas, binary, { onHitMap = () => {} } = {}) {
    verifyGlb(binary);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
        if (!url.startsWith("blob:")) throw new Error("Unexpected external model resource");
        return url;
    });
    const loader = new GLTFLoader(manager);
    loader.register(parser => new VRMLoaderPlugin(parser));
    const model = await loader.parseAsync(binary, "");
    const vrm = model.userData.vrm;
    let renderer;
    try {
        if (!vrm) throw new Error("Unsupported VRM model");
        VRMUtils.removeUnnecessaryVertices(vrm.scene);
        VRMUtils.combineSkeletons(vrm.scene);
        VRMUtils.rotateVRM0(vrm);
        const scene = new THREE.Scene();
        scene.add(vrm.scene);
        const ambient = new THREE.HemisphereLight(0xffffff, 0xb7c2e0, 2.2);
        scene.add(ambient);
        const light = new THREE.DirectionalLight(0xfff4e6, 2.2);
        light.position.set(2, 3, 4);
        scene.add(light);
        const toonMaterials = (vrm.materials ?? []).filter(material => material.isMToonMaterial).map(material => ({
            material, softness: material.shadingToonyFactor, shift: material.shadingShiftFactor,
            shade: material.shadeColorFactor.clone(),
        }));
        let toonCg = false;
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
        renderer.setClearColor(0, 0);
        const camera = new THREE.PerspectiveCamera(30, 1, 0.02, 50);
        const bounds = new THREE.Box3().setFromObject(vrm.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        if (!(size.y > 0) || !Number.isFinite(size.y)) throw new Error("Model bounds are invalid");
        const hips = vrm.humanoid.getNormalizedBoneNode("hips");
        const head = vrm.humanoid.getNormalizedBoneNode("head");
        const rig = motionRig(vrm);
        const stageNodes = new Map(MOTION_BONES.flatMap((name, index) => {
            const node = vrm.humanoid.getNormalizedBoneNode(name);
            return node ? [[name, {
                node,
                default: new THREE.Quaternion().fromArray(rig?.neutral[index] ?? node.quaternion.toArray()),
            }]] : [];
        }));
        const leftArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
        const rightArm = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
        if (leftArm) leftArm.rotation.z = -1.10;
        if (rightArm) rightArm.rotation.z = 1.10;
        if (leftArm) stageNodes.get("leftUpperArm").default.copy(leftArm.quaternion);
        if (rightArm) stageNodes.get("rightUpperArm").default.copy(rightArm.quaternion);
        function capturePose() {
            const pose = {};
            for (const [name, entry] of stageNodes) pose[name] = entry.node.quaternion.toArray();
            return pose;
        }
        let motionMask = [];
        let motionFrame = null;
        let vrmUpdates = 0;
        let latestDrawMs = 0;
        const look = new THREE.Object3D();
        scene.add(look);
        if (vrm.lookAt) vrm.lookAt.target = look;
        const expression = vrm.expressionManager;
        let expressionSequence = 0;
        const face = createFaceMixer(expression, original => {
            const morphs = original.binds.filter(bind => Array.isArray(bind.primitives) && Number.isInteger(bind.index));
            if (!morphs.length) return null;
            let alias;
            do { alias = "kei_curve_" + ++expressionSequence; } while (expression.getExpression(alias));
            // Retain the model's binary material and texture expression for its normal use.
            // Authored curves animate only the same expression's morph binds continuously.
            const curve = new VRMExpression(alias);
            for (const bind of morphs) curve.addBind(bind);
            expression.registerExpression(curve);
            return alias;
        });
        // The live silhouette comes from a tiny color pass and an asynchronous GPU read.
        // Raycasting the original skinned morph geometry would skin its triangles on the UI thread.
        const maskSize = 128;
        const hitTarget = new THREE.WebGLRenderTarget(maskSize, maskSize);
        let hitPixels = null;
        let readingHitMap = false;
        let requestedHitMap = false;
        let hitMapWarm = false;
        let hitMapTime = -Infinity;
        let viewport = null;
        let surface = null;
        let hitMapViewport = null;
        let disposed = false;
        function renderHitMap() {
            const previous = renderer.getRenderTarget();
            try {
                renderer.setRenderTarget(hitTarget);
                renderer.render(scene, camera);
            } finally {
                renderer.setRenderTarget(previous);
            }
        }
        function storeHitMap(buffer, renderedViewport) {
            if (disposed || renderedViewport.distance !== viewport.distance) return;
            hitPixels = buffer;
            hitMapViewport = renderedViewport;
            hitMapTime = performance.now();
            onHitMap();
        }
        function usableHitMap() {
            return hitPixels && hitMapViewport.distance === viewport.distance;
        }
        function prepareHit() {
            if (!usableHitMap() || performance.now() - hitMapTime >= 120) {
                requestedHitMap = true;
            }
        }
        // Compile the mask variant in the background while the regular surface is warming.
        renderer.setRenderTarget(hitTarget);
        const maskCompilation = renderer.compileAsync(scene, camera);
        renderer.setRenderTarget(null);
        void maskCompilation.catch(() => {}).finally(() => { hitMapWarm = true; });
        async function warmHitMap() {
            await maskCompilation.catch(() => {});
            if (disposed || !viewport || hitMapViewport === viewport) return;
            const renderedViewport = viewport;
            renderHitMap();
            const buffer = await renderer.readRenderTargetPixelsAsync(hitTarget, 0, 0, maskSize, maskSize, new Uint8Array(maskSize ** 2 * 4));
            storeHitMap(buffer, renderedViewport);
        }
        const gl = renderer.getContext();
        const gpu = gl.getExtension("WEBGL_debug_renderer_info");
        return {
            setToonCg(enabled) {
                const next = enabled && toonMaterials.length > 0;
                if (next === toonCg) return toonCg;
                toonCg = next;
                for (const { material, softness, shift, shade } of toonMaterials) {
                    material.shadingToonyFactor = next ? 0.91 : softness;
                    material.shadingShiftFactor = next ? -0.065 : shift;
                    material.shadeColorFactor.copy(shade).multiplyScalar(next ? 0.86 : 1);
                }
                ambient.intensity = next ? 1.65 : 2.2;
                return toonCg;
            },
            expressionOptions: face.supported,
            capabilities: {
                name: vrm.meta.name || vrm.meta.title,
                authors: vrm.meta.authors ?? [vrm.meta.author].filter(Boolean),
                version: vrm.meta.metaVersion,
                bones: Object.keys(vrm.humanoid.humanBones),
                expressions: Object.keys(expression?.expressionMap ?? {}),
                lookAt: Boolean(vrm.lookAt),
                springBone: Boolean(vrm.springBoneManager?.joints.size),
                materials: [...new Set((vrm.materials ?? []).map(material => material.type))],
                webgl: gl.getParameter(gl.VERSION),
                renderer: gpu ? gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL) : null,
            },
            resize(width, height, scale) {
                if (viewport?.width === width && viewport.height === height && viewport.scale === scale) return;
                const aspect = width / height;
                const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
                const distance = Math.max(size.y, size.x / aspect) * 0.57 / Math.tan(halfFov);
                viewport = { width, height, scale, aspect, distance };
                // Native size and CG changes use the current backing surface. The CSS canvas
                // stretches it during a resize while projection follows the actual viewport.
                if (!surface || surface.scale !== scale || width > surface.width * 1.35 || height > surface.height * 1.35) {
                    renderer.setDrawingBufferSize(width, height, scale);
                    surface = viewport;
                }
                camera.aspect = aspect;
                camera.position.set(center.x, center.y, center.z + distance);
                camera.lookAt(center);
                camera.updateProjectionMatrix();
            },
            draw(pose) {
                const started = performance.now();
                for (const name of motionMask) {
                    const entry = stageNodes.get(name);
                    entry.node.quaternion.copy(entry.default);
                }
                if (hips) hips.rotation.y = pose.sway * 0.09;
                motionMask = pose.bodyMotion?.mask ?? [];
                const bodyOwnsHead = motionMask.includes("head") || motionMask.includes("neck");
                if (head) {
                    const g = bodyOwnsHead ? null : pose.gesture;
                    head.rotation.x = pose.lookY * 0.12 + (g?.pitch ?? 0);
                    head.rotation.y = pose.lookX * 0.20 + (g?.yaw ?? 0);
                    head.rotation.z = pose.sway * 0.035 + (g?.roll ?? 0);
                }
                motionMask.forEach((name, index) => {
                    const entry = stageNodes.get(name);
                    if (!entry) return;
                    if (pose.bodyMotion.blend >= 0.999) entry.node.quaternion.copy(pose.bodyMotion.rotations[index]);
                    else entry.node.quaternion.slerp(pose.bodyMotion.rotations[index], pose.bodyMotion.blend);
                });
                motionFrame = pose.bodyMotion ? {
                    motion: pose.bodyMotion.motion, at: pose.bodyMotion.at, blend: pose.bodyMotion.blend,
                    releasing: Boolean(pose.bodyMotion.releasing), ownsHead: bodyOwnsHead,
                    rotations: Object.fromEntries(motionMask.map(name => [name, stageNodes.get(name).node.quaternion.toArray()])),
                } : null;
                look.position.set(center.x + pose.lookX * 1.1, center.y + size.y * 0.34 - pose.lookY, center.z + 2);
                face.apply(pose);
                vrm.update(pose.dt);
                vrmUpdates++;
                renderer.render(scene, camera);
                if (requestedHitMap && hitMapWarm && !readingHitMap) {
                    requestedHitMap = false;
                    readingHitMap = true;
                    const renderedViewport = viewport;
                    renderHitMap();
                    void renderer.readRenderTargetPixelsAsync(hitTarget, 0, 0, maskSize, maskSize, new Uint8Array(maskSize ** 2 * 4))
                        .then(buffer => storeHitMap(buffer, renderedViewport)).catch(() => {})
                        .finally(() => { readingHitMap = false; });
                }
                latestDrawMs = performance.now() - started;
            },
            motionRig: () => rig,
            capturePose,
            motion: () => ({ compatible: Boolean(rig), active: motionFrame, vrmUpdates, latestDrawMs,
                head: head ? [head.rotation.x, head.rotation.y, head.rotation.z] : null }),
            face() {
                const state = face.snapshot();
                if (!state) return null;
                const actual = {};
                for (const name of [...Object.keys(state.used), "aa", "blink", "blinkLeft", "blinkRight"]) {
                    const values = expression?.getExpression(name)?.binds.flatMap(bind =>
                        (bind.primitives ?? []).map(primitive => primitive.morphTargetInfluences?.[bind.index] ?? 0)) ?? [];
                    if (values.length) actual[name] = Math.max(...values);
                }
                return { ...state, actual };
            },
            prepareHit,
            warmHitMap,
            hit(x, y, click = false) {
                prepareHit();
                if (!usableHitMap() && click) {
                    renderHitMap();
                    const buffer = new Uint8Array(maskSize ** 2 * 4);
                    renderer.readRenderTargetPixels(hitTarget, 0, 0, maskSize, maskSize, buffer);
                    storeHitMap(buffer, viewport);
                }
                if (!usableHitMap()) return false;
                // At the same camera distance, only the horizontal projection changes.
                x *= viewport.aspect / hitMapViewport.aspect;
                if (x < -1 || x > 1) return false;
                const i = Math.min(maskSize - 1, Math.floor((x + 1) * maskSize / 2));
                const j = Math.min(maskSize - 1, Math.floor((1 - y) * maskSize / 2));
                return hitPixels[(j * maskSize + i) * 4 + 3] > 24;
            },
            dispose() {
                disposed = true;
                hitTarget.dispose();
                disposeVrm(vrm.scene);
                scene.clear();
                renderer.dispose();
                renderer.forceContextLoss();
            },
        };
    } catch (error) {
        disposeVrm(model.scene);
        renderer?.dispose();
        renderer?.forceContextLoss();
        throw error;
    }
}
