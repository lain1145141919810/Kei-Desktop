const {app,dialog,ipcMain}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const pack=require('./character-pack');

module.exports=function profileSettings(getWindow,config,save){
    let draft;
    function snapshot(){
        return {name:draft.name,persona:draft.persona,
            files:Object.fromEntries(Object.entries(draft.media).map(([k,v])=>[k,v?path.basename(v):'']))};
    }
    function bind(action,fn){
        ipcMain.handle('kei:profile-'+action,(event,...args)=>{
            if(event.senderFrame!==getWindow()?.webContents.mainFrame)throw Error('呼び出し元を確認できません。');
            return fn(...args);
        });
    }
    bind('begin',()=>{
        draft={...config.character,media:{...config.media,startupSound:config.character.startupSound||''}};
        return {...snapshot(),configured:config.character.configured};
    });
    bind('pick',async key=>{
        const prompt=key==='persona';
        if(!prompt&&!Object.hasOwn(pack.types,key))throw Error('未対応の素材です。');
        const choice=await dialog.showOpenDialog(getWindow(),{properties:['openFile'],filters:[{
            name:prompt?'人格設定':key==='startupSound'?'音声':'画像・動画',extensions:prompt?['txt','md']:pack.types[key]}]});
        if(choice.canceled)return null;
        const file=choice.filePaths[0];
        if(prompt){
            if(fs.statSync(file).size>65536)throw Error('人格設定は16000文字以内で指定してください。');
            const persona=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
            pack.validate({name:'確認',persona});return persona;
        }
        pack.allowed(key,file);draft.media[key]=file;return path.basename(file);
    });
    bind('clear',key=>{if(Object.hasOwn(pack.types,key))draft.media[key]='';});
    bind('import',async()=>{
        const choice=await dialog.showOpenDialog(getWindow(),{properties:['openFile'],filters:[{name:'キャラクターパック',extensions:['json']}]});
        if(choice.canceled)return null;
        draft=pack.readPack(choice.filePaths[0]);return snapshot();
    });
    bind('export',async fields=>{
        const profile={...pack.validate(fields),media:draft.media};
        const choice=await dialog.showOpenDialog(getWindow(),{properties:['openDirectory','createDirectory']});
        return choice.canceled?'':pack.writePack(choice.filePaths[0],profile);
    });
    bind('save',fields=>{
        const profile={...pack.validate(fields),media:{...draft.media}};
        const library=path.join(app.getPath('userData'),'characters');
        fs.mkdirSync(library,{recursive:true});
        const changed=Object.keys(pack.types).some(k=>profile.media[k] !== (k==='startupSound'?config.character.startupSound:config.media[k]));
        if(changed){
            const folder=pack.writePack(library,profile);
            profile.media=pack.readPack(path.join(folder,'character.json')).media;
        }
        const before={character:config.character,media:config.media};
        config.character={name:profile.name,persona:profile.persona,startupSound:profile.media.startupSound,configured:true};
        config.media={portrait:profile.media.portrait,opening:profile.media.opening,ending:profile.media.ending};
        try{save();}catch(error){Object.assign(config,before);throw error;}
        return {name:profile.name,persona:profile.persona};
    });
};
