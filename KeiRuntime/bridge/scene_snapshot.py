"""Retain a bounded view of the current Agent work for Desktop reconnects."""

from __future__ import annotations

import time
from copy import deepcopy
from typing import Any


class AgentSceneSnapshot:
    def __init__(self) -> None:
        self.revision = 0
        self.current: dict[str, Any] | None = None

    def record(self, event: dict[str, Any]) -> int:
        """Record one Agent lifecycle event and return its scene revision.

        Args:
            event: Normalized Runtime event.

        Returns:
            Monotonically increasing revision of the presentation state.
        """
        kind = event.get("type")
        if kind not in {
            "agent.begin",
            "agent.tool.start",
            "agent.tool.end",
            "agent.done",
        }:
            return self.revision
        self.revision += 1
        turn_id = event.get("turn_id")
        if kind == "agent.done":
            if self.current and self.current["turn_id"] == turn_id:
                self.current = None
            return self.revision
        if (
            kind != "agent.begin"
            and self.current
            and self.current["turn_id"] != turn_id
        ):
            return self.revision
        if kind == "agent.tool.end" and not self.current:
            return self.revision
        if kind == "agent.begin" or not self.current:
            self.current = {
                "turn_id": turn_id,
                "session_id": event.get("session_id") or "local",
                "steps": [],
            }
        if kind == "agent.begin":
            return self.revision

        payload = event.get("payload") or {}
        tool_name = str(payload.get("tool_name") or "")[:100]
        if kind == "agent.tool.start":
            if payload.get("activity") not in {
                "searching",
                "reading",
                "computing",
                "controlling",
            }:
                return self.revision
            step = {
                "tool_name": tool_name,
                "activity": payload["activity"],
                "status": "running",
                "started_at_ms": int(time.time() * 1000),
            }
            for key, length in (("step_label", 24), ("subject", 72)):
                if isinstance(payload.get(key), str):
                    step[key] = " ".join(payload[key].split())[:length]
            self.current["steps"].append(step)
            self.current["steps"] = self.current["steps"][-6:]
            return self.revision

        for step in reversed(self.current["steps"]):
            if step["tool_name"] != tool_name or step["status"] != "running":
                continue
            step["status"] = (
                "failed" if payload.get("status") == "failed" else "completed"
            )
            step["duration_ms"] = max(
                0, int(time.time() * 1000) - step["started_at_ms"]
            )
            count = payload.get("result_count")
            if isinstance(count, int) and count >= 0:
                step["result_count"] = count
            previews = payload.get("result_previews")
            if isinstance(previews, list):
                step["result_previews"] = [
                    {
                        key: " ".join(value.split())[:limit]
                        for key, limit in (
                            ("title", 90),
                            ("snippet", 120),
                            ("source", 60),
                        )
                        if isinstance(value := item.get(key), str)
                    }
                    for item in previews[:2]
                    if isinstance(item, dict)
                ]
            break
        return self.revision

    def clear(self) -> None:
        """Discard a cancelled turn without keeping its tools visible."""
        self.revision += 1
        self.current = None

    def event(self) -> dict[str, Any]:
        """Build a revisioned snapshot event for a newly connected Desktop.

        Returns:
            Event containing the active turn and bounded tool steps.
        """
        state = deepcopy(self.current)
        return {
            "type": "agent.scene.snapshot",
            "session_id": state["session_id"] if state else "runtime",
            "turn_id": state["turn_id"] if state else None,
            "text": None,
            "payload": {
                "revision": self.revision,
                "steps": state["steps"] if state else [],
            },
        }
