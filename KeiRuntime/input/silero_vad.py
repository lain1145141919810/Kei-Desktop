from __future__ import annotations

import numpy as np

from pysilero_vad import SileroVoiceActivityDetector


class SileroSpeechVAD:
    """
    Kei Runtime Silero VAD wrapper.

    Input:
        48000 Hz
        mono
        int16 PCM

    Internal:
        48 kHz -> 16 kHz
        buffer to Silero chunk size
    """

    def __init__(
        self,
        *,
        input_sample_rate: int = 48000,
        start_probability: float = 0.70,
        end_probability: float = 0.35,
        start_chunks: int = 3,
        end_chunks: int = 6,
    ):
        if input_sample_rate != 48000:
            raise ValueError(
                "SileroSpeechVAD currently expects 48000 Hz input."
            )

        self.input_sample_rate = input_sample_rate

        self.start_probability = start_probability
        self.end_probability = end_probability

        self.start_chunks = start_chunks
        self.end_chunks = end_chunks

        self.model = SileroVoiceActivityDetector()

        self.chunk_samples = self.model.chunk_samples()
        self.chunk_bytes = self.model.chunk_bytes()

        self._buffer = bytearray()

        self.is_speaking = False

        self._speech_counter = 0
        self._silence_counter = 0

        self.last_probability = 0.0

        print(
            "[Kei Silero VAD]",
            f"chunk_samples={self.chunk_samples},",
            f"chunk_bytes={self.chunk_bytes}",
        )

    @property
    def silence_duration_ms(self) -> int:
        """Consecutive low-probability audio within the current speech segment."""
        return self._silence_counter * self.chunk_samples * 1000 // 16000

    def reset(self) -> None:
        """Discard speech state after an audio input discontinuity."""
        self.model.reset()
        self._buffer.clear()
        self.is_speaking = False
        self._speech_counter = self._silence_counter = 0
        self.last_probability = 0.0

    @staticmethod
    def _downsample_48k_to_16k(
        pcm: bytes,
    ) -> bytes:
        samples = np.frombuffer(
            pcm,
            dtype=np.int16,
        )

        usable = (
            len(samples)
            - len(samples) % 3
        )

        if usable <= 0:
            return b""

        samples = (
            samples[:usable]
            .astype(np.float32)
            .reshape(-1, 3)
        )

        samples_16k = (
            samples.mean(axis=1)
        )

        samples_16k = np.clip(
            samples_16k,
            -32768,
            32767,
        ).astype(np.int16)

        return samples_16k.tobytes()

    def _process_probability(
        self,
        probability: float,
    ) -> str | None:

        self.last_probability = probability

        if not self.is_speaking:

            if probability >= self.start_probability:
                self._speech_counter += 1
            else:
                self._speech_counter = 0

            if self._speech_counter >= self.start_chunks:

                self.is_speaking = True

                self._speech_counter = 0
                self._silence_counter = 0

                print(
                    "[Kei Silero VAD] speech start:",
                    f"p={probability:.3f}",
                )

                return "start"

            return None

        if probability <= self.end_probability:
            self._silence_counter += 1
        else:
            self._silence_counter = 0

        if self._silence_counter >= self.end_chunks:

            self.is_speaking = False

            self._speech_counter = 0
            self._silence_counter = 0

            print(
                "[Kei Silero VAD] speech end:",
                f"p={probability:.3f}",
            )

            return "end"

        return None

    def process(
        self,
        pcm_48k: bytes,
    ) -> str | None:

        pcm_16k = self._downsample_48k_to_16k(
            pcm_48k
        )

        if not pcm_16k:
            return None

        self._buffer.extend(
            pcm_16k
        )

        while len(self._buffer) >= self.chunk_bytes:

            chunk = bytes(
                self._buffer[
                    :self.chunk_bytes
                ]
            )

            del self._buffer[
                :self.chunk_bytes
            ]

            probability = float(
                self.model(chunk)
            )

            event = self._process_probability(
                probability
            )

            if event is not None:
                return event

        return None
