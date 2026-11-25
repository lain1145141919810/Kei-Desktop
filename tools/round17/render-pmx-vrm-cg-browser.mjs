import {
    Bone, Box3, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, FrontSide,
    Group, HemisphereLight, MeshStandardMaterial, PerspectiveCamera, Scene, Skeleton, SkinnedMesh,
    SRGBColorSpace, TextureLoader, Uint16BufferAttribute, Vector3, WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { createFaceMixer } from "../../frontend/character/face.mjs";

const METER = 0.08;
const fromPmx = v => new Vector3(v[0], v[1], -v[2]);

let renderer, camera, pmxScene, pmxRig, vrmScene, vrmModel, vrmMixer, vrmLights, vrmToonMaterials;
let pmxLights;
let sharedBounds;

async function buildOriginalPmx(pmx) {
    const ground = pmx.vertices.reduce((min, v) => Math.min(min, v[1] * METER), Infinity);
    const meters = v => fromPmx(v).multiplyScalar(METER).sub(new Vector3(0, ground, 0));
    const bonePositions = pmx.bones.map(b => meters(b.position));
    const root = new Group();
    const bones = bonePositions.map((pos, i) => {
        const bone = new Bone();
        bone.name = pmx.bones[i].name;
        return bone;
    });
    const spineIdx = pmx.bones.findIndex(b => b.name === "上半身");
    const hipsIdx = pmx.bones.findIndex(b => b.name === "下半身");
    bones.forEach((bone, i) => {
        const parentIndex = i === spineIdx ? hipsIdx : pmx.bones[i].parent;
        (bones[parentIndex] ?? root).add(bone);
        bone.position.copy(bonePositions[i]);
        if (parentIndex >= 0) bone.position.sub(bonePositions[parentIndex]);
    });

    const leftArm = bones.find(b => b.name === "左腕");
    const rightArm = bones.find(b => b.name === "右腕");

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(pmx.vertices.flatMap(v => meters(v).toArray()), 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(pmx.normals.flatMap(v => fromPmx(v).normalize().toArray()), 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(pmx.uvs.flat(), 2));
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute(pmx.joints.flat(), 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(pmx.weights.flat(), 4));
    const indices = pmx.indices.slice();
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    geometry.setIndex(indices);
    pmx.materials.forEach((mat, i) => geometry.addGroup(mat.start, mat.count, i));

    const loader = new TextureLoader();
    const texCache = new Map();
    const materials = await Promise.all(pmx.materials.map(async item => {
        if (item.texture && !texCache.has(item.texture)) {
            const fname = item.texture.split("/").at(-1);
            texCache.set(item.texture, loader.loadAsync("/texture/" + encodeURIComponent(fname)).then(tex => {
                tex.flipY = false;
                tex.colorSpace = SRGBColorSpace;
                return tex;
            }));
        }
        const map = item.texture ? await texCache.get(item.texture) : null;
        return new MeshStandardMaterial({
            name: item.name,
            color: new Color().fromArray(item.diffuse),
            opacity: item.diffuse[3],
            map,
            roughness: 0.95,
            metalness: 0,
            side: item.flags & 1 ? DoubleSide : FrontSide,
            alphaTest: 0.09,
        });
    }));

    const mesh = new SkinnedMesh(geometry, materials);
    mesh.name = "Original PMX";
    root.add(mesh);
    root.updateMatrixWorld(true);
    mesh.normalizeSkinWeights();
    mesh.bind(new Skeleton(bones));
    // Apply desktop rest arm pose AFTER binding in T-pose so skin deformation matches vrm.mjs lines 103-104!
    if (leftArm) leftArm.rotation.z = -1.10;
    if (rightArm) rightArm.rotation.z = 1.10;
    root.updateMatrixWorld(true);
    return root;
}

window.initComparison = async () => {
    const [pmx, vrmBin] = await Promise.all([
        fetch("/pmx-geometry.json").then(r => r.json()),
        fetch("/kei-r16.vrm").then(r => r.arrayBuffer()),
    ]);

    renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    document.body.style.cssText = "margin:0;overflow:hidden;background:#646464";
    document.body.append(renderer.domElement);
    camera = new PerspectiveCamera(30, 1, 0.02, 50);

    // 1. Original PMX scene
    pmxRig = await buildOriginalPmx(pmx);
    pmxScene = new Scene();
    pmxScene.background = new Color("#646464");
    const pmxHemi = new HemisphereLight(0xffffff, 0xb7c2e0, 1.05);
    const pmxDir = new DirectionalLight(0xfff4e6, 1.05);
    pmxDir.position.set(2, 3, 4);
    pmxScene.add(pmxRig, pmxHemi, pmxDir);
    pmxLights = { hemi: pmxHemi, dir: pmxDir };

    // 2. Round 16 VRM / MToon CG scene (exact desktop lighting & pose from vrm.mjs!)
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const parsed = await loader.parseAsync(vrmBin, "");
    vrmModel = parsed.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(vrmModel.scene);
    VRMUtils.combineSkeletons(vrmModel.scene);
    VRMUtils.rotateVRM0(vrmModel);

    // Match exact desktop arm pose (vrm.mjs lines 101-104)
    const leftArm = vrmModel.humanoid.getNormalizedBoneNode("leftUpperArm");
    const rightArm = vrmModel.humanoid.getNormalizedBoneNode("rightUpperArm");
    if (leftArm) leftArm.rotation.z = -1.10;
    if (rightArm) rightArm.rotation.z = 1.10;
    vrmModel.update(0);

    vrmScene = new Scene();
    vrmScene.background = new Color("#646464");
    const vrmHemi = new HemisphereLight(0xffffff, 0xb7c2e0, 2.2);
    const vrmDir = new DirectionalLight(0xfff4e6, 2.2);
    vrmDir.position.set(2, 3, 4);
    vrmScene.add(vrmModel.scene, vrmHemi, vrmDir);
    vrmLights = { hemi: vrmHemi, dir: vrmDir };

    vrmToonMaterials = (vrmModel.materials ?? []).filter(m => m.isMToonMaterial).map(material => ({
        material,
        softness: material.shadingToonyFactor,
        shift: material.shadingShiftFactor,
        shade: material.shadeColorFactor.clone(),
    }));
    vrmMixer = createFaceMixer(vrmModel.expressionManager);

    const bounds = new Box3().setFromObject(vrmModel.scene);
    const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    sharedBounds = { center, size, minY: bounds.min.y, maxY: bounds.max.y };
    return {
        bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), size: size.toArray() },
        toonMaterialCount: vrmToonMaterials.length,
        expressions: Object.keys(vrmModel.expressionManager.expressionMap),
    };
};

