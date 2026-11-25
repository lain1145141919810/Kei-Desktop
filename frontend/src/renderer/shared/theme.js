"use strict";
// Theme is shared between Kei's windows through localStorage("kei-theme"), as in v0.3.2.
(function () {
    const THEMES = ["hakuji", "yoru", "sora"];
    function current() {
        try { const value = localStorage.getItem("kei-theme"); return THEMES.includes(value) ? value : "hakuji"; } catch { return "hakuji"; }
    }
    function apply() {
        document.documentElement.dataset.theme = current();
        document.dispatchEvent(new CustomEvent("kei:theme", { detail: current() }));
    }
    function set(theme) {
        if (!THEMES.includes(theme)) return;
        try { localStorage.setItem("kei-theme", theme); } catch { /* default only */ }
        apply();
    }
    apply();
    window.addEventListener("storage", event => { if (event.key === "kei-theme") apply(); });
    window.KeiTheme = { THEMES, current, apply, set };
})();
