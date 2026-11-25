"""Authenticated, operator-selected model provider routing."""

import base64
import binascii
import json
import math
import os
import re

from .host import write_json
from .package import ApiError, CAPABILITIES
from .process import MODEL_TIMEOUT, WorkerFailure

AUDIO = {"audio/wav", "audio/mpeg", "audio/ogg", "audio/flac"}
IMAGE = {"image/png", "image/jpeg"}
SECRET_REF = re.compile(r"[A-Z_][A-Z0-9_]{0,127}")


def text(value, size):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= size


def obj(value, keys):
    return isinstance(value, dict) and not value.keys() - set(keys.split())


def binary(value, mimes):
    if not obj(value, "mime base64") or not isinstance(value.get("mime"), str) or value["mime"] not in mimes:
        return False
    part = value.get("base64")
    if not isinstance(part, str) or not 1 <= len(part) <= 750000:
        return False
    try:
        raw = base64.b64decode(part, validate=True)
    except (ValueError, binascii.Error):
        return False
    if value["mime"] == "image/png":
        return raw.startswith(b"\x89PNG\r\n\x1a\n")
    if value["mime"] == "image/jpeg":
        return raw.startswith(b"\xff\xd8")
    if value["mime"] == "audio/wav":
        return len(raw) >= 44 and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
    if value["mime"] == "audio/ogg":
        return raw.startswith(b"OggS")
    if value["mime"] == "audio/flac":
        return raw.startswith(b"fLaC")
    return raw.startswith(b"ID3") or (len(raw) > 1 and raw[0] == 0xff and raw[1] & 0xe0 == 0xe0)


def valid_input(capability, value):
    if not isinstance(value, dict) or ("locale" in value and not text(value["locale"], 32)):
        return False
    if capability == "tts":
        return obj(value, "text voice locale") and text(value.get("text"), 8000) and ("voice" not in value or text(value["voice"], 80))
    if capability == "asr":
        return obj(value, "audio locale") and binary(value.get("audio"), AUDIO)
    if capability == "vision":
        return obj(value, "image prompt locale") and text(value.get("prompt"), 4000) and binary(value.get("image"), IMAGE)
    batch = value.get("texts")
    return obj(value, "texts") and isinstance(batch, list) and 1 <= len(batch) <= 32 and all(text(item, 4000) for item in batch)


def valid_segments(segments):
    prior = 0
    if not isinstance(segments, list) or len(segments) > 300:
        return False
    for segment in segments:
        if not obj(segment, "text startMs endMs") or not text(segment.get("text"), 4000):
            return False
        start, end = segment.get("startMs"), segment.get("endMs")
        if type(start) is not int or type(end) is not int or not prior <= start <= end <= 7 * 24 * 3600 * 1000:
            return False
        prior = end
    return True


def valid_output(capability, value, inputs):
    if capability == "tts":
        return obj(value, "audio") and binary(value.get("audio"), AUDIO)
    if capability == "asr":
        return (obj(value, "text segments") and isinstance(value.get("text"), str) and len(value["text"]) <= 32000
                and ("segments" not in value or valid_segments(value["segments"])))
    if capability == "vision":
        return obj(value, "text") and text(value.get("text"), 12000)
    if not obj(value, "dimensions vectors"):
        return False
    dimension, vectors = value.get("dimensions"), value.get("vectors")
    return (type(dimension) is int and 1 <= dimension <= 4096 and isinstance(vectors, list)
            and len(vectors) == len(inputs["texts"]) and len(vectors) * dimension <= 65536
            and all(isinstance(vector, list) and len(vector) == dimension
                    and all(type(number) in (int, float) and abs(number) <= 1e30 and math.isfinite(number)
                            for number in vector) for vector in vectors))


