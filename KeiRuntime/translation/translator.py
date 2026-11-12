from __future__ import annotations


class TranslatorRouter:
    def __init__(
        self,
        *,
        mode: str,
        local_translator=None,
        api_translator=None,
    ):
        self.mode = mode
        self.local = local_translator
        self.api = api_translator

    async def translate_zh_to_ja(
        self,
        text: str,
    ) -> str:

        if self.mode == "local":

            if self.local is None:
                raise RuntimeError(
                    "Local translator is not configured"
                )

            return await self.local.translate_zh_to_ja(
                text
            )

        if self.mode == "api":

            if self.api is None:
                raise RuntimeError(
                    "API translator is not configured"
                )

            return await self.api.translate_zh_to_ja(
                text
            )

        if self.mode == "local_api_fallback":

            if self.local is not None:

                try:
                    return await (
                        self.local
                        .translate_zh_to_ja(text)
                    )

                except Exception as exc:
                    print(
                        "[Kei Translation] "
                        "local failed, fallback to API:",
                        repr(exc),
                    )

            if self.api is None:
                raise RuntimeError(
                    "Local translation failed "
                    "and API fallback is unavailable"
                )

            return await self.api.translate_zh_to_ja(
                text
            )

        raise ValueError(
            f"Unknown translation mode: {self.mode}"
        )

    async def close(self) -> None:

        if (
            self.api is not None
            and hasattr(self.api, "close")
        ):
            await self.api.close()