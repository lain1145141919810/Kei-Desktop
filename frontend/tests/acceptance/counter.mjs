// Round 05 milestone 1 acceptance: studio.counter in the real Electron shell against the
// supplied host (backend-acceptance/kei-host.pyz), fresh profile and data directory.
//
//   node tests/acceptance/counter.mjs [--headless]
//
// Overrides (e.g. Windows or a copied source tree): KEI_HOST_PYTHON, KEI_HOST_ARTIFACT,
// KEI_COUNTER_ZIP, KEI_EVIDENCE_DIR.
//
// The only substitution is the OS file chooser: dialog.showOpenDialog in main is replaced
// to return backend-acceptance/studio.counter.zip. Everything after that (ZIP check,
// POST /v1/plugins/install, grants, pages, events) is the production path.

import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "..", "..");
const repo = path.resolve(frontend, "..");
const backend = path.join(repo, "backend-acceptance");
const evidence = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence"));
const shots = path.join(evidence, "screenshots");
const headless = process.argv.includes("--headless");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });

const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-shell-acceptance-"));
const profileDir = path.join(run, "profile");
const dataDir = path.join(run, "host-data");
const python = process.env.KEI_HOST_PYTHON || path.join(backend, ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python");
// The artifact main will launch (same default as src/main/main.js), recorded with its hash.
const hostArtifactPath = path.resolve(process.env.KEI_HOST_ARTIFACT || path.join(backend, "kei-host.pyz"));
const sha256 = file => { try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; } };
const counterZip = path.resolve(process.env.KEI_COUNTER_ZIP || path.join(backend, "studio.counter.zip"));

const results = [];
const started = Date.now();
function record(step, ok, details = {}) {
    results.push({ step, ok, ms: Date.now() - started, ...details });
    console.log(`${ok ? "PASS" : "FAIL"} ${step}${Object.keys(details).length ? " " + JSON.stringify(details) : ""}`);
    if (!ok) throw new Error(`Step failed: ${step}`);
}

