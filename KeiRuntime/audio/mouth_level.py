from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(slots=True)
class MouthFrame:
    value: float
    rms: float


class MouthLevelEstimator:
    """
    Convert float32 mono PCM into a smoothed mouth-open value.

    Pipeline:
        PCM
          ↓
        RMS
          ↓
        noise gate
          ↓
        nonlinear normalization
          ↓
        attack / release smoothing
          ↓
        value 0.0 ~ 1.0
    """

    def __init__(
        self,
        *,
        sample_rate: int = 24000,
        frame_ms: int = 30,
        noise_floor: float = 0.008,
        full_scale_rms: float = 0.10,
        gamma: float = 0.65,
        attack: float = 0.72,
        release: float = 0.28,
    ):
        self.sample_rate = int(sample_rate)
        self.frame_ms = int(frame_ms)

        self.frame_samples = max(
            1,
            int(
                self.sample_rate
                * self.frame_ms
                / 1000
            ),
        )

        self.noise_floor = float(noise_floor)
        self.full_scale_rms = float(full_scale_rms)
        self.gamma = float(gamma)
        self.attack = float(attack)
        self.release = float(release)

        self._buffer = np.empty(
            0,
            dtype=np.float32,
        )

        self._smoothed = 0.0

    def reset(self) -> None:
        self._buffer = np.empty(
            0,
            dtype=np.float32,
        )
        self._smoothed = 0.0

    def _normalize_rms(
        self,
        rms: float,
    ) -> float:
        if rms <= self.noise_floor:
            return 0.0

        denominator = (
            self.full_scale_rms
            - self.noise_floor
        )

        if denominator <= 0:
            return 0.0

        normalized = (
            rms
            - self.noise_floor
        ) / denominator

        normalized = max(
            0.0,
            min(
                1.0,
                normalized,
            ),
        )

        # Gamma < 1 makes normal speech visibly move the mouth
        # without requiring very loud audio.
        return normalized ** self.gamma

    def _smooth(
        self,
        target: float,
    ) -> float:
        alpha = (
            self.attack
            if target > self._smoothed
            else self.release
        )

        self._smoothed += (
            alpha
            * (
                target
                - self._smoothed
            )
        )

        if self._smoothed < 0.015:
            self._smoothed = 0.0

        return max(
            0.0,
            min(
                1.0,
                self._smoothed,
            ),
        )

    def feed(
        self,
        pcm: bytes | np.ndarray,
    ) -> list[MouthFrame]:
        if isinstance(
            pcm,
            bytes,
        ):
            samples = np.frombuffer(
                pcm,
                dtype=np.float32,
            )
        else:
            samples = np.asarray(
                pcm,
                dtype=np.float32,
            ).reshape(-1)

        if samples.size == 0:
            return []

        self._buffer = np.concatenate(
            (
                self._buffer,
                samples,
            )
        )

        frames: list[MouthFrame] = []

        while (
            self._buffer.size
            >= self.frame_samples
        ):
            frame = self._buffer[
                :self.frame_samples
            ]

            self._buffer = self._buffer[
                self.frame_samples:
            ]

            rms = float(
                np.sqrt(
                    np.mean(
                        frame * frame
                    )
                )
            )

            target = self._normalize_rms(
                rms
            )

            value = self._smooth(
                target
            )

            frames.append(
                MouthFrame(
                    value=value,
                    rms=rms,
                )
            )

        return frames
