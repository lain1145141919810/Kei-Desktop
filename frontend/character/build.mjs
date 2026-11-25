import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../src/renderer/character/kei-character.js");
const sdk = process.env.KEI_CUBISM_SDK;
const liveModel = process.env.KEI_LIVE2D_MODEL;
if (Boolean(sdk) !== Boolean(liveModel)) throw new Error("Set KEI_CUBISM_SDK and KEI_LIVE2D_MODEL together");

const vrmFile = process.env.KEI_VRM_MODEL;
const vrm = vrmFile ? await readFile(vrmFile) : null;
const assets = new Map();
const hash = data => createHash("sha256").update(data).digest("hex");
const vrmInfo = vrm ? { file: path.basename(vrmFile), sha256: hash(vrm) } : null;
if (vrm) assets.set("vrm", vrm);
let manifest = null;
let expressions = {};
let shaderSources;
if (sdk) {
    const modelRoot = await realpath(path.dirname(liveModel));
    async function modelAsset(relative) {
        if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) throw new Error("Invalid model asset path");
        const resolved = await realpath(path.join(modelRoot, relative));
        const local = path.relative(modelRoot, resolved);
        if (local.startsWith(".." + path.sep) || path.isAbsolute(local)) throw new Error("Model asset is outside its directory");
        return readFile(resolved);
    }
    const descriptor = await readFile(liveModel);
    const config = JSON.parse(descriptor);
    const refs = config.FileReferences;
    assets.set("core", await readFile(path.join(sdk, "Core/live2dcubismcore.min.js")));
    assets.set("moc", await modelAsset(refs.Moc));
    if (refs.Physics) assets.set("physics", await modelAsset(refs.Physics));
    for (const [index, relative] of refs.Textures.entries()) {
        assets.set("texture" + index, await modelAsset(relative));
    }
    expressions = Object.fromEntries(await Promise.all((refs.Expressions ?? []).map(async entry => {
        const bytes = await modelAsset(entry.File);
        assets.set("expression:" + entry.Name, bytes);
        return [entry.Name, JSON.parse(bytes).Parameters ?? []];
    })));
    manifest = {
        name: path.basename(liveModel, ".model3.json"), version: config.Version,
        hitAreas: (config.HitAreas ?? []).map(area => area.Id),
        expressions: (refs.Expressions ?? []).map(expression => expression.Name),
        textureCount: refs.Textures.length,
        descriptorSha256: hash(descriptor),
        sha256: Object.fromEntries([...assets].filter(([name]) => name !== "vrm").map(([name, buffer]) => [name, hash(buffer)])),
    };
    const shaders = path.join(sdk, "Framework/Shaders/WebGL");
    const names = (await readdir(shaders)).filter(file => /\.(frag|vert)$/.test(file));
    shaderSources = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(shaders, name), "utf8")])));
}

await build({
    absWorkingDir: here,
    entryPoints: ["entry.mjs"],
    outfile: out,
    bundle: true,
    format: "iife",
    target: "chrome140",
    minify: true,
    legalComments: "eof",
    banner: assets.has("core") ? { js: assets.get("core").toString("utf8") + "\n;" } : undefined,
    plugins: [{
        name: "package-character-assets",
        setup(plugin) {
            plugin.onResolve({ filter: /^kei-live2d-adapter$/ }, () => ({
                path: path.join(here, sdk ? "live2d.mjs" : "live2d-missing.mjs"),
            }));
            plugin.onResolve({ filter: /^cubism\// }, ({ path: specifier }) => ({
                path: path.resolve(sdk, "Framework/src", specifier.slice("cubism/".length) + ".ts"),
            }));
            plugin.onResolve({ filter: /^kei-(live2d-assets|vrm-asset)$/ }, ({ path: name }) => ({ path: name, namespace: "kei-character" }));
            plugin.onResolve({ filter: /^kei-bytes:/ }, ({ path: name }) => ({ path: name.slice(10), namespace: "kei-byte-array" }));
            plugin.onLoad({ filter: /.*/, namespace: "kei-byte-array" }, ({ path: name }) => ({
                contents: assets.get(name), loader: "binary",
            }));
            plugin.onLoad({ filter: /.*/, namespace: "kei-character" }, ({ path: name }) => {
                if (name === "kei-vrm-asset") return {
                    contents: (vrm ? "export {default as bytes} from 'kei-bytes:vrm';" : "export const bytes = null;") +
                        "export const vrmInfo = " + JSON.stringify(vrmInfo) + ";",
                };
                const textureNames = Array.from({ length: manifest.textureCount }, (_, index) => "texture" + index);
                return {
                    contents: ["moc", "physics", ...textureNames].map(key =>
                        assets.has(key) ? "import " + key + " from 'kei-bytes:" + key + "';" : "const " + key + " = null;"
                    ).join("\n") + "\nexport {moc,physics}; export const textures = [" + textureNames.join(",") +
                        "]; export const manifest = " + JSON.stringify(manifest) +
                        "; export const expressions = " + JSON.stringify(expressions) + ";",
                };
            });
            plugin.onLoad({ filter: /[/\\]cubismshader_webgl\.ts$/ }, async ({ path: file }) => {
                const source = await readFile(file, "utf8");
                const fetch = /const response = await fetch\(url\);\r?\n    return await response.text\(\);/;
                if (!fetch.test(source)) throw new Error("Unsupported Cubism Web shader loader. Use SDK 5-r.5");
                const shaders = "const bundledShaders: Record<string, string> = " + JSON.stringify(shaderSources) + ";\n";
                return {
                    contents: shaders + source.replace(fetch, () => "const key = url.slice(url.lastIndexOf('/') + 1);\n" +
                        "    if (!Object.hasOwn(bundledShaders, key)) throw new Error('Unknown Cubism shader: ' + key);\n" +
                        "    return bundledShaders[key];"),
                    loader: "ts", resolveDir: path.dirname(file),
                };
            });
        },
    }],
});
await mkdir(path.dirname(out), { recursive: true });
await writeFile(path.join(path.dirname(out), "kei-character-assets.json"), JSON.stringify({ vrm: vrmInfo, live2d: manifest }, null, 2) + "\n");
console.log(JSON.stringify({ file: out, vrm: vrmInfo, live2d: manifest }, null, 2));
