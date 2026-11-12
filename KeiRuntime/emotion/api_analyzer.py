from __future__ import annotations

import json
from typing import Any

import httpx

from emotion.affect import AffectVector
from emotion.analyzer import AffectObservation


SYSTEM_PROMPT = """
You analyze ONLY the speaking prosody of the assistant's current reply.

Do not infer or maintain long-term mood.
Do not rewrite or translate the text.
Do not judge personality.

Return exactly one JSON object.

Dimensions:

valence:
-1.0 negative to +1.0 positive

arousal:
0.0 calm to 1.0 highly activated

dominance:
-1.0 hesitant/submissive to +1.0 assertive/commanding

intensity:
0.0 weak emotional expression to 1.0 strong expression

warmth:
0.0 cold/distant to 1.0 warm/affectionate

certainty:
0.0 uncertain/hesitant to 1.0 confident/certain

restraint:
0.0 expressive/unrestrained to 1.0 controlled/restrained

Be conservative.
Ordinary conversational speech should stay near moderate values.
Do not exaggerate emotion merely because punctuation exists.

Return:

{
  "valence": 0.0,
  "arousal": 0.25,
  "dominance": 0.0,
  "intensity": 0.25,
  "warmth": 0.55,
  "certainty": 0.55,
  "restraint": 0.70,
  "confidence": 0.0
}
""".strip()


class APIProsodyAnalyzer:

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        endpoint: str = "/v1/chat/completions",
        timeout: float = 15.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.endpoint = endpoint
        self.timeout = timeout

        self.client = httpx.AsyncClient(
            timeout=timeout
        )

    async def close(self) -> None:
        await self.client.aclose()

    def _extract_json(
        self,
        content: str,
    ) -> dict[str, Any]:

        content = content.strip()

        if content.startswith("```"):
            content = content.replace(
                "```json",
                "",
                1,
            ).replace(
                "```",
                "",
            ).strip()

        start = content.find("{")
        end = content.rfind("}")

        if start < 0 or end < start:
            raise ValueError(
                "Prosody API returned no JSON object"
            )

        return json.loads(
            content[start:end + 1]
        )

    async def analyze(
        self,
        text: str,
        payload: dict[str, Any] | None = None,
    ) -> AffectObservation:

        payload = payload or {}

        # 只允许“当前轮即时上下文”，不保存。
        immediate_context = (
            payload.get("user_text")
            or payload.get("input_text")
            or payload.get("prompt")
            or ""
        )

        user_content = {
            "assistant_reply": text,
        }

        if immediate_context:
            user_content["immediate_user_context"] = (
                immediate_context
            )

        response = await self.client.post(
            self.base_url + self.endpoint,
            headers={
                "Authorization":
                    f"Bearer {self.api_key}",

                "Content-Type":
                    "application/json",
            },
            json={
                "model":
                    self.model,

                "temperature":
                    0.0,

                "messages": [
                    {
                        "role": "system",
                        "content":
                            SYSTEM_PROMPT,
                    },
                    {
                        "role": "user",
                        "content":
                            json.dumps(
                                user_content,
                                ensure_ascii=False,
                            ),
                    },
                ],
            },
        )

        response.raise_for_status()

        data = response.json()

        content = (
            data["choices"][0]
            ["message"]["content"]
        )

        result = self._extract_json(
            content
        )

        affect = AffectVector.from_mapping(
            result
        )

        # 如果你的 AffectVector.clamp()
        # 返回新对象，就改成 affect = affect.clamp()
        affect.clamp()

        confidence = float(
            result.get(
                "confidence",
                0.75,
            )
        )

        confidence = max(
            0.0,
            min(
                1.0,
                confidence,
            ),
        )

        return AffectObservation(
            affect=affect,
            confidence=confidence,
            source="api",
        )