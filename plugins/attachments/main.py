"""Bounded UTF-8 extraction for a conversation's trusted attachment reference."""
import base64
import codecs
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from kei_sdk import ChatAskError


def extract(data, cancelled, truncated):
    decoder = codecs.getincrementaldecoder("utf-8-sig")("strict")
    parts = []
    try:
        for offset in range(0, len(data), 4096):
            if cancelled.is_set():
                return {"status": "cancelled"}
            chunk = data[offset:offset + 4096]
            if b"\0" in chunk:
                return {"status": "failed", "error": "unsupported_attachment_format"}
            parts.append(decoder.decode(chunk))
        parts.append(decoder.decode(b"", final=not truncated))
    except UnicodeError:
        return {"status": "failed", "error": "unsupported_attachment_format"}
    result = "".join(parts).strip()
    if cancelled.is_set():
        return {"status": "cancelled"}
    return {"status": "completed", "text": result[:12000], "shortExcerpt": result[:1500],
            "truncated": truncated or len(result) > 12000}


def initialize(context):
    jobs = {}
    pool = ThreadPoolExecutor(max_workers=1)
    context.extractor = pool
    context.jobs = jobs

    def start(request):
        if len(jobs) >= 80:
            done = [key for key, value in jobs.items() if value["future"].done()]
            for key in done[:40]:
                del jobs[key]
        if len(jobs) >= 80:
            return {"error": {"code": "attachment_busy", "message": "処理が完了するまでお待ちください"}}
        try:
            source = context.read_attachment(request.get("attachmentId"))
        except ChatAskError as error:
            return {"error": {"code": error.code, "message": str(error)}}
        ident = uuid4().hex
        cancelled = threading.Event()
        child = pool.submit(extract, base64.b64decode(source["data"]), cancelled, source["truncated"])
        jobs[ident] = {"future": child, "cancel": cancelled, "name": source["name"], "conversation": context.conversation_id}
        return {"id": ident, "status": "queued"}

    def job(request):
        ident = request.get("id")
        result = jobs.get(ident) if isinstance(ident, str) else None
        return result if result and result["conversation"] == context.conversation_id else None

    def status(request):
        task = job(request)
        if task is None:
            return {"error": {"code": "attachment_job_unavailable", "message": "読取タスクが見つかりません"}}
        future = task["future"]
        if future.cancelled():
            result = {"status": "cancelled"}
        else:
            result = future.result() if future.done() else {"status": "running"}
        return {"id": request["id"], "name": task["name"], **result}

    def cancel(request):
        task = job(request)
        if task is None or task["future"].done():
            return {"accepted": False}
        task["cancel"].set()
        task["future"].cancel()
        return {"accepted": True}

    context.register("extract.start", start)
    context.register("extract.status", status)
    context.register("extract.cancel", cancel)


def terminate(context):
    for job in context.jobs.values():
        job["cancel"].set()
    context.extractor.shutdown(wait=True, cancel_futures=True)
