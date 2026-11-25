"""Opt-in observations of frames supplied by the trusted desktop capture bridge."""
import hashlib
import time

from kei_sdk import ChatAskError


def initialize(context):
    data = {"enabled": False, "sourceId": None, "kind": None, "lastCapture": None}
    generation = 0
    description = None
    fingerprint = None
    captured_at = 0.0
    conversation = None

    def status(_request=None):
        return {**data, "generation": generation, "intervalSeconds": context.config["interval_seconds"]}

    def configure(request):
        nonlocal generation, description, fingerprint, captured_at, conversation
        active, source, kind = request.get("enabled"), request.get("sourceId"), request.get("kind")
        if type(active) is not bool or (active and (not isinstance(source, str) or not 1 <= len(source) <= 100
                                                  or kind not in ("display", "window") or not isinstance(context.conversation_id, str))):
            return {"error": {"code": "invalid_capture_source", "message": "観察対象を指定してください"}}
        generation += 1
        conversation = context.conversation_id if active else None
        data.update(enabled=active, sourceId=source if active else None, kind=kind if active else None, lastCapture=None)
        captured_at, description, fingerprint = 0.0, None, None
        context.emit("observation.changed", {"enabled": active, "generation": generation})
        return status()

    def capture(request):
        nonlocal description, fingerprint, captured_at
        if (not data["enabled"] or context.conversation_id != conversation
            or request.get("generation") != generation or request.get("sourceId") != data["sourceId"]):
            return {"error": {"code": "capture_closed", "message": "観察対象が有効ではありません"}}
        image = request.get("image")
        raw = image.get("base64") if isinstance(image, dict) else None
        if not isinstance(raw, str) or len(raw) > 750000:
            return {"error": {"code": "invalid_capture", "message": "画面データが無効です"}}
        now = time.monotonic()
        current = hashlib.sha256(raw.encode()).hexdigest()
        if now - captured_at < context.config["interval_seconds"] or (
            current == fingerprint and now - captured_at < context.config["context_ttl_seconds"]
        ):
            return {"skipped": True, **status()}
        try:
            observed = context.describe_capture({**image, "sourceId": data["sourceId"], "kind": data["kind"]})
        except ChatAskError as error:
            description = None
            return {"error": {"code": error.code, "message": str(error)}}
        description, fingerprint, captured_at = observed["text"], current, time.monotonic()
        data["lastCapture"] = int(time.time() * 1000)
        context.emit("observation.updated", {"lastCapture": data["lastCapture"]})
        return status()

    def recent(request):
        if not data["enabled"] or context.conversation_id != conversation or request.get("generation") != generation or not description or (
            time.monotonic() - captured_at >= context.config["context_ttl_seconds"]
        ):
            return {"selection": None}
        return {"selection": {"text": description, "source": "画面観察", "page": None}}

    for name, handler in {"status": status, "configure": configure, "capture": capture,
                          "observation.context": recent}.items():
        context.register(name, handler)