class ModelProviders:
    def __init__(self, host):
        self.host = host
        self.path = host.root / "model-selection-v1.json"
        try:
            values = json.loads(self.path.read_text("utf-8"))
            if not isinstance(values, dict):
                raise ValueError()
            self.selections = {
                cap: {key: value.get(key) for key in ("pluginId", "model", "credentialRef")}
                for cap, value in values.items() if cap in CAPABILITIES and obj(value, "pluginId model credentialRef")
                and text(value.get("pluginId"), 100) and text(value.get("model"), 100)
                and (value.get("credentialRef") is None or (
                    isinstance(value["credentialRef"], str) and SECRET_REF.fullmatch(value["credentialRef"])))
            }
            self.error = None
        except FileNotFoundError:
            self.selections, self.error = {}, None
        except (OSError, ValueError, RecursionError):
            self.selections, self.error = {}, "model_selection_unreadable"
        self.revisions = {cap: 0 for cap in CAPABILITIES}
        self.inflight = set()
        self.timeout = MODEL_TIMEOUT

    def provider(self, plugin, capability):
        if not isinstance(plugin, str):
            return None
        return self.host.manifests.get(plugin, {}).get("modelProviders", {}).get(capability)

    def active(self, plugin, capability):
        return plugin in self.host.workers and f"model.provide.{capability}" in self.host.states[plugin]["grants"]

    def credential(self, ref):
        if not isinstance(ref, str) or not SECRET_REF.fullmatch(ref):
            return None
        value = os.environ.get(ref)
        return value if value and len(value) <= 4096 else None

    def status(self):
        with self.host.guard:
            providers = [
                {"pluginId": plugin, "name": metadata["name"], "version": metadata["version"], "capability": capability,
                 "models": info["models"], "requiresCredential": info["requiresCredential"],
                 "enabled": self.active(plugin, capability), "streaming": False, "cancellation": False}
                for plugin, metadata in sorted(self.host.manifests.items())
                for capability, info in sorted(metadata["modelProviders"].items())
            ]
            selections = {}
            for capability, value in self.selections.items():
                plugin, model = value.get("pluginId"), value.get("model")
                descriptor = self.provider(plugin, capability)
                selection_state = "unavailable"
                if descriptor and model in descriptor["models"] and self.active(plugin, capability):
                    selection_state = "credential_unavailable" if descriptor["requiresCredential"] and not self.credential(
                        value.get("credentialRef")) else "ready"
                selections[capability] = {**value, "state": selection_state}
            return {"capabilities": list(CAPABILITIES), "providers": providers, "selections": selections, "error": self.error}

    def set(self, capability, value):
        if capability not in CAPABILITIES:
            raise ApiError(404, "model_capability_unknown", "Unknown model capability")
        with self.host.guard:
            choices = dict(self.selections)
            if obj(value, "pluginId") and value == {"pluginId": None}:
                choices.pop(capability, None)
            else:
                if not obj(value, "pluginId model credentialRef"):
                    raise ApiError(422, "model_selection_invalid", "Send a pluginId, model, and optional credentialRef")
                plugin, model, ref = (value.get(key) for key in ("pluginId", "model", "credentialRef"))
                descriptor = self.provider(plugin, capability)
                if not descriptor or model not in descriptor["models"] or not self.active(plugin, capability):
                    raise ApiError(409, "model_unavailable", "Enable a provider with the required grant and choose an advertised model")
                if ((ref is not None and (not isinstance(ref, str) or not SECRET_REF.fullmatch(ref)))
                        or descriptor["requiresCredential"] != (ref is not None)):
                    raise ApiError(422, "model_credential_reference_invalid", "Use an environment variable name for a provider that requires a credential")
                choices[capability] = {"pluginId": plugin, "model": model, "credentialRef": ref}
            write_json(self.path, choices)
            self.selections, self.error = choices, None
            self.revisions[capability] += 1
            return self.status()

    def invoke(self, capability, body):
        if capability not in CAPABILITIES:
            raise ApiError(404, "model_capability_unknown", "Unknown model capability")
        if not obj(body, "input stream") or not valid_input(capability, body.get("input")) or type(body.get("stream", False)) is not bool:
            raise ApiError(422, "model_input_invalid", "Input is invalid for this model capability")
        if body.get("stream"):
            raise ApiError(409, "model_streaming_unavailable", "This provider API version accepts complete requests")
        inputs = body["input"]
        with self.host.guard:
            selection = self.selections.get(capability, {})
            plugin, model = selection.get("pluginId"), selection.get("model")
            descriptor = self.provider(plugin, capability)
            if not descriptor or model not in descriptor["models"] or not self.active(plugin, capability):
                raise ApiError(503, "model_unavailable", "No selected model provider is available for this capability")
            credential = self.credential(selection.get("credentialRef"))
            if descriptor["requiresCredential"] and credential is None:
                raise ApiError(503, "model_credential_unavailable", "The configured environment variable is unavailable")
            worker = self.host.workers[plugin]
            version = self.host.manifests[plugin]["version"]
            revision = self.revisions[capability]
            if worker in self.inflight or len(self.inflight) >= 16:
                raise ApiError(429, "model_provider_busy", "Wait until the active model request finishes")
            self.inflight.add(worker)
        try:
            result, _ = worker.request("provide_model", action=descriptor["action"], credential=credential,
                                       timeout=self.timeout,
                                       arguments={"capability": capability, "model": model, "input": inputs})
        except WorkerFailure as error:
            with self.host.guard:
                if self.host.workers.get(plugin) is not worker or self.revisions[capability] != revision:
                    raise ApiError(409, "model_selection_changed", "The provider changed while the request was in progress") from error
                if worker.broken and self.host.workers.get(plugin) is worker:
                    self.host.disable(plugin)
            if error.reason == "worker_unresponsive":
                raise ApiError(504, "model_provider_timeout", "The model provider timed out") from error
            raise ApiError(502, "model_provider_failed", "The provider could not complete the request") from error
        finally:
            with self.host.guard:
                self.inflight.discard(worker)
        valid = valid_output(capability, result, inputs)
        with self.host.guard:
            if self.host.workers.get(plugin) is not worker or self.revisions[capability] != revision:
                raise ApiError(409, "model_selection_changed", "The provider changed while the request was in progress")
            if not valid:
                raise ApiError(502, "model_output_invalid", "The provider returned an invalid result")
            return {"pluginId": plugin, "providerVersion": version, "model": model, "capability": capability, "output": result}
