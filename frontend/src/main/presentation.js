"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TYPES = {
    opening: { mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
    ending: { mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" },
    voice: { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac" },
};
const LIMIT = 24 * 1024 * 1024;
const typeOf = (slot, filename) => TYPES[slot]?.[path.extname(filename).slice(1).toLowerCase()];

class Presentation {
    constructor(config, defaults, dialog, getWindow) {
        this.config = config;
        this.defaults = defaults;
        this.dialog = dialog;
        this.getWindow = getWindow;
    }

    settings() {
        try { return JSON.parse(fs.readFileSync(this.config, "utf8")) ?? {}; }
        catch { return {}; }
    }

    resolved(slot, settings) {
        const file = Object.hasOwn(settings, slot) ? settings[slot] : this.defaults[slot];
        return typeof file === "string" && path.isAbsolute(file) && typeOf(slot, file) ? file : null;
    }

    status() {
        const settings = this.settings();
        return { muted: settings.muted === true, assets: Object.fromEntries(Object.keys(TYPES).map(slot => {
            const file = this.resolved(slot, settings);
            return [slot, { label: file ? path.basename(file) : null, available: Boolean(file && fs.existsSync(file)) }];
        })) };
    }

    patch(patch) {
        const data = { ...this.settings(), ...patch };
        fs.mkdirSync(path.dirname(this.config), { recursive: true });
        const scratch = this.config + ".tmp";
        fs.writeFileSync(scratch, JSON.stringify(data, null, 2), { mode: 0o600 });
        fs.renameSync(scratch, this.config);
        return this.status();
    }

    async choose(slot) {
        if (!Object.hasOwn(TYPES, slot)) throw Object.assign(new Error("invalid slot"), { code: "invalid_request" });
        const chosen = await this.dialog.showOpenDialog(this.getWindow(), {
            properties: ["openFile"],
            filters: [{ name: slot === "voice" ? "起動音声" : "起動・終了画面", extensions: Object.keys(TYPES[slot]) }],
        });
        if (chosen.canceled || !chosen.filePaths[0]) return this.status();
        const file = chosen.filePaths[0];
        const info = await fs.promises.stat(file).catch(() => null);
        if (!typeOf(slot, file) || !info?.isFile() || !info.size || info.size > LIMIT) {
            throw Object.assign(new Error("invalid asset"), { code: "invalid_presentation_asset" });
        }
        return this.patch({ [slot]: file });
    }

    async read(slot) {
        if (!Object.hasOwn(TYPES, slot)) return null;
        const file = this.resolved(slot, this.settings());
        if (!file) return null;
        let fd;
        try {
            fd = await fs.promises.open(file, "r");
            const info = await fd.stat();
            if (!info.isFile() || !info.size || info.size > LIMIT) return null;
            const buffer = Buffer.alloc(info.size);
            let offset = 0;
            while (offset < buffer.length) {
                const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
                if (bytesRead === 0) return null;
                offset += bytesRead;
            }
            return { type: typeOf(slot, file), bytes: new Uint8Array(buffer) };
        } catch {
            return null;
        } finally {
            await fd?.close();
        }
    }
}

module.exports = { Presentation };
