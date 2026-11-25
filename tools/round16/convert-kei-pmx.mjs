import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const round = path.dirname(fileURLToPath(import.meta.url));
const local = path.resolve(process.env.KEI_ROUND16_OUTPUT ?? path.join(round, "../../../round-16-17-integration/private-kei"));
const diagDir = path.join(local, "eyelid-diag");
const transDir = path.join(local, "blink-transitions");
const original = path.join(round, "../../../round-10/private-kei");
const character = path.resolve(round, "../../frontend/character");
const requireBuild = createRequire(path.join(character, "package.json"));
const requireFrontend = createRequire(path.join(character, "../package.json"));
const { build } = requireBuild("esbuild");
const { chromium } = requireFrontend("playwright-core");

await fs.mkdir(local, { recursive: true });
await fs.mkdir(diagDir, { recursive: true });
await fs.mkdir(transDir, { recursive: true });

const generated = await build({
    entryPoints: [path.join(round, "convert-kei-pmx-browser.mjs")], bundle: true, write: false,
    target: "chrome140", format: "esm", nodePaths: [path.join(character, "node_modules")],
});

const textureDirectory = path.join(original, "pmx/textures");
const textures = new Set(await fs.readdir(textureDirectory));
const routes = new Map([
    ["/", ["text/html", '<!doctype html><meta charset="utf-8"><script type="module" src="/convert.js"></script>']],
    ["/convert.js", ["text/javascript", generated.outputFiles[0].contents]],
    ["/input.fbx", ["application/octet-stream", await fs.readFile(path.join(original, "fbx/kei.fbx"))]],
    ["/pmx-geometry.json", ["application/json", await fs.readFile(path.join(original, "pmx-geometry.json"))]],
    ["/skeleton.json", ["application/json", await fs.readFile(path.join(round, "../../../round-10/HAST-SEC/configs/skeleton_profile.json"))]],
]);

const server = http.createServer(async (request, response) => {
    try {
        if (request.method !== "GET") { response.writeHead(405).end(); return; }
        const url = decodeURIComponent(request.url);
        const route = routes.get(url);
        if (url === "/favicon.ico") {
            response.writeHead(204).end();
        } else if (route) {
            response.writeHead(200, { "content-type": route[0], "cache-control": "no-store" }).end(route[1]);
        } else if (url.startsWith("/texture/") && textures.has(url.slice(9))) {
            response.writeHead(200, { "content-type": url.endsWith(".bmp") ? "image/bmp" : "image/png", "cache-control": "no-store" })
                .end(await fs.readFile(path.join(textureDirectory, url.slice(9))));
        } else {
            response.writeHead(404).end();
        }
    } catch {
        response.destroy();
    }
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const edge = path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe");
let browser;
try {
    browser = await chromium.launch({ headless: true, executablePath: edge });
    const page = await browser.newPage();
    page.on("console", message => {
        if (message.type() === "error" || message.type() === "warning") console.error(`[${message.type()}]`, message.text());
    });
    page.on("pageerror", err => console.error("[pageerror]", err));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof window.convert === "function");

    const metadata = await page.evaluate(() => window.convert());

    // 1. Export VRM binary
    const binary = await page.evaluate(async () => {
        const blob = new Blob([window.resultVrm]);
        return new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result.split(",")[1]);
            reader.readAsDataURL(blob);
        });
    });
    const buffer = Buffer.from(binary, "base64");
    const targetName = "kei-pmx-r16.vrm";
    const target = path.join(local, targetName);
    await fs.writeFile(target, buffer);
    metadata.sha256 = createHash("sha256").update(buffer).digest("hex");
    metadata.bytes = buffer.length;
    await fs.writeFile(path.join(local, "pmx-conversion.json"), JSON.stringify(metadata, null, 2) + "\n");

    // 2. Render 8-panel eyelid diagnostic suite + MToon CG + happy/shout close-ups!
    await page.setViewportSize({ width: 700, height: 700 });
    const diagSpecs = [
        ["01-lit-full-zoom.png",       "lit-full",        "eyesClosed", 0, 0],
        ["02-unlit-full-zoom.png",     "unlit-full",      "eyesClosed", 0, 0],
        ["03-lit-notex-head-zoom.png", "lit-notex-head",  "eyesClosed", 0, 0],
        ["04-unlit-head-only-zoom.png","unlit-head-only", "eyesClosed", 0, 0],
        ["05-lit-head-only-zoom.png",  "lit-head-only",   "eyesClosed", 0, 0],
        ["06-normals-head-zoom.png",   "normals-head",    "eyesClosed", 0, 0],
        ["07-lit-full-34-zoom.png",    "lit-full",        "eyesClosed", 0, 0.45],
        ["08-unlit-full-34-zoom.png",  "unlit-full",      "eyesClosed", 0, 0.45],
        ["09-toon-cg-zoom.png",        "toon-cg",         "eyesClosed", 0, 0],
        ["10-toon-cg-34-zoom.png",     "toon-cg",         "eyesClosed", 0, 0.45],
        ["11-happy-lit-zoom.png",      "lit-full",        "happy",      0, 0],
        ["12-happy-34-zoom.png",       "lit-full",        "happy",      0, 0.45],
        ["13-shout-lit-zoom.png",      "lit-full",        "shout",      0, 0],
        ["14-shout-34-zoom.png",       "lit-full",        "shout",      0, 0.45],
    ];
    for (const [file, mode, expr, blink, angle] of diagSpecs) {
        await page.evaluate(args => window.renderEyelidDiagnostic(...args), [mode, 700, 700, expr, blink, angle]);
        await page.locator("canvas").screenshot({ path: path.join(diagDir, file) });
    }

    // 3. Render blink transition sequence (frontal & 3/4 at 0.0, 0.25, 0.50, 0.75, 1.0)
    for (const t of [0.0, 0.25, 0.50, 0.75, 1.0]) {
        const tag = String(Math.round(t * 100)).padStart(3, "0");
        await page.evaluate(args => window.renderEyelidDiagnostic(...args), ["lit-full", 700, 700, null, t, 0]);
        await page.locator("canvas").screenshot({ path: path.join(transDir, `blink-front-${tag}.png`) });
        await page.evaluate(args => window.renderEyelidDiagnostic(...args), ["lit-full", 700, 700, null, t, 0.45]);
        await page.locator("canvas").screenshot({ path: path.join(transDir, `blink-34-${tag}.png`) });
    }

    // 4. Render all expression portraits (same framing as Round 15!)
    const portraits = ["neutral", "bashful", "flustered", "surprised", "shout", "relieved", "worried", "skeptical", "eyesClosed", "happy", "sad", "angry", "thoughtful", "relaxed"];
    for (const expression of portraits) {
        await page.evaluate(name => window.preview("face", 700, 700, name), expression);
        await page.locator("canvas").screenshot({ path: path.join(local, `model-${expression}.png`) });
    }

    console.log(JSON.stringify({
        filename: "round-16-gemini/private-kei/" + targetName,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        boneCount: metadata.bones.length,
        expressionsCount: metadata.expressions.length,
        normalMorphTargetsCount: metadata.normalMorphTargetsCount,
        textureCount: metadata.textureCount,
        blinkMorph: metadata.transferred.morphs.blink,
        happyLidMorph: metadata.transferred.morphs["keiLids.happy"],
        eyesClosedLidMorph: metadata.transferred.morphs["keiLids.eyesClosed"],
    }, null, 2));
} finally {
    await browser?.close();
    server.close();
}
