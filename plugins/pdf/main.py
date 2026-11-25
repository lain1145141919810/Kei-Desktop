"""Reading plans and explicit selection questions."""
import copy
import hashlib
import json
import time
from datetime import date, timedelta
from math import ceil
from uuid import uuid4

from kei_sdk import ChatAskError


class InvalidReading(ValueError):
    pass


def clean(value, limit, *, required=True):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise InvalidReading("読書データの文字列が無効です")
    return value.strip()


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise InvalidReading("ページ数または範囲が無効です")
    return value


def stamp():
    return int(time.time() * 1000)


def plan_view(plan):
    today = date.today()
    finished, total, pace = plan["currentPage"], plan["totalPages"], plan["pagesPerDay"]
    read_today = sum(item["to"] - item["from"] for item in plan["log"] if item["day"] == today.isoformat())
    target = min(total, finished - read_today + pace)
    remaining = total - finished
    date_due = today + timedelta(days=ceil(max(0, total - max(target, finished)) / pace))
    return {**plan, "schedule": {
        "remaining": remaining, "readToday": read_today, "percent": int(finished * 100 / total + .5),
        "done": remaining == 0, "todayFrom": min(total, finished + 1), "todayTo": target,
        "todayDone": finished >= target, "finishDay": date_due.isoformat() if remaining else None,
    }}


