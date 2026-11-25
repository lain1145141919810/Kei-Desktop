import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { shortBlink } from "../../frontend/character/blink.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const compDir = path.join(here, "../../../round-16-17-integration/private-kei", "comparisons");
const clipsDir = path.join(here, "../../../round-16-17-integration/private-kei", "clips");
const originalDir = path.resolve(here, "../../../round-10/private-kei");
const r16Vrm = path.resolve(process.env.KEI_VRM_MODEL ?? path.join(here, "../../../round-16-17-integration/private-kei/kei-pmx-r16.vrm"));
const sameLineWav = path.resolve(here, "../../../round-15/private-kei/same-line.wav");
const characterDir = path.resolve(here, "../../frontend/character");

const requireBuild = createRequire(path.join(characterDir, "package.json"));
const requireFrontend = createRequire(path.join(characterDir, "../package.json"));
const { build } = requireBuild("esbuild");
const { chromium } = requireFrontend("playwright-core");

await fs.mkdir(compDir, { recursive: true });
await fs.mkdir(clipsDir, { recursive: true });

const bundle = await build({
    entryPoints: [path.join(here, "render-pmx-vrm-cg-browser.mjs")],
    bundle: true,
    write: false,
    target: "chrome140",
    format: "esm",
    nodePaths: [path.join(characterDir, "node_modules")],
});

const texDir = path.join(originalDir, "pmx", "textures");
const texSet = new Set(await fs.readdir(texDir));
const routes = new Map([
    ["/", ["text/html", '<!doctype html><meta charset="utf-8"><script type="module" src="/app.js"></script>']],
    ["/app.js", ["text/javascript", bundle.outputFiles[0].contents]],
    ["/pmx-geometry.json", ["application/json", await fs.readFile(path.join(originalDir, "pmx-geometry.json"))]],
    ["/kei-r16.vrm", ["application/octet-stream", await fs.readFile(r16Vrm)]],
]);

