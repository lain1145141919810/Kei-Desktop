if(window.keiLocal){
    const bridge=window.keiLocal;
    const notify=text=>window.KeiShell?.showToast?.(text);
    let recorder=null, recordingBusy=false, audio;
    async function microphone(){
        if(recordingBusy)return;
        if(recorder?.state==='recording'){recorder.stop();return;}
        recordingBusy=true;
        let stream;
        try{
            stream=await navigator.mediaDevices.getUserMedia({audio:true});
            recorder=new MediaRecorder(stream);
            const chunks=[];
            recorder.ondataavailable=e=>chunks.push(e.data);
            recorder.onstop=async()=>{
                recordingBusy=true;
                clearTimeout(timeout);
                stream.getTracks().forEach(track=>track.stop());
                try{
                    notify('正在识别语音');
                    await bridge.mic(new Uint8Array(await new Blob(chunks).arrayBuffer()));
                }catch(error){notify(error.message);}
                finally{recordingBusy=false;recorder=null;}
            };
            recorder.start();const timeout=setTimeout(()=>{if(recorder?.state==='recording')recorder.stop();},60000);
            notify('正在录音，再按 F8 或录音按钮结束');
        }catch(error){stream?.getTracks().forEach(track=>track.stop());notify(error.message);}
        finally{recordingBusy=false;}
    }
    bridge.onMic(microphone);
    const mic=document.createElement('button');
    mic.type='button';mic.textContent='麦克风';mic.title='开始或停止录音（F8）';
    const admin=document.querySelector('#reading-button');
    if(admin){mic.className=admin.className;admin.insertAdjacentElement('afterend',mic);mic.onclick=microphone;}
    bridge.audio(async data=>{
        if(audio)audio.pause();
        const url=URL.createObjectURL(new Blob([data.bytes],{type:'audio/wav'}));
        audio=new Audio(url);
        let done=false;
        const finish=()=>{if(done)return;done=true;URL.revokeObjectURL(url);bridge.audioEvent('tts.end',data.base);};
        audio.onplaying=()=>bridge.audioEvent('tts.start',{...data.base,text:data.text});
        audio.onended=finish;audio.onpause=finish;audio.onerror=finish;
        await audio.play().catch(finish);
    });
    bridge.events(event=>{if(event.type==='interrupt')audio?.pause();});
    bridge.media().then(({portrait})=>{
        if(!portrait)return;
        const stage=document.getElementById('character-layer');
        const item=document.createElement(portrait.video?'video':'img');
        item.src=portrait.src;
        if(portrait.video){item.loop=true;item.muted=true;item.autoplay=true;}
        for(const child of stage.children)child.style.setProperty('visibility','hidden','important');
        item.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:contain';
        stage.append(item);
    });
}
