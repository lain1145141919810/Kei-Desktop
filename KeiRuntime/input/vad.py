from __future__ import annotations

import math
import sys
from array import array


class EnergyVAD:
    """
    Playback-aware Energy VAD

    普通状态：
        使用正常阈值检测用户讲话。

    TTS 播放状态：
        提高阈值；
        要求更长的连续高能量；
        不学习播放声音作为新的环境噪声。

    这不是 AEC。
    它只是 Stage 5C-1 的回声误触发抑制层。
    """

    def __init__(
        self,
        *,
        sample_rate: int = 48000,
        frame_ms: int = 10,

        calibration_ms: int = 2000,

        threshold_ratio: float = 4.0,
        min_threshold: float = 500.0,

        start_frames: int = 12,
        end_frames: int = 35,

        # -----------------------------
        # TTS 播放期间的额外限制
        # -----------------------------

        playback_threshold_multiplier: float = 3.0,
        playback_min_threshold: float = 2000.0,
        playback_start_frames: int = 4,
    ):
        self.sample_rate = sample_rate
        self.frame_ms = frame_ms

        self.threshold_ratio = threshold_ratio
        self.min_threshold = min_threshold

        self.start_frames = start_frames
        self.end_frames = end_frames

        self.playback_threshold_multiplier = (
            playback_threshold_multiplier
        )

        self.playback_min_threshold = (
            playback_min_threshold
        )

        self.playback_start_frames = (
            playback_start_frames
        )

        self.calibration_frames = max(
            1,
            calibration_ms // frame_ms,
        )

        self._calibration_values: list[float] = []

        self.noise_rms: float | None = None

        self.is_speaking = False

        self._speech_counter = 0
        self._silence_counter = 0

    @staticmethod
    def rms(
        pcm: bytes,
    ) -> float:
        if not pcm:
            return 0.0

        samples = array("h")
        samples.frombytes(pcm)

        if sys.byteorder != "little":
            samples.byteswap()

        if not samples:
            return 0.0

        square_sum = 0.0

        for sample in samples:
            square_sum += sample * sample

        return math.sqrt(
            square_sum / len(samples)
        )

    @property
    def calibrated(
        self,
    ) -> bool:
        return self.noise_rms is not None

    @property
    def normal_threshold(
        self,
    ) -> float:
        if self.noise_rms is None:
            return self.min_threshold

        return max(
            self.min_threshold,
            self.noise_rms
            * self.threshold_ratio,
        )

    def get_threshold(
        self,
        *,
        playback_active: bool,
    ) -> float:

        normal = self.normal_threshold

        if not playback_active:
            return normal

        return max(
            self.playback_min_threshold,
            normal
            * self.playback_threshold_multiplier,
        )

    def process(
        self,
        pcm: bytes,
        *,
        playback_active: bool = False,
    ) -> str | None:

        level = self.rms(pcm)

        # ============================================
        # Initial calibration
        # ============================================

        if not self.calibrated:
            self._calibration_values.append(
                level
            )

            if (
                len(self._calibration_values)
                >= self.calibration_frames
            ):
                values = sorted(
                    self._calibration_values
                )

                usable_count = max(
                    1,
                    int(
                        len(values)
                        * 0.8
                    ),
                )

                usable = values[
                    :usable_count
                ]

                self.noise_rms = (
                    sum(usable)
                    / len(usable)
                )

                print(
                    "[Kei VAD] calibrated:",
                    f"noise={self.noise_rms:.1f},",
                    f"threshold="
                    f"{self.normal_threshold:.1f}",
                )

            return None

        threshold = self.get_threshold(
            playback_active=playback_active
        )

        required_start_frames = (
            self.playback_start_frames
            if playback_active
            else self.start_frames
        )

        # ============================================
        # Currently silent
        # ============================================

        if not self.is_speaking:

            if level >= threshold:
                self._speech_counter += 1

            else:
                self._speech_counter = 0

                # TTS 正在播放时：
                #
                # 不让扬声器声音污染环境噪声基准。
                if not playback_active:
                    self.noise_rms = (
                        self.noise_rms
                        * 0.98
                        + level
                        * 0.02
                    )

            if (
                self._speech_counter
                >= required_start_frames
            ):
                self.is_speaking = True

                self._speech_counter = 0
                self._silence_counter = 0

                mode = (
                    "playback"
                    if playback_active
                    else "normal"
                )

                print(
                    "[Kei VAD] speech start:",
                    f"mode={mode},",
                    f"rms={level:.1f},",
                    f"threshold={threshold:.1f}",
                )

                return "start"

            return None

        # ============================================
        # Currently speaking
        # ============================================

        if level < threshold:
            self._silence_counter += 1
        else:
            self._silence_counter = 0

        if (
            self._silence_counter
            >= self.end_frames
        ):
            self.is_speaking = False

            self._speech_counter = 0
            self._silence_counter = 0

            print(
                "[Kei VAD] speech end:",
                f"rms={level:.1f}",
            )

            return "end"

        return None