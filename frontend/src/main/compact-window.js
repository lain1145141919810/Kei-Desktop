"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, screen } = require("electron");

const SNAP = 28;
const MARGIN = 12;
const validScale = scale => Number.isFinite(scale) && scale >= 0.35 && scale <= 3;

class CompactWindow {
    constructor(getWindow, audit) {
        this.getWindow = getWindow;
        this.audit = audit;
        this.previous = null;
        this.stage = null;
        this.ignored = false;
        this.probe = null;
        this.scale = null;
    }

    supported() {
        if (process.env.KEI_OFFSCREEN === "1") return process.env.KEI_COMPACT_PREVIEW === "1";
        return process.platform === "win32" || process.platform === "linux";
    }

    #file() { return path.join(app.getPath("userData"), "compact.json"); }

    #loadScale() {
        if (this.scale !== null) return this.scale;
        let saved;
        try { saved = JSON.parse(fs.readFileSync(this.#file(), "utf8")); } catch { /* first use */ }
        this.scale = validScale(saved?.scale) ? saved.scale : 1;
        return this.scale;
    }

    status() {
        return { supported: this.supported(), active: Boolean(this.previous), scale: this.#loadScale() };
    }

    #notify(win) {
        const state = this.status();
        win.webContents.send("kei:compact:changed", state);
        return state;
    }

    #readStage(rect, bounds) {
        if (!rect) return null;
        const { x, y, width, height } = rect;
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 ||
            x < -1 || y < -1 || x + width > bounds.width + 1 || y + height > bounds.height + 1) return null;
        return { x, y, width, height };
    }

    updateGeometry(rect, scale) {
        const win = this.getWindow();
        if (!this.previous || !win || win.isDestroyed()) return;
        const stage = this.#readStage(rect, win.getContentBounds());
        if (!stage) return;
        this.stage = stage;
        if (!validScale(scale) || this.scale === scale) return;
        this.scale = scale;
        try { fs.writeFileSync(this.#file(), JSON.stringify({ scale })); } catch { /* best effort */ }
        this.audit("compact.resized", { scale, width: stage.width, height: stage.height });
    }

    set(enabled, rect) {
        const win = this.getWindow();
        if (!this.supported() || !win || win.isDestroyed() || enabled === Boolean(this.previous)) return this.status();
        if (enabled) {
            if (win.isMinimized()) win.restore();
            this.previous = { bounds: win.getBounds(), top: win.isAlwaysOnTop() };
            this.stage = this.#readStage(rect, win.getContentBounds());
            // Keep the native surface in place. Windows can otherwise present an
            // old frame at the resized window's bounds before its next paint.
            win.setAlwaysOnTop(true);
            if (!win.isVisible()) win.show();
        } else {
            const previous = this.previous;
            this.hit(true);
            this.previous = null;
            this.stage = null;
            const current = win.getBounds();
            const { x, y } = previous.bounds;
            if (current.x !== x || current.y !== y) win.setBounds({ ...current, x, y });
            win.setAlwaysOnTop(previous.top);
            win.focus();
        }
        const state = this.#notify(win);
        if (enabled) this.hit(false);
        this.audit("compact.changed", { ...state, bounds: win.getBounds() });
        return state;
    }

    toggle() {
        const win = this.getWindow();
        if (win && !win.isDestroyed() && win.isVisible() && !win.webContents.isLoadingMainFrame()) {
            win.webContents.send("kei:compact:toggle-requested");
            return this.status();
        }
        return this.set(!this.previous);
    }

    hit(interactive) {
        const win = this.getWindow();
        if (!this.previous || !win || win.isDestroyed() || this.ignored === !interactive) return;
        this.ignored = !interactive;
        if (this.ignored) {
            win.setIgnoreMouseEvents(true);
            let lastPoint;
            // Poll the cursor while Windows lets mouse events through the window.
            this.probe = setInterval(() => {
                if (win.isDestroyed()) return;
                const point = screen.getCursorScreenPoint();
                const bounds = win.getContentBounds();
                const x = point.x - bounds.x, y = point.y - bounds.y;
                if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
                    if (lastPoint) win.webContents.send("kei:compact:probe", -1, -1);
                    lastPoint = null;
                    return;
                }
                if (lastPoint?.x === x && lastPoint?.y === y) return;
                lastPoint = { x, y };
                win.webContents.send("kei:compact:probe", x, y);
            }, 40);
            this.probe.unref();
        } else {
            clearInterval(this.probe);
            this.probe = null;
            win.setIgnoreMouseEvents(false);
        }
    }

    #footprint(bounds) {
        if (!this.stage) return bounds;
        const { x, y, width, height } = this.stage;
        return { x: bounds.x + x, y: bounds.y + y, width, height };
    }

    move(x, y) {
        const win = this.getWindow();
        if (!this.previous || !win || win.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const bounds = win.getBounds();
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const footprint = this.#footprint({ ...bounds, x, y });
        const right = area.x + Math.max(0, area.width - footprint.width);
        const bottom = area.y + Math.max(0, area.height - footprint.height);
        const left = Math.min(right, Math.max(area.x, footprint.x));
        const top = Math.min(bottom, Math.max(area.y, footprint.y));
        const nextX = Math.round(x + left - footprint.x);
        const nextY = Math.round(y + top - footprint.y);
        if (nextX !== bounds.x || nextY !== bounds.y) win.setBounds({ ...bounds, x: nextX, y: nextY });
    }

    settle() {
        const win = this.getWindow();
        if (!this.previous || !win || win.isDestroyed()) return;
        const bounds = win.getBounds();
        const footprint = this.#footprint(bounds);
        const area = screen.getDisplayMatching(footprint).workArea;
        let { x, y } = footprint;
        const right = area.x + area.width - footprint.width;
        const bottom = area.y + area.height - footprint.height;
        if (Math.abs(x - area.x) < SNAP + MARGIN) x = area.x + MARGIN;
        else if (Math.abs(right - x) < SNAP + MARGIN) x = right - MARGIN;
        if (Math.abs(y - area.y) < SNAP + MARGIN) y = area.y + MARGIN;
        else if (Math.abs(bottom - y) < SNAP + MARGIN) y = bottom - MARGIN;
        if (x !== footprint.x || y !== footprint.y) {
            win.setBounds({ ...bounds, x: Math.round(bounds.x + x - footprint.x), y: Math.round(bounds.y + y - footprint.y) });
        }
    }

    reset() {
        clearInterval(this.probe);
        this.probe = null;
        this.previous = null;
        this.stage = null;
        this.ignored = false;
    }
}

module.exports = { CompactWindow };
