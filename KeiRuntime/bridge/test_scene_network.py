"""Check scene recovery across real HTTP and WebSocket connections."""

from __future__ import annotations

import asyncio
import json
import socket

import httpx
import uvicorn
import websockets

import app as runtime


def available_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def test_scene_network() -> None:
    port = available_port()
    config = uvicorn.Config(
        runtime.app,
        host="127.0.0.1",
        port=port,
        lifespan="off",
        log_level="error",
    )
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())
    runtime.agent_scene_snapshot.clear()
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        assert server.started, "isolated Runtime server did not start"

        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}", timeout=5, trust_env=False
        ) as client:
            for kind, payload in (
                ("agent.begin", {}),
                (
                    "agent.tool.start",
                    {
                        "tool_name": "search",
                        "activity": "searching",
                        "step_label": "Searching",
                        "subject": "Kei scene recovery",
                    },
                ),
            ):
                response = await client.post(
                    "/events",
                    json={
                        "type": kind,
                        "session_id": "scene-network-test",
                        "turn_id": "scene-network-turn",
                        "payload": payload,
                    },
                )
                response.raise_for_status()

            url = f"ws://127.0.0.1:{port}/ws?client=kei-desktop"
            async with websockets.connect(url, proxy=None) as websocket:
                welcome = json.loads(await asyncio.wait_for(websocket.recv(), 5))
                snapshot = json.loads(await asyncio.wait_for(websocket.recv(), 5))
                assert welcome["type"] == "runtime.connected"
                assert snapshot["type"] == "agent.scene.snapshot"
                assert snapshot["turn_id"] == "scene-network-turn"
                assert snapshot["payload"]["steps"][0]["status"] == "running"

                response = await client.post(
                    "/events",
                    json={
                        "type": "agent.tool.end",
                        "session_id": "scene-network-test",
                        "turn_id": "scene-network-turn",
                        "payload": {
                            "tool_name": "search",
                            "status": "completed",
                            "result_count": 2,
                        },
                    },
                )
                response.raise_for_status()
                live = json.loads(await asyncio.wait_for(websocket.recv(), 5))
                assert live["type"] == "agent.tool.end"
                assert (
                    live["payload"]["scene_revision"] > snapshot["payload"]["revision"]
                )

                response = await client.post(
                    "/events",
                    json={
                        "type": "agent.done",
                        "session_id": "scene-network-test",
                        "turn_id": "scene-network-turn",
                        "payload": {"has_reply": False},
                    },
                )
                response.raise_for_status()
                done = json.loads(await asyncio.wait_for(websocket.recv(), 5))
                assert done["type"] == "agent.done"

            async with websockets.connect(url, proxy=None) as websocket:
                await asyncio.wait_for(websocket.recv(), 5)
                idle = json.loads(await asyncio.wait_for(websocket.recv(), 5))
                assert idle["type"] == "agent.scene.snapshot"
                assert idle["turn_id"] is None
                assert idle["payload"]["steps"] == []
    finally:
        server.should_exit = True
        await asyncio.wait_for(server_task, 5)


if __name__ == "__main__":
    asyncio.run(test_scene_network())
    print("agent scene HTTP/WebSocket reconnect passed")
