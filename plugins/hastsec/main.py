"""Kei adapter for the separately installed, pinned HAST-SEC solver and reviewed vocabulary."""

import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from secrets import token_urlsafe


PIN = "f4d5c9aa32f9d04e249585e0b2e6d4c56572ca51"
SOLVER = Path(__file__).with_name("solve.mjs")
VOCAB = Path(__file__).with_name("vocabulary.mjs")
SOLVER_SHA256 = hashlib.sha256(
    SOLVER.read_bytes() + (VOCAB.read_bytes() if VOCAB.is_file() else b"")
).hexdigest()
REST_POSE_VERSION = "vrm1-arms-1.10-v2"
CACHE_LIMIT = 128
OPTIONS = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
STANDARD_TOOLS = {
    "node": ("C:/Program Files/nodejs/node.exe", "/usr/local/bin/node", "/usr/bin/node"),
    "git": ("C:/Program Files/Git/cmd/git.exe", "/usr/local/bin/git", "/usr/bin/git"),
}
PREWARM_MOTIONS = (
    "greeting-wave",
    "explain-open-palm",
    "hesitate-pause",
    "ack-nod",
    "indicate-direction",
    "complete-settle",
    "kei-greet-composed",
    "kei-listen-attentive",
    "kei-explain-measured",
    "kei-hesitate-guarded",
    "kei-work-check",
    "kei-complete-composed",
)


def fallback(code):
    return {"state": "fallback", "code": code}


def tool(name, configured):
    if configured:
        candidate = Path(configured)
        if candidate.is_absolute() and candidate.name.lower() in (name, name + ".exe") and candidate.is_file():
            return str(candidate)
        return None
    discovered = shutil.which(name)
    if discovered:
        return discovered
    return next((candidate for candidate in STANDARD_TOOLS[name]
                 if Path(candidate).is_absolute() and os.access(candidate, os.X_OK)), None)


def intent_from(request):
    motion = request.get("motion")
    speed = request.get("speed", 1)
    strength = request.get("strength", 0.9)
    variant = request.get("variant", "auto")
    if not isinstance(motion, str) or not motion or len(motion) > 100:
        return None
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (speed, strength)):
        return None
    if not 0.6 <= speed <= 2 or not 0 < strength <= 1:
        return None
    if variant is None:
        variant = "auto"
    if not isinstance(variant, str) or not variant.strip() or len(variant) > 48:
        return None
    return {"motion": motion, "speed": round(float(speed), 3), "strength": round(float(strength), 3), "variant": variant.strip()}


