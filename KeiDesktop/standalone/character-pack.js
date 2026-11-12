const fs = require('node:fs');
const path = require('node:path');

const images = ['png','jpg','jpeg','webp','gif','mp4','webm'];
const types = {portrait:images, opening:images, ending:images, startupSound:['wav','mp3','ogg','m4a','flac']};
function validate(data) {
    if (!data || typeof data.name !== 'string' || !data.name.trim() || [...data.name.trim()].length > 40)
        throw Error('名前を1～40文字で入力してください。');
    if (typeof data.persona !== 'string' || data.persona.length > 16000)
        throw Error('人格設定は16000文字以内で入力してください。');
    return {name:data.name.trim(), persona:data.persona};
}
function allowed(key, file) {
    if (!types[key]?.includes(path.extname(file).slice(1).toLowerCase())) throw Error('未対応の素材形式です。');
}
function readPack(file) {
    const data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
    if(data.format !== 'kei-character-v1') throw Error('対応するキャラクターパックではありません。');
    const profile=validate(data), media={};
    const root=fs.realpathSync(path.dirname(file));
    for(const key of Object.keys(types)){
        const name=data.media?.[key];
        if(!name){media[key]='';continue;}
        if(typeof name!=='string' || /[\\/:]/.test(name) || name==='.' || name==='..') throw Error('素材名が正しくありません。');
        const src=fs.realpathSync(path.join(root,name));
        if(path.dirname(src)!==root || !fs.statSync(src).isFile())throw Error('パック内の素材を確認してください。');
        allowed(key,src);media[key]=src;
    }
    return {...profile,media};
}
function writePack(directory,profile) {
    const data={format:'kei-character-v1',...validate(profile),media:{}};
    const dest=fs.mkdtempSync(path.join(directory,'character-'));
    try{
        for(const key of Object.keys(types)){
            const src=profile.media[key];if(!src)continue;
            allowed(key,src);
            const name=key+path.extname(src).toLowerCase();
            fs.copyFileSync(src,path.join(dest,name));
            data.media[key]=name;
        }
        fs.writeFileSync(path.join(dest,'character.json'),JSON.stringify(data,null,2),'utf8');
        return dest;
    }catch(error){fs.rmSync(dest,{recursive:true,force:true});throw error;}
}
module.exports={validate,readPack,writePack,types,allowed};
