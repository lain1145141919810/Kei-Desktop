// The shell must boot and stay usable when the host cannot start (disconnected backend).
//   node tests/acceptance/no-host.mjs [--headless]
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = path.resolve(frontend, "..");
const headless = process.argv.includes("--headless");
const run = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "kei-shell-nohost-"));
const env = { ...process.env, KEI_PROFILE_DIR: path.join(run, "profile"), KEI_DATA_DIR: path.join(run, "data"),
    KEI_HOST_PYTHON: path.join(run, "missing-python"), XDG_RUNTIME_DIR: run };
const args = [frontend, "--no-sandbox"];
if (headless) { args.push("--ozone-platform=headless", "--disable-gpu"); env.KEI_OFFSCREEN = "1"; delete env.DISPLAY; }

const app = await electron.launch({ executablePath: require("electron"), args, env, cwd: frontend });
let ok = false;
try {
    const desktop = await app.firstWindow();
    const end = Date.now() + 20000;
    while (Date.now() < end && (await desktop.locator("#connection-text").textContent()) !== "Kei ホスト未接続") await new Promise(r => setTimeout(r, 100));
    const text = await desktop.locator("#connection-text").textContent();
    await desktop.click("#extension-button");
    const empty = await desktop.locator("#extension-empty").isVisible();
    const b64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
    const shots = path.join(path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence")), "screenshots");
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, "00-desktop-host-unavailable.png"), Buffer.from(b64, "base64"));
    ok = text === "Kei ホスト未接続" && empty;
    console.log(`${ok ? "PASS" : "FAIL"} shell boots without a host: status="${text}", extension menu empty=${empty}`);
} finally {
    const closing = Date.now();
    const closed = await Promise.race([app.close().then(() => true, () => true), new Promise(r => setTimeout(() => r(false), 10000))]);
    console.log(`${closed ? "PASS" : "FAIL"} shell quits cleanly without a host (${Date.now() - closing} ms)`);
    if (!closed) ok = false;
    try { app.process().kill("SIGKILL"); } catch { /* already exited */ }
    fs.rmSync(run, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
}
