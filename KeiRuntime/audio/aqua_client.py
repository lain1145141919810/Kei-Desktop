import wave
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import numpy as np
from audio.speech_preview import SpeechPreview


class AquaTTSClient:
    """
    Kei Runtime -> Aqua-TTS 流式客户端。

    Aqua /tts 返回：
        float32 PCM
        24000 Hz
        mono
    """

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:17880",
        voice: str = "kei",
        text_language: str = "日文",
        preset: str = "balanced",
        recorded_utterances: dict[str, Path] | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.voice = voice
        self.text_language = text_language
        self.preset = preset
        self.preview = SpeechPreview(lambda text: self.stream_pcm(text, _preview=False))
        self.recorded_pcm: dict[str, bytes] = {}
        for text, path in (recorded_utterances or {}).items():
            with wave.open(str(path), "rb") as recording:
                if (
                    recording.getframerate(),
                    recording.getnchannels(),
                    recording.getsampwidth(),
                ) != (24000, 1, 2):
                    raise ValueError(
                        f"Recorded voice must be 24 kHz mono PCM16: {path}"
                    )
                pcm = recording.readframes(recording.getnframes())
            self.recorded_pcm[text] = (
                np.frombuffer(pcm, dtype="<i2").astype("<f4") / 32768.0
            ).tobytes()

    async def stream_pcm(
        self,
        text: str,
        *,
        voice: str | None = None,
        text_language: str | None = None,
        preset: str | None = None,
        _preview: bool = True,
    ) -> AsyncIterator[bytes]:
        """
        从 Aqua /tts 流式读取原始 PCM。
        """

        if _preview and (voice or self.voice) == self.voice and (text_language or self.text_language) == self.text_language and (preset or self.preset) == self.preset:
            cached = self.preview.take(text)
            if cached is not None:
                emitted = False
                try:
                    async for chunk in cached:
                        emitted = True
                        yield chunk
                    return
                except Exception:
                    if emitted:
                        raise
                    # Failed private preparation must not prevent ordinary TTS.

        # Fixed startup recordings use the same speaker/mouth event pipeline.
        # Never contact Aqua for a registered recording, even while offline.
        recorded = (
            self.recorded_pcm.get(text) if (voice or self.voice) == self.voice else None
        )
        if recorded is not None:
            for offset in range(0, len(recorded), 8192):
                yield recorded[offset : offset + 8192]
            return

        params = {
            "text": text,
            "voice": voice or self.voice,
            "text_language": (text_language or self.text_language),
            "preset": preset or self.preset,
            # Aqua V3 true streaming:
            # CFM + BigVGAN generate audio incrementally.
            # Fewer CFM/BigVGAN boundaries improve long-form continuity.
            # With CUDA Graph enabled, measured first PCM remains ~1.4 s.
            "chunk_size_seconds": 1.5,
        }

        timeout = httpx.Timeout(
            None,
            connect=5.0,
        )

        async with httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
        ) as client:
            async with client.stream(
                "POST",
                "/tts",
                params=params,
            ) as response:
                response.raise_for_status()

                # Deliver arriving bytes immediately. SpeechController retains
                # incomplete float32 samples until the next network chunk.
                async for chunk in response.aiter_bytes():
                    if chunk:
                        yield chunk
