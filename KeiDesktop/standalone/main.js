const { app, BrowserWindow, ipcMain, nativeTheme, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const {createService} = require('./service');

let window, service, config, file;
const assets = path.join(__dirname,'../assets');
const defaults = {
    character:{name:'ケイ',persona:'',startupSound:'',configured:false},
    chat:{provider:'compatible',url:'http://127.0.0.1:11434/v1/chat/completions',model:'',key:''},
    astrbot:{url:'http://127.0.0.1:6185/api/v1/chat',key:''},
    dsh:{url:'',token:'',entry:'',workspace:''},
    speech:{enabled:false,provider:'gpt-sovits',externalUrl:'',externalKey:'',textField:'input',model:'',voice:'',extra:{},url:'http://127.0.0.1:9880/tts',language:'ja',referenceLanguage:'ja',referenceText:'',referencePath:''},
    asr:{python:'python',model:'small'},vision:{url:'',model:'',key:''},
    media:{portrait:'',opening:'',ending:''},api:{port:17883,token:randomBytes(32).toString('hex')}
};
function save() {
    fs.writeFileSync(file+'.tmp',JSON.stringify(config,null,2),{mode:0o600});
    fs.renameSync(file+'.tmp',file);
}
function media() {
    const fallback = {portrait:'character/CH0335_home_Idle_01.webm',opening:'lifecycle/startup.mp4',ending:'lifecycle/shutdown.mp4'};
    return Object.fromEntries(Object.entries(fallback).map(([key,name])=>{
        const chosen=config.media[key];
        const src=chosen && fs.existsSync(chosen) ? chosen : path.join(assets,name);
        return [key,{src:pathToFileURL(src).href,video:/\.(webm|mp4)$/i.test(src)}];
    }));
}
module.exports=async function setup(getWindow){
    file=path.join(app.getPath('userData'),'standalone.json');
    const saved=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
    config=Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,{...v,...saved[k]}]));
    config.speech.language='ja';
    save();
    require('./profile-settings')(getWindow,config,save);
    service=createService(config);
    await new Promise((resolve,reject)=>service.server.once('error',reject).listen(config.api.port,'127.0.0.1',resolve));
    nativeTheme.themeSource='dark';
    function settings(){
    if(window&&!window.isDestroyed()){window.show();window.focus();return;}
    window=new BrowserWindow({width:1080,height:740,minWidth:640,minHeight:480,title:'Kei Desktop',
        icon:path.join(assets,'branding/kei-logo.png'),webPreferences:{preload:path.join(__dirname,'preload.js'),sandbox:true}});
    window.removeMenu();
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',e=>e.preventDefault());
    window.loadFile(path.join(__dirname,'index.html'));
    }
    const handle=(name,fn)=>ipcMain.handle('kei-independent:'+name,(e,...args)=>{
        if(e.senderFrame!==window?.webContents.mainFrame) throw new Error('呼び出し元を確認できません');
        return fn(...args);
    });
    handle('state',()=>({media:media(),voice:config.speech.enabled,provider:config.chat.provider,characterName:config.character.name}));
    handle('run',(action,body)=>service.run(action,body));
    handle('voice-config',()=>({...config.speech,externalKey:undefined,hasKey:Boolean(config.speech.externalKey)}));
    handle('save-voice',value=>{
        if(!['gpt-sovits','external'].includes(value.provider))throw Error('読み上げ方式を選択してください。');
        const next={...config.speech};
        for(const field of ['url','referenceLanguage','referenceText','referencePath','externalUrl','textField','model','voice'])
            next[field]=String(value[field]??'').trim();
        next.provider=value.provider;next.enabled=Boolean(value.enabled);
        if(value.clearKey)next.externalKey='';
        else if(value.externalKey)next.externalKey=String(value.externalKey);
        next.extra=JSON.parse(value.extra||'{}');
        if(!next.extra||Array.isArray(next.extra)||typeof next.extra!=='object')throw Error('追加パラメーターは JSON オブジェクトで指定してください。');
        if(next.enabled){
            const address=new URL(next.provider==='external'?next.externalUrl:next.url);
            if(!['http:','https:'].includes(address.protocol))throw Error('HTTP または HTTPS の URL を入力してください。');
        }
        if(next.provider==='external'&&!next.textField)throw Error('本文フィールド名を入力してください。');
        const old=config.speech;config.speech=next;
        try{save();}catch(error){config.speech=old;throw error;}
        return next.enabled;
    });
    handle('copy-install',()=>{
        const prompt=fs.readFileSync(path.join(__dirname,'AI-INSTALL.ja.txt'),'utf8');
        require('electron').clipboard.writeText(prompt);
    });
    handle('settings',()=>shell.openPath(file));
    handle('media',async key=>{
        if(!Object.hasOwn(defaults.media,key)) throw new Error('未対応のメディアです');
        const choice=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'画像・動画',extensions:['png','jpg','jpeg','webp','gif','mp4','webm']}]});
        if(!choice.canceled){config.media[key]=choice.filePaths[0];save();}
        return media();
    });
    const runtime=await require('./desktop-runtime')({getWindow,service,config,media,settings});
    handle('memories',()=>runtime.memory.list());
    handle('forget',id=>{runtime.memory.remove(Number(id));return runtime.memory.list();});
    handle('remember',text=>{runtime.memory.add(text);return runtime.memory.list();});
    handle('import',async()=>{
        const choice=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'MemoryCompanion データベース',extensions:['db']}]});
        if(!choice.canceled)runtime.memory.importFile(choice.filePaths[0]);
        return runtime.memory.list();
    });
    app.once('will-quit',()=>service.server.close());
    return runtime;
};
