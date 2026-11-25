"use strict";
// Pure helpers for the scoped plugin-page protocol (host-api.md, "Electron integration").
// No Electron imports here so the rules can be unit-tested with node --test.

const fs = require("node:fs");
const path = require("node:path");

const PAGE_CSP = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
].join("; ");

// Round 10: aligned with the host's 2 MiB limit for POST /v1/pages/call (Round 06 contract:
// "The selected page action limit is 2 MiB per request"), minus headroom for the envelope
// (sessionId, action, context). Was 64 KiB, which blocked legacy reading-plan imports.
const HOST_PAGE_CALL_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = HOST_PAGE_CALL_BYTES - 4 * 1024;
const MAX_CALLS_PER_SECOND = 20;
const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ACTION_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const PLUGIN_ID = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
const ENTRY_ID = /^[a-z][a-z0-9_.-]{0,63}$/;

// Slots each trusted window may mount. Management stays in the admin window only.
const WINDOW_SLOTS = Object.freeze({
    desktop: Object.freeze(["extensions", "attachment", "selection", "character-settings"]),
    admin: Object.freeze(["admin", "character-settings"]),
});

function isPlainObject(value) {
    return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

// Validate a {type:"kei:call"} message from a plugin frame. Returns a sanitized copy
// containing only id, action and arguments, so a child can never smuggle a session ID,
// host URL or management action through extra fields.
function sanitizeCall(message, allowedActions) {
    if (!isPlainObject(message) || message.type !== "kei:call") return { error: "invalid_request" };
    const { id, action } = message;
    const args = message.arguments === undefined ? {} : message.arguments;
    if (typeof id !== "string" || !MESSAGE_ID.test(id)) return { error: "invalid_request" };
    if (typeof action !== "string" || !ACTION_ID.test(action)) return { error: "invalid_request", id };
    if (!isPlainObject(args)) return { error: "invalid_request", id };
    let encoded;
    try { encoded = JSON.stringify(args); } catch { return { error: "invalid_request", id }; }
    if (typeof encoded !== "string") return { error: "invalid_request", id };
    if (Buffer.byteLength(encoded, "utf8") > MAX_MESSAGE_BYTES) return { error: "message_too_large", id };
    if (Array.isArray(allowedActions) && !allowedActions.includes(action)) return { error: "scope_denied", id };
    return { call: { id, action, arguments: JSON.parse(encoded) } };
}

// Sliding one-second window per frame.
function createRateLimiter(limit = MAX_CALLS_PER_SECOND, windowMs = 1000, now = Date.now) {
    const stamps = [];
    return () => {
        const t = now();
        while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
        if (stamps.length >= limit) return false;
        stamps.push(t);
        return true;
    };
}

// Put the host-controlled CSP ahead of any packaged markup (after a leading doctype so
// the document stays in standards mode). Packaged <meta> CSPs can only narrow it further.
// Kei's plugin base stylesheet (zero-specificity, so package CSS wins) and a theme listener
// that accepts only {type:"kei:theme"} from the embedding trusted window. Both sit right after
// the CSP meta and before any packaged markup.
const PLUGIN_BASE_CSS = (() => {
    try { return fs.readFileSync(path.join(__dirname, "..", "renderer", "shared", "plugin-base.css"), "utf8").replace(/<\/style/gi, ""); } catch { return ""; }
})();
const THEME_LISTENER = "addEventListener(\"message\",function(e){var d=e.data;if(e.source===parent&&d&&d.type===\"kei:theme\"&&/^(hakuji|yoru|sora)$/.test(d.theme))document.documentElement.setAttribute(\"data-kei-theme\",d.theme)});";
const PLUGIN_BASE = (PLUGIN_BASE_CSS ? `<style id="kei-plugin-base">${PLUGIN_BASE_CSS}</style>` : "") + `<script>${THEME_LISTENER}</script>`;

function withHostCsp(html) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">` + PLUGIN_BASE;
    const text = String(html);
    const doctype = text.match(/^﻿?\s*<!doctype[^>]*>/i);
    return doctype ? doctype[0] + meta + text.slice(doctype[0].length) : meta + text;
}

function slotAllowed(windowKind, slot) {
    return (WINDOW_SLOTS[windowKind] || []).includes(slot);
}

