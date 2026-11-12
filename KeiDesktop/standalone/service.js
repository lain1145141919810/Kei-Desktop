function characterInstruction(config){
    const {name='ケイ',persona=''}=config.character||{};
    return [name+'として自然な日本語で回答してください。コード、固有名詞、引用は原文を保ってください。',persona].filter(Boolean).join('\n');
}
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');

async function post(url, body, key, headers = {}) {
    const response = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(180000),
        headers: { 'Content-Type': 'application/json', ...(key && { Authorization: 'Bearer ' + key }), ...headers },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('接続先の応答：HTTP ' + response.status);
    return response;
}

function createService(config) {
    async function run(action, body) {
        if (!['chat','task','speech'].includes(action)) throw new Error('この操作には対応していません');
        const japanese=characterInstruction(config);
        const text = body?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('1～16000文字で入力してください');
        const session = body.session ?? 'default';
        if (typeof session !== 'string' || !session.length || session.length > 128) throw new Error('会話 ID が正しくありません');
        if (action === 'speech') {
            if (!config.speech.enabled) throw new Error('GPT-SoVITS を有効にし、参照音声を設定してください');
            const v = config.speech;
            const response = await post(v.url, { text, text_lang: v.language, prompt_lang: v.referenceLanguage,
                prompt_text: v.referenceText, ref_audio_path: v.referencePath, media_type: 'wav', streaming_mode: false }, null);
            if (!/audio\//i.test(response.headers.get('content-type') || '')) throw new Error('音声サービスから音声が返りませんでした');
            return Buffer.from(await response.arrayBuffer());
        }
        if (action === 'task') {
            if (config.dsh.entry && !config.dsh.url) {
                const {execFile} = require('node:child_process');
                const execute = require('node:util').promisify(execFile);
                if (!config.dsh.workspace) throw new Error('DSH の作業フォルダーを設定してください');
                const result = await execute('node', [config.dsh.entry,'headless',japanese+'\n最終報告は日本語でお願いします。タスク：' + text], {
                    cwd:config.dsh.workspace, timeout:180000, windowsHide:true, maxBuffer:4*1024*1024
                }).catch(error=>{throw new Error('DSH タスクに失敗しました：' + (error.code ?? '起動エラー'));});
                return {result:result.stdout.trim()};
            }
            if (!config.dsh.url) throw new Error('DSH の接続先を設定してください');
            const scope = 'astrbot-' + createHash('sha256').update(session).digest('hex');
            return (await post(config.dsh.url, {request:japanese+'\n最終報告は日本語でお願いします。タスク：'+text, scope, task_id:randomUUID().replaceAll('-','')}, null,
                {'X-Kei-Bridge': config.dsh.token})).json();
        }
        if (config.chat.provider === 'astrbot') {
            const a = config.astrbot;
            const response = await post(a.url, {username:'kei-desktop',session_id:session,message:japanese+'\n'+(body.memory ? 'ユーザーが保存した記憶：'+body.memory+'\nユーザーのメッセージ：'+text : text),enable_streaming:true}, a.key);
            const pieces = [];
            for (const line of (await response.text()).split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                const item = JSON.parse(data);
                if (item.type === 'plain' && !['reasoning','tool_call','tool_call_result','agent_stats'].includes(item.chain_type)
                    && typeof item.data === 'string') pieces.push(item.data);
            }
            if (!pieces.join('').trim()) throw new Error('AstrBot から本文が返りませんでした');
            return {text:pieces.join('')};
        }
        const c = config.chat;
        if (!c.url || !c.model) throw new Error('設定にモデルの接続先とモデル名を入力してください');
        const history = body.history ?? [];
        if (!Array.isArray(history) || history.length > 64 || history.some(m => !['user','assistant'].includes(m?.role) || typeof m.content !== 'string')) throw new Error('会話履歴の形式が正しくありません');
        const response = await post(c.url,{model:c.model,messages:[{role:'system',content:japanese},...(body.memory?[{role:'system',content:'ユーザーが保存した記憶です。関連する質問にのみ使ってください。'+body.memory}]:[]),...history,{role:'user',content:text}],stream:false},c.key);
        const reply = (await response.json()).choices?.[0]?.message?.content;
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('モデルから本文が返りませんでした');
        return {text:reply};
    }

    const server = http.createServer(async (req,res) => {
        const json = (code, data) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
        if (req.url === '/health' && req.method === 'GET') return json(200,{status:'ok',service:'kei-desktop'});
        if (req.headers.authorization !== 'Bearer ' + config.api.token || !config.api.token) return json(401,{error:'認証が必要です'});
        const route = /^\/v1\/(chat|task|speech)$/.exec(req.url);
        if (req.method !== 'POST' || !route) return json(404,{error:'未対応のエンドポイントです'});
        let input = '';
        req.setEncoding('utf8');
        try {
            for await (const chunk of req) {
                input += chunk;
                if (Buffer.byteLength(input) > 262144) return json(413,{error:'リクエストが大きすぎます'});
            }
            let body;
            try { body = JSON.parse(input); } catch { return json(400,{error:'JSON の形式が正しくありません'}); }
            const result = await run(route[1],body);
            if (Buffer.isBuffer(result)) {res.writeHead(200,{'Content-Type':'audio/wav'});res.end(result);}
            else json(200,result);
        } catch (error) { json(400,{error:error.message}); }
    });
    return {run,server};
}
module.exports = {createService,characterInstruction};
