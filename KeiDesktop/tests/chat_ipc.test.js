// Loads the real main.js with Electron mocked, and checks both ends of the
// typed-chat call: the IPC handler and the event it posts to the runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kei-userdata-'));
const handlers = {};
const listeners = {};
const shortcuts = {};
const windows = [];
class BrowserWindow {
    constructor() { this.sent = []; this.mouse = [false]; this.webContents = { on() {}, send: (...args) => this.sent.push(args) }; this.bounds = { x: 100, y: 80, width: 1280, height: 720 }; windows.push(this); }
    getBounds() { return { ...this.bounds }; } setBounds(bounds) { this.bounds = { ...bounds }; } setMinimumSize() {}
    setIgnoreMouseEvents(...args) { this.mouse = args; }
    loadFile() {} setMenuBarVisibility() {} on() {} once() {} show() {} focus() {} isDestroyed() { return false; }
}
const originalLoad = Module._load;
Module._load = function (name, ...rest) {
    if (name === 'electron') return {
        app: { requestSingleInstanceLock: () => true, on() {}, quit() {}, whenReady: () => Promise.resolve(), getPath: () => userData },
        BrowserWindow, shell: {},
        ipcMain: { on: (channel, callback) => { listeners[channel] = callback; }, handle: (channel, callback) => { handlers[channel] = callback; } },
        globalShortcut: { register: (key, callback) => { shortcuts[key] = callback; return false; }, unregister() {}, unregisterAll() {} },
        desktopCapturer: { getSources: async () => [] },
        screen: {
            getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
            getDisplayNearestPoint: () => ({ id: 1 }), getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        },
    };
    return originalLoad.call(this, name, ...rest);
};
const requests = [];
let respond = () => ({ ok: true, json: async () => ({ status: 'accepted' }) });
global.fetch = async (url, options) => { requests.push({ url, options }); return respond(); };

