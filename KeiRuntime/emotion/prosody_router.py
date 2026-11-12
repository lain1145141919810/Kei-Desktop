from __future__ import annotations

from typing import Any

from emotion.analyzer import (
    AffectAnalyzer,
    AffectObservation,
)
from emotion.api_analyzer import (
    APIProsodyAnalyzer,
)


class ProsodyAnalyzerRouter:

    def __init__(
        self,
        *,
        mode: str,
        local_analyzer: AffectAnalyzer,
        api_analyzer: APIProsodyAnalyzer | None,
    ):
        self.mode = mode
        self.local_analyzer = (
            local_analyzer
        )
        self.api_analyzer = (
            api_analyzer
        )

    async def analyze(
        self,
        text: str,
        payload: dict[str, Any] | None = None,
    ) -> AffectObservation:

        # An explicit emotion selected by AstrBot must win over API inference.
        # This is local and immediate, including when API prosody is enabled.
        if isinstance((payload or {}).get("affect"), dict):
            return self.local_analyzer.analyze(text, payload)

        if self.mode == "local":
            return self.local_analyzer.analyze(
                text,
                payload,
            )

        if self.mode == "api":

            if self.api_analyzer is None:
                raise RuntimeError(
                    "Prosody API analyzer "
                    "is not configured"
                )

            return await (
                self.api_analyzer.analyze(
                    text,
                    payload,
                )
            )

        if self.mode == "api_local_fallback":

            if self.api_analyzer is not None:

                try:
                    return await (
                        self.api_analyzer.analyze(
                            text,
                            payload,
                        )
                    )

                except Exception as exc:

                    print(
                        "[Kei Prosody] "
                        "API failed, "
                        "falling back to local:",
                        repr(exc),
                    )

            return self.local_analyzer.analyze(
                text,
                payload,
            )

        if self.mode == "local_api_fallback":

            try:
                return self.local_analyzer.analyze(
                    text,
                    payload,
                )

            except Exception as exc:

                print(
                    "[Kei Prosody] "
                    "local failed, "
                    "falling back to API:",
                    repr(exc),
                )

                if self.api_analyzer is None:
                    raise

                return await (
                    self.api_analyzer.analyze(
                        text,
                        payload,
                    )
                )

        raise ValueError(
            f"Unknown prosody mode: "
            f"{self.mode}"
        )

    async def close(self) -> None:

        if self.api_analyzer is not None:
            await self.api_analyzer.close()
