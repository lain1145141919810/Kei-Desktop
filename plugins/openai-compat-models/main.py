"""OpenAI-compatible HTTP model provider for TTS, ASR, vision, and embeddings (model-providers-v1)."""
import base64
import http.client
import json
import uuid
from urllib.parse import urlsplit

MAX_HTTP_BYTES = 1024 * 1024
MAX_BASE64 = 750000
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MIME_EXTENSIONS = {
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
}


def _parse_base_url(raw):
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Configure base_url before invoking kei.openai-compat-models")
    parsed = urlsplit(raw.strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or (parsed.scheme == "http" and parsed.hostname not in LOOPBACK_HOSTS)
    ):
        raise ValueError("base_url must use HTTPS or a loopback HTTP host without credentials or query")
    return parsed


def _join_path(base_path, suffix):
    prefix = base_path.rstrip("/")
    return f"{prefix}/{suffix.lstrip('/')}"


def _http_post(parsed, route, body_bytes, content_type, credential, timeout):
    if not isinstance(credential, str) or not credential:
        raise RuntimeError("Missing model credential")
    headers = {
        "Authorization": "Bearer " + credential,
        "Content-Type": content_type,
        "Accept": "application/json, audio/wav, audio/mpeg, */*",
    }
    connector = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    client = connector(parsed.hostname, parsed.port, timeout=timeout)
    try:
        client.request("POST", _join_path(parsed.path, route), body_bytes, headers)
        response = client.getresponse()
        raw = response.read(MAX_HTTP_BYTES + 1)
        if not 200 <= response.status < 300:
            raise RuntimeError(f"Upstream HTTP {response.status}")
        if len(raw) > MAX_HTTP_BYTES:
            raise ValueError("Upstream response exceeded size ceiling")
        return raw, (response.getheader("Content-Type") or "").split(";")[0].strip().lower()
    finally:
        client.close()


def _multipart_audio(model, audio_bytes, mime, language):
    boundary = "kei-boundary-" + uuid.uuid4().hex
    ext = MIME_EXTENSIONS.get(mime, "wav")
    parts = []

    def add_field(name, value):
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )

    add_field("model", model)
    if language:
        add_field("language", language)
    parts.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="audio.{ext}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode("utf-8")
        + audio_bytes
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _effective_model(selected, override):
    if selected.startswith("custom-") and isinstance(override, str) and override.strip():
        return override.strip()
    return selected


def _resolve_audio_mime(raw, header_mime):
    if len(raw) >= 44 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        return "audio/wav"
    if raw.startswith(b"OggS"):
        return "audio/ogg"
    if raw.startswith(b"fLaC"):
        return "audio/flac"
    if raw.startswith(b"ID3") or (len(raw) > 1 and raw[0] == 0xFF and raw[1] & 0xE0 == 0xE0):
        return "audio/mpeg"
    return header_mime or "audio/wav"


def initialize(context):
    cfg = context.config or {}
    base_url = str(cfg.get("base_url", "") or "").strip()
    timeout = int(cfg.get("timeout_seconds", 16))
    default_voice = str(cfg.get("default_voice", "alloy") or "alloy").strip() or "alloy"
    overrides = {
        "tts": str(cfg.get("tts_model_override", "") or "").strip(),
        "asr": str(cfg.get("asr_model_override", "") or "").strip(),
        "vision": str(cfg.get("vision_model_override", "") or "").strip(),
        "embedding": str(cfg.get("embedding_model_override", "") or "").strip(),
    }

    def handle_tts(message):
        parsed = _parse_base_url(base_url)
        inp = message["input"]
        model = _effective_model(message["model"], overrides["tts"])
        payload = json.dumps({
            "model": model,
            "input": inp["text"],
            "voice": inp.get("voice") or default_voice,
            "response_format": "wav",
        }, ensure_ascii=False).encode("utf-8")
        raw, content_type = _http_post(parsed, "/audio/speech", payload, "application/json", context.model_credential, timeout)
        encoded = base64.b64encode(raw).decode("ascii")
        if len(encoded) > MAX_BASE64:
            raise ValueError("Audio output exceeds base64 limit")
        return {"audio": {"mime": _resolve_audio_mime(raw, content_type), "base64": encoded}}

    def handle_asr(message):
        parsed = _parse_base_url(base_url)
        inp = message["input"]
        audio = inp["audio"]
        raw_audio = base64.b64decode(audio["base64"], validate=True)
        model = _effective_model(message["model"], overrides["asr"])
        locale = inp.get("locale")
        language = locale.split("-")[0].lower() if isinstance(locale, str) and locale.strip() else None
        body, content_type = _multipart_audio(model, raw_audio, audio["mime"], language)
        raw, _ = _http_post(parsed, "/audio/transcriptions", body, content_type, context.model_credential, timeout)
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("ASR response must be a JSON object")
        result = {"text": data.get("text")}
        if isinstance(data.get("segments"), list):
            segments = []
            for seg in data["segments"]:
                if not isinstance(seg, dict):
                    segments.append(seg)
                    continue
                seg_text = seg.get("text")
                start_ms = seg.get("startMs")
                end_ms = seg.get("endMs")
                if start_ms is None and isinstance(seg.get("start"), (int, float)):
                    start_ms = int(round(seg["start"] * 1000))
                if end_ms is None and isinstance(seg.get("end"), (int, float)):
                    end_ms = int(round(seg["end"] * 1000))
                segments.append({
                    "text": seg_text.strip() if isinstance(seg_text, str) else seg_text,
                    "startMs": start_ms,
                    "endMs": end_ms,
                })
            if segments:
                result["segments"] = segments
        return result

    def handle_vision(message):
        parsed = _parse_base_url(base_url)
        inp = message["input"]
        image = inp["image"]
        model = _effective_model(message["model"], overrides["vision"])
        data_uri = f"data:{image['mime']};base64,{image['base64']}"
        payload = json.dumps({
            "model": model,
            "stream": False,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": inp["prompt"]},
                        {"type": "image_url", "image_url": {"url": data_uri}},
                    ],
                }
            ],
        }, ensure_ascii=False).encode("utf-8")
        raw, _ = _http_post(parsed, "/chat/completions", payload, "application/json", context.model_credential, timeout)
        data = json.loads(raw)
        content = data["choices"][0]["message"]["content"]
        return {"text": content}

    def handle_embedding(message):
        parsed = _parse_base_url(base_url)
        inp = message["input"]
        model = _effective_model(message["model"], overrides["embedding"])
        payload = json.dumps({
            "model": model,
            "input": inp["texts"],
            "encoding_format": "float",
        }, ensure_ascii=False).encode("utf-8")
        raw, _ = _http_post(parsed, "/embeddings", payload, "application/json", context.model_credential, timeout)
        data = json.loads(raw)
        rows = sorted(data["data"], key=lambda item: item["index"])
        vectors = [row["embedding"] for row in rows]
        dimensions = len(vectors[0]) if vectors else 0
        return {"dimensions": dimensions, "vectors": vectors}

    context.register("openai.tts", handle_tts)
    context.register("openai.asr", handle_asr)
    context.register("openai.vision", handle_vision)
    context.register("openai.embedding", handle_embedding)
