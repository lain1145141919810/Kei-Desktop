"use strict";
// Round 18: per-plugin entry icons fall back to the title initial when no font has the glyph.
const test = require("node:test");
const assert = require("node:assert/strict");
const { choose } = require("../../src/renderer/shared/entry-icon.js");

const none = () => false;
const all = () => true;

test("entry icon: a drawable glyph is shown as given", () => {
    assert.deepEqual(choose({ title: "読書", icon: "読" }, none), { text: "読", glyph: "icon" });
    assert.deepEqual(choose({ title: "Bilibili", icon: "▶" }, none), { text: "▶", glyph: "icon" });
});

test("entry icon: a glyph no font can draw falls back to the first title character", () => {
    const missing = text => text === "⏱";
    assert.deepEqual(choose({ title: "集中タイマー", icon: "⏱" }, missing), { text: "集", glyph: "fallback" });
    assert.deepEqual(choose({ title: "  Bilibili", icon: "⏱" }, all), { text: "B", glyph: "fallback" });
});

test("entry icon: no icon uses the title initial (whole code point, not half a surrogate pair)", () => {
    assert.deepEqual(choose({ title: "画面観察", icon: null }, all), { text: "画", glyph: "title" });
    assert.deepEqual(choose({ title: "𠮷野家の注文", icon: "" }, none), { text: "𠮷", glyph: "title" });
    assert.deepEqual(choose({ title: "", icon: undefined }, none), { text: "?", glyph: "title" });
});
