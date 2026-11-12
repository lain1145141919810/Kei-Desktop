const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');

async function post(url, body, key, headers = {}) {
    const response = await fetch(url, {
        method: 'POST', signal: AbortSignal.timeout(180000),
        headers: { 'Content-Type': 'application/json', ...(key && { Authorization: 'Bearer ' + key }), ...headers },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error('上游服务返回 HTTP ' + response.status);
    return response;
}

function createService(config) {
    async function run(action, body) {
        if (!['chat','task','speech'].includes(action)) throw new Error('未知操作');
        const text = body?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('请输入 1–16000 个字符');
        const session = body.session ?? 'default';
        if (typeof session !== 'string' || !session.length || session.length > 128) throw new Error('无效的会话 ID');
        if (action === 'speech') {
            if (!config.speech.enabled) throw new Error('请先启用 GPT-SoVITS 并配置参考音频');
            const v = config.speech;
            const response = await post(v.url, { text, text_lang: v.language, prompt_lang: v.referenceLanguage,
                prompt_text: v.referenceText, ref_audio_path: v.referencePath, media_type: 'wav', streaming_mode: false }, null);
            if (!/audio\//i.test(response.headers.get('content-type') || '')) throw new Error('语音服务未返回音频');
            return Buffer.from(await response.arrayBuffer());
        }
        if (action === 'task') {
            if (config.dsh.entry && !config.dsh.url) {
                const {execFile} = require('node:child_process');
                const execute = require('node:util').promisify(execFile);
                if (!config.dsh.workspace) throw new Error('请配置 DSH 工作目录');
                const result = await execute('node', [config.dsh.entry,'headless','Task: ' + text], {
                    cwd:config.dsh.workspace, timeout:180000, windowsHide:true, maxBuffer:4*1024*1024
                }).catch(error=>{throw new Error('DSH 任务失败：' + (error.code ?? '启动错误'));});
                return {result:result.stdout.trim()};
            }
            if (!config.dsh.url) throw new Error('请先配置 DSH 任务接口');
            const scope = 'astrbot-' + createHash('sha256').update(session).digest('hex');
            return (await post(config.dsh.url, {request:text, scope, task_id:randomUUID().replaceAll('-','')}, null,
                {'X-Kei-Bridge': config.dsh.token})).json();
        }
        if (config.chat.provider === 'astrbot') {
            const a = config.astrbot;
            const response = await post(a.url, {username:'kei-desktop',session_id:session,message:body.memory ? '用户保存的记忆：'+body.memory+'\n用户消息：'+text : text,enable_streaming:true}, a.key);
            const pieces = [];
            for (const line of (await response.text()).split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                const item = JSON.parse(data);
                if (item.type === 'plain' && !['reasoning','tool_call','tool_call_result','agent_stats'].includes(item.chain_type)
                    && typeof item.data === 'string') pieces.push(item.data);
            }
            if (!pieces.join('').trim()) throw new Error('AstrBot 未返回文本');
            return {text:pieces.join('')};
        }
        const c = config.chat;
        if (!c.url || !c.model) throw new Error('请在设置中填写模型接口地址和模型名');
        const history = body.history ?? [];
        if (!Array.isArray(history) || history.length > 64 || history.some(m => !['user','assistant'].includes(m?.role) || typeof m.content !== 'string')) throw new Error('无效的对话历史');
        const response = await post(c.url,{model:c.model,messages:[...(body.memory?[{role:'system',content:'用户保存的记忆，仅用于相关问题：'+body.memory}]:[]),...history,{role:'user',content:text}],stream:false},c.key);
        const reply = (await response.json()).choices?.[0]?.message?.content;
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('模型未返回文本');
        return {text:reply};
    }

    const server = http.createServer(async (req,res) => {
        const json = (code, data) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
        if (req.url === '/health' && req.method === 'GET') return json(200,{status:'ok',service:'kei-desktop'});
        if (req.headers.authorization !== 'Bearer ' + config.api.token || !config.api.token) return json(401,{error:'Unauthorized'});
        const route = /^\/v1\/(chat|task|speech)$/.exec(req.url);
        if (req.method !== 'POST' || !route) return json(404,{error:'Unknown endpoint'});
        let input = '';
        req.setEncoding('utf8');
        try {
            for await (const chunk of req) {
                input += chunk;
                if (Buffer.byteLength(input) > 262144) return json(413,{error:'Request too large'});
            }
            let body;
            try { body = JSON.parse(input); } catch { return json(400,{error:'Invalid JSON'}); }
            const result = await run(route[1],body);
            if (Buffer.isBuffer(result)) {res.writeHead(200,{'Content-Type':'audio/wav'});res.end(result);}
            else json(200,result);
        } catch (error) { json(400,{error:error.message}); }
    });
    return {run,server};
}
module.exports = {createService};