def normalize_plan(raw):
    if not isinstance(raw, dict):
        raise InvalidReading("旧読書プランが無効です")
    overall = integer(raw.get("totalPages"), 1, 20000)
    current = integer(raw.get("currentPage", 0), 0, overall)
    created = integer(raw.get("created", stamp()), 0, 9999999999999)
    log, notes = raw.get("log", []), raw.get("notes", [])
    if not isinstance(log, list) or not isinstance(notes, list):
        raise InvalidReading("旧読書ログまたはメモが無効です")
    clean_logs, clean_notes = [], []
    for item in log[-400:]:
        try:
            day = date.fromisoformat(item["day"]).isoformat()
            lower = integer(item["from"], 0, overall)
            upper = integer(item["to"], lower, overall)
        except (KeyError, TypeError, ValueError) as error:
            raise InvalidReading("旧読書ログが無効です") from error
        clean_logs.append({"day": day, "from": lower, "to": upper})
    for item in notes[-200:]:
        if not isinstance(item, dict):
            raise InvalidReading("旧読書メモが無効です")
        page = item.get("page")
        clean_notes.append({
            "ts": integer(item.get("ts", created), 0, 9999999999999),
            "page": integer(page, 0, overall) if page is not None else None,
            "question": clean(item.get("question", ""), 300, required=False),
            "excerpt": clean(item.get("excerpt", ""), 240, required=False),
        })
    return {
        "id": clean(raw.get("id"), 128), "title": clean(raw.get("title"), 120), "totalPages": overall,
        "pagesPerDay": integer(raw.get("pagesPerDay"), 1, overall), "currentPage": current,
        "created": created, "updated": integer(raw.get("updated", created), 0, 9999999999999),
        "log": clean_logs, "notes": clean_notes,
    }


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def initialize(context):
    path = context.data_dir / "reading-v1.json"
    state = json.loads(path.read_text("utf-8")) if path.exists() else {"plans": {}, "imports": {}}
    state.setdefault("notedTurns", {})

    def save():
        scratch = path.with_suffix(".tmp")
        scratch.write_text(json.dumps(state, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        scratch.replace(path)

    def item(data):
        ident = clean(data.get("id"), 128)
        if ident not in state["plans"]:
            raise InvalidReading("読書プランが見つかりません")
        return state["plans"][ident]

    def plan_list(_data):
        records = sorted(state["plans"].values(), key=lambda row: row["updated"], reverse=True)
        return [
            {key: value for key, value in plan_view(row).items() if key not in ("log", "notes")}
            | {"noteCount": len(row["notes"])} for row in records[:200]
        ]

    def create(data):
        now = stamp()
        candidate = normalize_plan({**data, "id": uuid4().hex, "created": now, "updated": now,
                                    "currentPage": 0, "log": [], "notes": []})
        state["plans"][candidate["id"]] = candidate
        save()
        return plan_view(candidate)

    def progress(data):
        plan = item(data)
        new = integer(data.get("page"), 0, plan["totalPages"])
        old = plan["currentPage"]
        if old < new:
            plan["log"].append({"day": date.today().isoformat(), "from": old, "to": new})
        else:
            plan["log"] = [{**row, "to": min(row["to"], new)} for row in plan["log"] if row["from"] < new]
        plan["log"] = plan["log"][-400:]
        plan.update(currentPage=new, updated=stamp())
        save()
        return plan_view(plan)

    def note(data):
        rows = item(data)
        page = data.get("page")
        if page is not None:
            integer(page, 1, rows["totalPages"])
        record = {"ts": stamp(), "page": page, "question": clean(data.get("question", ""), 300, required=False),
                  "excerpt": clean(data.get("excerpt", ""), 240, required=False)}
        rows["notes"] = (rows["notes"] + [record])[-200:]
        rows["updated"] = stamp()
        save()
        return plan_view(rows)

    def remove(data):
        ident = item(data)["id"]
        del state["plans"][ident]
        state["notedTurns"].pop(ident, None)
        save()
        return {"deleted": ident}

    def migrate(data):
        raw = data.get("plans")
        if not isinstance(raw, list) or len(raw) > 200:
            raise InvalidReading("旧読書プランの形式が無効です")
        plans = [normalize_plan(row) for row in raw]
        if len({row["id"] for row in plans}) != len(plans):
            raise InvalidReading("旧読書プランの ID が重複しています")
        ident = digest(raw)
        if ident in state["imports"]:
            return {"migrationId": ident, "added": 0, "duplicate": True}
        added = {}
        for row in plans:
            if row["id"] not in state["plans"]:
                added[row["id"]] = digest(row)
                state["plans"][row["id"]] = row
        state["imports"][ident] = added
        save()
        return {"migrationId": ident, "added": len(added), "duplicate": False}

    def rollback(data):
        ident = clean(data.get("migrationId"), 64)
        if ident not in state["imports"]:
            return {"removed": 0, "preserved": 0}
        added = state["imports"].pop(ident)
        removed = 0
        for key, hash_value in added.items():
            if key in state["plans"] and digest(state["plans"][key]) == hash_value:
                del state["plans"][key]
                removed += 1
        save()
        return {"removed": removed, "preserved": len(added) - removed}

    def ask(data):
        question = clean(data.get("question"), 4000)
        selection = data.get("selection")
        if not isinstance(selection, dict):
            raise InvalidReading("先に文章を選択してください")
        plan_id = data.get("planId")
        plan = item({"id": plan_id}) if plan_id is not None else None
        page = selection.get("page")
        if plan is not None and page is not None:
            integer(page, 1, plan["totalPages"])
        selection = {**selection, "text": clean(selection.get("text"), 12000)}
        turn = context.ask_chat(data.get("requestId"), question, selection=selection, turn_id=data.get("turnId"))
        if plan is not None and turn["turnId"] not in state["notedTurns"].get(plan_id, []):
            state["notedTurns"].setdefault(plan_id, []).append(turn["turnId"])
            plan["notes"].append({"ts": stamp(), "page": selection.get("page"), "question": question[:300],
                                  "excerpt": selection["text"][:240], "turnId": turn["turnId"]})
            plan["notes"] = plan["notes"][-200:]
            plan["updated"] = stamp()
            save()
        return turn

    def guarded(handler, writes):
        def call(data):
            before = copy.deepcopy(state) if writes else None
            try:
                return handler(data)
            except InvalidReading as error:
                return {"error": {"code": "invalid_reading_request", "message": str(error)}}
            except ChatAskError as error:
                return {"error": {"code": error.code, "message": str(error)}}
            except OSError:
                if before is not None:
                    state.clear()
                    state.update(before)
                return {"error": {"code": "reading_storage_error", "message": "読書データを保存できませんでした"}}
        return call

    for name, handler in {
        "plans.list": plan_list, "plans.get": lambda data: plan_view(item(data)), "plans.create": create,
        "plans.progress": progress, "plans.note": note, "plans.remove": remove,
        "legacy.import": migrate, "legacy.rollback": rollback, "selection.ask": ask,
    }.items():
        context.register(name, guarded(handler, name not in {"plans.list", "plans.get"}))
