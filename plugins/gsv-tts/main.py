"""Connect to an already-running loopback GPT-SoVITS v2 /tts service."""

import base64
import http.client
import json
from urllib.parse import urlencode

MAX_WAV = 562_500
OPTIONS = {
    "ref_audio_path", "prompt_text", "prompt_lang", "aux_ref_audio_paths", "text_lang",
    "top_k", "top_p", "temperature", "text_split_method", "batch_size",
    "batch_threshold", "split_bucket", "speed_factor", "fragment_interval",
    "seed", "parallel_infer", "repetition_penalty",
}


def initialize(context):
    settings = context.config or {}
    port = settings.get("port", 9880)
    parameters = json.loads(settings.get("parameters", "{}"))
    if not isinstance(parameters, dict) or set(parameters) - OPTIONS:
        raise ValueError("Invalid GPT-SoVITS synthesis options")

    def synthesize(message):
        params = {**parameters, "text": message["input"]["text"], "media_type": "wav", "streaming_mode": False}
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=17)
        try:
            connection.request("GET", "/tts?" + urlencode(params, doseq=True))
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError("Local synthesis service returned HTTP " + str(response.status))
            raw = response.read(MAX_WAV + 1)
        finally:
            connection.close()
        if not 44 < len(raw) <= MAX_WAV or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
            raise RuntimeError("Local synthesis service did not return a supported WAV")
        return {"audio": {"mime": "audio/wav", "base64": base64.b64encode(raw).decode("ascii")}}

    context.register("tts.synthesize", synthesize)
