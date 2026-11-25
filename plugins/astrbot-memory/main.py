"""Opt-in transcript handoff to the existing AstrBot MemoryCompanion bridge."""

import datetime
import hashlib
import json
import re
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def failure(code):
    return {"error": {"code": code}}


def transcript(value):
    session = value.get("sessionId")
    try:
        session = str(UUID(session)) if isinstance(session, str) else None
    except ValueError:
        return None
    rows = value.get("messages")
    if not session or not isinstance(rows, list) or not 2 <= len(rows) <= 128:
        return None
    normalized = []
    for row in rows:
        if not isinstance(row, dict):
            return None
        role, content, timestamp = (row.get(key) for key in ("role", "content", "timestamp"))
        if (role not in ("user", "assistant") or not isinstance(content, str) or not content.strip()
                or len(content) > 4000 or not isinstance(timestamp, str) or len(timestamp) > 48
                or role == "assistant" and row.get("status") != "completed"):
            return None
        try:
            occurred = datetime.datetime.fromisoformat(timestamp)
            if occurred.utcoffset() is None:
                return None
        except ValueError:
            return None
        normalized.append({"role": role, "content": content, "timestamp": occurred.isoformat(), "status": "completed"})
    if {row["role"] for row in normalized} != {"assistant", "user"}:
        return None
    return {"session_id": session, "messages": normalized}


class Bridge:
    def __init__(self, context):
        self.origin = context.config["bridge_origin"]
        self.token_file = context.config["token_file"]
        self.storage = context.data_dir / "handoffs.json"
        self.client = build_opener(NoRedirect(), ProxyHandler({}))

    def settings(self):
        value = urlsplit(self.origin)
        if (value.scheme != "http" or value.hostname != "127.0.0.1" or not value.port or value.username is not None
                or value.path or value.query or value.fragment):
            return None
        token_file = Path(self.token_file)
        if not token_file.is_absolute():
            return None
        with token_file.open(encoding="ascii") as reader:
            token = reader.read(257).strip()
        return token if re.fullmatch(r"[A-Za-z0-9_-]{16,256}", token) else None

    def ledger(self):
        if not self.storage.exists():
            return {}
        data = json.loads(self.storage.read_text("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("invalid ledger")
        return data

    def persist(self, data):
        self.storage.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.storage.parent, delete=False) as writer:
            temporary = Path(writer.name)
            json.dump(data, writer, indent=2)
        try:
            temporary.replace(self.storage)
        finally:
            temporary.unlink(missing_ok=True)

    def status(self, _request):
        try:
            configured = bool(self.settings())
        except (ValueError, OSError):
            configured = False
        return {"configured": configured, "direction": "kei-to-astrbot"}

    def request(self, resource, method, data, credential):
        headers = {"X-Kei-Bridge": credential, "Content-Type": "application/json"}
        with self.client.open(Request(self.origin + resource, data=data, headers=headers, method=method), timeout=2.4) as response:
            body = json.loads(response.read(128 * 1024 + 1))
        if not isinstance(body, dict):
            raise ValueError("invalid bridge response")
        return body

    def handoff(self, request):
        if request.get("confirm") is not True:
            return failure("confirmation_required")
        value = transcript(request)
        if value is None:
            return failure("invalid_transcript")
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
        if len(encoded) > 128 * 1024:
            return failure("transcript_too_large")
        try:
            credential = self.settings()
        except (ValueError, OSError):
            credential = None
        if not credential:
            return failure("bridge_unconfigured")
        key = hashlib.sha256(encoded).hexdigest()
        ledger = self.ledger()
        if key in ledger:
            return {**ledger[key], "duplicate": True}
        if len(ledger) >= 2000:
            return failure("handoff_ledger_full")
        ledger[key] = {"state": "outcome_unknown"}
        self.persist(ledger)
        try:
            reply = self.request("/handoff", "POST", encoded, credential)
        except HTTPError as error:
            if error.code in (400, 401, 403, 404, 413, 422):
                del ledger[key]
                self.persist(ledger)
                return failure("handoff_rejected")
            return ledger[key]
        except (ValueError, URLError, OSError):
            return ledger[key]
        if reply.get("accepted") is True and self.batch_id(reply.get("batch_id")):
            ledger[key] = {"state": "accepted", "batchId": reply["batch_id"]}
            self.persist(ledger)
        return ledger[key]

    @staticmethod
    def batch_id(value):
        return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value)

    def batch(self, request, resume=False):
        ident = request.get("batchId")
        if not self.batch_id(ident) or not any(item.get("batchId") == ident for item in self.ledger().values()):
            return failure("unknown_batch")
        try:
            credential = self.settings()
            if not credential:
                return failure("bridge_unconfigured")
            suffix = "/resume" if resume else ""
            value = self.request("/handoff/" + ident + suffix, "POST" if resume else "GET", b"{}" if resume else None, credential)
            return {"batchId": ident, "state": str(value.get("state") or "unknown")[:40]}
        except (ValueError, OSError, URLError):
            return failure("bridge_unavailable")


def initialize(context):
    adapter = Bridge(context)
    context.register("status", adapter.status)
    context.register("handoff", adapter.handoff)
    context.register("handoff.status", adapter.batch)
    context.register("handoff.resume", lambda request: adapter.batch(request, resume=True))