async function waitFor(label, fn, timeout = 8000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (error) { last = error.message; }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const args = [frontend, "--no-sandbox"];
if (headless) args.push("--ozone-platform=headless", "--disable-gpu");
const env = { ...process.env, KEI_PROFILE_DIR: profileDir, KEI_DATA_DIR: dataDir, KEI_HOST_PYTHON: python, XDG_RUNTIME_DIR: run };
if (headless) { env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; delete env.WAYLAND_DISPLAY; }

const app = await electron.launch({
    executablePath: require("electron"), args, env, cwd: frontend, timeout: 60000,
});

async function shot(name, kind) {
    const b64 = await app.evaluate(async ({ BrowserWindow }, kind) => {
        const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes(kind === "admin" ? "/admin/admin.html" : "/desktop/index.html"));
        await new Promise(r => setTimeout(r, 350)); // let the last frame paint
        return (await win.webContents.capturePage()).toPNG().toString("base64");
    }, kind);
    const file = path.join(shots, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    return path.relative(repo, file);
}

const frameText = (page, container) => page.frameLocator(`${container} iframe.plugin-frame`).locator("output").textContent({ timeout: 3000 });
async function setExtensions(page, open) {
    const hidden = await page.locator("#extension-panel").isHidden();
    if (hidden === open) await page.click("#extension-button");
    await waitFor(`extension panel ${open ? "open" : "closed"}`, async () => (await page.locator("#extension-panel").isHidden()) === !open);
}
// Offscreen (headless) windows do not route synthetic mouse input into out-of-process
// iframes, so headless runs activate the plugin's own button with a DOM click. The page's
// handler, postMessage, frame host, IPC and host call path are identical.
async function pressPlusOne(page) {
    const button = page.frameLocator("#plugin-sheet-body iframe.plugin-frame").getByRole("button", { name: "＋1" });
    if (headless) await button.evaluate(element => element.click());
    else await button.click();
}
const frameCount = page => page.locator("iframe.plugin-frame").count();
const pluginFrame = (page, pluginEntry) => page.frames().find(f => f.url().startsWith("kei-page://frame/") && f.parentFrame() === page.mainFrame());

let exitCode = 0;
try {
    const desktop = await app.firstWindow();
    await desktop.waitForLoadState("domcontentloaded");
    const version = await app.evaluate(({ app }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, userData: app.getPath("userData") }));

    // 1. Fresh profile, empty plugin directory, usable shell.
    await waitFor("host connected", async () => (await desktop.locator("#connection-text").textContent()) === "Kei ホスト接続済み", 20000);
    await setExtensions(desktop, true);
    await waitFor("empty extension menu", async () => (await desktop.locator("#extension-empty").isVisible()) && (await desktop.locator("#extension-list .menu-item").count()) === 0);
    record("fresh profile: host connected, zero active plugins in desktop menu", true, { ...version, dataDir: "<temp>/host-data" });
    const s1 = await shot("01-desktop-fresh-empty-extensions", "desktop");

    // 2. Admin window from the desktop quick panel.
    const adminPromise = app.waitForEvent("window");
    await desktop.click("#quick-button");
    await desktop.click("#admin-button");
    const admin = await adminPromise;
    await admin.waitForLoadState("domcontentloaded");
    await waitFor("admin empty list", async () => admin.locator("#plugin-empty").isVisible());
    await waitFor("no admin entries", async () => (await admin.locator("#admin-entries .side-entry").count()) === 0 && admin.locator("#admin-entries-empty").isVisible());
    record("admin window: no installed plugins, no admin pages", true);
    const s2 = await shot("02-admin-fresh-empty", "admin");

    // 3. Install from the (stubbed) OS chooser; package arrives disabled.
    await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, counterZip);
    await admin.click("#install");
    const card = admin.locator('.plugin-card[data-plugin-id="studio.counter"]');
    await waitFor("installed card", async () => (await card.getAttribute("data-enabled")) === "false");
    const installText = await admin.locator("#install-status").textContent();
    record("install studio.counter.zip via management UI, disabled by default", true, { status: installText });
    const s3 = await shot("03-admin-installed-disabled", "admin");

    // 4. Grant counter.read + counter.write and enable.
    for (const scope of ["counter.read", "counter.write"]) await card.locator(`input[value="${scope}"]`).check();
    await card.locator('button[data-action="enable"]').click();
    await waitFor("enabled", async () => (await admin.locator('.plugin-card[data-plugin-id="studio.counter"]').getAttribute("data-enabled")) === "true");
    await waitFor("admin entry カウンター設定", async () => (await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).count()) === 1);
    await setExtensions(desktop, false);
    await setExtensions(desktop, true);
    await waitFor("desktop entry カウンター", async () => (await desktop.locator("#extension-list .menu-item", { hasText: "カウンター" }).count()) === 1);
    record("enable with grants: カウンター in desktop menu, カウンター設定 in admin area", true);
    const s4 = await shot("04-desktop-extension-menu-counter", "desktop");
    const s5 = await shot("05-admin-enabled-entry", "admin");

    // 5. Open both pages; ＋1 updates both.
    await desktop.locator("#extension-list .menu-item", { hasText: "カウンター" }).click();
    await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).click();
    await waitFor("desktop shows 0", async () => (await frameText(desktop, "#plugin-sheet-body")) === "0");
    await waitFor("admin shows 0", async () => (await frameText(admin, "#plugin-page-body")) === "0");
    await pressPlusOne(desktop);
    await waitFor("desktop shows 1", async () => (await frameText(desktop, "#plugin-sheet-body")) === "1");
    await waitFor("admin shows 1 via event", async () => (await frameText(admin, "#plugin-page-body")) === "1");
    record("open desktop and admin pages; click ＋1; both display 1", true);
    const s6 = await shot("06-desktop-counter-1", "desktop");
    const s7 = await shot("07-admin-counter-1", "admin");

    // 6. Isolation probes inside the desktop plugin frame.
    const frame = await waitFor("plugin frame", async () => pluginFrame(desktop));
    const probes = await frame.evaluate(async () => {
        const out = {};
        out.origin = String(self.origin);
        out.keiBridge = typeof window.kei;
        out.require = typeof window.require;
        try { out.parentDocument = parent.document ? "accessible" : "none"; } catch { out.parentDocument = "blocked"; }
        try { await fetch("http://127.0.0.1:9/v1/status"); out.fetch = "allowed"; } catch { out.fetch = "blocked"; }
        out.spoof = await new Promise(resolve => {
            const listener = ({ source, data }) => {
                if (source === parent && data?.type === "kei:result" && data.id === "spoof") { removeEventListener("message", listener); resolve(data); }
            };
            addEventListener("message", listener);
            parent.postMessage({ type: "kei:call", id: "spoof", action: "reset", arguments: {}, sessionId: "forged", url: "http://127.0.0.1:1" }, "*");
            setTimeout(() => resolve("timeout"), 4000);
        });
        return out;
    });
    const probeOk = probes.origin === "null" && probes.keiBridge === "undefined" && probes.require === "undefined"
        && probes.parentDocument === "blocked" && probes.fetch === "blocked" && probes.spoof?.ok === false && probes.spoof?.error?.code === "scope_denied";
    record("plugin frame isolation: opaque origin, no bridge, no parent DOM, no network, undeclared action denied", probeOk, { probes });
    await waitFor("still 1 after denied reset", async () => (await frameText(admin, "#plugin-page-body")) === "1");

    // 7. Reload twice: former frames close, reopened views keep the count.
    for (const round of [1, 2]) {
        await admin.locator('.plugin-card[data-plugin-id="studio.counter"] button[data-action="reload"]').click();
        await waitFor(`frames closed after reload ${round}`, async () => (await frameCount(desktop)) === 0 && (await frameCount(admin)) === 0
            && (await desktop.locator("#plugin-sheet").isHidden()) && (await admin.locator("#plugin-page").isHidden()));
        await waitFor("entry still listed", async () => (await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).count()) === 1);
        if (round === 1) await shot("08-desktop-after-reload-frame-closed", "desktop");
        await setExtensions(desktop, true);
        await waitFor("menu item", async () => (await desktop.locator("#extension-list .menu-item", { hasText: "カウンター" }).count()) === 1);
        await desktop.locator("#extension-list .menu-item", { hasText: "カウンター" }).click();
        await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).click();
        await waitFor("desktop retains 1", async () => (await frameText(desktop, "#plugin-sheet-body")) === "1");
        await waitFor("admin retains 1", async () => (await frameText(admin, "#plugin-page-body")) === "1");
        record(`reload ${round}: former frames and subscriptions closed; reopened views show retained count 1`, true);
    }
    await pressPlusOne(desktop);
    await waitFor("desktop 2", async () => (await frameText(desktop, "#plugin-sheet-body")) === "2");
    await waitFor("admin 2", async () => (await frameText(admin, "#plugin-page-body")) === "2");
    record("after two reloads, ＋1 propagates to both new sessions (2)", true);
    await shot("09-desktop-counter-2-after-reloads", "desktop");
    await shot("10-admin-counter-2-after-reloads", "admin");

    // 8. Disable with both pages open: entries and frames disappear in both windows.
    // Stale-action probes are prepared first:
    //  (a) app level: the desktop frame's tag, as the renderer knew it before disable;
    //  (b) host level: an extra page session opened directly on the host (operator token
    //      from the test data dir, never logged), standing in for any page opened earlier.
    const staleTag = await desktop.locator("#plugin-sheet-body iframe.plugin-frame").getAttribute("data-kei-frame");
    const connection = JSON.parse(fs.readFileSync(path.join(dataDir, "connection.json"), "utf8"));
    const hostCall = async (method, route, body) => {
        const response = await fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };
    const hostPage = await hostCall("POST", "/v1/pages/open", { pluginId: "studio.counter", entryId: "desktop-counter" });
    const hostSession = hostPage.body.data.sessionId;
    const beforeDisable = (await hostCall("POST", "/v1/pages/call", { sessionId: hostSession, action: "current", arguments: {} })).body.data.result.value;

    await admin.locator('.plugin-card[data-plugin-id="studio.counter"] button[data-action="disable"]').click();
    await waitFor("frames removed on disable", async () => (await frameCount(desktop)) === 0 && (await frameCount(admin)) === 0
        && (await desktop.locator("#plugin-sheet").isHidden()) && (await admin.locator("#plugin-page").isHidden()));
    await waitFor("admin entry removed", async () => (await admin.locator("#admin-entries .side-entry").count()) === 0);
    await setExtensions(desktop, true);
    await waitFor("desktop entry removed", async () => (await desktop.locator("#extension-list .menu-item").count()) === 0 && desktop.locator("#extension-empty").isVisible());
    await waitFor("card shows disabled", async () => (await admin.locator('.plugin-card[data-plugin-id="studio.counter"]').getAttribute("data-enabled")) === "false");
    record("disable with both pages open: frames, desktop entry and admin entry removed immediately", true);

    const appStale = await desktop.evaluate(tag => window.kei.pages.call(tag, { type: "kei:call", id: "stale", action: "increment", arguments: {} }), staleTag);
    const hostStale = await hostCall("POST", "/v1/pages/call", { sessionId: hostSession, action: "increment", arguments: {} });
    const staleResult = {
        valueBeforeDisable: beforeDisable,
        appLevel: { via: "trusted bridge with the closed frame's tag", ok: appStale.ok, code: appStale.error?.code },
        hostLevel: { via: "POST /v1/pages/call on a session opened before disable", httpStatus: hostStale.status, code: hostStale.body.error?.code },
    };
    record("stale page cannot invoke increment after disable", appStale.ok === false && appStale.error?.code === "page_closed"
        && hostStale.status >= 400 && Boolean(hostStale.body.error), { staleResult });
    await shot("11-desktop-after-disable", "desktop");
    await shot("12-admin-after-disable", "admin");
    await setExtensions(desktop, false);

    // 9. Re-enable, open a page, uninstall with it open (retain data).
    const card2 = admin.locator('.plugin-card[data-plugin-id="studio.counter"]');
    for (const scope of ["counter.read", "counter.write"]) await card2.locator(`input[value="${scope}"]`).check();
    await card2.locator('button[data-action="enable"]').click();
    await waitFor("re-enabled", async () => (await admin.locator('.plugin-card[data-plugin-id="studio.counter"]').getAttribute("data-enabled")) === "true");
    await waitFor("admin entry back", async () => (await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).count()) === 1);
    await setExtensions(desktop, true);
    await waitFor("menu item back", async () => (await desktop.locator("#extension-list .menu-item", { hasText: "カウンター" }).count()) === 1);
    await desktop.locator("#extension-list .menu-item", { hasText: "カウンター" }).click();
    await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).click();
    await waitFor("desktop 2 after re-enable", async () => (await frameText(desktop, "#plugin-sheet-body")) === "2");
    record("re-enable: entries return and saved count 2 is shown; stale increments had no effect", beforeDisable === 2, { valueBeforeDisable: beforeDisable, valueAfterReenable: 2 });

    const card3 = admin.locator('.plugin-card[data-plugin-id="studio.counter"]');
    await card3.locator('button[data-action="uninstall"]').click();
    await card3.locator("input[value=keep]").check();
    await shot("13-admin-uninstall-confirm-retain", "admin");
    await card3.locator('button[data-action="uninstall-confirm"]').click();
    await waitFor("frames removed on uninstall", async () => (await frameCount(desktop)) === 0 && (await frameCount(admin)) === 0);
    await waitFor("plugin list empty", async () => (await admin.locator(".plugin-card").count()) === 0 && admin.locator("#plugin-empty").isVisible());
    await waitFor("admin entries empty", async () => (await admin.locator("#admin-entries .side-entry").count()) === 0);
    await setExtensions(desktop, true);
    await waitFor("desktop menu empty", async () => (await desktop.locator("#extension-list .menu-item").count()) === 0);
    const audit = fs.readFileSync(path.join(profileDir, "logs", "shell-events.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const uninstall = audit.find(e => e.type === "plugin.uninstall");
    record("uninstall while pages open: frames and entries removed; retention choice recorded", uninstall?.retainData === true && uninstall?.openPagesClosed === 2, { uninstall });
    await shot("14-desktop-after-uninstall", "desktop");
    await shot("15-admin-after-uninstall", "admin");
    await setExtensions(desktop, false);

    // 10. Reinstall: retained data comes back.
    await admin.click("#install");
    const card4 = admin.locator('.plugin-card[data-plugin-id="studio.counter"]');
    await waitFor("reinstalled", async () => (await card4.getAttribute("data-enabled")) === "false");
    for (const scope of ["counter.read", "counter.write"]) await card4.locator(`input[value="${scope}"]`).check();
    await card4.locator('button[data-action="enable"]').click();
    await waitFor("admin entry", async () => (await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).count()) === 1);
    await admin.locator("#admin-entries .side-entry", { hasText: "カウンター設定" }).click();
    await waitFor("retained count 2", async () => (await frameText(admin, "#plugin-page-body")) === "2");
    record("reinstall after retainData=true: count 2 restored", true);
    await shot("16-admin-reinstalled-retained-2", "admin");

    const denied = audit.filter(e => e.type.endsWith(".denied"));
    record("no navigation, popup, network, permission or IPC denials during the normal flow", denied.length === 0, { denied: denied.length });
} catch (error) {
    exitCode = 1;
    console.error(error);
    if (!results.length || results[results.length - 1].ok) results.push({ step: "unexpected error", ok: false, error: String(error.message || error) });
    try { await shot("zz-failure-desktop", "desktop"); await shot("zz-failure-admin", "admin"); } catch { /* best effort */ }
} finally {
    try { fs.copyFileSync(path.join(profileDir, "logs", "shell-events.log"), path.join(evidence, "logs", "shell-events.counter-acceptance.log")); } catch { /* none */ }
    await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 10000))]);
    try { app.process().kill("SIGKILL"); } catch { /* already exited */ }
    fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });
    fs.writeFileSync(path.join(evidence, "acceptance-counter.json"), JSON.stringify({
        when: new Date().toISOString(), headless, platform: `${os.type()} ${os.release()}`, node: process.version,
        hostArtifact: path.relative(repo, hostArtifactPath), hostSha256: sha256(hostArtifactPath),
        package: path.relative(repo, counterZip), packageSha256: sha256(counterZip), results,
    }, null, 2));
    console.log(exitCode ? "FAIL counter acceptance" : "PASS counter acceptance");
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(exitCode);
}
