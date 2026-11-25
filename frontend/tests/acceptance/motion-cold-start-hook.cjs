"use strict";
// Loaded into the Electron main process with `electron -r <this file>` (test only). At the
// desktop window's dom-ready it replays the DEF-02 trigger: the character stage announcing
// kei:stage-character-changed (reactions.js -> invalidatePlan() -> motion.interrupt()) while
// the motion provider's startup refresh is still in flight. It also samples the provider
// snapshot so the result does not depend on how quickly Playwright attaches.
const { app } = require("electron");

const STORM_MS = Number(process.env.KEI_STORM_MS || 1500);
const script = `(() => {
    const stage = document.querySelector("#character-stage");
    const started = performance.now();
    const trace = [];
    let last = "";
    window.__keiColdStart = { trace, interrupts: 0, firstConnectedMs: null, startedAt: Date.now() };
    const sample = () => {
        const api = window.KeiCharacterStage?.get(stage);
        const p = api?.motion?.snapshot()?.provider;
        const key = p ? String(p.connected) + ":" + p.state : "no-stage";
        const ms = Number((performance.now() - started).toFixed(1));
        if (key !== last) { trace.push({ ms, key }); last = key; }
        if (p?.connected && window.__keiColdStart.firstConnectedMs === null) window.__keiColdStart.firstConnectedMs = ms;
        return api;
    };
    const tick = () => {
        sample();
        if (performance.now() - started < ${STORM_MS}) {
            stage?.dispatchEvent(new CustomEvent("kei:stage-character-changed", { detail: { model: "vrm", capabilities: null } }));
            window.__keiColdStart.interrupts++;
            setTimeout(tick, 1);
        } else if (performance.now() - started < 8000) {
            setTimeout(tick, 20);
        }
    };
    tick();
})();`;

app.on("web-contents-created", (_event, contents) => {
    contents.on("dom-ready", () => {
        if (!/desktop\/index\.html/.test(contents.getURL())) return;
        contents.executeJavaScript(script).catch(error => console.error("[def02-hook]", error?.message ?? error));
    });
});
