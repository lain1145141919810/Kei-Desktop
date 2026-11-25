"""Read-only Bilibili schedule and media evidence workflow."""
import json
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
MAX_EVIDENCE = 6


def clock_minutes(value):
    hour, minute = value.split(":")
    if len(hour) != 2 or len(minute) != 2 or not hour.isascii() or not minute.isascii():
        raise ValueError("Invalid clock")
    hours, minutes = int(hour), int(minute)
    if not (0 <= hours < 24 and 0 <= minutes < 60 or hours == 24 and minutes == 0):
        raise ValueError("Invalid clock")
    return hours * 60 + minutes


def window(now, start, end):
    local = now.astimezone(JST)
    current = local.hour * 60 + local.minute
    return local.date().isoformat() if start <= current < end else None


class Schedule:
    def __init__(self, path, config, query):
        self.path, self.enabled, self.query = path, config["schedule_enabled"], query
        self.start = clock_minutes(config["schedule_start"])
        self.end = clock_minutes(config["schedule_end"])
        if self.start >= self.end or not config["schedule_keyword"].strip() or len(config["schedule_keyword"]) > 180:
            raise ValueError("Invalid Bilibili schedule range or search input")
        self.keyword = config["schedule_keyword"]
        self.state = json.loads(path.read_text("utf-8")) if path.exists() else {"paused": False, "runs": {}}
        for run in self.state["runs"].values():
            if run["state"] == "pending":
                run["state"] = "unknown"
        self.save()

    def save(self):
        scratch = self.path.with_suffix(".tmp")
        scratch.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
        scratch.replace(self.path)

    def status(self, _data=None):
        return {"enabled": self.enabled, "paused": self.state["paused"], "timezone": "Asia/Tokyo",
                "runs": list(reversed(list(self.state["runs"].values())))[:20]}

    def toggle(self, paused):
        self.state["paused"] = paused
        self.save()
        return self.status()

    def tick(self, _data=None, *, now=None):
        if not self.enabled or self.state["paused"]:
            return self.status()
        day = window(now or datetime.now(JST), self.start, self.end)
        if day is None or day in self.state["runs"]:
            return self.status()
        run = {"day": day, "state": "pending"}
        latest = list(self.state["runs"].items())[-59:]
        self.state["runs"] = dict(latest) | {day: run}
        self.save()
        result = self.query({"operation": "search", "keyword": self.keyword, "count": 5,
                             "requestId": "scheduled-search-" + day})
        run["state"] = "failed" if result.get("error") or result.get("status") == "account_required" else "complete"
        self.save()
        return self.status()


def media_evidence(result):
    structured = result.get("structuredContent") or {}
    evidence = structured.get("evidence", []) if isinstance(structured, dict) else []
    if not isinstance(evidence, list):
        return []
    return [item for item in evidence[:MAX_EVIDENCE] if isinstance(item, dict) and (
        item.get("mime") in ("image/png", "image/jpeg") and
        isinstance(item.get("base64"), str) and 0 < len(item["base64"]) <= 150000
    )]
