"""Optional authored expression curves and local semantic selection."""
import importlib.util
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from secrets import token_urlsafe

from catalog import ASSET_REVISION, LABEL_TARGET, PINNED, SOURCE_REVISION, Curves, mapping_from
from selector import Selector

ROOT = Path(__file__).resolve().parent
MAX_JOBS = 8
JOB_SECONDS = 45
PACKAGE_CREDIT = "LumenAct / 流明表情工坊 · Lumen_流明_ · CC BY 4.0"


class Provider:
    def __init__(self, context):
        self.context = context
        self.settings_file = context.data_dir / "lumenact-settings-v1.json"
        self.config = {**context.config}
        if self.settings_file.is_file():
            self.config.update(json.loads(self.settings_file.read_text("utf-8")))
        self.saved = self.config
        path = self.config["resource_root"]
        directory = Path(path) if path else None
        self.resource_root = directory if directory and directory.is_absolute() else None
        self.sample = Curves(ROOT / "sample")
        self.full = None
        self.selector = None
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lumenact")
        self.jobs = {}
        self.preview_id = None
        self.selector_state = "idle"

    def availability(self):
        if not self.resource_root or not all((self.resource_root / name).is_file() for name in PINNED):
            return "assets_missing"
        if not all(importlib.util.find_spec(name) for name in ("numpy", "onnxruntime", "tokenizers")):
            return "runtime_missing"
        return self.selector_state

    def status(self, _request):
        return {
            "mode": self.config["selector_mode"], "selectorState": self.availability(),
            "sourceRevision": SOURCE_REVISION, "assetRevision": ASSET_REVISION, "credit": PACKAGE_CREDIT,
            "samples": [{"id": ident, "label": style["label"]} for ident, style in self.sample.styles.items()],
        }

    def settings(self, _request):
        return {"state": "ready", "values": self.saved, "pendingReload": self.saved != self.config}

    def save(self, request):
        values = request.get("values")
        if not isinstance(values, dict) or values.keys() != self.config.keys():
            return {"state": "fallback", "code": "settings_invalid"}
        mode, root, clip, strength = (values[k] for k in ("selector_mode", "resource_root", "fixed_clip", "strength"))
        if (mode not in ("onnx", "fixed") or not isinstance(root, str) or len(root) > 1024
            or "\0" in root or (root and not Path(root).is_absolute()) or not isinstance(clip, str)
            or not clip.isascii() or not clip.isdigit() or len(clip) > 5
            or type(strength) not in (int, float) or not math.isfinite(strength) or not 0 <= strength <= 1
            or not isinstance(values["mapping"], dict)):
            return {"state": "fallback", "code": "settings_invalid"}
        try:
            mapping_from(values["mapping"])
        except ValueError as error:
            return {"state": "fallback", "code": str(error)}
        self.settings_file.parent.mkdir(parents=True, exist_ok=True)
        scratch = self.settings_file.with_suffix(".tmp")
        scratch.write_text(json.dumps(values, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        scratch.replace(self.settings_file)
        self.saved = values
        return self.settings({})

    def render(self, intent, text, fixed):
        try:
            mapping = mapping_from(self.config["mapping"])
            strength = self.config["strength"]
            if fixed is not None or self.config["selector_mode"] == "fixed":
                ident = fixed if fixed is not None else self.config["fixed_clip"]
                style = self.sample.styles.get(ident)
                curves = self.sample
                if style is None and self.resource_root:
                    if self.full is None:
                        self.full = Curves(self.resource_root / "models/expression", self.resource_root)
                    curves = self.full
                    style = curves.styles.get(ident)
                if style is None:
                    return {"state": "fallback", "code": "clip_missing"}
                selection = {"selector": "fixed", "label": style["label"], "contextId": style["context_id"]}
            else:
                availability = self.availability()
                if availability in ("assets_missing", "runtime_missing"):
                    return {"state": "fallback", "code": availability}
                if self.selector is None:
                    self.selector_state = "loading"
                    self.selector = Selector(self.resource_root)
                if self.full is None:
                    self.full = Curves(self.resource_root / "models/expression", self.resource_root)
                self.selector_state = "ready"
                selection = self.selector.predict(intent, text)
                curves = self.full
                style = curves.find(selection["label"], selection["contextId"])
                if style is None:
                    return {"state": "fallback", "code": "clip_missing", "selection": selection}
            if not self.config["mapping"]:
                target = LABEL_TARGET.get(style["label"])
                mapping = {target: mapping[target]} if target else {}
            clip = curves.clip(style, mapping, strength)
            if not clip["targets"]:
                return {"state": "fallback", "code": "no_mapped_curves", "selection": selection}
            return {"state": "ready", "selection": selection, "clip": clip}
        except ValueError as error:
            code = str(error)
            if code not in {"asset_missing", "asset_integrity", "mapping_invalid", "mapping_reserved", "curve_format",
                            "curve_channel", "curve_span", "curve_nonfinite"}:
                code = "selector_unavailable"
            if self.selector_state == "loading":
                self.selector_state = code
            return {"state": "fallback", "code": code}
        except (ImportError, OSError, RuntimeError) as error:
            self.selector_state = "runtime_missing" if isinstance(error, ImportError) else "selector_unavailable"
            return {"state": "fallback", "code": self.selector_state}

    def cleanup(self):
        now = time.monotonic()
        for ident, job in list(self.jobs.items()):
            if now >= job["deadline"]:
                self.remove(ident)

    def remove(self, ident):
        if ident in self.jobs:
            self.jobs.pop(ident)["future"].cancel()

    def begin(self, request, preview=False):
        self.cleanup()
        intent, text = request.get("intent", ""), request.get("text", "")
        fixed = request.get("clipId") if preview else None
        if (not isinstance(intent, str) or len(intent) > 256 or not isinstance(text, str) or len(text) > 512
            or (fixed is not None and (not isinstance(fixed, str) or not fixed.isascii() or not fixed.isdigit() or len(fixed) > 5))
            or (fixed is None and not intent.strip())):
            return {"state": "fallback", "code": "invalid_input"}
        if preview:
            self.remove(self.preview_id)
        if len(self.jobs) >= MAX_JOBS:
            return {"state": "fallback", "code": "busy"}
        ident = token_urlsafe(18)
        issued = int(time.time() * 1000)
        self.jobs[ident] = {
            "preview": preview, "future": self.executor.submit(self.render, intent.strip(), text, fixed),
            "deadline": time.monotonic() + JOB_SECONDS, "issuedAt": issued,
        }
        if preview:
            self.preview_id = ident
        return {"state": "pending", "jobId": ident}

    def poll(self, request, preview=False):
        self.cleanup()
        ident = request.get("jobId")
        job = self.jobs.get(ident) if isinstance(ident, str) else None
        if not job or job["preview"] != preview:
            return {"state": "fallback", "code": "job_closed"}
        if not job["future"].done():
            return {"state": "pending", "jobId": ident}
        self.jobs.pop(ident)
        try:
            result = job["future"].result()
        except Exception:
            result = {"state": "fallback", "code": "selector_unavailable"}
        if preview and result["state"] == "ready" and ident == self.preview_id:
            self.context.emit("lumenact.preview", {
                "type": "play", "clip": result["clip"], "selection": result["selection"], "issuedAt": job["issuedAt"],
            })
            return {**result, "clip": {key: val for key, val in result["clip"].items() if key != "tracks"}}
        return result

    def cancel(self, request):
        self.cleanup()
        ident = request.get("jobId")
        job = self.jobs.get(ident) if isinstance(ident, str) else None
        if job and not job["preview"]:
            self.remove(ident)
        return {"state": "stopped"}

    def stop_preview(self, _request):
        self.remove(self.preview_id)
        self.preview_id = None
        self.context.emit("lumenact.preview", {"type": "stop", "issuedAt": int(time.time() * 1000)})
        return {"state": "stopped"}


provider = None


def initialize(context):
    global provider
    provider = Provider(context)
    context.register("select", provider.begin)
    context.register("select.poll", provider.poll)
    context.register("select.cancel", provider.cancel)
    context.register("status", provider.status)
    context.register("preview", lambda message: provider.begin(message, preview=True))
    context.register("preview.poll", lambda message: provider.poll(message, preview=True))
    context.register("preview.stop", provider.stop_preview)
    context.register("settings.get", provider.settings)
    context.register("settings.save", provider.save)


def terminate(_context):
    if provider:
        provider.executor.shutdown(wait=False, cancel_futures=True)