function setToonCg(enabled) {
    for (const { material, softness, shift, shade } of vrmToonMaterials) {
        material.shadingToonyFactor = enabled ? 0.91 : softness;
        material.shadingShiftFactor = enabled ? -0.065 : shift;
        material.shadeColorFactor.copy(shade).multiplyScalar(enabled ? 0.86 : 1);
    }
    vrmLights.hemi.intensity = enabled ? 1.65 : 2.2;
    vrmLights.dir.intensity = 2.2;
}

function setCamera(framing, width, height, yawRad = 0) {
    const aspect = width / height;
    camera.aspect = aspect;
    let targetY, dist, pitchOffset;
    if (framing === "face") {
        targetY = 1.285;
        dist = 0.64;
        pitchOffset = 0.015;
    } else if (framing === "upper") {
        targetY = 1.07;
        dist = 1.52;
        pitchOffset = 0.03;
    } else {
        // Full desktop framing (matches vrm.mjs line 210!)
        const halfFov = (camera.fov * Math.PI) / 360;
        targetY = sharedBounds.center.y;
        dist = Math.max(sharedBounds.size.y, sharedBounds.size.x / aspect) * 0.57 / Math.tan(halfFov);
        pitchOffset = 0;
    }
    const cx = sharedBounds.center.x;
    const cz = sharedBounds.center.z;
    camera.position.set(
        cx + dist * Math.sin(yawRad),
        targetY + pitchOffset,
        cz + dist * Math.cos(yawRad),
    );
    camera.lookAt(cx, targetY, cz);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}

