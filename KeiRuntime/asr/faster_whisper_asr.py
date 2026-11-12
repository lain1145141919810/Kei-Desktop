from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel


class FasterWhisperASR:
    """
    Kei Runtime ASR provider.

    Input:
        48000 Hz
        mono
        int16 PCM

    Whisper input:
        16000 Hz
        mono
        float32 [-1, 1]
    """

    def __init__(
        self,
        *,
        model_size: str = "small",
        device: str = "cpu",
        compute_type: str = "int8",
        language: str | None = "zh",
        cpu_threads: int = 4,
        download_root: str = "models/faster-whisper",
        hotwords: str | None = None,
        hotwords_path: str | None = None,
    ):
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.cpu_threads = cpu_threads
        self.hotwords = hotwords
        if hotwords_path:
            try:
                words = json.loads(Path(hotwords_path).read_text(encoding="utf-8-sig"))
                if not isinstance(words, list) or len(words) > 64 or not all(
                    isinstance(word, str) and 0 < len(word.strip()) <= 64 for word in words
                ):
                    raise ValueError("Expected at most 64 nonempty hotwords")
                self.hotwords = " ".join(dict.fromkeys(word.strip() for word in words))
            except (OSError, ValueError) as exc:
                print(f"[Kei ASR] hotword file unavailable; using defaults: {type(exc).__name__}")

        self.download_root = str(
            Path(download_root).resolve()
        )

        self.model: WhisperModel | None = None

    def load(
        self,
    ) -> None:
        """
        Load model once.

        First run may download the model.
        """

        if self.model is not None:
            return

        print(
            "[Kei ASR] loading model:",
            self.model_size,
            self.device,
            self.compute_type,
        )

        self.model = WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type,
            cpu_threads=self.cpu_threads,
            download_root=self.download_root,
        )

        print(
            "[Kei ASR] model ready"
        )

    @staticmethod
    def _pcm_48k_to_16k(
        pcm: bytes,
    ) -> np.ndarray:
        """
        48 kHz int16 PCM
            ↓
        16 kHz float32

        48k -> 16k is exactly 3:1.
        """

        samples = np.frombuffer(
            pcm,
            dtype="<i2",
        ).astype(
            np.float32
        )

        usable = (
            len(samples)
            - len(samples) % 3
        )

        if usable <= 0:
            return np.empty(
                0,
                dtype=np.float32,
            )

        samples = samples[
            :usable
        ].reshape(
            -1,
            3,
        )

        # Simple anti-alias/downsample for speech.
        audio = samples.mean(
            axis=1
        )

        audio /= 32768.0

        return np.ascontiguousarray(
            audio,
            dtype=np.float32,
        )

    def transcribe(
        self,
        pcm: bytes,
        *,
        sample_rate: int = 48000,
    ) -> dict:
        """
        Transcribe one complete utterance.
        """

        if self.model is None:
            self.load()

        if sample_rate != 48000:
            raise ValueError(
                "Current ASR input expects "
                f"48000 Hz, got {sample_rate}"
            )

        audio = self._pcm_48k_to_16k(
            pcm
        )

        if audio.size == 0:
            return {
                "text": "",
                "language": self.language,
                "language_probability": 0.0,
            }

        segments, info = self.model.transcribe(
            audio,

            task="transcribe",

            # 第一阶段主要和凯伊说中文。
            # 后面需要中日英混合时可改 None。
            language=self.language,

            # Runtime 已经完成 VAD 和完整分段，
            # 不需要 faster-whisper 再做第二遍 VAD。
            vad_filter=False,

            beam_size=1,
            best_of=1,

            temperature=0.0,

            # 每句话独立，避免前一句污染后一句。
            condition_on_previous_text=False,

            without_timestamps=True,

            hotwords=self.hotwords,
        )

        # faster-whisper 的 segments 是 generator，
        # 真正推理会在迭代时执行。
        segment_list = list(
            segments
        )

        text = "".join(
            segment.text
            for segment in segment_list
        ).strip()

        return {
            "text": text,

            "language": info.language,

            "language_probability":
                info.language_probability,

            "segments":
                len(segment_list),
        }
