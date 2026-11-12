from __future__ import annotations

import httpx


class APITranslator:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        endpoint: str = "/v1/chat/completions",
    ):
        self.model = model
        self.endpoint = endpoint

        self.client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=httpx.Timeout(
                60.0,
                connect=5.0,
            ),
        )

    async def translate_zh_to_ja(
        self,
        text: str,
    ) -> str:

        text = text.strip()

        if not text:
            return ""

        response = await self.client.post(
            self.endpoint,
            json={
                "model": self.model,
                "temperature": 0.1,
                "stream": False,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "将用户输入翻译成自然、流畅、"
                            "适合日语语音合成的现代日语口语。"
                            "保持原意、情绪和人物语气。"
                            "不要解释，不要 Markdown，"
                            "不要引号，只输出最终日语。"
                            "凯伊译为ケイ，"
                            "天童凯伊译为天童ケイ。"
                        ),
                    },
                    {
                        "role": "user",
                        "content": text,
                    },
                ],
            },
        )

        response.raise_for_status()

        data = response.json()

        return (
            data["choices"][0]
            ["message"]
            ["content"]
            .strip()
        )

    async def close(self) -> None:
        await self.client.aclose()