// ---------------------------------------------------------------- Round 08 (decision 4)

const FRAME_TAG = /^[0-9a-f]{32}$/;
const KNOWN_SLOTS = new Set(["extensions", "attachment", "selection", "character-settings", "admin"]);

// Exactly kei-page://frame/<32 hex>; no query, hash, userinfo, port or extra segments.
function parseFrameUrl(raw) {
    let url;
    try { url = new URL(String(raw)); } catch { return null; }
    if (url.protocol !== "kei-page:" || url.host !== "frame" || url.search || url.hash || url.username || url.password || url.port) return null;
    const tag = url.pathname.replace(/^\//, "");
    return FRAME_TAG.test(tag) && url.href === `kei-page://frame/${tag}` ? tag : null;
}

// Host-supplied entry metadata must be well-formed before a page can be opened from it.
// Returns a sanitized entry, or null for anything malformed (unknown slot, bad IDs,
// non-string/duplicate/invalid actions, oversized lists).
function validateEntryMetadata(entry) {
    if (!isPlainObject(entry)) return null;
    const { pluginId, id, slot, title, actions } = entry;
    if (typeof pluginId !== "string" || !PLUGIN_ID.test(pluginId)) return null;
    if (typeof id !== "string" || !ENTRY_ID.test(id)) return null;
    if (typeof slot !== "string" || !KNOWN_SLOTS.has(slot)) return null;
    if (typeof title !== "string" || !title.trim() || title.length > 80) return null;
    if (!Array.isArray(actions) || actions.length > 64) return null;
    if (!actions.every(a => typeof a === "string" && ACTION_ID.test(a))) return null;
    if (new Set(actions).size !== actions.length) return null;
    const order = entry.order === undefined || entry.order === null ? 100 : entry.order;
    if (!Number.isInteger(order) || order < -100000 || order > 100000) return null;
    const icon = entry.icon === undefined || entry.icon === null ? null : entry.icon;
    if (icon !== null && (typeof icon !== "string" || icon.length > 4)) return null;
    return { pluginId, id, slot, title, actions: [...actions], order, icon };
}

function normalizeWindowsFileUrl(href) {
    return href.replace(/^file:\/\/\/([a-z]):\//, (_, drive) => `file:///${drive.toUpperCase()}:/`);
}

function normalizeWindowsDrive(filePath, sep) {
    return sep === "\\" ? filePath.replace(/^([a-z]):\\/, (_, drive) => `${drive.toUpperCase()}:\\`) : filePath;
}

// The trusted sender must be showing exactly the expected Kei page (a same-document #anchor
// is allowed; queries, other files and other schemes are not).
function isTrustedPageUrl(raw, expected, platform = process.platform) {
    let url;
    try { url = new URL(String(raw)); } catch { return false; }
    if (url.protocol !== "file:" || url.search || url.username || url.host) return false;
    url.hash = "";
    if (platform === "win32") return normalizeWindowsFileUrl(url.href) === normalizeWindowsFileUrl(String(expected));
    return url.href === expected;
}

// file: loads are limited to the shell's own renderer and asset directories.
function isAllowedFilePath(resolved, roots, sep = require("node:path").sep) {
    const candidate = normalizeWindowsDrive(resolved, sep);
    return roots.some(rawRoot => {
        const root = normalizeWindowsDrive(rawRoot, sep);
        return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
    });
}

function auditScheme(raw) {
    try {
        const scheme = new URL(raw).protocol;
        return ["http:", "https:", "file:", "kei-page:", "blob:", "data:", "devtools:"].includes(scheme)
            ? scheme.slice(0, -1) : "other";
    } catch {
        return "invalid";
    }
}

module.exports = {
    auditScheme,
    parseFrameUrl, validateEntryMetadata, isTrustedPageUrl, isAllowedFilePath, FRAME_TAG,
    PAGE_CSP, MAX_MESSAGE_BYTES, HOST_PAGE_CALL_BYTES, MAX_CALLS_PER_SECOND, PLUGIN_ID, ENTRY_ID, WINDOW_SLOTS,
    sanitizeCall, createRateLimiter, withHostCsp, slotAllowed, isPlainObject,
};
