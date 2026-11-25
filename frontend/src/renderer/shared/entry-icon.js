"use strict";
// Per-plugin entry icons (metadata "icon": a short text glyph, at most 4 characters).
// The glyph is drawn as text. Where no installed font has it (e.g. "⏱" on a Linux desktop
// without an emoji font) Chromium would draw an empty box, so the first character of the
// entry title is shown instead and the icon is marked data-glyph="fallback".

(function () {
    const MISSING = "\u{10FFFD}"; // private-use plane 16: never has a glyph, so it draws .notdef
    const cache = new Map();

    function pixels(text, font) {
        const canvas = document.createElement("canvas");
        canvas.width = 40;
        canvas.height = 40;
        const g = canvas.getContext("2d");
        if (!g) return null;
        g.font = font;
        g.textBaseline = "middle";
        g.fillStyle = "#000";
        g.fillText(text, 4, 20);
        return g.getImageData(0, 0, 40, 40).data.join(",");
    }

    // True when the glyph draws like a code point that has no glyph at all.
    function glyphMissing(text, font = "16px sans-serif") {
        const key = `${font}\u0000${text}`;
        if (cache.has(key)) return cache.get(key);
        let missing = false;
        try {
            const drawn = pixels(text, font);
            missing = drawn !== null && (drawn === pixels(MISSING, font) || !/[1-9]/.test(drawn));
        } catch { missing = false; }
        cache.set(key, missing);
        return missing;
    }

    // Pure choice used by render() and the unit tests.
    function choose(entry, isMissing) {
        const title = typeof entry?.title === "string" ? entry.title.trim() : "";
        const fallback = [...title][0] || "?";
        const icon = typeof entry?.icon === "string" ? entry.icon.trim() : "";
        if (!icon) return { text: fallback, glyph: "title" };
        if (isMissing(icon)) return { text: fallback, glyph: "fallback" };
        return { text: icon, glyph: "icon" };
    }

    // <span class="…" aria-hidden="true" data-glyph="icon|fallback|title">X</span>
    function render(entry, className) {
        const span = document.createElement("span");
        span.className = className;
        span.setAttribute("aria-hidden", "true");
        // Measure with the font the icon is actually drawn in once it is in the document.
        const pick = font => choose(entry, text => glyphMissing(text, font));
        const apply = ({ text, glyph }) => { span.textContent = text; span.dataset.glyph = glyph; };
        apply(pick("16px sans-serif"));
        requestAnimationFrame(() => {
            if (!span.isConnected || span.dataset.glyph === "title") return;
            const font = getComputedStyle(span).font;
            if (font) apply(pick(font));
        });
        return span;
    }

    const api = { render, choose, glyphMissing };
    if (typeof window !== "undefined") window.KeiEntryIcon = api;
    if (typeof module !== "undefined") module.exports = api;
})();