// Render one panel and optionally compute ROI pixel stats
window.renderPanel = ({ mode, framing, width, height, yawRad = 0, expression = null, mouth = 0, blink = 0, speaking = false, statsRoi = null }) => {
    setCamera(framing, width, height, yawRad);
    if (mode === "pmx-ref") {
        pmxLights.hemi.intensity = 1.05;
        pmxLights.dir.intensity = 1.05;
        renderer.render(pmxScene, camera);
    } else if (mode === "pmx-equal") {
        pmxLights.hemi.intensity = 2.2;
        pmxLights.dir.intensity = 2.2;
        renderer.render(pmxScene, camera);
    } else {
        setToonCg(mode === "toon-cg");
        vrmMixer.apply({
            expressionPreview: expression && expression !== "neutral" ? { values: { [expression]: 1 } } : null,
            mouth,
            blink,
            speaking,
            smile: 0,
        });
        vrmModel.update(0);
        renderer.render(vrmScene, camera);
    }

    let metrics = null;
    if (statsRoi) {
        const tmp = document.createElement("canvas");
        tmp.width = width; tmp.height = height;
        const ctx = tmp.getContext("2d");
        ctx.drawImage(renderer.domElement, 0, 0);
        const [rx, ry, rw, rh] = statsRoi;
        const img = ctx.getImageData(Math.round(rx * width), Math.round(ry * height), Math.round(rw * width), Math.round(rh * height)).data;
        let sr = 0, sg = 0, sb = 0, n = 0;
        const lumas = [];
        for (let i = 0; i < img.length; i += 4) {
            const r = img[i], g = img[i + 1], b = img[i + 2];
            // Exclude exact gray backdrop (#646464 = 100,100,100)
            if (Math.abs(r - 100) <= 2 && Math.abs(g - 100) <= 2 && Math.abs(b - 100) <= 2) continue;
            sr += r; sg += g; sb += b; n++;
            lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        }
        lumas.sort((a, b) => a - b);
        const pick = q => lumas.length ? Number(lumas[Math.min(lumas.length - 1, Math.floor(q * lumas.length))].toFixed(2)) : 0;
        const meanLuma = lumas.length ? lumas.reduce((a, b) => a + b, 0) / lumas.length : 0;
        const variance = lumas.length ? lumas.reduce((s, v) => s + (v - meanLuma) ** 2, 0) / lumas.length : 0;
        metrics = {
            fgPixels: n,
            meanRgb: n ? [Number((sr / n).toFixed(2)), Number((sg / n).toFixed(2)), Number((sb / n).toFixed(2))] : [0, 0, 0],
            lumaMean: Number(meanLuma.toFixed(2)),
            lumaStd: Number(Math.sqrt(variance).toFixed(2)),
            lumaP10: pick(0.1),
            lumaP50: pick(0.5),
            lumaP90: pick(0.9),
            lumaRangeP90MinusP10: Number((pick(0.9) - pick(0.1)).toFixed(2)),
        };
    }

    return {
        pngBase64: renderer.domElement.toDataURL("image/png").split(",")[1],
        metrics,
    };
};

// Render a 3-panel side-by-side clip frame (Original PMX Ref | Normal VRM | MToon CG) as JPEG base64!
let stripCanvas, stripCtx;
window.renderTripletFrame = ({ width, height, yawRad, expression, mouth, blink, speaking, label }) => {
    const totalW = width * 3;
    const barH = 26;
    if (!stripCanvas || stripCanvas.width !== totalW || stripCanvas.height !== height + barH) {
        stripCanvas = document.createElement("canvas");
        stripCanvas.width = totalW;
        stripCanvas.height = height + barH;
        stripCtx = stripCanvas.getContext("2d");
    }
    stripCtx.fillStyle = "#22252b";
    stripCtx.fillRect(0, 0, totalW, height + barH);

    const panels = [
        ["pmx-ref", "Original PMX (rest ref, 1.05/1.05)"],
        ["normal-vrm", `Normal VRM r16 (${expression})`],
        ["toon-cg", `MToon CG r16 (${expression})`],
    ];
    panels.forEach(([mode, title], idx) => {
        setCamera("face", width, height, yawRad);
        if (mode === "pmx-ref") {
            pmxLights.hemi.intensity = 1.05;
            pmxLights.dir.intensity = 1.05;
            renderer.render(pmxScene, camera);
        } else {
            setToonCg(mode === "toon-cg");
            vrmMixer.apply({
                expressionPreview: expression && expression !== "neutral" ? { values: { [expression]: 1 } } : null,
                mouth,
                blink,
                speaking,
                smile: 0,
            });
            vrmModel.update(0);
            renderer.render(vrmScene, camera);
        }
        stripCtx.drawImage(renderer.domElement, idx * width, 0);
        stripCtx.fillStyle = "#e6e8ee";
        stripCtx.font = "13px Segoe UI, sans-serif";
        stripCtx.fillText(`${title}${idx > 0 ? "  " + label : ""}`, idx * width + 8, height + 18);
    });
    return stripCanvas.toDataURL("image/jpeg", 0.90).split(",")[1];
};

// Assemble a labeled grid contact sheet from rendered PNG data URLs
window.composeSheet = async ({ cols, rows, cellW, cellH, title, cells }) => {
    const headerH = 44;
    const labelH = 28;
    const pad = 10;
    const W = cols * cellW + (cols + 1) * pad;
    const H = headerH + rows * (cellH + labelH) + (rows + 1) * pad;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1c1f24";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f2f4f8";
    ctx.font = "bold 18px Segoe UI, sans-serif";
    ctx.fillText(title, pad + 4, 29);

    for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = pad + col * (cellW + pad);
        const y = headerH + pad + row * (cellH + labelH + pad);
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + c.pngBase64; });
        ctx.drawImage(img, x, y, cellW, cellH);
        ctx.fillStyle = "#2b2f38";
        ctx.fillRect(x, y + cellH, cellW, labelH);
        ctx.fillStyle = "#e7eaf0";
        ctx.font = "13px Segoe UI, sans-serif";
        ctx.fillText(c.label, x + 8, y + cellH + 19);
    }
    return canvas.toDataURL("image/png").split(",")[1];
};
