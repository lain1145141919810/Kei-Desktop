"""Bilibili business routing through the public scoped MCP broker."""
import json
import re

from kei_sdk import MCPCallError
from compatibility import Schedule, media_evidence

VIDEO_ID = re.compile(r"BV[A-Za-z0-9]{8,14}")
TOOL = re.compile(r"[A-Za-z0-9_.-]{1,128}")
WRITE_OPERATIONS = {"comment", "dynamic", "like", "follow"}


class InvalidRequest(ValueError):
    pass


def text(value, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise InvalidRequest("入力を確認してください")
    return value.strip()


def video(data):
    value = text(data.get("bvid"), 20)
    if not VIDEO_ID.fullmatch(value):
        raise InvalidRequest("Bilibili の BV ID が必要です")
    return value


def query_args(operation, data):
    if operation == "search":
        count = data.get("count", 10)
        if type(count) is not int or not 1 <= count <= 30:
            raise InvalidRequest("検索件数は 1〜30 にしてください")
        return "bili_search", {"keyword": text(data.get("keyword"), 180), "num": count}
    if operation == "detail":
        return "bili_video_info", {"bvid": video(data)}
    if operation == "account":
        return "bili_check_credential", {}
    if operation == "login-check":
        return "bili_login_check", {}
    raise InvalidRequest("利用できない検索操作です")


def mutation_args(operation, data):
    if operation == "comment":
        return {"bvid": video(data), "text": text(data.get("text"), 800)}
    if operation == "dynamic":
        return {"text": text(data.get("text"), 1300)}
    if operation == "like":
        return {"bvid": video(data)}
    uid = data.get("uid")
    if type(uid) is not int or uid < 1 or uid > 2**53 - 1:
        raise InvalidRequest("有効な UID が必要です")
    return {"uid": uid}


def account_required(result):
    items = [result.get("structuredContent")]
    for item in result.get("content", []):
        text_value = item.get("text") if isinstance(item, dict) else None
        if isinstance(text_value, str):
            if any(phrase in text_value[:400] for phrase in ("凭证可能已过期", "凭据已过期", "登录已失效", "未登录", "请先登录")):
                return True
            try:
                items.append(json.loads(text_value))
            except (ValueError, RecursionError):
                pass
    return any(isinstance(item, dict) and (item.get("logged_in") is False or
               item.get("code") in ("auth_expired", "unauthorized", "account_required")) for item in items)


def initialize(context):
    server = context.config["server_id"]
    configured = context.config["interaction_tools"]
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,59}", server):
        raise InvalidRequest("MCP サービス ID が無効です")
    if set(configured) - WRITE_OPERATIONS or not all(isinstance(name, str) and TOOL.fullmatch(name) for name in configured.values()):
        raise InvalidRequest("Bilibili 操作のツール設定が無効です")

    def query(data):
        tool, args = query_args(data.get("operation"), data)
        receipt = context.call_mcp(server, tool, args, text(data.get("requestId"), 100))
        status = "account_required" if account_required(receipt["result"]) else "received"
        if data.get("operation") == "account":
            return {"status": status, "serverId": server}
        return {"status": status, **receipt}

    def prepare(data):
        operation = data.get("operation")
        if not isinstance(operation, str) or operation not in configured:
            raise InvalidRequest("この操作に対応する MCP ツールが設定されていません")
        return {
            "serverId": server, "pluginId": "kei.bilibili", "toolName": configured[operation],
            "arguments": mutation_args(operation, data), "requestId": text(data.get("requestId"), 100),
        }

    def interact(data):
        draft = prepare(data)
        confirmation = data.get("confirmation")
        if not isinstance(confirmation, str) or not confirmation:
            return {"error": {"code": "confirmation_required", "message": "操作を確認してください"}}
        receipt = context.call_mcp(server, draft["toolName"], draft["arguments"], draft["requestId"],
                                   confirmation=confirmation, require_confirmation=True)
        return {"status": "account_required" if account_required(receipt["result"]) else "received", **receipt}

    def preview(data):
        tool = context.config["preview_tool"]
        if not TOOL.fullmatch(tool):
            raise InvalidRequest("プレビュー用の MCP ツールが無効です")
        receipt = context.call_mcp(server, tool, {"bvid": video(data)}, text(data.get("requestId"), 100))
        result = receipt["result"]
        if result.get("isError") is True:
            return {"error": {"code": "preview_failed", "message": "動画プレビューを取得できませんでした"}}
        return {**receipt, "evidence": media_evidence(result)}

    def capabilities(_data):
        return {"serverId": server, "queries": ["search", "detail", "account", "login-check"],
                "interactions": sorted(configured)}

    def guarded(handler):
        def call(data):
            try:
                return handler(data)
            except InvalidRequest as error:
                return {"error": {"code": "invalid_bilibili_request", "message": str(error)}}
            except MCPCallError as error:
                details = error.details
                if details.get("mayHaveRun"):
                    return {"status": "outcome_unknown", "error": {"code": error.code, "details": details,
                            "message": "結果を確認できません。再送する前に Bilibili 側を確認してください。"}}
                return {"error": {"code": error.code, "message": str(error), "details": details}}
        return call

    schedule = Schedule(context.data_dir / "schedule-v1.json", context.config, guarded(query))
    for name, handler in {
        "query": query, "prepare": prepare, "interact": interact, "capabilities": capabilities, "preview": preview,
        "schedule.status": schedule.status, "schedule.tick": schedule.tick,
        "schedule.pause": lambda _data: schedule.toggle(True), "schedule.resume": lambda _data: schedule.toggle(False),
    }.items():
        context.register(name, guarded(handler))