const server = http.createServer(async (req, res) => {
    try {
        const url = decodeURIComponent(req.url);
        const r = routes.get(url);
        if (url === "/favicon.ico") res.writeHead(204).end();
        else if (r) res.writeHead(200, { "content-type": r[0], "cache-control": "no-store" }).end(r[1]);
        else if (url.startsWith("/texture/") && texSet.has(url.slice(9))) {
            res.writeHead(200, { "content-type": url.endsWith(".bmp") ? "image/bmp" : "image/png", "cache-control": "no-store" })
                .end(await fs.readFile(path.join(texDir, url.slice(9))));
        } else res.writeHead(404).end();
    } catch {
        res.destroy();
    }
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const edge = path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe");
let browser;

try {
    browser = await chromium.launch({ headless: true, executablePath: edge });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on("pageerror", e => console.error("[pageerror]", e));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof window.initComparison === "function");
    const initInfo = await page.evaluate(() => window.initComparison());
    console.log("Initialized matched comparison scenes:", {
        toonMaterials: initInfo.toonMaterialCount,
        expressions: initInfo.expressions.length,
    });

    const metricsReport = {
        camera: {
            type: "PerspectiveCamera",
            fovDeg: 30,
            frontYawDeg: 0,
            threeQuarterYawDeg: Number((0.45 * 180 / Math.PI).toFixed(2)),
            armRestPoseRad: { leftUpperArmZ: -1.10, rightUpperArmZ: 1.10 },
        },
        lightingAndMaterialDifferences: {
            "pmx-ref": {
                material: "MeshStandardMaterial (roughness=0.95, metalness=0, baseColor=1.0, no MToon ramp, no outline)",
                hemisphereLight: { sky: "#ffffff", ground: "#b7c2e0", intensity: 1.05 },
                directionalLight: { color: "#fff4e6", intensity: 1.05, position: [2, 3, 4] },
                note: "Matched diffuse reference brightness avoiding highlight clipping on baseColor=1.0 PBR.",
            },
            "pmx-equal": {
                material: "MeshStandardMaterial (roughness=0.95, metalness=0, baseColor=1.0, no MToon ramp, no outline)",
                hemisphereLight: { sky: "#ffffff", ground: "#b7c2e0", intensity: 2.2 },
                directionalLight: { color: "#fff4e6", intensity: 2.2, position: [2, 3, 4] },
                note: "Exact desktop light rig intensity applied to unscaled PMX diffuse=1.0 (demonstrates why VRM uses baseColorFactor=0.56).",
            },
            "normal-vrm": {
                material: "MToonMaterial (baseColorFactor=0.56, oral=[0.92,0.77,0.76], shade=0.86 head / 0.70 tf / 0.76 other, shadingShift=0.04, shadingToony=0.40, giEqualization=0.70, outline=none)",
                hemisphereLight: { sky: "#ffffff", ground: "#b7c2e0", intensity: 2.2 },
                directionalLight: { color: "#fff4e6", intensity: 2.2, position: [2, 3, 4] },
            },
            "toon-cg": {
                material: "MToonMaterial desktop CG overrides (shadingToony=0.91, shadingShift=-0.065, shadeColorFactor*=0.86, outline=none)",
                hemisphereLight: { sky: "#ffffff", ground: "#b7c2e0", intensity: 1.65 },
                directionalLight: { color: "#fff4e6", intensity: 2.2, position: [2, 3, 4] },
                note: "Higher cel-step sharpness (0.91 vs 0.40), deeper shifted shadows (-0.065 shift, 0.86x shade), lower ambient fill (1.65 vs 2.2).",
            },
        },
        upperBodyMetrics: {},
        faceMetrics: {},
        clips: [],
    };

    // 1. Matched Upper-Body Front & Three-Quarter comparison (4 columns x 2 rows)
    const upperCells = [];
    for (const [viewName, yawRad] of [["front", 0], ["34", 0.45]]) {
        metricsReport.upperBodyMetrics[viewName] = {};
        for (const [mode, label] of [
            ["pmx-ref", "Original PMX (Matched Ref 1.05)"],
            ["pmx-equal", "Original PMX (Equal Rig 2.2)"],
            ["normal-vrm", "Normal VRM r16 (Desktop Rig)"],
            ["toon-cg", "MToon CG r16 (CG Rig)"],
        ]) {
            const res = await page.evaluate(args => window.renderPanel(args), {
                mode, framing: "upper", width: 420, height: 520, yawRad, expression: "neutral",
                statsRoi: [0.22, 0.14, 0.56, 0.78],
            });
            await fs.writeFile(path.join(compDir, `upper-${viewName}-${mode}.png`), Buffer.from(res.pngBase64, "base64"));
            metricsReport.upperBodyMetrics[viewName][mode] = res.metrics;
            upperCells.push({ pngBase64: res.pngBase64, label: `${viewName === "front" ? "Front" : "3/4"} · ${label}` });
        }
    }
    const upperSheet = await page.evaluate(args => window.composeSheet(args), {
        cols: 4, rows: 2, cellW: 420, cellH: 520,
        title: "Round 17 Matched Camera & Pose — Upper Body (Original PMX vs Normal VRM r16 vs MToon CG r16)",
        cells: upperCells,
    });
    await fs.writeFile(path.join(compDir, "sheet-upperbody-front-34.png"), Buffer.from(upperSheet, "base64"));

    // 2. Matched Face Close-Ups: Front & Three-Quarter across neutral, eyesClosed, happy, shout!
    const exprSpecs = [
        ["neutral", "Neutral (Open)"],
        ["eyesClosed", "Full Closure (eyesClosed)"],
        ["happy", "Smiling Closure (happy)"],
        ["shout", "Shout (shout)"],
    ];

    for (const [viewName, yawRad, viewTitle] of [["front", 0, "Front (0 deg)"], ["34", 0.45, "Three-Quarter (+25.8 deg)"]]) {
        const cells = [];
        metricsReport.faceMetrics[viewName] = {};
        for (const [expr, exprLabel] of exprSpecs) {
            metricsReport.faceMetrics[viewName][expr] = {};
            for (const [mode, modeLabel] of [
                ["pmx-ref", expr === "neutral" ? "Original PMX (Ref 1.05)" : "Original PMX (Rest — no morphs)"],
                ["normal-vrm", "Normal VRM r16"],
                ["toon-cg", "MToon CG r16"],
            ]) {
                const res = await page.evaluate(args => window.renderPanel(args), {
                    mode, framing: "face", width: 440, height: 440, yawRad, expression: expr,
                    statsRoi: [0.28, 0.25, 0.44, 0.50],
                });
                if (mode !== "pmx-ref" || expr === "neutral") {
                    await fs.writeFile(path.join(compDir, `face-${viewName}-${expr}-${mode}.png`), Buffer.from(res.pngBase64, "base64"));
                }
                metricsReport.faceMetrics[viewName][expr][mode] = res.metrics;
                cells.push({ pngBase64: res.pngBase64, label: `${exprLabel} · ${modeLabel}` });
            }
        }
        const sheet = await page.evaluate(args => window.composeSheet(args), {
            cols: 3, rows: 4, cellW: 440, cellH: 440,
            title: `Round 17 Matched Face Comparison — ${viewTitle} (Original PMX | Normal VRM r16 | MToon CG r16)`,
            cells,
        });
        await fs.writeFile(path.join(compDir, `sheet-face-${viewName}-4expr.png`), Buffer.from(sheet, "base64"));
    }
    console.log("Rendered matched upper-body and 4-expression Front & 3/4 comparison sheets!");

    // 3. Matched Speech + Blink Clips at 24 FPS using round-15 same-line.wav + shortBlink!
    const wave = await fs.readFile(sameLineWav);
    const rate = wave.readUInt32LE(24);
    const dataStart = wave.indexOf("data", 36) + 8;
    const duration = (wave.length - dataStart) / (rate * 2);
    const fps = 24;
    const lead = 6;
    const totalFrames = lead + Math.ceil(duration * fps) + 12;
    const frames = Array.from({ length: totalFrames }, (_, i) => {
        const time = (i - lead) / fps;
        const active = time >= 0 && time < duration;
        let energy = 0;
        const count = Math.floor(rate / 100);
        if (active) {
            for (let j = 0; j < count; j++) {
                const off = dataStart + (Math.floor(time * rate) + j) * 2;
                if (off + 2 <= wave.length) energy += (wave.readInt16LE(off) / 32768) ** 2;
            }
        }
        return {
            index: i,
            timeSec: Number(time.toFixed(3)),
            mouth: Number(Math.min(1, 3.4 * Math.sqrt(energy / count)).toFixed(4)),
            active,
            blink: Number(shortBlink((time - 0.94) * 1000).toFixed(4)),
            returningNeutral: time > duration + 0.35,
        };
    });

    const peakBlinkIdx = frames.reduce((best, f, idx) => f.blink > frames[best].blink ? idx : best, 0);
    const peakMouthIdx = frames.reduce((best, f, idx) => f.mouth > frames[best].mouth ? idx : best, 0);
    const keyIndices = [...new Set([0, Math.max(0, peakMouthIdx - 4), peakMouthIdx, Math.max(0, peakBlinkIdx - 1), peakBlinkIdx, Math.min(totalFrames - 1, peakBlinkIdx + 2), totalFrames - 1])].sort((a, b) => a - b);

    for (const [expr] of exprSpecs) {
        for (const [viewName, yawRad] of [["front", 0], ["34", 0.45]]) {
            const clipName = `${expr}-${viewName}`;
            const dir = path.join(clipsDir, clipName);
            await fs.mkdir(dir, { recursive: true });
            const keyCells = [];
            for (const f of frames) {
                const pose = f.returningNeutral ? "neutral" : expr;
                const blinkVal = f.blink;
                const label = `f${String(f.index).padStart(2, "0")} t=${f.timeSec.toFixed(2)}s aa=${f.mouth.toFixed(2)} blk=${blinkVal.toFixed(2)}`;
                const jpgB64 = await page.evaluate(args => window.renderTripletFrame(args), {
                    width: 320, height: 320, yawRad, expression: pose, mouth: f.mouth, blink: blinkVal, speaking: f.active, label,
                });
                await fs.writeFile(path.join(dir, String(f.index).padStart(4, "0") + ".jpg"), Buffer.from(jpgB64, "base64"));
                if (keyIndices.includes(f.index)) {
                    // Convert JPEG strip directly into a quick visual review strip via composeSheet (data URL is PNG/JPEG compatible in Image!)
                    keyCells.push({ pngBase64: jpgB64, label });
                }
            }
            metricsReport.clips.push({
                name: clipName,
                expression: expr,
                view: viewName,
                fps,
                frameCount: frames.length,
                durationSec: Number((frames.length / fps).toFixed(2)),
                peakMouthFrame: peakMouthIdx,
                peakBlinkFrame: peakBlinkIdx,
                keyframeIndices: keyIndices,
            });
            console.log(`Rendered clip ${clipName}: ${frames.length} triplet frames at ${fps} FPS`);
        }
    }

    await fs.writeFile(path.join(clipsDir, "timeline.json"), JSON.stringify({ fps, lead, audioDurationSec: Number(duration.toFixed(3)), keyIndices, frames }, null, 2) + "\n");
    await fs.writeFile(path.join(here, "../../../round-16-17-integration/pmx-vrm-cg-metrics.json"), JSON.stringify(metricsReport, null, 2) + "\n");
    console.log("PASS All matched PMX / VRM / MToon CG sheets, metrics, and 8 speech+blink clips rendered!");
} finally {
    await browser?.close();
    server.close();
}
