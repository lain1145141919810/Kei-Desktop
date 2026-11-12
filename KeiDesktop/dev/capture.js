'use strict';
// DEVELOPMENT ONLY. Starts the real main.js, drives the main window with the
// steps in KEI_CAPTURE_STEPS (a JSON array), and saves screenshots.
//   electron dev/capture.js --user-data-dir=<tmp>
// Step forms: {"wait":ms} {"js":"..."} {"shot":"name"} {"type":"text"} {"key":"Enter"}
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
// Sandboxed dev shells may forbid the Unix socket behind the single-instance lock.
if (process.env.KEI_CAPTURE_NO_LOCK) app.requestSingleInstanceLock = () => true;
require('../main.js');

const out = process.env.KEI_CAPTURE_DIR || process.cwd();
const steps = JSON.parse(process.env.KEI_CAPTURE_STEPS || '[{"wait":12000},{"shot":"main"}]');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
    await sleep(1500);
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('index.html'));
    main.webContents.on('console-message', event => { if (event.level === 'error') console.log('[renderer error]', event.message); });
    for (const step of steps) {
        if (step.wait) await sleep(step.wait);
        if (step.js) console.log('js:', JSON.stringify(await main.webContents.executeJavaScript(step.js)));
        if (step.type) { main.focus(); main.webContents.focus(); await main.webContents.insertText(step.type); }
        if (step.key) for (const type of ['keyDown', 'keyUp']) main.webContents.sendInputEvent({ type, keyCode: step.key });
        if (step.size) main.setSize(step.size[0], step.size[1]);
        if (step.shot) {
            const image = await main.webContents.capturePage();
            fs.writeFileSync(path.join(out, `${step.shot}.png`), image.toPNG());
            console.log('saved', step.shot);
        }
    }
    app.exit(0);
});