class HAST:
    def __init__(self, context):
        self.context = context
        self.settings_file = context.data_dir / "settings-v1.json"
        self.path = context.config["resource_root"]
        self.tools = {name: context.config[name + "_executable"] for name in STANDARD_TOOLS}
        if self.settings_file.is_file():
            self.path = json.loads(self.settings_file.read_text("utf-8"))["resource_root"]
        self.saved = self.path
        self.jobs = {}
        self.cache_dir = context.data_dir / "solve-cache-v2"
        self._runtime_cache = None
        self._library_cache = None
        self._solve_cache = {}
        self._ready_by_motion = {}
        self._variant_cursor = {}

    def runtime(self):
        if self._runtime_cache is not None:
            return self._runtime_cache
        node, git = (tool(name, self.tools[name]) for name in ("node", "git"))
        root = Path(self.path)
        if not self.path or not root.is_absolute() or not (root / "motion/v9/controller.mjs").is_file():
            return fallback("assets_missing")
        if not node or not git or not (root / "node_modules/three/build/three.module.js").is_file():
            return fallback("runtime_missing")
        try:
            base = [git, "-C", str(root)]
            revision = subprocess.check_output([*base, "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, timeout=1, **OPTIONS)
            clean = subprocess.run([*base, "diff", "--quiet", "HEAD", "--"], timeout=1, **OPTIONS).returncode == 0
            three = json.loads((root / "node_modules/three/package.json").read_text("utf-8"))
            if revision.decode("ascii").strip() != PIN or not clean or three["version"] != "0.180.0":
                return fallback("asset_integrity")
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            return fallback("asset_integrity")
        self._runtime_cache = {"state": "ready", "root": str(root), "node": node}
        return self._runtime_cache

    def settings(self, _request):
        return {"state": "ready", "revision": PIN, "resource_root": self.saved, "pendingReload": self.saved != self.path}

    def save(self, request):
        value = request.get("resource_root")
        if not isinstance(value, str) or len(value) > 1024 or "\0" in value or (value and not Path(value).is_absolute()):
            return fallback("settings_invalid")
        self.settings_file.parent.mkdir(parents=True, exist_ok=True)
        scratch = self.settings_file.with_suffix(".tmp")
        scratch.write_text(json.dumps({"resource_root": value}, ensure_ascii=False), encoding="utf-8")
        scratch.replace(self.settings_file)
        self.saved = value
        self._runtime_cache = None
        self._library_cache = None
        return self.settings({})

    def library(self, _request):
        if self._library_cache is not None:
            return self._library_cache
        runtime = self.runtime()
        if runtime["state"] != "ready":
            return runtime
        try:
            result = subprocess.check_output([runtime["node"], str(SOLVER), runtime["root"], "library"],
                                             stderr=subprocess.DEVNULL, timeout=2.5, **OPTIONS)
            parsed = json.loads(result)
            if isinstance(parsed, dict) and parsed.get("state") == "ready":
                self._library_cache = parsed
            return parsed
        except (OSError, ValueError, subprocess.SubprocessError):
            return fallback("solver_unavailable")

    def _motion_variants(self, motion_id):
        lib = self._library_cache or self.library({})
        if isinstance(lib, dict) and lib.get("state") == "ready":
            for item in lib.get("motions", []):
                if item.get("id") == motion_id:
                    variants = item.get("variants")
                    if isinstance(variants, list) and variants:
                        return [v["id"] for v in variants if isinstance(v, dict) and isinstance(v.get("id"), str)]
        return []

    def _pick_variant(self, intent):
        variants = self._motion_variants(intent["motion"])
        if not variants:
            return intent["variant"], 0
        if intent["variant"] != "auto" and intent["variant"] in variants:
            return intent["variant"], variants.index(intent["variant"])
        idx = self._variant_cursor.get(intent["motion"], 0) % len(variants)
        self._variant_cursor[intent["motion"]] = idx + 1
        return variants[idx], idx

    def _cache_key(self, motion, variant_id, speed, strength, rig, runtime_root):
        key_blob = json.dumps({
            "pin": PIN,
            "solver": SOLVER_SHA256,
            "rest": REST_POSE_VERSION,
            "root": runtime_root,
            "motion": motion,
            "variant": variant_id,
            "speed": round(float(speed), 3),
            "strength": round(float(strength), 3),
            "rig": rig,
        }, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        return hashlib.sha256(key_blob).hexdigest()

    def _rig_hash(self, rig, runtime_root):
        blob = json.dumps({"root": runtime_root, "rig": rig}, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()[:16]

    def _cache_get(self, cache_key, prewarmed=False):
        t0 = time.perf_counter()
        hit = self._solve_cache.get(cache_key)
        if hit is None:
            path = self.cache_dir / f"{cache_key}.json"
            if path.is_file():
                try:
                    loaded = json.loads(path.read_text("utf-8"))
                    if isinstance(loaded, dict) and loaded.get("state") == "ready" and isinstance(loaded.get("clip"), dict):
                        hit = loaded
                        if len(self._solve_cache) < CACHE_LIMIT:
                            self._solve_cache[cache_key] = hit
                except (OSError, ValueError):
                    hit = None
        if hit is None:
            return None
        diag = {
            **hit.get("diagnostics", {}),
            "cached": True,
            "prewarmed": bool(hit.get("prewarmed") or prewarmed),
            "solveMs": round((time.perf_counter() - t0) * 1000, 3),
        }
        self.context.emit("hastsec.diagnostics", diag)
        return {"state": "ready", "clip": hit["clip"], "diagnostics": diag}

    def _cache_put(self, cache_key, result, motion=None, rig_id=None, variant_id=None, prewarmed=False):
        if len(self._solve_cache) >= CACHE_LIMIT:
            self._solve_cache.pop(next(iter(self._solve_cache)))
        entry = {"state": "ready", "clip": result["clip"], "diagnostics": result["diagnostics"], "prewarmed": prewarmed}
        self._solve_cache[cache_key] = entry
        if motion and rig_id:
            bucket = self._ready_by_motion.setdefault((rig_id, motion), [])
            if (variant_id, cache_key) not in bucket:
                bucket.append((variant_id, cache_key))
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            path = self.cache_dir / f"{cache_key}.json"
            scratch = path.with_suffix(".tmp")
            scratch.write_text(json.dumps(entry, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
            scratch.replace(path)
        except OSError:
            pass

    def prewarm(self, request):
        rig = request.get("rig")
        if not isinstance(rig, dict):
            return fallback("invalid_intent")
        runtime = self.runtime()
        if runtime["state"] != "ready":
            return runtime
        lib = self.library({})
        if not isinstance(lib, dict) or lib.get("state") != "ready":
            return fallback("solver_unavailable")
        rig_id = self._rig_hash(rig, runtime["root"])
        requested_motions = request.get("motions")
        motion_ids = [m for m in requested_motions if isinstance(m, str)] if isinstance(requested_motions, list) and requested_motions else list(PREWARM_MOTIONS)
        items = []
        already = 0
        for mid in motion_ids[:16]:
            variants = self._motion_variants(mid) or ["default"]
            for idx, vid in enumerate(variants):
                key = self._cache_key(mid, vid, 1.0, 0.9, rig, runtime["root"])
                if self._cache_get(key, prewarmed=True) is not None:
                    bucket = self._ready_by_motion.setdefault((rig_id, mid), [])
                    if (vid, key) not in bucket:
                        bucket.append((vid, key))
                    already += 1
                    continue
                items.append({"motion": mid, "variant": vid, "variantIndex": idx, "speed": 1.0, "strength": 0.9})
        if not items:
            return {"state": "ready", "prewarmed": already, "computed": 0, "elapsedMs": 0.0}
        payload = json.dumps({"rig": rig, "items": items}, allow_nan=False).encode("utf-8")
        if len(payload) > 64 * 1024:
            return fallback("rig_mismatch")
        t0 = time.perf_counter()
        try:
            proc = subprocess.run(
                [runtime["node"], str(SOLVER), runtime["root"], "prewarm"],
                input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=8.0, check=False, **OPTIONS
            )
            parsed = json.loads(proc.stdout.decode("utf-8"))
        except (OSError, ValueError, subprocess.SubprocessError):
            return fallback("solver_unavailable")
        if not isinstance(parsed, dict) or parsed.get("state") != "ready":
            return fallback("solver_unavailable")
        computed = 0
        for entry in parsed.get("results", []):
            solved = entry.get("solved")
            if isinstance(solved, dict) and solved.get("state") == "ready":
                vid = solved.get("clip", {}).get("beat", {}).get("variantId") or entry.get("variant") or "default"
                key = self._cache_key(entry["motion"], vid, entry["speed"], entry["strength"], rig, runtime["root"])
                self._cache_put(key, solved, motion=entry["motion"], rig_id=rig_id, variant_id=vid, prewarmed=True)
                computed += 1
        return {
            "state": "ready",
            "prewarmed": already + computed,
            "computed": computed,
            "elapsedMs": round((time.perf_counter() - t0) * 1000, 1),
        }

    def solve(self, request):
        self.expire()
        intent = intent_from(request)
        if intent is None or not isinstance(request.get("rig"), dict):
            return fallback("invalid_intent")
        runtime = self.runtime()
        if runtime["state"] != "ready":
            return runtime
        variant_id, variant_idx = self._pick_variant(intent)
        rig = request["rig"]
        rig_id = self._rig_hash(rig, runtime["root"])
        cache_key = self._cache_key(intent["motion"], variant_id, intent["speed"], intent["strength"], rig, runtime["root"])
        if not request.get("noCache"):
            cached = self._cache_get(cache_key)
            if cached is not None:
                return cached
            # If caller prefers an immediately ready compatible variant (e.g., speech deadline approaching)
            if request.get("preferReady"):
                bucket = self._ready_by_motion.get((rig_id, intent["motion"]), [])
                if bucket:
                    chosen_vid, chosen_key = bucket[variant_idx % len(bucket)]
                    ready = self._cache_get(chosen_key)
                    if ready is not None:
                        ready["diagnostics"]["variantSelection"] = "ready-cached-variant"
                        ready["diagnostics"]["requestedSpeed"] = intent["speed"]
                        return ready
        payload = json.dumps({
            **intent,
            "variant": variant_id,
            "variantIndex": variant_idx,
            "rig": rig,
        }, allow_nan=False).encode("utf-8")
        if len(payload) > 32 * 1024:
            return fallback("rig_mismatch")
        if len(self.jobs) >= 2:
            return fallback("solver_busy")
        source, result = tempfile.TemporaryFile(), tempfile.TemporaryFile()
        try:
            source.write(payload)
            source.seek(0)
            child = subprocess.Popen(
                [runtime["node"], str(SOLVER), runtime["root"], "solve"], stdin=source, stdout=result,
                stderr=subprocess.DEVNULL, **OPTIONS
            )
        except OSError:
            result.close()
            return fallback("solver_unavailable")
        finally:
            source.close()
        key = token_urlsafe(18)
        self.jobs[key] = (child, result, time.monotonic() + 30, cache_key, intent["motion"], rig_id, variant_id)
        return {"state": "pending", "jobId": key}

    def drop(self, key):
        job = self.jobs.pop(key, None)
        if job is None:
            return
        child, result = job[0], job[1]
        try:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=1)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            result.close()

    def expire(self):
        for key, job in list(self.jobs.items()):
            if job[2] <= time.monotonic():
                self.drop(key)

    def poll(self, request):
        self.expire()
        key = request.get("jobId")
        job = self.jobs.get(key) if isinstance(key, str) else None
        if not job:
            return fallback("job_closed")
        child, output, _, cache_key, motion_id, rig_id, variant_id = job
        if child.poll() is None:
            return {"state": "pending", "jobId": key}
        try:
            output.seek(0)
            result = json.loads(output.read(512 * 1024))
            if result.get("state") == "ready":
                result["diagnostics"]["cached"] = False
                self._cache_put(cache_key, result, motion=motion_id, rig_id=rig_id, variant_id=variant_id, prewarmed=False)
                self.context.emit("hastsec.diagnostics", result["diagnostics"])
            return result
        except (ValueError, KeyError, AttributeError):
            return fallback("solver_unavailable")
        finally:
            self.drop(key)

    def cancel(self, request):
        key = request.get("jobId")
        if isinstance(key, str):
            self.drop(key)
        return {"state": "stopped"}

    def preview(self, request):
        intent = intent_from(request)
        if intent is None:
            return fallback("invalid_intent")
        self.context.emit("hastsec.preview", {"type": "play", "intent": intent, "issuedAt": int(time.time() * 1000)})
        return {"state": "requested"}

    def stop(self, _request):
        self.context.emit("hastsec.preview", {"type": "stop", "issuedAt": int(time.time() * 1000)})
        return {"state": "stopped"}


provider = None


def initialize(context):
    global provider
    provider = HAST(context)
    for action, handler in (
        ("catalog", provider.library), ("library", provider.library), ("settings.get", provider.settings), ("settings.save", provider.save),
        ("solve", provider.solve), ("solve.poll", provider.poll), ("solve.cancel", provider.cancel), ("prewarm", provider.prewarm),
        ("preview", provider.preview), ("preview.stop", provider.stop),
    ):
        context.register(action, handler)


def terminate(_context):
    if provider:
        for key in list(provider.jobs):
            provider.drop(key)
