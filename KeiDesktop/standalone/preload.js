const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name,...args)=>ipcRenderer.invoke('kei-independent:'+name,...args);
contextBridge.exposeInMainWorld('kei',{
    state:()=>invoke('state'),run:(action,body)=>invoke('run',action,body),
    settings:()=>invoke('settings'),media:key=>invoke('media',key),
    onClose:fn=>ipcRenderer.once('kei-independent:closing',fn),closed:()=>invoke('closed')
});
