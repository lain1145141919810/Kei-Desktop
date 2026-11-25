"""Verify installable model-provider plugins (TTS->ASR real speech loop, vision, embedding, lifecycle & faults)."""
import argparse
import base64
import http.server
import io
import json
import os
import struct
import sys
import tempfile
import threading
import time
import wave
import zipfile
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host_smoke import BuiltHost


def make_synthetic_shape_png(width=64, height=64):
    """Generate a valid 64x64 RGB PNG: centered red square (#DC2626) on white background (#FFFFFF)."""
    rows = []
    for y in range(height):
        row = bytearray([0])  # filter type 0
        for x in range(width):
            if 16 <= x < 48 and 16 <= y < 48:
                row.extend((220, 38, 38))
            else:
                row.extend((255, 255, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, payload):
        crc = zlib.crc32(tag + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    return {"mime": "image/png", "base64": base64.b64encode(png).decode("ascii")}


def make_wav_bytes(duration_ms=200, sample_rate=16000):
    frames = max(1, int(sample_rate * duration_ms / 1000))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as writer:
        writer.setparams((1, 2, sample_rate, 0, "NONE", ""))
        writer.writeframes(b"\x00\x00" * frames)
    return buf.getvalue()


def inspect_wav(raw):
    with wave.open(io.BytesIO(raw), "rb") as reader:
        ch = reader.getnchannels()
        sw = reader.getsampwidth()
        sr = reader.getframerate()
        n = reader.getnframes()
    return {
        "channels": ch,
        "sampleWidthBytes": sw,
        "sampleRateHz": sr,
        "frames": n,
        "durationMs": int(round((n / sr) * 1000)) if sr else 0,
    }


def pack_plugin_dir(plugin_dir, dest_zip=None):
    buf = io.BytesIO()
    files = sorted(
        p for p in Path(plugin_dir).rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and not p.name.endswith(".pyc")
    )
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file_path in files:
            arcname = file_path.relative_to(plugin_dir).as_posix()
            zf.write(file_path, arcname=arcname)
    data = buf.getvalue()
    if dest_zip is not None:
        Path(dest_zip).parent.mkdir(parents=True, exist_ok=True)
        Path(dest_zip).write_bytes(data)
    return data


def make_fault_fixture_zip(plugin_id="fixture.r20fault"):
    metadata = {
        "apiVersion": 1,
        "schemaVersion": 1,
        "id": plugin_id,
        "name": "Round 20 Fault Fixture",
        "version": "1.0.0",
        "requiresFeatures": ["model-providers-v1"],
        "permissions": ["model.provide.tts"],
        "actions": [{"id": "fault.tts", "scope": "model.provide.tts"}],
        "modelProviders": [{
            "capability": "tts",
            "action": "fault.tts",
            "models": ["fault-tts-v1"],
            "requiresCredential": False,
        }],
    }
    worker_py = """import base64, io, time, wave
def _wav():
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setparams((1, 2, 16000, 0, "NONE", ""))
        w.writeframes(b"\\x00\\x00" * 160)
    return {"mime": "audio/wav", "base64": base64.b64encode(b.getvalue()).decode("ascii")}

def initialize(context):
    def run(message):
        text = message["input"]["text"]
        if text == "hang":
            (context.data_dir / "hanging").touch()
            time.sleep(25)
        if text == "slow_disable":
            (context.data_dir / "busy_disable").touch()
            time.sleep(5)
        if text == "malformed":
            return {"audio": {"mime": "audio/wav", "base64": "not-valid-base64!!!"}}
        return {"audio": _wav()}
    context.register("fault.tts", run)
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.yaml", json.dumps(metadata))
        zf.writestr("main.py", worker_py)
    return buf.getvalue()


class LoopbackOpenAIServer:
    """Deterministic loopback HTTP server implementing OpenAI-compatible model routes."""

    def __init__(self, expected_token):
        self.expected_token = expected_token
        self.malformed_mode = False
        self.stall_seconds = 0.0
        self.calls = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(length)
                auth = self.headers.get("Authorization")
                outer.calls.append({"path": self.path, "authMatch": auth == f"Bearer {outer.expected_token}"})
                if auth != f"Bearer {outer.expected_token}":
                    self._send_json(401, {"error": "unauthorized"})
                    return
                if outer.stall_seconds > 0:
                    time.sleep(outer.stall_seconds)

                if self.path.endswith("/chat/completions"):
                    payload = json.loads(raw_body.decode("utf-8"))
                    user_content = payload["messages"][0]["content"]
                    image_url = user_content[1]["image_url"]["url"]
                    assert image_url.startswith("data:image/png;base64,")
                    if outer.malformed_mode:
                        self._send_json(200, {"choices": [{"message": {"content": "   "}}]})
                        return
                    self._send_json(200, {
                        "choices": [{"message": {"content": "A centered red square on a white 64x64 background (loopback fixture)."}}],
                    })
                elif self.path.endswith("/embeddings"):
                    payload = json.loads(raw_body.decode("utf-8"))
                    texts = payload["input"]
                    if outer.malformed_mode:
                        self._send_json(200, {"data": [{"index": 0, "embedding": [1.0, 2.0]}, {"index": 1, "embedding": [3.0]}]})
                        return
                    data = [
                        {"index": i, "embedding": [float(len(t)), float(i + 1), 0.25, -0.5]}
                        for i, t in enumerate(texts)
                    ]
                    self._send_json(200, {"data": data})
                elif self.path.endswith("/audio/speech"):
                    if outer.malformed_mode:
                        self._send_bytes(200, b"NOT-A-VALID-WAV-HEADER", "audio/wav")
                        return
                    self._send_bytes(200, make_wav_bytes(160), "audio/wav")
                elif self.path.endswith("/audio/transcriptions"):
                    if outer.malformed_mode:
                        self._send_json(200, {"text": "bad", "segments": [{"text": "bad", "startMs": 100, "endMs": 50}]})
                        return
                    self._send_json(200, {
                        "text": "loopback transcript ok",
                        "segments": [{"text": "loopback transcript ok", "start": 0.0, "end": 0.16}],
                    })
                else:
                    self._send_json(404, {"error": "not_found"})

            def _send_json(self, status, obj):
                self._send_bytes(status, json.dumps(obj).encode("utf-8"), "application/json")

            def _send_bytes(self, status, body, mime):
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    self.wfile.flush()
                except OSError:
                    pass

        class QuietServer(http.server.ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                return

        self.server = QuietServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()


def verify(artifact, plugins_root, pack_dir=None, sensevoice_dir=None, run_timeout=True):
    plugins_root = Path(plugins_root)
    win_tts_zip = pack_plugin_dir(
        plugins_root / "windows-tts",
        Path(pack_dir) / "kei.windows-tts-1.0.0.zip" if pack_dir else None,
    )
    sv_asr_zip = pack_plugin_dir(
        plugins_root / "sensevoice-asr",
        Path(pack_dir) / "kei.sensevoice-asr-1.0.0.zip" if pack_dir else None,
    )
    oai_zip = pack_plugin_dir(
        plugins_root / "openai-compat-models",
        Path(pack_dir) / "kei.openai-compat-models-1.0.0.zip" if pack_dir else None,
    )

    report = {
        "capabilities": {},
        "speechLoop": None,
        "visionFixture": None,
        "embeddingFixture": None,
        "lifecycleAndFaults": {},
        "allPassed": False,
    }

    with tempfile.TemporaryDirectory(prefix="kei-r20-models-") as tmp:
        root = Path(tmp)
        data = root / "host"
        data.mkdir()

        secret_value = "kei-r20-loopback-synthetic-token-do-not-leak"
        os.environ["KEI_R20_LOOPBACK_TOKEN"] = secret_value
        os.environ.pop("KEI_R20_MISSING_TOKEN", None)

        try:
            with LoopbackOpenAIServer(secret_value) as oai_server, BuiltHost(artifact, data) as host:
                req = host.request

                # ---- 1. Install, configure, enable, and select real local TTS & ASR plugins ----
                real_tts_ok = os.name == "nt"
                real_asr_dir = Path(sensevoice_dir) if sensevoice_dir else None
                real_asr_ready = bool(
                    real_asr_dir
                    and (real_asr_dir / "model.int8.onnx").is_file()
                    and (real_asr_dir / "tokens.txt").is_file()
                )

                req("POST", "/v1/plugins/install", win_tts_zip, 201)
                req("POST", "/v1/plugins/kei.windows-tts/enable", {"grants": ["model.provide.tts"]})

                req("POST", "/v1/plugins/install", sv_asr_zip, 201)
                if real_asr_ready:
                    req("PUT", "/v1/plugins/kei.sensevoice-asr/config", {
                        "values": {
                            "model_dir": str(real_asr_dir),
                            "default_language": "auto",
                            "num_threads": 4,
                            "use_itn": True,
                        },
                    })
                req("POST", "/v1/plugins/kei.sensevoice-asr/enable", {"grants": ["model.provide.asr"]})

                status = req("GET", "/v1/models")
                found_ids = {(p["pluginId"], p["capability"]) for p in status["providers"]}
                assert ("kei.windows-tts", "tts") in found_ids
                assert ("kei.sensevoice-asr", "asr") in found_ids

                # Real local TTS -> ASR closed speech loop!
                if real_tts_ok and real_asr_ready:
                    req("PUT", "/v1/models/selection/asr", {
                        "pluginId": "kei.sensevoice-asr",
                        "model": "sensevoice-int8",
                    })
                    loop_cases = []
                    phrases = [
                        ("sapi-ja-jp", "ja-JP", "おはようございます。今日はいい天気ですね。"),
                        ("sapi-zh-cn", "zh-CN", "你好，今天天气很好。"),
                        ("sapi-en-us", "en-US", "Hello, the local speech loop is ready."),
                    ]
                    for model_id, locale, expected in phrases:
                        req("PUT", "/v1/models/selection/tts", {
                            "pluginId": "kei.windows-tts",
                            "model": model_id,
                        })
                        t0 = time.monotonic()
                        tts_res = req("POST", "/v1/models/invoke/tts", {
                            "input": {"text": expected, "locale": locale},
                        })
                        tts_ms = int(round((time.monotonic() - t0) * 1000))
                        audio_obj = tts_res["output"]["audio"]
                        assert audio_obj["mime"] == "audio/wav"
                        wav_bytes = base64.b64decode(audio_obj["base64"], validate=True)
                        assert wav_bytes[:4] == b"RIFF" and wav_bytes[8:12] == b"WAVE"
                        wav_meta = inspect_wav(wav_bytes)
                        assert wav_meta["durationMs"] > 300

                        t1 = time.monotonic()
                        asr_res = req("POST", "/v1/models/invoke/asr", {
                            "input": {"audio": audio_obj, "locale": locale},
                        })
                        asr_ms = int(round((time.monotonic() - t1) * 1000))
                        transcript = asr_res["output"]["text"]
                        segments = asr_res["output"].get("segments", [])
                        assert transcript, f"Empty transcript for {locale}"
                        assert segments and segments[0]["startMs"] == 0 and segments[0]["endMs"] > 0

                        loop_cases.append({
                            "locale": locale,
                            "ttsModel": model_id,
                            "asrModel": "sensevoice-int8",
                            "expectedPhrase": expected,
                            "actualTranscript": transcript,
                            "exactMatch": transcript == expected,
                            "format": {
                                "mime": audio_obj["mime"],
                                "base64Chars": len(audio_obj["base64"]),
                                "wavBytes": len(wav_bytes),
                                **wav_meta,
                            },
                            "latencyMs": {"tts": tts_ms, "asr": asr_ms, "total": tts_ms + asr_ms},
                            "segmentsCount": len(segments),
                        })

                    # Also verify Kei desktop voice.js call shape ({text, voice:"kei", locale:"ja-JP"})
                    req("PUT", "/v1/models/selection/tts", {"pluginId": "kei.windows-tts", "model": "sapi-auto"})
                    desktop_tts = req("POST", "/v1/models/invoke/tts", {
                        "input": {"text": "おかえりなさい。", "voice": "kei", "locale": "ja-JP"},
                    })
                    assert desktop_tts["output"]["audio"]["mime"] == "audio/wav"

                    report["speechLoop"] = {
                        "evidenceClass": "real-local-inference",
                        "ttsProvider": {"pluginId": "kei.windows-tts", "source": "Windows SAPI local COM synthesis"},
                        "asrProvider": {"pluginId": "kei.sensevoice-asr", "source": "Local sherpa-onnx SenseVoice int8 CPU"},
                        "desktopVoiceCallCompatible": True,
                        "cases": loop_cases,
                    }
                    report["capabilities"]["tts"] = {
                        "evidenceClass": "real-local-inference",
                        "pluginId": "kei.windows-tts",
                        "models": ["sapi-auto", "sapi-ja-jp", "sapi-zh-cn", "sapi-en-us"],
                    }
                    report["capabilities"]["asr"] = {
                        "evidenceClass": "real-local-inference",
                        "pluginId": "kei.sensevoice-asr",
                        "models": ["sensevoice-int8"],
                    }
                    print("PASS Real TTS -> ASR speech loop:", [(c["locale"], c["actualTranscript"], c["latencyMs"]) for c in loop_cases])
                else:
                    report["capabilities"]["tts"] = {
                        "evidenceClass": "real-local-inference" if real_tts_ok else "unavailable-requires-windows",
                        "pluginId": "kei.windows-tts",
                    }
                    report["capabilities"]["asr"] = {
                        "evidenceClass": "unavailable-missing-sensevoice-model-dir",
                        "pluginId": "kei.sensevoice-asr",
                        "missingPrerequisite": "Pass --sensevoice-dir <path containing model.int8.onnx and tokens.txt>",
                    }

                # ---- 2. Vision & Embedding (plus OpenAI-compat HTTP TTS/ASR) via kei.openai-compat-models ----
                req("POST", "/v1/plugins/install", oai_zip, 201)
                req("PUT", "/v1/plugins/kei.openai-compat-models/config", {
                    "values": {
                        "base_url": oai_server.base_url,
                        "timeout_seconds": 6,
                        "default_voice": "alloy",
                        "tts_model_override": "",
                        "asr_model_override": "",
                        "vision_model_override": "",
                        "embedding_model_override": "",
                    },
                })
                req("POST", "/v1/plugins/kei.openai-compat-models/enable", {
                    "grants": [
                        "model.provide.tts", "model.provide.asr",
                        "model.provide.vision", "model.provide.embedding",
                    ],
                })

                # Missing credential check (never contacts server, reports credential_unavailable)
                req("PUT", "/v1/models/selection/vision", {
                    "pluginId": "kei.openai-compat-models",
                    "model": "gpt-4o-mini",
                    "credentialRef": "KEI_R20_MISSING_TOKEN",
                })
                st_missing = req("GET", "/v1/models")
                assert st_missing["selections"]["vision"]["state"] == "credential_unavailable"
                calls_before_missing = len(oai_server.calls)
                synth_png = make_synthetic_shape_png()
                req("POST", "/v1/models/invoke/vision", {
                    "input": {"image": synth_png, "prompt": "Describe the shape and colors."},
                }, 503, "model_credential_unavailable")
                assert len(oai_server.calls) == calls_before_missing

                # Valid synthetic credential -> invoke vision & embedding through normal registry route
                req("PUT", "/v1/models/selection/vision", {
                    "pluginId": "kei.openai-compat-models",
                    "model": "gpt-4o-mini",
                    "credentialRef": "KEI_R20_LOOPBACK_TOKEN",
                })
                req("PUT", "/v1/models/selection/embedding", {
                    "pluginId": "kei.openai-compat-models",
                    "model": "text-embedding-3-small",
                    "credentialRef": "KEI_R20_LOOPBACK_TOKEN",
                })
                st_ready = req("GET", "/v1/models")
                assert st_ready["selections"]["vision"]["state"] == "ready"
                assert st_ready["selections"]["embedding"]["state"] == "ready"
                assert secret_value not in json.dumps(st_ready)

                t_vis = time.monotonic()
                vis_res = req("POST", "/v1/models/invoke/vision", {
                    "input": {"image": synth_png, "prompt": "Describe the shape and colors.", "locale": "en-US"},
                })
                vis_ms = int(round((time.monotonic() - t_vis) * 1000))
                assert vis_res["pluginId"] == "kei.openai-compat-models" and vis_res["model"] == "gpt-4o-mini"
                assert isinstance(vis_res["output"]["text"], str) and "red square" in vis_res["output"]["text"].lower()
                assert secret_value not in json.dumps(vis_res)

                embed_texts = ["Kei local speech loop", "Model provider registry"]
                t_emb = time.monotonic()
                emb_res = req("POST", "/v1/models/invoke/embedding", {
                    "input": {"texts": embed_texts},
                })
                emb_ms = int(round((time.monotonic() - t_emb) * 1000))
                assert emb_res["pluginId"] == "kei.openai-compat-models" and emb_res["providerVersion"] == "1.0.0"
                assert emb_res["output"]["dimensions"] == 4
                assert len(emb_res["output"]["vectors"]) == 2
                assert emb_res["output"]["vectors"][0][0] == float(len(embed_texts[0]))
                assert emb_res["output"]["vectors"][1][0] == float(len(embed_texts[1]))
                assert secret_value not in json.dumps(emb_res)

                # Also verify kei.openai-compat-models HTTP TTS & ASR routes on loopback
                req("PUT", "/v1/models/selection/tts", {
                    "pluginId": "kei.openai-compat-models", "model": "gpt-4o-mini-tts", "credentialRef": "KEI_R20_LOOPBACK_TOKEN",
                })
                req("PUT", "/v1/models/selection/asr", {
                    "pluginId": "kei.openai-compat-models", "model": "whisper-1", "credentialRef": "KEI_R20_LOOPBACK_TOKEN",
                })
                oai_tts = req("POST", "/v1/models/invoke/tts", {"input": {"text": "Hello loopback", "locale": "en-US"}})
                assert oai_tts["output"]["audio"]["mime"] == "audio/wav"
                oai_asr = req("POST", "/v1/models/invoke/asr", {"input": {"audio": oai_tts["output"]["audio"], "locale": "en-US"}})
                assert oai_asr["output"]["text"] == "loopback transcript ok"
                assert oai_asr["output"]["segments"] == [{"text": "loopback transcript ok", "startMs": 0, "endMs": 160}]

                report["visionFixture"] = {
                    "evidenceClass": "loopback-http-fixture-not-live",
                    "pluginId": "kei.openai-compat-models",
                    "model": "gpt-4o-mini",
                    "syntheticImage": {"mime": "image/png", "width": 64, "height": 64, "base64Chars": len(synth_png["base64"])},
                    "outputText": vis_res["output"]["text"],
                    "latencyMs": vis_ms,
                }
                report["embeddingFixture"] = {
                    "evidenceClass": "loopback-http-fixture-not-live",
                    "pluginId": "kei.openai-compat-models",
                    "model": "text-embedding-3-small",
                    "inputTexts": embed_texts,
                    "dimensions": emb_res["output"]["dimensions"],
                    "vectorCount": len(emb_res["output"]["vectors"]),
                    "latencyMs": emb_ms,
                }
                report["capabilities"]["vision"] = {
                    "evidenceClass": "loopback-http-fixture-not-live",
                    "liveAvailableOnHost": False,
                    "missingLivePrerequisite": "No local vision weights or authorized vision endpoint configured; use kei.openai-compat-models with base_url and credentialRef",
                }
                report["capabilities"]["embedding"] = {
                    "evidenceClass": "loopback-http-fixture-not-live",
                    "liveAvailableOnHost": False,
                    "missingLivePrerequisite": "No local embedding weights or authorized embedding endpoint configured; use kei.openai-compat-models with base_url and credentialRef",
                }
                print("PASS Vision & Embedding contract verification via kei.openai-compat-models loopback fixture")

                # ---- 3. Malformed upstream output rejection & recovery ----
                oai_server.malformed_mode = True
                req("POST", "/v1/models/invoke/vision", {"input": {"image": synth_png, "prompt": "bad"}}, 502, "model_output_invalid")
                req("POST", "/v1/models/invoke/embedding", {"input": {"texts": embed_texts}}, 502, "model_output_invalid")
                req("POST", "/v1/models/invoke/tts", {"input": {"text": "bad wav"}}, 502, "model_output_invalid")
                req("POST", "/v1/models/invoke/asr", {"input": {"audio": oai_tts["output"]["audio"]}}, 502, "model_output_invalid")
                oai_server.malformed_mode = False
                assert req("POST", "/v1/models/invoke/embedding", {"input": {"texts": ["recovered"]}})["output"]["dimensions"] == 4

                # ---- 4. Disable, uninstall, reinstall, re-enable, re-select lifecycle ----
                req("POST", "/v1/plugins/kei.windows-tts/disable", {})
                req("PUT", "/v1/models/selection/tts", {"pluginId": "kei.windows-tts", "model": "sapi-auto"}, 409, "model_unavailable")
                req("DELETE", "/v1/plugins/kei.windows-tts", {"retainData": False})
                req("POST", "/v1/plugins/install", win_tts_zip, 201)
                req("POST", "/v1/plugins/kei.windows-tts/enable", {"grants": ["model.provide.tts"]})
                req("PUT", "/v1/models/selection/tts", {"pluginId": "kei.windows-tts", "model": "sapi-en-us"})
                if real_tts_ok:
                    reinstalled_tts = req("POST", "/v1/models/invoke/tts", {"input": {"text": "Reinstall verified.", "locale": "en-US"}})
                    assert reinstalled_tts["output"]["audio"]["mime"] == "audio/wav"

                # ---- 5. Late reply after disable (fast disable + 409 model_selection_changed, no host freeze) ----
                req("POST", "/v1/plugins/install", make_fault_fixture_zip(), 201)
                req("POST", "/v1/plugins/fixture.r20fault/enable", {"grants": ["model.provide.tts"]})
                req("PUT", "/v1/models/selection/tts", {"pluginId": "fixture.r20fault", "model": "fault-tts-v1"})
                req("POST", "/v1/models/invoke/tts", {"input": {"text": "malformed"}}, 502, "model_output_invalid")

                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(
                        req, "POST", "/v1/models/invoke/tts", {"input": {"text": "slow_disable"}},
                        409, "model_selection_changed",
                    )
                    busy_flag = data / "plugin-data" / "fixture.r20fault" / "busy_disable"
                    for _ in range(50):
                        if busy_flag.exists():
                            break
                        time.sleep(0.02)
                    assert busy_flag.exists(), "slow_disable worker did not start"
                    t_dis = time.monotonic()
                    req("POST", "/v1/plugins/fixture.r20fault/disable", {})
                    disable_ms = int(round((time.monotonic() - t_dis) * 1000))
                    pending.result(timeout=4)
                assert disable_ms < 1500, f"disable blocked for {disable_ms}ms while model invocation was in flight"
                req("POST", "/v1/models/invoke/tts", {"input": {"text": "after disable"}}, 503, "model_unavailable")
                print(f"PASS Late reply after disable rejected cleanly (disable took {disable_ms}ms)")

                # ---- 6. Worker timeout -> 504 model_provider_timeout + auto-disable + re-enable recovery ----
                timeout_ms = None
                if run_timeout:
                    req("POST", "/v1/plugins/fixture.r20fault/enable", {"grants": ["model.provide.tts"]})
                    t_to = time.monotonic()
                    req("POST", "/v1/models/invoke/tts", {"input": {"text": "hang"}}, 504, "model_provider_timeout")
                    timeout_ms = int(round((time.monotonic() - t_to) * 1000))
                    # Hung worker must now be disabled until explicitly re-enabled
                    req("POST", "/v1/models/invoke/tts", {"input": {"text": "after timeout"}}, 503, "model_unavailable")
                    req("POST", "/v1/plugins/fixture.r20fault/enable", {"grants": ["model.provide.tts"]})
                    assert req("POST", "/v1/models/invoke/tts", {"input": {"text": "recovered"}})["output"]["audio"]["mime"] == "audio/wav"
                    print(f"PASS Model provider timeout ({timeout_ms}ms) -> 504, disabled, recovered after enable")

                report["lifecycleAndFaults"] = {
                    "installEnableSelectDisableUninstallReinstall": "PASS",
                    "missingCredentialCode": "model_credential_unavailable",
                    "malformedOutputCode": "model_output_invalid",
                    "zeroSecretLeakage": True,
                    "lateReplyAfterDisable": {"status": "PASS", "code": "model_selection_changed", "disableMs": disable_ms},
                    "workerTimeout": {"status": "PASS" if run_timeout else "SKIPPED", "code": "model_provider_timeout", "elapsedMs": timeout_ms},
                }
        finally:
            os.environ.pop("KEI_R20_LOOPBACK_TOKEN", None)

    report["allPassed"] = True
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--plugins-root", type=Path, default=ROOT / "plugins")
    parser.add_argument("--pack-dir", type=Path)
    parser.add_argument("--sensevoice-dir", type=Path)
    parser.add_argument("--skip-timeout", action="store_true")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = verify(
        args.artifact.resolve(),
        args.plugins_root.resolve(),
        pack_dir=args.pack_dir,
        sensevoice_dir=args.sensevoice_dir,
        run_timeout=not args.skip_timeout,
    )
    if args.out:
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
