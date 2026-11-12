const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {writePack,readPack}=require('../standalone/character-pack');
const {createService,characterInstruction}=require('../standalone/service');

test('distributed character includes selected assets and excludes provider settings',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'kei-pack-test-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const sound=path.join(root,'voice.wav');
    fs.writeFileSync(sound,'test sound');
    const directory=writePack(root,{name:'雪',persona:'静かな口調',media:{startupSound:sound},key:'private'});
    const manifest=path.join(directory,'character.json');
    const restored=readPack(manifest);
    assert.equal(restored.name,'雪');assert.equal(restored.persona,'静かな口調');
    assert.equal(fs.readFileSync(restored.media.startupSound,'utf8'),'test sound');
    const data=JSON.parse(fs.readFileSync(manifest));
    assert.deepEqual(Object.keys(data).sort(),['format','media','name','persona']);
    data.media.startupSound='../voice.wav';
    fs.writeFileSync(manifest,JSON.stringify(data));
    assert.throws(()=>readPack(manifest));
});

test('a saved persona is read anew on compatible, AstrBot and DSH requests',async t=>{
    const requests=[];
    const mock=http.createServer(async(req,res)=>{
        let raw='';for await(const chunk of req)raw+=chunk;
        requests.push(JSON.parse(raw));
        if(req.url==='/astrbot')res.end('data: {"type":"plain","data":"はい"}\n\n');
        else res.end(JSON.stringify({choices:[{message:{content:'はい'}}]}));
    });
    await new Promise(ok=>mock.listen(0,'127.0.0.1',ok));
    t.after(()=>mock.close());
    const url='http://127.0.0.1:'+mock.address().port;
    const config={character:{name:'雪',persona:'短く話す'},chat:{url,model:'fixture'},astrbot:{url:url+'/astrbot'},dsh:{url,token:'fixture'}};
    const {run}=createService(config);
    await run('chat',{text:'こんにちは'});
    assert.equal(requests[0].messages[0].content,characterInstruction(config));
    config.character={name:'葵',persona:'丁寧に話す'};
    config.chat.provider='astrbot';
    await run('chat',{text:'こんにちは'});await run('task',{text:'確認'});
    for(const text of [requests[1].message,requests[2].request]){assert.match(text,/葵/);assert.match(text,/丁寧に話す/);assert.doesNotMatch(text,/短く話す/);}
});
