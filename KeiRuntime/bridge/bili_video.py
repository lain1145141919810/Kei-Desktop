"""Bounded public CDN download and CPU frame sampling. No model-controlled URLs."""

import asyncio
import base64
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import aiohttp

ROOT = Path("D:/KeiRuntime/data/bilibili-media")
LIMIT = 60 * 1024 * 1024


class MediaDownloadError(ValueError):
    def __init__(self, attempts):
        super().__init__("media_download_failed")
        self.attempts = attempts


async def download_media(candidates, source):
    allowed = []
    for candidate in candidates:
        try:
            url = checked_url(candidate)
        except (ValueError, TypeError):
            continue
        if url not in allowed:
            allowed.append(url)
    if not allowed:
        raise ValueError("media_host_denied")
    # This host repeatedly stalled on the current network; retain it as fallback.
    allowed.sort(
        key=lambda url: urlparse(url).hostname == "upos-hz-mirrorakam.akamaized.net"
    )
    attempts = []
    deadline = time.monotonic() + 45
    async with aiohttp.ClientSession(trust_env=False) as client:
        for url in allowed[:3]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            entry = {
                "host": urlparse(url).hostname,
                "stage": "media_download",
                "bytes": 0,
                "status": None,
            }
            try:
                async with asyncio.timeout(min(35, remaining)):
                    async with client.get(
                        url,
                        headers={
                            "Referer": "https://www.bilibili.com/",
                            "User-Agent": "Mozilla/5.0",
                        },
                        allow_redirects=False,
                    ) as response:
                        entry["status"] = response.status
                        if response.status != 200:
                            raise aiohttp.ClientPayloadError("media_http_error")
                        expected = int(response.headers.get("Content-Length", "0"))
                        if expected > LIMIT:
                            raise ValueError("media_too_large")
                        # Each attempt replaces any partial download.
                        with source.open("wb") as output:
                            async for chunk in response.content.iter_chunked(65536):
                                entry["bytes"] += len(chunk)
                                if entry["bytes"] > LIMIT:
                                    raise ValueError("media_too_large")
                                output.write(chunk)
                        if not entry["bytes"] or (
                            expected and expected != entry["bytes"]
                        ):
                            raise aiohttp.ClientPayloadError("media_incomplete")
                return
            except (aiohttp.ClientError, TimeoutError) as exc:
                entry["error"] = type(exc).__name__
                attempts.append(entry)
                source.unlink(missing_ok=True)
    raise MediaDownloadError(attempts)


def checked_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or parsed.port not in (None, 443)
        or parsed.username
        or not (
            host == "upos-hz-mirrorakam.akamaized.net"
            or any(
                host.endswith("." + d)
                for d in ("bilivideo.com", "bilivideo.cn", "hdslb.com", "bilibili.com")
            )
        )
    ):
        raise ValueError("media_host_denied")
    return url


def frame_times(duration):
    if not 30 <= duration <= 1200:
        raise ValueError("duration_out_of_range")
    return [round(duration * (i + 0.5) / 6, 2) for i in range(6)]


async def extract_frames(v, info):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise ValueError("ffmpeg_missing")
    urls = await v.get_download_url(page_index=0)
    streams = [
        s
        for s in urls.get("dash", {}).get("video", [])
        if str(s.get("codecs", "")).startswith("avc")
    ]
    if not streams:
        raise ValueError("avc_stream_unavailable")
    stream = min(streams, key=lambda s: s.get("bandwidth", 10**12))
    # Only accept verified CDN candidates returned by the authenticated video API.
    candidates = [stream.get("baseUrl") or stream.get("base_url") or ""]
    candidates.extend(stream.get("backupUrl") or stream.get("backup_url") or [])
    ROOT.mkdir(parents=True, exist_ok=True)
    # Only clean our own expired temporary directories, with path checks.
    for old in ROOT.glob("kei-video-*"):
        if (
            old.is_dir()
            and old.resolve().parent == ROOT.resolve()
            and time.time() - old.stat().st_mtime > 3600
        ):
            shutil.rmtree(old)
    occupied = sum(f.stat().st_size for f in ROOT.rglob("*") if f.is_file())
    if occupied > 120 * 1024 * 1024:
        raise ValueError("media_cache_budget_exceeded")
    with tempfile.TemporaryDirectory(prefix="kei-video-", dir=ROOT) as temporary:
        root = Path(temporary)
        source = root / "video.mp4"
        await download_media(candidates, source)
        frames = []
        for index, second in enumerate(frame_times(info["duration"])):
            target = root / f"{index}.jpg"
            proc = await asyncio.create_subprocess_exec(
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-threads",
                "1",
                "-ss",
                str(second),
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-vf",
                "scale=640:360:force_original_aspect_ratio=decrease",
                "-q:v",
                "5",
                "-threads",
                "1",
                "-y",
                str(target),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            try:
                await asyncio.wait_for(proc.wait(), 10)
            finally:
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
            if (
                proc.returncode
                or not target.exists()
                or not 100 < target.stat().st_size < 250000
            ):
                raise ValueError("frame_extraction_failed")
            frames.append(
                {
                    "seconds": second,
                    "image": "data:image/jpeg;base64,"
                    + base64.b64encode(target.read_bytes()).decode("ascii"),
                }
            )
        return {
            "status": "ok",
            "frames": frames,
            "sampling": "six_evenly_spaced_frames",
            "duration": info["duration"],
        }
