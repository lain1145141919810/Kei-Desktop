"""Regression checks for reconnect presentation state."""

from bridge.scene_snapshot import AgentSceneSnapshot


def test_active_work_snapshot() -> None:
    snapshot = AgentSceneSnapshot()
    snapshot.record({"type": "agent.begin", "turn_id": "turn-a", "session_id": "voice"})
    snapshot.record(
        {
            "type": "agent.tool.start",
            "turn_id": "turn-a",
            "payload": {
                "tool_name": "deepseek_web_search",
                "activity": "searching",
                "subject": "recent information",
                "step_label": "搜索资料",
            },
        }
    )
    current = snapshot.event()
    assert current["turn_id"] == "turn-a"
    assert current["payload"]["steps"][0]["status"] == "running"
    current["payload"]["steps"][0]["subject"] = "mutated"
    assert snapshot.event()["payload"]["steps"][0]["subject"] == "recent information"

    snapshot.record(
        {
            "type": "agent.tool.end",
            "turn_id": "turn-a",
            "payload": {
                "tool_name": "deepseek_web_search",
                "status": "completed",
                "result_count": 2,
                "result_previews": [{"title": "source", "source": "example.com"}],
            },
        }
    )
    finished = snapshot.event()["payload"]["steps"][0]
    assert finished["status"] == "completed"
    assert finished["result_count"] == 2
    assert finished["result_previews"][0]["source"] == "example.com"

    snapshot.record({"type": "agent.begin", "turn_id": "turn-b"})
    snapshot.record(
        {
            "type": "agent.tool.end",
            "turn_id": "turn-a",
            "payload": {"tool_name": "deepseek_web_search"},
        }
    )
    assert snapshot.event()["turn_id"] == "turn-b"
    snapshot.record({"type": "agent.done", "turn_id": "turn-a"})
    assert snapshot.event()["turn_id"] == "turn-b"
    snapshot.record({"type": "agent.done", "turn_id": "turn-b"})
    assert snapshot.event()["turn_id"] is None
    snapshot.record({"type": "agent.begin", "turn_id": "turn-c"})
    snapshot.clear()
    assert snapshot.event()["turn_id"] is None


if __name__ == "__main__":
    test_active_work_snapshot()
    print("agent scene snapshot passed")
