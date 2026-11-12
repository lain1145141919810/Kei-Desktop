const {DatabaseSync}=require('node:sqlite');
const terms=text=>new Set((text.toLowerCase().match(/[a-z0-9]{2,}|[\u3040-\u9fff]/g)||[]));
module.exports=function openMemory(file){
    const db=new DatabaseSync(file);
    db.exec('CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY, text TEXT UNIQUE NOT NULL)');
    const insert=db.prepare('INSERT OR IGNORE INTO memories(text) VALUES (?)');
    function add(text){
        if(typeof text!=='string'||!text.trim()||text.length>4000)throw Error('記憶は1～4000文字で入力してください');
        insert.run(text.trim());
    }
    function list(){return db.prepare('SELECT * FROM memories ORDER BY id DESC').all();}
    function recall(query){
        const keys=terms(query);
        return list().map(row=>({text:row.text,score:[...terms(row.text)].filter(x=>keys.has(x)).length}))
            .filter(row=>row.score>0).sort((a,b)=>b.score-a.score).slice(0,6).map(r=>r.text).join('\n').slice(0,3600);
    }
    function importFile(file){
        const source=new DatabaseSync(file,{readOnly:true});
        try{
            const rows=source.prepare("SELECT DISTINCT content FROM memories WHERE validity_status='active' AND content<>''").all();
            db.exec('BEGIN');
            try{for(const {content} of rows)add(content.slice(0,4000));db.exec('COMMIT');}
            catch(error){db.exec('ROLLBACK');throw error;}
        }finally{source.close();}
    }
    return {add,list,recall,importFile,remove:id=>db.prepare('DELETE FROM memories WHERE id=?').run(id),close:()=>db.close()};
};
