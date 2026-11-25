"""Exercise the model registry with independently packaged local fixtures."""

import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from zipfile import ZipFile

from host_smoke import BuiltHost

CAPABILITIES = ("tts", "asr", "vision", "embedding")
WORKER = """
import os
import time
def initialize(context):
    def provide(message):
        cap, model, value = (message[name] for name in ("capability", "model", "input"))
        if value.get("text") == "crash":
            os._exit(17)
        if value.get("text") == "slow":
            (context.data_dir / "busy").touch()
            time.sleep(.55)
        if cap == "tts":
            assert context.model_credential == "local-fixture-only"
            return {"audio": AUDIO}
        assert context.model_credential is None
        if cap == "asr":
            return {"text": model, "segments": [{"text": model, "startMs": 0, "endMs": 20}]}
        if cap == "vision":
            return {"text": f"{model}: {value['prompt']}"}
        if value["texts"] == ["malformed"]:
            return {"dimensions": 3, "vectors": [[0]]}
        return {"dimensions": 2, "vectors": [[len(text), 0.5] for text in value["texts"]]}
    for capability in CAPS:
        context.register("fixture." + capability, provide)
"""


def pcm():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setparams((1, 2, 8000, 0, "NONE", ""))
        out.writeframes(b"\x00\x00" * 160)
    return {"mime": "audio/wav", "base64": base64.b64encode(buffer.getvalue()).decode("ascii")}


def package(ident, caps, leak_page=False):
    declarations = [
        {"capability": cap, "action": "fixture." + cap, "models": [ident + "-" + cap], "requiresCredential": cap == "tts"}
        for cap in caps
    ]
    info = {
        "apiVersion": 1, "schemaVersion": 1, "id": ident, "name": "Fixture", "version": "1.0.0",
        "requiresFeatures": ["model-providers-v1"], "permissions": ["model.provide." + name for name in caps],
        "actions": [{"id": "fixture." + name, "scope": "model.provide." + name} for name in caps],
        "modelProviders": declarations,
    }
    if leak_page:
        info["entries"] = [{"id": "fixture", "title": "Fixture", "slot": "admin", "page": "fixture.html",
                            "actions": ["fixture." + caps[0]]}]
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as output:
        output.writestr("metadata.yaml", json.dumps(info))
        output.writestr("main.py", f"CAPS = {caps!r}\nAUDIO = {pcm()!r}\n" + WORKER)
        if leak_page:
            output.writestr("fixture.html", "<p>Fixture</p>")
    return buffer.getvalue()


def verify(artifact, directory):
    provider = "fixture.alpha"
    second = "fixture.bravo"
    os.environ["KEI_TEST_MODEL_TOKEN"] = "local-fixture-only"
    png = {"mime": "image/png", "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD9kAAAAASUVORK5CYII="}
    with BuiltHost(artifact, directory) as host:
        request = host.request
        status = lambda: request("GET", "/v1/models")
        invoke = lambda cap, inputs, *args: request("POST", "/v1/models/invoke/" + cap, {"input": inputs}, *args)
        def choose(cap, plugin=provider, ref=None):
            body = {"pluginId": plugin, "model": plugin + "-" + cap}
            if ref:
                body["credentialRef"] = ref
            return request("PUT", "/v1/models/selection/" + cap, body)

        assert status()["providers"] == []
        request("POST", "/v1/plugins/install", package("fixture.forbidden", ("tts",), True), 422, "invalid_manifest")
        request("POST", "/v1/plugins/install", package(provider, CAPABILITIES), 201)
        request("POST", "/v1/plugins/install", package(second, ("tts", "asr")), 201)
        assert all(not item["enabled"] for item in status()["providers"])
        request("POST", f"/v1/plugins/{provider}/enable", {"grants": ["model.provide." + cap for cap in CAPABILITIES]})
        request("POST", f"/v1/plugins/{second}/enable", {"grants": ["model.provide.tts", "model.provide.asr"]})
        print("PASS package registration, discovery, dedicated grants and page isolation")

        choose("tts", ref="KEI_TEST_MODEL_MISSING")
        invoke("tts", {"text": "Hello"}, 503, "model_credential_unavailable")
        choose("tts", ref="KEI_TEST_MODEL_TOKEN")
        for cap in ("asr", "vision", "embedding"):
            choose(cap)
        assert invoke("tts", {"text": "Hello"})["output"]["audio"] == pcm()
        assert invoke("asr", {"audio": pcm()})["output"]["text"] == provider + "-asr"
        assert invoke("vision", {"image": png, "prompt": "describe"})["output"]["text"].endswith(": describe")
        result = invoke("embedding", {"texts": ["abba", "bb"]})
        assert result["output"] == {"dimensions": 2, "vectors": [[4, .5], [2, .5]]}
        assert result["providerVersion"] == "1.0.0" and result["pluginId"] == provider
        assert "local-fixture-only" not in json.dumps(status())
        print("PASS typed TTS, ASR, vision, embedding and credential references")

        choose("asr", second)
        assert invoke("asr", {"audio": pcm()})["output"]["text"] == second + "-asr"
        assert invoke("tts", {"text": "Hello"})["pluginId"] == provider
        print("PASS per-capability switch through the normal selection and invocation paths")

        invoke("vision", {"image": pcm(), "prompt": "bad"}, 422, "model_input_invalid")
        invoke("embedding", {"texts": ["malformed"]}, 502, "model_output_invalid")
        request("POST", "/v1/models/invoke/tts", {"input": {"text": "Hi"}, "stream": True}, 409, "model_streaming_unavailable")
        assert invoke("embedding", {"texts": ["recovered"]})["output"]["dimensions"] == 2
        print("PASS invalid input, bad results, and streaming capability errors recover")

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(invoke, "tts", {"text": "slow"}, 409, "model_selection_changed")
            signal = directory / "plugin-data" / provider / "busy"
            for _ in range(30):
                if signal.exists():
                    break
                time.sleep(.01)
            assert signal.exists(), "provider did not start"
            invoke("tts", {"text": "overlap"}, 429, "model_provider_busy")
            choose("tts", second, "KEI_TEST_MODEL_TOKEN")
            pending.result(timeout=3)
        assert invoke("tts", {"text": "after selection"})["pluginId"] == second
        print("PASS changing selections invalidates stale in-flight results")

        invoke("tts", {"text": "crash"}, 502, "model_provider_failed")
        invoke("tts", {"text": "after crash"}, 503, "model_unavailable")
        request("POST", f"/v1/plugins/{second}/enable", {"grants": ["model.provide.tts", "model.provide.asr"]})
        assert invoke("tts", {"text": "after recovery"})["pluginId"] == second
        request("POST", f"/v1/plugins/{second}/disable", {})
        invoke("asr", {"audio": pcm()}, 503, "model_unavailable")
        request("DELETE", f"/v1/plugins/{second}", {"retainData": False})
        assert not any(item["pluginId"] == second for item in status()["providers"])
        assert status()["selections"]["asr"]["state"] == "unavailable"
        choose("asr")
        print("PASS worker crash recovery, disable, uninstall and manual rebind")

    with BuiltHost(artifact, directory) as host:
        value = host.request("GET", "/v1/models")["selections"]
        assert value["asr"]["state"] == "ready" and value["tts"]["state"] == "unavailable"
        host.request("PUT", "/v1/models/selection/tts", {"pluginId": None})
        assert "tts" not in host.request("GET", "/v1/models")["selections"]
        print("PASS restart persistence, unavailable selection diagnostics and explicit removal")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="kei-model-provider-") as directory:
        verify(Path(sys.argv[1]).resolve(), Path(directory))
