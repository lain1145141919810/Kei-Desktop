const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const elements = new Map();
function element() {
    return {
        textContent: '', hidden: false, style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {},
    };
}
const document = {
    body: element(), hidden: false,
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    },
    addEventListener() {},
};
const sockets = [];
class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() {
        this.readyState = FakeSocket.CONNECTING;
        this.listeners = new Map();
        sockets.push(this);
    }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    emit(type, data = {}) { this.listeners.get(type)?.(data); }
}
const stopped = [];
const character = {
    initialize: async () => {}, setVisible() {}, interruptCount: 0,
    interrupt() { this.interruptCount += 1; }, setSpeaking(value) { this.speaking = value; },
};
const scene = {
    resetCount: 0, resetToIdle() { this.resetCount += 1; },
    handleRuntimeEvent(event) { this.lastEvent = event; return true; },
};
const timers = [];
const context = {
    document,
    window: { keiDesktop: { stopPlayback: turnId => stopped.push(turnId) } },
    WebSocket: FakeSocket,
    WebMRenderer: class {},
    CharacterController: class { constructor() { return character; } },
    SceneController: class { constructor() { return scene; } },
    DesktopLifecycleController: class {
        constructor() { this.phase = 'ready'; }
        start() {} runtimeReady() {} observeEvent() {}
    },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8'), context);

setImmediate(() => {
    assert.equal(sockets.length, 1);
    sockets[0].readyState = FakeSocket.OPEN;
    sockets[0].emit('open');
    vm.runInContext(`state.currentTurnId = 'turn-a'; activeTtsTurnId = 'turn-a';
        state.speaking = true; pendingSubtitles.set('turn-a', 'old');`, context);
    sockets[0].readyState = 3;
    sockets[0].emit('close');
    assert.deepEqual(stopped, ['turn-a']);
    assert.equal(scene.resetCount, 1);
    assert.equal(character.interruptCount, 1);
    assert.equal(character.speaking, false);
    assert.equal(elements.get('subtitle-chinese').textContent, '');
    assert.equal(vm.runInContext('pendingSubtitles.size', context), 0);
    assert.equal(vm.runInContext('state.currentTurnId', context), null);
    timers.at(-1)();
    assert.equal(sockets.length, 2);
    sockets[0].emit('open');
    assert.equal(vm.runInContext('state.connected', context), false,
        'late callbacks from the old socket must not change the new connection state');
    sockets[1].readyState = FakeSocket.OPEN;
    sockets[1].emit('open');
    assert.equal(vm.runInContext('state.connected', context), true);
    assert.equal(vm.runInContext("retiredTurnIds.has('turn-a')", context), true);
    sockets[1].emit('message', { data: JSON.stringify({
        type: 'agent.scene.snapshot', turn_id: 'turn-a',
        payload: { revision: 3, steps: [] },
    }) });
    assert.equal(scene.lastEvent.type, 'agent.scene.snapshot');
    assert.equal(vm.runInContext("retiredTurnIds.has('turn-a')", context), false);
    console.log('desktop reconnect passed');
});
