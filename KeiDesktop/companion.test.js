const assert = require('node:assert/strict');
const Module = require('module');
const originalLoad = Module._load;
const handlers = {}, shortcuts = {}, files = new Map(), published = [];
let fetchResolve, captures = 0;
const admin = { webContents: { send() {} } };
const thumbnail = { isEmpty: () => false, resize() { return this; }, toBitmap: () => Buffer.alloc(64 * 40 * 4), toJPEG: () => Buffer.from('test') };
Module._load = function(name, ...rest) {
    if (name === 'electron') return {
        desktopCapturer: { getSources: async () => { captures++; return [{ display_id: '1', thumbnail }]; } },
        screen: { getDisplayNearestPoint: () => ({ id: 1 }), getCursorScreenPoint: () => ({x: 0, y: 0}) },
        globalShortcut: { register: (key, cb) => { shortcuts[key] = cb; return true; }, unregisterAll() {} },
    };
    if (name === 'fs') return {
        unlinkSync: p => files.delete(p), readFileSync: () => 'test-token',
        writeFileSync: (p, data) => files.set(p, data), renameSync: (p, q) => { files.set(q, files.get(p)); files.delete(p); },
    };
    return originalLoad.call(this, name, ...rest);
};
global.fetch = () => new Promise(resolve => { fetchResolve = resolve; });
const stop = require('./companion')({ ipcMain: { handle: (key, cb) => handlers[key] = cb }, getAdmin: () => admin, openAdmin() {}, publish: async value => published.push(value) });
Module._load = originalLoad;
const invoke = (action, data) => handlers['kei:companion']({ sender: admin.webContents }, action, data);
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
    assert.equal((await invoke('status')).enabled, false);
    assert.equal(captures, 0);
    await assert.rejects(handlers['kei:companion']({ sender: {} }, 'toggle', true), /Invalid sender/);
    await invoke('toggle', true); await tick();
    assert.equal(captures, 1);
    await invoke('toggle', false);
    fetchResolve({ ok: true, json: async () => ({ text: 'stale observation' }) }); await tick(); await tick();
    assert.equal(files.size, 0, 'late responses must not restore stopped observations');
    assert.equal((await invoke('status')).description, '');
    await invoke('toggle', true); await tick();
    fetchResolve({ ok: true, json: async () => ({ text: 'fresh evidence' }) }); await tick(); await tick();
    assert.equal(JSON.parse(files.get('D:/KeiRuntime/data/desktop-observation.json')).text, 'fresh evidence');
    await invoke('toggle', false);
    assert.equal(files.size, 0);
    await assert.rejects(invoke('ask', { text: '', question: 'explain' }));
    await invoke('ask', { text: 'PDF selected text', question: 'Explain' });
    assert.equal(published.length, 1);
    assert.equal(published[0].type, 'user.message');
    assert.match(published[0].text, /PDF selected text/);
    assert.match(published[0].text, /不是用户个人经历/);
    stop();
    console.log('PASS: default off, sender validation, stop race, fresh cache, clear cache, selection validation, desktop routing');
})().catch(error => { stop(); console.error(error); process.exitCode = 1; });