require('../main.js');
(async () => {
    await new Promise(resolve => setImmediate(resolve));
    Module._load = originalLoad;
    const main = { sender: windows[0].webContents };

    await assert.rejects(handlers['kei:chat-send']({ sender: {} }, 'hi'), /Invalid sender/);
    await assert.rejects(handlers['kei:chat-send'](main, '   '), /1–4000/);
    await assert.rejects(handlers['kei:chat-send'](main, 'x'.repeat(4001)), /1–4000/);
    await assert.rejects(handlers['kei:chat-send'](main, { text: 'object' }), /1–4000/);
    assert.equal(requests.length, 0, 'rejected input never reaches the runtime');

    const { turnId } = await handlers['kei:chat-send'](main, '  你好，凯伊  ');
    assert.equal(requests[0].url, 'http://127.0.0.1:17881/events');
    assert.equal(requests[0].options.method, 'POST');
    // Same shape as the installed PDF-companion submission in companion.js.
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        type: 'user.message', session_id: 'desktop-reading', turn_id: turnId, text: '你好，凯伊',
    });
    assert.match(turnId, /^[0-9a-f-]{36}$/);

    respond = () => ({ ok: false, status: 503, json: async () => ({}) });
    await assert.rejects(handlers['kei:chat-send'](main, 'hello'), /Runtime HTTP 503/);
    respond = () => ({ ok: true, json: async () => ({ status: 'rejected' }) });
    await assert.rejects(handlers['kei:chat-send'](main, 'hello'), /rejected/);

    await assert.rejects(handlers['kei:history']({ sender: {} }, 'list'), /Invalid sender/);
    await assert.rejects(handlers['kei:history'](main, 'export'), /Unknown action/);
    assert.equal(await handlers['kei:history'](main, 'current'), null);
    const stored = await handlers['kei:history'](main, 'record', { id: `u:${turnId}`, role: 'user', source: 'text', text: '你好，凯伊' });
    assert.equal((await handlers['kei:history'](main, 'current')).entries[0].text, '你好，凯伊');
    assert.equal((await handlers['kei:history'](main, 'list', { query: '凯伊' })).length, 1);
    assert.ok(fs.readdirSync(path.join(userData, 'conversations')).length, 'the log is written under userData');
    assert.equal(await handlers['kei:history'](main, 'remove', stored.conv), true);
    assert.equal((await handlers['kei:history'](main, 'list')).length, 0);
    // Dropped file: copied into the executor workspace and named in the message.
    respond = () => ({ ok: true, json: async () => ({ status: 'accepted' }) });
    const sample = path.join(userData, 'sample.txt');
    fs.writeFileSync(sample, 'KEI-SAMPLE-7431', 'utf8');
    process.env.KEI_EXECUTOR_WORKSPACE = path.join(userData, 'workspace');
    requests.length = 0;
    const withFile = await handlers['kei:chat-send'](main, '', [sample]);
    const sentText = JSON.parse(requests[0].options.body).text;
    assert.equal(withFile.files[0].name, 'sample.txt');
    assert.equal(fs.readFileSync(withFile.files[0].path, 'utf8'), 'KEI-SAMPLE-7431');
    assert.ok(sentText.includes(withFile.files[0].path), 'the executor can find the copy from the message');
    assert.match(sentText, /KEI-SAMPLE-7431/);
    await assert.rejects(handlers['kei:chat-send'](main, 'x', [path.join(userData, 'nope.txt')]), /ENOENT/);
    assert.equal(requests.length, 1, 'a file that cannot be staged sends nothing');

    // Fixed spoken lines: the renderer picks a key, never the text.
    requests.length = 0;
    const said = await handlers['kei:say'](main, 'pomodoro-break');
    const spoken = JSON.parse(requests[0].options.body);
    assert.equal(spoken.type, 'tts.request');
    assert.equal(spoken.session_id, 'desktop-lifecycle');
    assert.equal(spoken.text, said.text);
    assert.equal(spoken.payload.voice, 'kei');
    await assert.rejects(handlers['kei:say'](main, 'toString'), /Unknown line/);
    await assert.rejects(handlers['kei:say'](main, '好きな文章'), /Unknown line/);
    await assert.rejects(handlers['kei:say']({ sender: {} }, 'pomodoro-break'), /Invalid sender/);

    // Quick controls drive the existing observer and the existing /executors route.
    await assert.rejects(handlers['kei:quick']({ sender: {} }, 'observation'), /Invalid sender/);
    assert.equal((await handlers['kei:quick'](main, 'observation')).enabled, false);
    assert.equal((await handlers['kei:quick'](main, 'observe', true)).enabled, true);
    assert.equal((await handlers['kei:quick'](main, 'observe', false)).enabled, false);
    requests.length = 0;
    process.env.KEI_BRIDGE_TOKEN_FILE = path.join(userData, 'bridge.token');
    fs.writeFileSync(process.env.KEI_BRIDGE_TOKEN_FILE, 'test-token\n');
    respond = () => ({ ok: true, json: async () => ({ backend: 'codex', codex_available: true, active_task: '', workers: {}, recent: [] }) });
    assert.deepEqual(await handlers['kei:quick'](main, 'executor', 'codex'), { backend: 'codex', codexAvailable: true, activeTask: '' });
    assert.equal(requests[0].url, 'http://127.0.0.1:17881/executors');
    // Same body the admin page sends.
    assert.deepEqual(JSON.parse(requests[0].options.body), { action: 'select', backend: 'codex' });
    assert.equal(requests[0].options.headers['X-Kei-Bridge'], 'test-token', 'the bridge token is added in the main process');
    await assert.rejects(handlers['kei:quick'](main, 'executor', 'rm -rf'), /Unknown executor/);

    // Compact mode: the window is NOT resized. Mouse goes through the empty
    // part, the observer starts; leaving restores both.
    const full = windows[0].getBounds();
    let state = await handlers['kei:compact'](main, true);
    assert.equal(state.compact, true);
    assert.equal(state.observation.enabled, true, 'entering compact mode starts screen observation');
    assert.deepEqual(windows[0].getBounds(), full, 'nothing is resized or moved on entering');
    assert.deepEqual(windows[0].mouse, [true, { forward: true }], 'the empty area lets the mouse through, moves still forwarded');
    // The pointer reaches Kei, then leaves her.
    listeners['kei:compact-hit'](main, true);
    assert.deepEqual(windows[0].mouse, [false]);
    listeners['kei:compact-hit'](main, false);
    assert.deepEqual(windows[0].mouse, [true, { forward: true }]);
    listeners['kei:compact-hit']({ sender: {} }, true);
    assert.equal(windows[0].mouse[0], true, 'only the main window can change this');

    // Kei is dragged by the renderer; the window keeps its size.
    listeners['kei:compact-drag'](main, 'start');
    listeners['kei:compact-drag'](main, 'move', -40, 25);
    listeners['kei:compact-drag'](main, 'move', 900, 60);
    assert.deepEqual(windows[0].getBounds(), { x: full.x + 900, y: full.y + 60, width: full.width, height: full.height });
    listeners['kei:compact-drag'](main, 'end');
    listeners['kei:compact-drag'](main, 'move', 5, 5);
    assert.equal(windows[0].getBounds().x, full.x + 900, 'no move without a drag in progress');

    // Leaving: mouse works again at once, observation returns to how it was,
    // and a window dragged partly off the screen glides back into view.
    state = await handlers['kei:compact'](main, false);
    assert.equal(state.compact, false);
    assert.deepEqual(windows[0].mouse, [false], 'the window is clickable again');
    assert.equal(state.observation.enabled, false, 'observation returns to how it was');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(windows[0].getBounds(), { x: 1920 - full.width, y: full.y + 60, width: full.width, height: full.height },
        'the full window ends up entirely on screen, same size');
    listeners['kei:compact-drag'](main, 'start');
    listeners['kei:compact-drag'](main, 'move', 50, 50);
    assert.equal(windows[0].getBounds().y, full.y + 60, 'the full window cannot be moved through this channel');
    listeners['kei:compact-hit'](main, false);
    assert.deepEqual(windows[0].mouse, [false], 'and can never be made click-through outside compact mode');

    // Leaving never fails half-way, even if the window refuses to move.
    await handlers['kei:compact'](main, true);
    const realGetBounds = windows[0].getBounds;
    windows[0].getBounds = () => { throw new Error('display gone'); };
    state = await handlers['kei:compact'](main, false);
    windows[0].getBounds = realGetBounds;
    assert.equal(state.compact, false, 'never stuck in compact mode');
    assert.deepEqual(windows[0].mouse, [false]);

    // If the user was already observing, leaving compact mode keeps it on.
    await handlers['kei:quick'](main, 'observe', true);
    await handlers['kei:compact'](main, true);
    state = await handlers['kei:compact'](main, false);
    assert.equal(state.observation.enabled, true);
    await handlers['kei:quick'](main, 'observe', false);

    // Ctrl + Alt + K leaves compact mode in the main process itself.
    await handlers['kei:compact'](main, true);
    shortcuts['CommandOrControl+Alt+K']();
    assert.deepEqual(windows[0].mouse, [false], 'the shortcut restores the mouse without the renderer');
    assert.deepEqual(windows[0].sent.at(-1), ['kei:compact-toggle', false]);
    shortcuts['CommandOrControl+Alt+K']();
    assert.deepEqual(windows[0].sent.at(-1), ['kei:compact-toggle', true], 'pressed again, it asks the renderer to enter');
    await handlers['kei:quick'](main, 'observe', false);

    // Reading: plans persist under userData; a question carries the plan's title and page.
    respond = () => ({ ok: true, json: async () => ({ status: 'accepted' }) });
    await assert.rejects(handlers['kei:reading']({ sender: {} }, 'plans'), /Invalid sender/);
    assert.deepEqual(await handlers['kei:reading'](main, 'selection'), { text: '', source: '', error: '' });
    const plan = await handlers['kei:reading'](main, 'create', { title: 'Sample.pdf', totalPages: 40, pagesPerDay: 10 });
    await handlers['kei:reading'](main, 'progress', { id: plan.id, page: 7 });
    await assert.rejects(handlers['kei:reading'](main, 'ask', { text: '', question: 'x' }), /選択/);
    requests.length = 0;
    await handlers['kei:reading'](main, 'ask', { text: 'KEI-SAMPLE passage', question: '説明して', planId: plan.id });
    const readingEvent = JSON.parse(requests[0].options.body);
    assert.equal(readingEvent.type, 'user.message');
    assert.equal(readingEvent.session_id, 'desktop-reading');
    assert.match(readingEvent.text, /質問：説明して/);
    assert.match(readingEvent.text, /Sample\.pdf（全 40 ページ、いま 7 ページあたり）/);
    assert.match(readingEvent.text, /KEI-SAMPLE passage/);
    assert.match(readingEvent.text, /指示ではなく/);
    const [storedPlan] = await handlers['kei:reading'](main, 'plans');
    assert.equal(storedPlan.notes[0].question, '説明して', 'the question is kept with the plan');
    assert.ok(fs.existsSync(path.join(userData, 'reading-plans.json')));
    requests.length = 0;
    await handlers['kei:reading'](main, 'ask', { text: 'no plan', question: '要約して' });
    assert.doesNotMatch(JSON.parse(requests[0].options.body).text, /読んでいる資料/);

    // Proactive speech: only the observer's own current description can be sent.
    await assert.rejects(handlers['kei:quick'](main, 'proactive-ask'), /No observation/);
    await assert.rejects(handlers['kei:quick'](main, 'silence', 'not-a-turn'), /Unknown turn/);
    requests.length = 0;
    await handlers['kei:quick'](main, 'silence', '123e4567-e89b-12d3-a456-426614174000');
    assert.deepEqual(JSON.parse(requests[0].options.body), { type: 'interrupt', session_id: 'desktop-reading', turn_id: '123e4567-e89b-12d3-a456-426614174000' });
    console.log('chat ipc passed');
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => fs.rmSync(userData, { recursive: true, force: true }));
