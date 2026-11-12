const { app, ipcMain, session } = require('electron');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');

module.exports=async function desktopRuntime({getWindow,service,config,media,settings}){
    const dir=app.getPath('userData');
    const memory=require('./memory')(path.join(dir,'memory.sqlite'));
    const root=path.resolve(__dirname,'../live2d-official/public');
    const files=http.createServer((req,res)=>{
        let url;
        try{url=new URL(req.url,'http://localhost').pathname;}catch{res.writeHead(400).end();return;}
        const file=path.resolve(root,'.'+url);
        if(!file.startsWith(root+path.sep)||!fs.statSync(file,{throwIfNoEntry:false})?.isFile()){res.writeHead(404).end();return;}
        res.setHeader('Access-Control-Allow-Origin','*');
        fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    });
    await new Promise((ok,fail)=>files.once('error',fail).listen(0,'127.0.0.1',ok));
    const assetUrl='http://127.0.0.1:'+files.address().port;
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://localhost:5000/Resources/*','http://localhost:5000/Framework/*']},(details,done)=>{
        done({redirectURL:assetUrl+new URL(details.url).pathname});
    });
    let history=[], generation=0, queue=Promise.resolve(), conversation=randomUUID();
    const emit=(type,base,extra={})=>getWindow()?.webContents.send('kei:local-event',{...base,type,...extra});
    async function voice(text,base,epoch){
        if(!config.speech.enabled)return;
        const bytes=await service.run('speech',{text});
        if(epoch===generation)getWindow()?.webContents.send('kei:local-audio',{bytes,base,text});
    }
    async function turn(event,epoch){
        if(epoch!==generation)return;
        const {session_id,turn_id}=event, base={session_id,turn_id};
        emit(event.type,base,{text:event.text});emit('agent.begin',base);
        try{
            const note=/^(?:覚えて(?:おいて)?|記憶して|记住|记一下)[：:、，,\s]*(.+)$/s.exec(event.text) || /^(.+?)(?:と覚えておいて|を覚えておいて)[。！]?$/s.exec(event.text);
            if(note && !event.contextOnly)memory.add(note[1]);
            const context=memory.recall(event.text);
            const {text}=await service.run('chat',{session:conversation,text:event.text,history,
                ...(context&&{memory:context})});
            if(epoch!==generation)return;
            history=[...history,{role:'user',content:event.text},{role:'assistant',content:text}].slice(-32);
            emit('assistant.reply',base,{text});emit('agent.done',base);
            if(config.speech.enabled)await voice(text,base,epoch);
            else emit('tts.end',base,{payload:{status:'completed',reason:'streamed_turn_complete',segment_final:true}});
        }catch(error){if(epoch===generation){emit('assistant.reply',base,{text:error.message});emit('agent.done',base);emit('tts.end',base,{payload:{status:'error',segment_final:true}});}}
    }
    async function publish(event){
        if(event.type==='interrupt'){generation++;emit('interrupt',event);}
        else if(event.type==='tts.request'){void voice(event.text,event,generation).catch(()=>{});}
        else if(['user.message','user.transcript'].includes(event.type)){
            const epoch=generation;
            queue=queue.then(()=>turn(event,epoch)).catch(console.error);
        }
        return {status:'accepted'};
    }
    function handle(name,fn){ipcMain.handle('kei:local-'+name, (e,...args)=>{
        if(e.sender!==getWindow()?.webContents)throw Error('呼び出し元を確認できません');return fn(...args);
    });}
    handle('media',()=>({portrait:config.media.portrait?media().portrait:null,opening:media().opening,ending:media().ending}));
    handle('audio-event',(type,base)=>{if(['tts.start','tts.end'].includes(type))emit(type,base,{payload:{status:'completed',segment_final:true}});});
    handle('mic',async bytes=>{
        if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>16e6)throw Error('録音が空か、長すぎます');
        const audio=path.join(app.getPath('temp'),'kei-'+randomUUID()+'.webm');
        try{
            fs.writeFileSync(audio,bytes);
            const {stdout}=await promisify(execFile)(config.asr.python,[path.join(__dirname,'recognize.py'),config.asr.model,audio],{windowsHide:true,timeout:300000});
            const {text}=JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
            if(!text)throw Error('音声から言葉を認識できませんでした');
            await publish({type:'user.transcript',text,session_id:'desktop',turn_id:randomUUID()});return text;
        }finally{fs.rmSync(audio,{force:true});}
    });
    async function observe(image,signal){
        const v=config.vision.url?config.vision:config.chat;
        if(!v.url||!v.model)throw Error('画像入力に対応した vision.url と vision.model を設定してください');
        const response=await fetch(v.url,{method:'POST',signal,headers:{'Content-Type':'application/json',...(v.key&&{Authorization:'Bearer '+v.key})},
            body:JSON.stringify({model:v.model,messages:[{role:'user',content:[{type:'text',text:'画面上で確認できる内容だけを、日本語で簡潔に説明してください。'},{type:'image_url',image_url:{url:image}}]}]})});
        if(!response.ok)throw Error('画像認識サービスの応答：HTTP '+response.status);
        return {text:(await response.json()).choices?.[0]?.message?.content};
    }
    app.once('will-quit',()=>{files.close();memory.close();});
    return {publish,observe,settings,memory,reset(entries=[]){generation++;conversation=randomUUID();history=entries.slice(-32);}};
};
