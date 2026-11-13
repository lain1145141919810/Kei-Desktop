const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createService}=require('../standalone/service');

test('one speech endpoint preserves old SoVITS settings and switches to external audio',async t=>{
    const seen=[];
    const upstream=http.createServer(async(req,res)=>{
        let raw='';for await(const chunk of req)raw+=chunk;
        seen.push({url:req.url,body:JSON.parse(raw),authorization:req.headers.authorization});
        res.writeHead(200,{'content-type':req.url==='/tts'?'audio/wav':'audio/mpeg'});
        res.end(req.url==='/tts'?'RIFF':'ID3');
    });
    await new Promise(ok=>upstream.listen(0,'127.0.0.1',ok));
    t.after(()=>upstream.close());
    const base='http://127.0.0.1:'+upstream.address().port;
    const config={speech:{enabled:true,url:base+'/tts',language:'ja',referenceLanguage:'ja',referenceText:'はい',referencePath:'reference.wav'},api:{token:'fixture'}};
    const {server}=createService(config);
    await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>server.close());
    const request=()=>fetch('http://127.0.0.1:'+server.address().port+'/v1/speech',{method:'POST',headers:{Authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({text:'こんにちは'})});
    const first=await request();assert.equal(first.headers.get('content-type'),'audio/wav');assert.equal(await first.text(),'RIFF');
    assert.equal(seen[0].body.ref_audio_path,'reference.wav');
    Object.assign(config.speech,{provider:'external',externalUrl:base+'/custom',externalKey:'sample',textField:'sentence',model:'voice-model',voice:'jp',extra:{speed:1.2}});
    const next=await request();assert.equal(next.headers.get('content-type'),'audio/mpeg');assert.equal(await next.text(),'ID3');
    assert.deepEqual(seen[1].body,{speed:1.2,sentence:'こんにちは',model:'voice-model',voice:'jp'});assert.equal(seen[1].authorization,'Bearer sample');
    config.speech.provider='gpt-sovits';await request();assert.equal(seen[2].authorization,undefined);
});
