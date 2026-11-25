"""Durable Pomodoro state with sleep recovery and one-time reminder claims."""
import json
import time
from datetime import date, datetime
from uuid import uuid4

PRESETS = {"25": (25, 5, 15), "50": (50, 10, 20), "15": (15, 3, 10)}
PHASES = ("focus", "break", "long-break")
MINUTE = 60000


def today(now):
    return datetime.fromtimestamp(now / 1000).date().isoformat()


def number(value, low, high):
    return type(value) is int and low <= value <= high


class Timer:
    def __init__(self, raw=None):
        self.state = {
            "preset": "25", "phase": "focus", "status": "idle", "endsAt": 0, "remaining": 25 * MINUTE,
            "completed": 0, "day": "", "phaseId": None, "history": [], "notices": {}, "imported": False,
        }
        if raw is not None:
            self.state.update(raw)

    def duration(self):
        return PRESETS[self.state["preset"]][PHASES.index(self.state["phase"])] * MINUTE

    def remaining(self, now):
        return max(0, self.state["endsAt"] - now) if self.state["status"] == "running" else self.state["remaining"]

    def start(self, now):
        if self.state["status"] == "running":
            return
        self.new_day(now)
        self.state.update(status="running", endsAt=now + self.state["remaining"],
                          phaseId=self.state["phaseId"] or uuid4().hex)

    def pause(self, now):
        if self.state["status"] == "running":
            self.state.update(status="paused", remaining=self.remaining(now) or self.duration(), endsAt=0)

    def new_day(self, now):
        day = today(now)
        if day != self.state["day"]:
            self.state.update(day=day, completed=0)

    def advance(self, now, count, following):
        previous = self.state["phase"]
        phase_id = self.state["phaseId"]
        if previous == "focus" and count:
            self.new_day(now)
            self.state["completed"] += 1
        long_break = count and self.state["completed"] % 4 == 0
        self.state["phase"] = ("long-break" if long_break else "break") if previous == "focus" else "focus"
        self.state.update(status="idle", endsAt=0, phaseId=None, remaining=self.duration())
        if following:
            self.start(now)
        return previous, phase_id

    def tick(self, now):
        state = self.state
        if state["status"] != "running" or now < state["endsAt"]:
            return None
        due = state["endsAt"]
        stale = now - due > MINUTE
        phase, ident = self.advance(now, True, not stale)
        entry = {"id": ident, "phase": phase, "completedAt": due, "recovered": stale}
        state["history"] = (state["history"] + [entry])[-500:]
        if not stale:
            pending = {key: row for key, row in state["notices"].items() if row["expiresAt"] > now}
            pending[ident] = {"id": ident, "phase": phase, "claimed": False, "expiresAt": now + MINUTE}
            state["notices"] = pending
            return ident
        return None

    def reset(self):
        self.state.update(status="idle", phase="focus", phaseId=None, endsAt=0)
        self.state["remaining"] = self.duration()

    def import_legacy(self, raw):
        if self.state["imported"] or self.state["status"] != "idle" or self.state["history"]:
            return False
        if not isinstance(raw, dict) or raw.get("preset") not in PRESETS or raw.get("phase") not in PHASES:
            raise ValueError("保存されたタイマーの形式が無効です")
        completed = raw.get("completed", 0)
        if not number(completed, 0, 100000):
            raise ValueError("保存された完了回数が無効です")
        day = raw.get("day", "")
        day = date.fromisoformat("-".join(f"{int(field):02d}" if index else f"{int(field):04d}"
                                        for index, field in enumerate(day.split("-")))).isoformat() if day else ""
        self.state.update(preset=raw["preset"], phase=raw["phase"], day=day, completed=completed, imported=True)
        remaining = raw.get("remaining")
        self.state["remaining"] = remaining if number(remaining, 1, self.duration()) else self.duration()
        if raw.get("running") is True and number(raw.get("endsAt"), 1, 9999999999999):
            self.state.update(status="running", endsAt=raw["endsAt"], phaseId=uuid4().hex)
        return True


def initialize(context):
    path = context.data_dir / "timer-v1.json"
    timer = Timer(json.loads(path.read_text("utf-8")) if path.exists() else None)

    def persist():
        scratch = path.with_suffix(".tmp")
        scratch.write_text(json.dumps(timer.state), encoding="utf-8")
        scratch.replace(path)

    def dispatch(action, request):
        now = int(time.time() * 1000)
        before = json.dumps(timer.state)
        try:
            claimed = None
            notice = timer.tick(now)
            if action in ("start", "resume"):
                timer.start(now)
            elif action == "pause":
                timer.pause(now)
            elif action == "skip":
                timer.advance(now, False, timer.state["status"] == "running")
            elif action == "cancel":
                timer.reset()
            elif action == "preset":
                choice = request.get("preset")
                if not isinstance(choice, str) or choice not in PRESETS:
                    raise ValueError("表示されたプリセットを選択してください")
                if choice != timer.state["preset"]:
                    timer.state["preset"] = choice
                    timer.reset()
            elif action == "legacy.import":
                timer.import_legacy(request.get("state"))
                notice = timer.tick(now) or notice
            elif action == "claim":
                ident = request.get("id")
                row = timer.state["notices"].get(ident) if isinstance(ident, str) else None
                if row and not row["claimed"] and row["expiresAt"] > now:
                    row["claimed"] = True
                    claimed = {"id": ident, "phase": row["phase"]}
            if json.dumps(timer.state) != before:
                persist()
            if notice:
                context.emit("focus.completed", {"noticeId": notice})
            waiting = [row for row in timer.state["notices"].values() if not row["claimed"] and row["expiresAt"] > now]
            data = {key: timer.state[key] for key in ("preset", "phase", "status", "endsAt", "completed", "day", "history")}
            return {**data, "remaining": timer.remaining(now), "notices": waiting, "claimed": claimed}
        except (ValueError, TypeError, OSError) as error:
            timer.state = json.loads(before)
            code = "timer_storage_error" if isinstance(error, OSError) else "invalid_timer_request"
            return {"error": {"code": code, "message": "集中タイマーの状態を更新できませんでした"}}

    for action in ("status", "tick", "start", "pause", "resume", "cancel", "skip", "preset", "claim", "legacy.import"):
        context.register(action, lambda request, action=action: dispatch(action, request))
