// DEF-01 fixture check (Linux, deterministic): real admin.html + real preload, fixture host.
// Admin opens while the host is down, then the fixture connects exactly the way main.js
// announces it. No click on 今すぐ更新 anywhere. Covers the stale-reply race, empty,
// populated and disconnected states, and keyboard focus across automatic refreshes.
//
//   node tests/acceptance/admin-models-fixture.mjs [--headless] [--runs 5]
// KEI_FRONTEND_DIR points at another checkout (e.g. the baseline) to compare.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const HEADLESS = process.argv.includes("--headless");
const runsAt = process.argv.indexOf("--runs");
const RUNS = runsAt > 0 ? Number(process.argv[runsAt + 1]) : 5;
const out = path.resolve(process.env.KEI_EVIDENCE_DIR || path.join(repo, "evidence", "admin-models"));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CANNOT_LIST = "Kei ホストに接続できないため、モデルを表示できません。";
const CANNOT_CHAT = "Kei ホストに接続できないため、会話モデル設定を読み込めません。";

const read = () => ({
    summary: document.getElementById("model-summary")?.textContent ?? "",
    list: document.getElementById("model-list")?.textContent ?? "",
    cards: document.querySelectorAll("#model-list .model-card").length,
    options: [...document.querySelectorAll("#model-list option")].filter(o => o.value).length,
    chat: document.getElementById("chat-config-current")?.textContent ?? "",
    focus: document.activeElement && document.activeElement !== document.body
        ? [document.activeElement.closest(".model-card")?.dataset.capability ?? null, document.activeElement.dataset?.role ?? null] : null,
});
const waitFor = async (page, fn, arg, ms = 4000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 50 }).then(() => true, () => false);

const rows = [];
for (let run = 0; run < RUNS; run++) {
    const app = await electron.launch({
        executablePath: require("electron"),
        args: [path.join(here, "admin-models-fixture-main.cjs"), "--no-sandbox", ...(HEADLESS ? ["--ozone-platform=headless", "--disable-gpu"] : [])],
        env: { ...process.env }, timeout: 30_000,
    });
    const row = { run };
    try {
        const page = await app.firstWindow();
        await page.waitForLoadState("domcontentloaded");
        // Stale-reply race on alternate runs: the pre-connect failure is still in flight
        // when the connect broadcast arrives and its fast success lands first.
        row.staleRace = run % 2 === 1;
        if (row.staleRace) await app.evaluate(() => global.__fixture.set({ failDelayMs: 600 }));
        await page.evaluate(() => document.getElementById("models")?.scrollIntoView());
        if (row.staleRace) {
            await page.evaluate(() => document.getElementById("refresh").click()); // in-flight slow failure
            await sleep(100);
        } else {
            await waitFor(page, ([a, b]) => document.getElementById("model-list").textContent.includes(a)
                && document.getElementById("chat-config-current").textContent.includes(b), [CANNOT_LIST, CANNOT_CHAT]);
        }
        row.beforeHost = await page.evaluate(read);
        await app.evaluate(() => global.__fixture.connect());
        await sleep(1200); // past any slow stale failure
        row.afterConnect = await page.evaluate(read);
        row.listRecovered = row.afterConnect.cards === 4 && !row.afterConnect.list.includes(CANNOT_LIST);
        row.chatRecovered = !row.afterConnect.chat.includes(CANNOT_CHAT) && row.afterConnect.chat.length > 0;
        row.emptyState = row.afterConnect.cards === 4 && row.afterConnect.options === 0;
        // Keyboard focus survives an automatic refresh (populate) and a disconnect.
        await page.locator('.model-card[data-capability="asr"] [data-role="select"]').focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        row.focusBefore = (await page.evaluate(read)).focus;
        await app.evaluate(() => global.__fixture.populate());
        await waitFor(page, () => [...document.querySelectorAll("#model-list option")].some(o => o.value));
        row.populated = await page.evaluate(read);
        row.focusKeptOnPopulate = JSON.stringify(row.populated.focus) === JSON.stringify(row.focusBefore);
        await app.evaluate(() => global.__fixture.disconnect());
        await waitFor(page, () => document.getElementById("model-summary").textContent.includes("接続待ち"), null, 2500);
        row.disconnected = await page.evaluate(read);
        row.focusKeptOnDisconnect = JSON.stringify(row.disconnected.focus) === JSON.stringify(row.focusBefore);
        await app.evaluate(() => global.__fixture.connect());
        await sleep(400);
        row.reconnected = await page.evaluate(read);
        row.refreshClicksByUser = 0;
    } catch (error) {
        row.error = String(error.message).split("\n")[0];
    } finally {
        await app.close().catch(() => {});
    }
    row.ok = !row.error && row.listRecovered && row.chatRecovered && row.emptyState && row.populated?.options === 8
        && row.focusKeptOnPopulate && row.disconnected?.cards === 4 && row.disconnected?.summary.includes("接続待ち")
        && row.focusKeptOnDisconnect && row.reconnected?.options === 8 && !row.reconnected?.summary.includes("接続待ち");
    rows.push(row);
    console.log(`${row.ok ? "PASS" : "FAIL"} admin-models fixture ${run + 1}/${RUNS}${row.staleRace ? " (stale-reply race)" : ""} ` +
        `list=${row.listRecovered} chat=${row.chatRecovered} empty=${row.emptyState} populatedOpts=${row.populated?.options ?? "-"} ` +
        `focusPopulate=${row.focusKeptOnPopulate} disconnected="${row.disconnected?.summary ?? "-"}"/${row.disconnected?.cards ?? "-"}cards ` +
        `focusDisconnect=${row.focusKeptOnDisconnect}` + (row.error ? " error=" + row.error : ""));
}
fs.writeFileSync(path.join(out, "admin-models-fixture.json"), JSON.stringify({ kind: "fixture", headless: HEADLESS, rows }, null, 2));
const passed = rows.filter(r => r.ok).length;
console.log(`SUMMARY admin-models fixture: ${passed}/${RUNS}`);
process.exit(passed === RUNS ? 0 : 1);
