'use strict';
// DEVELOPMENT FIXTURE — not KeiRuntime and never started by the app.
// Stands in for the runtime on 127.0.0.1:17881 so the desktop UI can be driven
// without the original machine. Event names and payload fields mirror what
// renderer/app.js and scene_controller.js already handle; anything shown with
// this fixture is simulated evidence.
//
//   node dev/mock-runtime.js            answer every user.message
//   POST /dev/voice {"text":"..."}      simulate a recognised voice turn
//   KEI_MOCK_ECHO=1                     also echo user.message to the socket
//   A message starting with 【画面観察メモ】 is answered with [[SILENT]] unless it
//   mentions an error, to exercise both outcomes of proactive speech.
const http = require('http');
const crypto = require('crypto');

const PORT = 17881;
const clients = new Set();
let revision = 1;

function frame(text) {
    const data = Buffer.from(text, 'utf8');
    const head = data.length < 126 ? Buffer.from([0x81, data.length])
        : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
        : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(data.length)); return b; })()]);
    return Buffer.concat([head, data]);
}
const interrupted = new Set();
function broadcast(event) {
    // Like a real runtime, an interrupted turn produces nothing further.
    if (event.type !== 'interrupt' && interrupted.has(event.turn_id)) return;
    const packet = frame(JSON.stringify(event));
    for (const socket of clients) socket.write(packet);
    console.log('->', event.type, event.turn_id || '');
}
const later = (ms, fn) => setTimeout(fn, ms);

function answer(session_id, turn_id, text) {
    // A proactive observation note: stay silent unless the screen shows a problem.
    const observation = text.startsWith('【画面観察メモ】');
    const silent = observation && !/エラー|失敗|error/i.test(text);
    const search = !observation && /搜索|查一下|search|検索|調べて/i.test(text);
    const base = { session_id, turn_id };
    let at = 300;
    later(at, () => broadcast({ ...base, type: 'agent.begin', payload: { activity: 'thinking', scene_revision: ++revision } }));
    if (search) {
        later(at += 700, () => broadcast({ ...base, type: 'agent.tool.start', payload: { tool_name: 'desktop_web_search', activity: 'searching', subject: text.slice(0, 40), scene_revision: ++revision } }));
        later(at += 2600, () => broadcast({ ...base, type: 'agent.tool.end', payload: { tool_name: 'desktop_web_search', activity: 'searching', status: 'completed', duration_ms: 2600, result_count: 3,
            result_previews: [{ title: '示例来源：模拟搜索结果', snippet: '这是开发夹具返回的占位摘要。', source: 'example.test' }], scene_revision: ++revision } }));
    }
    const reply = silent ? '[[SILENT]]' : observation ? '画面にエラーが出ているようですね。手伝いましょうか。' : search
        ? '老师，我查到了。结论：这是模拟运行环境给出的示例结果，共 3 条来源。'
        : `收到了，老师。你刚才说的是“${text.slice(0, 40)}”。这是模拟运行环境的回复。`;
    const japanese = observation ? 'エラーが出ているようですね。手伝いましょうか。' : search
        ? '先生、調べました。これはモックランタイムのサンプル結果です。'
        : '了解しました、先生。これはモックランタイムからの返事です。';
    later(at += 900, () => {
        broadcast({ ...base, type: 'assistant.affect', payload: { affect: { valence: .65, arousal: .7, intensity: .65, warmth: .85, restraint: .4 } } });
        broadcast({ ...base, type: 'assistant.reply', text: reply, payload: search ? { result_summary: '• 模拟搜索完成\n• 3 条来源' } : {} });
        broadcast({ ...base, type: 'agent.done', payload: { has_reply: true, scene_revision: ++revision } });
        broadcast({ ...base, type: 'assistant.translation', text: japanese, payload: { segment_index: 1 } });
    });
    later(at += 600, () => broadcast({ ...base, type: 'tts.start', text: japanese, payload: { segment_index: 1 } }));
    for (let i = 1; i <= 24; i++) later(at + i * 110, () => broadcast({ ...base, type: 'tts.mouth', payload: { value: Math.abs(Math.sin(i * 1.3)) } }));
    later(at += 2900, () => {
        broadcast({ ...base, type: 'tts.mouth', payload: { value: 0, final: true, reason: 'completed' } });
        broadcast({ ...base, type: 'tts.end', payload: { status: 'completed', segment_final: true } });
    });
}

function receive(event) {
    if (event.type === 'user.message') {
        if (process.env.KEI_MOCK_ECHO) broadcast(event);
        answer(event.session_id, event.turn_id, String(event.text || ''));
    } else if (event.type === 'tts.request') {
        later(200, () => broadcast({ type: 'tts.start', session_id: event.session_id, turn_id: event.turn_id, text: event.text, payload: {} }));
        later(1800, () => broadcast({ type: 'tts.end', session_id: event.session_id, turn_id: event.turn_id, payload: { status: 'completed', segment_final: true } }));
    } else if (event.type === 'interrupt') {
        interrupted.add(event.turn_id);
        broadcast(event);
    }
}

const server = http.createServer((request, response) => {
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method === 'GET' && request.url === '/health') return json(200, { status: 'ok', desktop_clients: clients.size, mock: true });
    if (request.method !== 'POST') return json(404, { detail: 'mock runtime: not found' });
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { return json(400, { detail: 'invalid json' }); }
        if (request.url === '/events') { receive(data); return json(200, { status: 'accepted' }); }
        if (request.url === '/dev/voice') {
            const turn_id = crypto.randomUUID();
            broadcast({ type: 'user.transcript', session_id: 'mock-voice', turn_id, text: String(data.text || '') });
            answer('mock-voice', turn_id, String(data.text || ''));
            return json(200, { status: 'accepted', turn_id });
        }
        return json(404, { detail: 'mock runtime: not found' });
    });
});

server.on('upgrade', (request, socket) => {
    if (!request.url.startsWith('/ws')) return socket.destroy();
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    clients.add(socket);
    console.log('client connected:', request.url);
    socket.write(frame(JSON.stringify({ type: 'runtime.connected', session_id: 'mock', payload: {} })));
    socket.write(frame(JSON.stringify({ type: 'agent.scene.snapshot', session_id: 'mock', payload: { revision: ++revision, steps: [] } })));
    const drop = () => clients.delete(socket);
    socket.on('data', data => { if ((data[0] & 0x0f) === 8) { drop(); socket.end(); } });
    socket.on('close', drop);
    socket.on('error', drop);
});

server.listen(PORT, '127.0.0.1', () => console.log(`MOCK runtime (development fixture) on 127.0.0.1:${PORT}`));
