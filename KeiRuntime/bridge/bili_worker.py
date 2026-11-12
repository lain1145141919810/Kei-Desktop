"""Fixed Bilibili adapter, executed with the existing biliMCP environment.

No generic MCP dispatch, shell, arbitrary URLs, uploads or private messages.
Credentials stay here and errors leave as codes only.
"""

import asyncio
import json
import re
import sys
from urllib.parse import urlparse

from bili_video import MediaDownloadError, extract_frames
from bili_diagnostics import error_detail, write_error

sys.path.insert(0, "D:/bilibili-mcp")
import aiohttp
import mcp_server as upstream
from bilibili_api import comment, dynamic, user, video


async def dispatch(request):
    action = request["action"]
    request["_stage"] = "load_credentials"
    cred = upstream.get_cred()
    request["_stage"] = "verify_identity"
    me = await user.get_self_info(credential=cred)
    uid = str(me["mid"])
    if action == "identity":
        return {"logged_in": True, "uid": uid}
    if uid != str(request["owner_uid"]):
        raise ValueError("account_changed")
    if action == "discover":
        request["_stage"] = "discover"
        data = json.loads(await upstream.bili_hot_videos(ps=12))
        return {
            "videos": [
                {k: v.get(k) for k in ("bvid", "title", "author", "duration", "tname")}
                for v in data["videos"]
            ]
        }
    request["_stage"] = "validate_target"
    bvid = request["bvid"]
    if not re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid):
        raise ValueError("invalid_bvid")
    if action in {"like", "follow", "dynamic"}:
        v = video.Video(bvid=bvid, credential=cred)
        request["_stage"] = "video_metadata"
        info = await v.get_info()
        if action == "like":
            request["_stage"] = "submit_like"
            await v.like(status=True)
            return {"success": True, "receipt": bvid}
        if action == "follow":
            author = int(info["owner"]["mid"])
            if str(author) == uid:
                raise ValueError("self_follow_denied")
            request["_stage"] = "submit_follow"
            await user.User(uid=author, credential=cred).modify_relation(
                user.RelationType.SUBSCRIBE
            )
            return {"success": True, "receipt": str(author)}
        text = request.get("text", "")
        if not isinstance(text, str) or not 10 <= len(text) <= 400:
            raise ValueError("invalid_dynamic")
        request["_stage"] = "submit_dynamic"
        result = await dynamic.send_dynamic(
            info=dynamic.BuildDynamic.empty().add_text(text), credential=cred
        )
        receipt = str(
            result.get("dyn_id_str")
            or result.get("dyn_id")
            or result.get("dynamic_id")
            or ""
        )
        return {"success": bool(receipt), "receipt": receipt}
    if action == "frames":
        v = video.Video(bvid=bvid, credential=cred)
        request["_stage"] = "video_metadata"
        info = await v.get_info()
        if len(info.get("pages", [])) != 1:
            raise ValueError("multipart_not_supported")
        return await extract_frames(v, info)
    if action == "evidence":
        v = video.Video(bvid=bvid, credential=cred)
        request["_stage"] = "video_metadata"
        info = await v.get_info()
        # Do not mistake the first part of a multi-part video for the entire work.
        if len(info.get("pages", [])) != 1 or not 30 <= info.get("duration", 0) <= 1200:
            return {"status": "unsupported_duration_or_multipart"}
        cid = info["pages"][0]["cid"]
        base = {
            "status": "ok",
            "bvid": bvid,
            "title": info.get("title", ""),
            "description": info.get("desc", "")[:1500],
            "author": info.get("owner", {}).get("name", ""),
            "evidence_type": "subtitles_only",
            "visual_observation": False,
            "duration": info["duration"],
            "transcript": "",
        }
        available = (await v.get_subtitle(cid=cid)).get("subtitles", [])
        if not available:
            return {**base, "subtitles_status": "missing"}
        sub = next(
            (s for s in available if s.get("lan") in ("zh-CN", "zh", "ai-zh")),
            available[0],
        )
        url = sub.get("subtitle_url", "")
        if url.startswith("//"):
            url = "https:" + url
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if (
            parsed.scheme != "https"
            or parsed.port not in (None, 443)
            or parsed.username
            or not (host.endswith(".hdslb.com") or host.endswith(".bilibili.com"))
        ):
            raise ValueError("subtitle_host_denied")
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20), trust_env=False
        ) as client:
            async with client.get(url, allow_redirects=False) as response:
                if response.status != 200:
                    raise ValueError("subtitle_http_error")
                raw = await response.content.read(512001)
                if len(raw) > 512000:
                    raise ValueError("subtitle_too_large")
                body = json.loads(raw)["body"]
        transcript = "\n".join(str(s.get("content", "")) for s in body)
        if not 80 <= len(transcript) <= 18000:
            return {"status": "insufficient_or_oversized_subtitles"}
        return {**base, "transcript": transcript, "subtitles_status": "available"}
    if action == "publish":
        text = request["text"]
        if not isinstance(text, str) or not 10 <= len(text) <= 400:
            raise ValueError("invalid_comment")
        request["_stage"] = "video_metadata"
        info = await video.Video(bvid=bvid, credential=cred).get_info()
        request["_stage"] = "submit_publish"
        result = await comment.send_comment(
            text=text,
            oid=info["aid"],
            type_=comment.CommentResourceType.VIDEO,
            credential=cred,
        )
        return {"success": True, "rpid": str(result.get("rpid", ""))}
    raise ValueError("action_denied")


async def main():
    request = {}
    try:
        request = json.loads(sys.stdin.buffer.readline(32000))
        result = await asyncio.wait_for(
            dispatch(request), 110 if request.get("action") == "frames" else 40
        )
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=True), flush=True)
    except Exception as exc:
        detail = error_detail(exc, request.get("action"), request.get("_stage", "parse_request"), request.get("bvid"))
        write_error(detail)
        result = {"ok": False, "error": type(exc).__name__, "diagnostic": detail}
        if isinstance(exc, MediaDownloadError):
            result["code"] = "media_download_failed"
            result["attempts"] = exc.attempts
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
