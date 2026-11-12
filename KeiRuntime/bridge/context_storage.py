"""Storage controls for Kei-owned contexts only."""
from datetime import datetime, timezone
import os
import re
import stat
from pathlib import Path


def safe_file(path, root):
    root = root.absolute()
    if root.resolve() != root or not path.absolute().is_relative_to(root):
        return False
    for item in [path, *path.parents]:
        if item == root:
            break
        if item.is_symlink() or getattr(item.lstat(), "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            return False
    return path.is_file()


def task_files(manager, backend, native):
    if not native:
        return []
    if backend == "dsh" and re.fullmatch("kei-[0-9a-f]{32}", native):
        root = manager.root / "dsh-home/sessions"
        paths = root.glob("*/" + native + "/**/*")
    elif backend == "codex" and re.fullmatch("[0-9a-f-]{36}", native):
        root = Path(os.environ.get("CODEX_HOME") or Path.home()/".codex") / "sessions"
        paths = (p for p in root.glob("*/*/*/rollout-*-" + native + ".jsonl*") if p.name.endswith((".jsonl",".jsonl.zst")))
    else:
        return []
    return [p for p in paths if safe_file(p,root)]


def inventory(chat,manager):
    items = []
    for thread, in chat.db.execute("SELECT thread FROM thread_segments UNION SELECT thread FROM thread_seed"):
        segs = chat.db.execute("SELECT s.state,s.error,s.created_at FROM sessions s JOIN thread_segments l ON l.segment=s.id WHERE l.thread=? ORDER BY s.created_at DESC",(thread,)).fetchall()
        size,title,n = chat.db.execute("SELECT SUM(length(cast(content as blob))), (SELECT substr(content,1,45) FROM messages WHERE session_id IN (SELECT segment FROM thread_segments WHERE thread=?) AND role='user' ORDER BY id LIMIT 1), count(*) FROM messages WHERE session_id IN (SELECT segment FROM thread_segments WHERE thread=?)",(thread,thread)).fetchone()
        pending = any(state not in ("archived","empty") and err!="incomplete" for state,err,_ in segs)
        seed = chat.db.execute("SELECT length(cast(entries as blob)) FROM thread_seed WHERE thread=?",(thread,)).fetchone()
        meta = chat.db.execute("SELECT sum(length(cast(snapshot as blob))) FROM sessions WHERE id IN (SELECT segment FROM thread_segments WHERE thread=?)",(thread,)).fetchone()[0]
        summary = chat.db.execute("SELECT length(cast(summary as blob)) FROM thread_summary WHERE thread=?",(thread,)).fetchone()
        latest = chat.db.execute("SELECT MAX(timestamp) FROM messages WHERE session_id IN (SELECT segment FROM thread_segments WHERE thread=?)",(thread,)).fetchone()[0]
        if not latest and seed:
            import json
            entries = json.loads(chat.db.execute("SELECT entries FROM thread_seed WHERE thread=?",(thread,)).fetchone()[0])
            latest = max((entry.get("timestamp","") for entry in entries),default="")
        items.append(dict(kind="chat",id=thread,title=title or thread,date=latest or (segs[0][2] if segs else ""),size=(size or 0)+(meta or 0)+(seed[0] if seed else 0)+(summary[0] if summary else 0),status="使用中" if thread==chat.thread_id else "転送待ち" if pending else "保存済み",locked=thread==chat.thread_id or pending))
    known=set()
    for ident,backend,native,status,size,updated in manager.db.execute("SELECT id,backend,native,status,length(cast(result as blob)),updated FROM tasks ORDER BY updated DESC"):
        known.add(native)
        paths=task_files(manager,backend,native)
        items.append(dict(kind=backend,id=ident,date=datetime.fromtimestamp(updated,timezone.utc).isoformat() if updated else "",title=native or ident,size=sum(p.stat().st_size for p in paths)+(size or 0),status=status,locked=bool(manager.active)))
    for folder in (manager.root/"dsh-home/sessions").glob("*/kei-*"):
        if folder.name in known or not re.fullmatch("kei-[0-9a-f]{32}",folder.name):continue
        paths=task_files(manager,"dsh",folder.name)
        if paths:items.append(dict(kind="dsh-cache",id=folder.name,date=datetime.fromtimestamp(max(p.stat().st_mtime for p in paths),timezone.utc).isoformat(),title=folder.name,size=sum(p.stat().st_size for p in paths),status="保存ファイル",locked=bool(manager.active)))
    return items


async def manage(chat,manager,body):
    action=body.get("action","list")
    if action=="list":return {"items":inventory(chat,manager)}
    if manager.active or manager.lock.locked():raise ValueError("実行中のタスクが終了してから操作してください")
    kind,ident=body.get("kind"),body.get("id")
    if action=="release":
        await manager.release()
        return {"released":True}
    if action!="delete":raise ValueError("Unknown action")
    item=next((x for x in inventory(chat,manager) if x["kind"]==kind and x["id"]==ident),None)
    if not item or item["locked"]:raise ValueError("使用中または転送待ちの項目は削除できません")
    if kind=="chat":
        with chat.db:
            turns=[r[0] for r in chat.db.execute("SELECT DISTINCT turn_id FROM messages WHERE session_id IN (SELECT segment FROM thread_segments WHERE thread=?)",(ident,))]
            for table,key in (("messages","session_id"),("sessions","id")):
                chat.db.execute(f"DELETE FROM {table} WHERE {key} IN (SELECT segment FROM thread_segments WHERE thread=?)",(ident,))
            for table in ("thread_summary","thread_seed","thread_segments"):
                chat.db.execute(f"DELETE FROM {table} WHERE thread=?",(ident,))
        chat.db.execute("VACUUM")
        return {"turns":turns,"legacy":ident[7:] if ident.startswith("legacy-") else None}
    async with manager.lock:
        if kind=="dsh-cache":
            native=ident
            backend="dsh"
        else:
            native,backend=manager.db.execute("SELECT native,backend FROM tasks WHERE id=?",(ident,)).fetchone()
        worker=manager.workers.get(backend)
        if worker and native in worker.loaded:
            await worker.close()
            manager.workers.pop(backend,None)
        for p in task_files(manager,backend,native):
            p.unlink(missing_ok=True)
        if kind!="dsh-cache":
            with manager.db:manager.db.execute("DELETE FROM tasks WHERE id=?",(ident,))
            manager.db.execute("VACUUM")
        return {"deleted":True}
