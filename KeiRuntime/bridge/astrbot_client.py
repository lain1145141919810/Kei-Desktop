from __future__ import annotations

import json
import time

import httpx


class AstrBotClient:
    """
    Kei Runtime -> AstrBot OpenAPI

    这里只负责把用户文本送进 AstrBot。

    AstrBot 的最终回复不从这里处理，
    而是继续由 astrbot_plugin_kei
    发布 assistant.reply 回 Kei Runtime。
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        username: str = "kei-local-voice",
        session_id: str = "kei-local-voice",
    ):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.session_id = session_id

        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
            },
            timeout=httpx.Timeout(
                180.0,
                connect=5.0,
            ),
        )

    async def send_message(
        self,
        text: str,
        *,
        voice_turn_id: str = "",
        on_stream_event=None,
    ) -> None:

        text = text.strip()

        if not text:
            return

        payload = {
            "username": self.username,
            "session_id": self.session_id,
            "message": text,
            "enable_streaming": True,
        }

        started = time.perf_counter()
        first_text = False
        async with self.client.stream(
            "POST",
            "/api/v1/chat",
            json=payload,
        ) as response:

            if response.status_code >= 400:

                body = (
                    await response.aread()
                ).decode(
                    "utf-8",
                    errors="replace",
                )

                raise RuntimeError(
                    "AstrBot API failed: "
                    f"{response.status_code} "
                    f"{body}"
                )

            # 必须把 SSE 消费完。
            #
            # 但这里不处理 AstrBot 回复文本。
            # 回复仍由 astrbot_plugin_kei
            # 通过 assistant.reply 回 Runtime。
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    item = json.loads(line[5:].strip())
                except (ValueError, TypeError):
                    continue
                if not isinstance(item, dict):
                    continue
                if on_stream_event is not None:
                    on_stream_event(item)
                # Measure visible answer text separately from reasoning/tools.
                if (not first_text and item.get("type") == "plain"
                        and item.get("chain_type") not in
                        ("reasoning", "tool_call", "tool_call_result", "agent_stats")
                        and isinstance(item.get("data"), str) and item["data"].strip()):
                    first_text = True
                    elapsed = int((time.perf_counter() - started) * 1000)
                    print(f"[Kei Latency] voice_turn_id={voice_turn_id} "
                          f"stage=astrbot.first_visible_text elapsed={elapsed}ms")

    async def stop_session(self):
        response = await self.client.post("/api/v1/chat/stop", json={
            "username": self.username, "session_id": self.session_id,
        }, timeout=5.0)
        response.raise_for_status()
        if response.json().get("status") == "error":
            raise RuntimeError("AstrBot rejected stop request")

    async def close(self) -> None:
        await self.client.aclose()