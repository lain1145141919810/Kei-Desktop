import { CubismFramework } from "cubism/live2dcubismframework";
import { CubismMatrix44 } from "cubism/math/cubismmatrix44";
import { CubismUserModel } from "cubism/model/cubismusermodel";
import { CubismShaderManager_WebGL } from "cubism/rendering/cubismshader_webgl";
import { moc, textures, physics, manifest, expressions } from "kei-live2d-assets";

const previewNames = {
    smallSmile: "SmallSmile", gentle: "Gentle", happy: "HappyClosed", bashful: "Bashful",
    surprised: "OpenMouth", flustered: "Flustered", shadowed: "Shadowed", shout: "Shout",
    sad: "Crying", serious: "Serious", thoughtful: "Thoughtful",
};

let coreReady;
function initializeCubism() {
    coreReady ??= upTo(() => {
        try {
            return globalThis.Live2DCubismCore?.Version.csmGetVersion() > 0;
        } catch {
            return false;
        }
    }, "Cubism Core did not initialize");
    return coreReady.then(() => {
        if (!CubismFramework.isStarted() && !CubismFramework.startUp()) throw new Error("Cubism startup failed");
        if (!CubismFramework.isInitialized()) CubismFramework.initialize();
    });
}

class LiveModel extends CubismUserModel {
    physicsStep(dt) {
        this._physics?.evaluate(this.getModel(), dt);
    }
}

function upTo(predicate, message) {
    return new Promise((resolve, reject) => {
        const deadline = performance.now() + 3500;
        const check = () => {
            if (predicate()) resolve();
            else if (performance.now() >= deadline) reject(new Error(message));
            else setTimeout(check, 15);
        };
        check();
    });
}

function renderTexture(gl, image) {
    const texture = gl.createTexture();
    if (!texture) throw new Error("Cannot allocate Cubism texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
}

export async function loadLive2D(canvas) {
    await initializeCubism();
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL2 is unavailable for Live2D");
    const userModel = new LiveModel();
    const matrix = new CubismMatrix44();
    const textureHandles = [];
    let scaleX = 1;
    let scaleY = 1;
    let model;
    const dispose = () => {
        userModel.release();
        const manager = CubismShaderManager_WebGL.getInstance();
        manager.getShader(gl)?.release();
        // The pinned Web SDK keeps a per-context map. Remove the released context.
        manager._shaderMap.delete(gl);
        for (const handle of textureHandles) gl.deleteTexture(handle);
        textureHandles.length = 0;
        gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    try {
        userModel.loadModel(moc.slice().buffer, true);
        model = userModel.getModel();
        if (!model) throw new Error("Unable to read the Cubism model");
        if (physics) userModel.loadPhysics(physics.slice().buffer, physics.byteLength);
        userModel.createRenderer(canvas.width, canvas.height);
        const renderer = userModel.getRenderer();
        renderer.startUp(gl);
        renderer.setIsPremultipliedAlpha(true);
        for (const [index, texture] of textures.entries()) {
            const image = await createImageBitmap(new Blob([texture]), { premultiplyAlpha: "premultiply", colorSpaceConversion: "none" });
            try {
                const handle = renderTexture(gl, image);
                textureHandles.push(handle);
                renderer.bindTexture(index, handle);
            } finally {
                image.close();
            }
        }
        renderer.loadShaders();
        const shader = CubismShaderManager_WebGL.getInstance().getShader(gl);
        await upTo(() => shader._isShaderLoaded, "Cubism shaders did not initialize");
        const id = name => CubismFramework.getIdManager().getId(name);
        const params = Object.fromEntries([
            "ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamEyeBallX", "ParamEyeBallY",
            "ParamEyeLOpen", "ParamEyeROpen", "ParamMouthOpenY", "ParamMouthForm", "ParamBreath",
        ].map(name => [name, model.getParameterIndex(id(name))]).filter(([, index]) => index < model.getParameterCount()));
        const set = (name, value) => {
            if (params[name] !== undefined) model.setParameterValueByIndex(params[name], value);
        };
        const authored = new Map(Object.entries(previewNames).flatMap(([key, name]) => {
            if (!expressions[name]) return [];
            return [[key, expressions[name].flatMap(parameter => {
                const index = model.getParameterIndex(id(parameter.Id));
                if (index >= model.getParameterCount() || !Number.isFinite(parameter.Value)) return [];
                return [{ index, value: parameter.Value, blend: parameter.Blend }];
            })]];
        }));
        const gpu = gl.getExtension("WEBGL_debug_renderer_info");
        return {
            expressionOptions: [...authored.keys()],
            face() {
                const read = name => params[name] === undefined ? null : model.getParameterValueByIndex(params[name]);
                return { eyeLeft: read("ParamEyeLOpen"), eyeRight: read("ParamEyeROpen"), mouth: read("ParamMouthOpenY") };
            },
            capabilities: {
                name: manifest.name, version: manifest.version, parameters: Object.keys(params),
                drawables: model.getDrawableCount(), physics: Boolean(physics),
                expressions: manifest.expressions,
                webgl: gl.getParameter(gl.VERSION),
                renderer: gpu ? gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL) : null,
            },
            resize(width, height, density) {
                canvas.width = Math.max(1, Math.round(width * density));
                canvas.height = Math.max(1, Math.round(height * density));
                const unit = Math.min(1.87 / model.getCanvasHeight(), 1.94 * width / height / model.getCanvasWidth());
                scaleX = unit * height / width;
                scaleY = unit;
                matrix.loadIdentity();
                matrix.scale(scaleX, scaleY);
                renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
            },
            draw(pose) {
                model.loadParameters();
                const degrees = 180 / Math.PI;
                set("ParamAngleX", pose.lookX * 14 + (pose.gesture?.yaw ?? 0) * degrees);
                set("ParamAngleY", -pose.lookY * 10 - (pose.gesture?.pitch ?? 0) * degrees);
                set("ParamAngleZ", pose.sway * 2.5 + (pose.gesture?.roll ?? 0) * degrees);
                set("ParamBodyAngleX", pose.sway * 3.5);
                set("ParamEyeBallX", pose.lookX);
                set("ParamEyeBallY", -pose.lookY);
                set("ParamEyeLOpen", 1 - pose.blink);
                set("ParamEyeROpen", 1 - pose.blink);
                set("ParamMouthForm", pose.smile * 0.75);
                set("ParamMouthOpenY", pose.mouth);
                set("ParamBreath", 0.5 + 0.5 * pose.sway);
                for (const [name, weight] of Object.entries(pose.expressionPreview?.values ?? {})) {
                    for (const { index, value, blend } of authored.get(name) ?? []) {
                        if (blend === "Add") model.addParameterValueByIndex(index, value, weight);
                        else if (blend === "Multiply") model.multiplyParameterValueByIndex(index, value, weight);
                        else model.setParameterValueByIndex(index, value, weight);
                    }
                }
                userModel.physicsStep(pose.dt);
                model.update();
                gl.viewport(0, 0, canvas.width, canvas.height);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
                renderer.setMvpMatrix(matrix);
                renderer.drawModel();
            },
            hit(x, y) {
                for (const area of manifest.hitAreas) {
                    if (userModel.isHit(id(area), x / scaleX, -y / scaleY)) return true;
                }
                // Legacy Kei model declares no named areas. Keep its center as the interaction region.
                return !manifest.hitAreas.length && Math.abs(x) < 0.48 && Math.abs(y) < 0.79;
            },
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
}
