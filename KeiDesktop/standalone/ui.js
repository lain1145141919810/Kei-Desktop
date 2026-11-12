const el=id=>document.getElementById(id);
let state, history=[], session=crypto.randomUUID(), activeAudio, closing=false;
function visual(target,asset,loop=false){
    const node=document.createElement(asset.video?'video':'img');
    node.src=asset.src;
    if(asset.video){node.muted=true;node.autoplay=true;node.loop=loop;}
    target.replaceChildren(node);
    return node;
}
async function scene(asset,limit){
    const layer=el('overlay');
    layer.hidden=false;
    const node=visual(layer,asset);
    await new Promise(resolve=>{
        const timer=setTimeout(resolve,asset.video?limit:1500);
        const finish=()=>{clearTimeout(timer);resolve();};
        node.onended=finish;node.onerror=finish;layer.onclick=finish;
    });
    if(layer.firstChild===node){layer.hidden=true;layer.replaceChildren();}
}
function log(text,role){const p=document.createElement('p');p.className=role;p.textContent=text;el('log').append(p);p.scrollIntoView();}
async function speak(text){
    const bytes=await window.kei.run('speech',{text});
    if(closing)return;
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    if(activeAudio)activeAudio.pause();
    activeAudio=new Audio(url);
    const release=()=>URL.revokeObjectURL(url);
    activeAudio.onended=release;activeAudio.onpause=release;
    try{await activeAudio.play();}catch(error){release();throw error;}
}
window.kei.onClose(async()=>{closing=true;activeAudio?.pause();try{if(state)await scene(state.media.ending,4500);}finally{window.kei.closed();}});
window.kei.state().then(value=>{state=value;visual(el('portrait'),state.media.portrait,true);if(!closing)scene(state.media.opening,8000);});
el('settings').onclick=async()=>{const error=await window.kei.settings();log(error?'設定ファイルを開けませんでした。':'設定を保存してから Kei Desktop を再起動してください。','info');};
for(const button of document.querySelectorAll('[data-media]'))button.onclick=async()=>{state.media=await window.kei.media(button.dataset.media);visual(el('portrait'),state.media.portrait,true);};
document.querySelector('form').onsubmit=async event=>{
    event.preventDefault();
    const field=document.querySelector('textarea'),text=field.value.trim(), action=el('mode').value;
    if(!text||el('send').disabled)return;
    field.value='';el('send').disabled=true;log(text,'user');
    try{
        const reply=await window.kei.run(action,{text,session,history});
        const answer=reply.text??reply.result??JSON.stringify(reply,null,2);
        log(typeof answer==='string'?answer:JSON.stringify(answer),'assistant');
        if(action==='chat'){history=[...history,{role:'user',content:text},{role:'assistant',content:answer}].slice(-32);if(state.voice)await speak(answer);}
    }catch(error){log(error.message,'error');}finally{el('send').disabled=false;field.focus();}
};

function showNotes(rows){
    const container=el('notes');container.replaceChildren();
    for(const row of rows){const p=document.createElement('p'), button=document.createElement('button');
        p.textContent=row.text+' ';button.textContent='削除';button.onclick=async()=>showNotes(await window.kei.forget(row.id));p.append(button);container.append(p);}
}
el('memory').onclick=async()=>{showNotes(await window.kei.memories());el('memory-panel').showModal();};
el('close-memory').onclick=()=>el('memory-panel').close();
el('save-note').onclick=async()=>{try{showNotes(await window.kei.remember(el('note').value));el('note').value='';}catch(e){alert(e.message);}};
el('import-memory').onclick=async()=>{if(confirm('選んだ個人用データベースから有効な記憶をすべて取り込み、今後の会話で使いますか？')){try{showNotes(await window.kei.importMemory());}catch(e){alert(e.message);}}};
