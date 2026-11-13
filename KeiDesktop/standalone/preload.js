const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name,...args)=>ipcRenderer.invoke('kei-independent:'+name,...args);
contextBridge.exposeInMainWorld('kei',{
    memories:()=>invoke('memories'), remember:text=>invoke('remember',text), forget:id=>invoke('forget',id), importMemory:()=>invoke('import'),
    voiceConfig:()=>invoke('voice-config'),saveVoice:data=>invoke('save-voice',data),copyInstall:()=>invoke('copy-install'),
    state:()=>invoke('state'),run:(action,body)=>invoke('run',action,body),
    settings:()=>invoke('settings'),media:key=>invoke('media',key),
    onClose:fn=>ipcRenderer.once('kei-independent:closing',fn),closed:()=>invoke('closed')
});
