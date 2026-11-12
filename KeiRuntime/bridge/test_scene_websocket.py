"""Exercise the Runtime reconnect handshake without starting audio workers."""

from __future__ import annotations

import asyncio

from fastapi import WebSocketDisconnect

import app as runtime


class FakeWebSocket:
    def __init__(self) -> None:
        self.query_params = {"client": "kei-desktop"}
        self.messages: list[dict] = []
        self.connected = asyncio.Event()
        self.first_send = asyncio.Event()
        self.release_first_send = asyncio.Event()
        self.disconnect = asyncio.Event()
        self.fail_next_send = False

    async def accept(self) -> None:
        self.connected.set()

    async def send_json(self, event: dict) -> None:
        if self.fail_next_send:
            raise ConnectionError("simulated broken socket")
        if not self.messages:
            self.first_send.set()
            await self.release_first_send.wait()
        self.messages.append(event)

    async def receive_text(self) -> str:
        await self.disconnect.wait()
        raise WebSocketDisconnect()


async def test_snapshot_precedes_live_events() -> None:
    snapshot = runtime.agent_scene_snapshot
    snapshot.clear()
    snapshot.record({"type": "agent.begin", "session_id": "voice", "turn_id": "turn-a"})
    snapshot.record(
        {
            "type": "agent.tool.start",
            "turn_id": "turn-a",
            "payload": {
                "tool_name": "search",
                "activity": "searching",
                "step_label": "Searching",
            },
        }
    )
    websocket = FakeWebSocket()
    connection = asyncio.create_task(runtime.websocket_endpoint(websocket))
    try:
        await asyncio.wait_for(websocket.first_send.wait(), 5)
        live_event = {
            "type": "agent.tool.end",
            "turn_id": "turn-a",
            "payload": {"scene_revision": snapshot.revision + 1},
        }
        broadcast = asyncio.create_task(runtime.broadcast_event(live_event))
        await asyncio.sleep(0)
        websocket.release_first_send.set()
        await asyncio.wait_for(broadcast, 5)

        assert [message["type"] for message in websocket.messages] == [
            "runtime.connected",
            "agent.scene.snapshot",
            "agent.tool.end",
        ]
        saved = websocket.messages[1]
        assert saved["turn_id"] == "turn-a"
        assert saved["payload"]["steps"][0]["status"] == "running"
        assert saved["payload"]["revision"] < live_event["payload"]["scene_revision"]
    finally:
        websocket.release_first_send.set()
        websocket.disconnect.set()
        await asyncio.wait_for(connection, 5)
        snapshot.clear()
        assert websocket not in runtime.websocket_clients
        assert websocket not in runtime.desktop_clients
        assert websocket not in runtime.websocket_send_locks


async def test_failed_send_removes_connection_state() -> None:
    websocket = FakeWebSocket()
    websocket.release_first_send.set()
    connection = asyncio.create_task(runtime.websocket_endpoint(websocket))
    try:
        await asyncio.wait_for(websocket.first_send.wait(), 5)
        while len(websocket.messages) < 2:
            await asyncio.sleep(0)
        websocket.fail_next_send = True
        await runtime.broadcast_event({"type": "agent.tool.end"})
        assert websocket not in runtime.websocket_clients
        assert websocket not in runtime.desktop_clients
        assert websocket not in runtime.websocket_send_locks
    finally:
        websocket.disconnect.set()
        await asyncio.wait_for(connection, 5)


if __name__ == "__main__":
    asyncio.run(test_snapshot_precedes_live_events())
    asyncio.run(test_failed_send_removes_connection_state())
    print("agent scene WebSocket reconnect passed")
