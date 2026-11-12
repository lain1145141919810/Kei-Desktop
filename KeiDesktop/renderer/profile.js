(() => {
    const bridge=window.keiLocal;
    if(!bridge)return;
    const call=bridge.profile;
    let current='ケイ';
    window.KeiName=()=>current;
    const bindings=[];
    const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walk.nextNode()){
        const node=walk.currentNode,template=node.data;
        if(node.parentElement?.closest('script,style'))continue;
        if(template.includes('ケイ')||template.trim()==='KEI')
            bindings.push(name=>{node.data=template.trim()==='KEI'?(name==='ケイ'?'KEI':''):template.replaceAll('ケイ',()=>name);});
    }
    for(const element of document.querySelectorAll('[title],[aria-label],[placeholder]')){
        for(const attr of ['title','aria-label','placeholder']){
            const template=element.getAttribute(attr);
            if(template?.includes('ケイ'))bindings.push(name=>element.setAttribute(attr,template.replaceAll('ケイ',()=>name)));
        }
    }
    function apply(name){
        const previous=current;
        current=name;
        for(const update of bindings)update(name);
        for(const node of document.querySelectorAll('.log-name'))if(node.textContent===previous)node.textContent=name;
        const composer=document.querySelector('#chat-input, textarea[aria-label$="メッセージを送る"]');
        if(composer?.placeholder.includes(previous))composer.placeholder=composer.placeholder.replace(previous,()=>name);
        const badge=document.getElementById('compact-character-name');
        badge.textContent=name;badge.hidden=name==='ケイ';
        window.dispatchEvent(new Event('kei-profile-change'));
    }
    const panel=document.createElement('dialog');
    panel.id='character-profile';
    panel.innerHTML=`<form><h2>キャラクター設定</h2>
    <label>キャラクター名<input name="name" required maxlength="40" autocomplete="off"></label>
    <label>人格プロンプト<textarea name="persona" maxlength="16000" rows="4" placeholder="口調、性格、ユーザーとの関係など"></textarea></label>
    <button type="button" data-pick="persona">テキストから読み込む</button>
    <div class="profile-files"></div><div class="profile-pack"><button type="button" data-action="import">パックを読み込む</button>
    <button type="button" data-action="export">配布用に書き出す</button></div>
    <p role="status"></p><footer><button type="button" data-action="cancel">キャンセル</button>
    <button type="submit">保存して閉じる</button></footer></form>`;
    document.body.append(panel);
    const files={portrait:'立ち絵',opening:'起動画面',ending:'終了画面',startupSound:'起動音'};
    for(const [key,label] of Object.entries(files)){
        const row=document.createElement('div');
        row.innerHTML=`<button type="button" data-pick="${key}">${label}を選択</button><span data-file="${key}"></span><button type="button" data-clear="${key}">標準に戻す</button>`;
        panel.querySelector('.profile-files').append(row);
    }
    const form=panel.querySelector('form'),status=panel.querySelector('[role=status]'),cancel=panel.querySelector('[data-action=cancel]');
    const fields=()=>({name:form.elements.name.value,persona:form.elements.persona.value});
    const showFile=(key,name)=>{panel.querySelector('[data-file="'+key+'"]').textContent=name||'標準';};
    function fill(state){form.elements.name.value=state.name;form.elements.persona.value=state.persona;for(const key of Object.keys(files))showFile(key,state.files[key]);}
    let first=false, resolveSetup;
    panel.addEventListener('cancel',e=>{if(first)e.preventDefault();});
    async function open(state){
        state=state||await call('begin');
        first=!state.configured;cancel.hidden=first;
        fill(state);status.textContent='';panel.showModal();
        form.elements.name.focus();
    }
    panel.addEventListener('click',async event=>{
        const button=event.target.closest('button');if(!button)return;
        try{
            const {pick,clear,action}=button.dataset;
            if(pick){const value=await call('pick',pick);if(value!==null){if(pick==='persona')form.elements.persona.value=value;else showFile(pick,value);}}
            if(clear){await call('clear',clear);showFile(clear,'');}
            if(action==='import'){const state=await call('import');if(state)fill(state);}
            if(action==='export'){const folder=await call('export',fields());if(folder)status.textContent='書き出し先：'+folder;}
            if(action==='cancel')panel.close();
        }catch(error){status.textContent=error.message;}
    });
    form.onsubmit=async e=>{
        e.preventDefault();
        try{const saved=await call('save',fields());apply(saved.name);panel.close();resolveSetup?.();}
        catch(error){status.textContent=error.message;}
    };
    const edit=document.createElement('button');
    edit.type='button';edit.className='pill wide';edit.textContent='キャラクター設定';
    document.getElementById('admin-button').before(edit);
    edit.onclick=()=>open();
    window.KeiProfileReady=(async()=>{
        const state=await call('begin');apply(state.name);
        if(!state.configured){const wait=new Promise(ok=>{resolveSetup=ok;});await open(state);await wait;}
    })();
})();
