from __future__ import annotations

import asyncio

import numpy as np
from pywebrtc_audio import AudioProcessor


class EchoCancellationProcessor:
    """
    WebRTC AEC3 wrapper.

    Processing format:
        48000 Hz
        mono
        int16
        10 ms
        480 samples
        960 bytes
    """

    def __init__(
        self,
        *,
        sample_rate: int = 48000,
        stream_delay_ms: int = 0,
    ):
        self.sample_rate = sample_rate

        self.frame_samples = (
            sample_rate // 100
        )

        self.frame_bytes = (
            self.frame_samples * 2
        )

        self.processor = AudioProcessor(
            sample_rate=sample_rate,
            num_channels=1,
            echo_cancellation=True,
            noise_suppression=True,
            auto_gain_control=False,
            stream_delay_ms=stream_delay_ms,
        )

        # 保存 Speaker reference。
        #
        # 每个元素：
        # 10 ms / 48 kHz / mono / int16
        self._far_queue: asyncio.Queue[bytes] = (
            asyncio.Queue(
                maxsize=200
            )
        )

    def clear_far(
        self,
    ) -> None:
        """
        清除还没有被 AEC 消费的播放参考。

        interrupt 时使用。
        """

        while True:
            try:
                self._far_queue.get_nowait()
                self._far_queue.task_done()

            except asyncio.QueueEmpty:
                break

    def reset(
        self,
    ) -> None:
        """
        完整重置 AEC。

        平时不要频繁调用。
        """

        self.clear_far()
        self.processor.reset()

    def _zero_far(
        self,
    ) -> bytes:
        return bytes(
            self.frame_bytes
        )

    async def push_far(
        self,
        pcm: bytes,
    ) -> None:
        """
        Speaker -> AEC far reference。

        pcm 必须为：
            10 ms
            48 kHz
            mono
            int16
        """

        if len(pcm) != self.frame_bytes:
            raise ValueError(
                "AEC far frame must be "
                f"{self.frame_bytes} bytes, "
                f"got {len(pcm)}"
            )

        if self._far_queue.full():
            try:
                self._far_queue.get_nowait()
                self._far_queue.task_done()
            except asyncio.QueueEmpty:
                pass

        try:
            self._far_queue.put_nowait(
                pcm
            )

        except asyncio.QueueFull:
            pass

    def _get_far_nowait(
        self,
    ) -> bytes:
        try:
            frame = (
                self._far_queue
                .get_nowait()
            )

            self._far_queue.task_done()

            return frame

        except asyncio.QueueEmpty:
            # 当前没有扬声器输出时，
            # far reference 就是静音。
            return self._zero_far()

    def process(
        self,
        near_pcm: bytes,
    ) -> bytes:
        """
        Mic near + Speaker far
            ↓
        WebRTC AEC3
            ↓
        clean microphone
        """

        if len(near_pcm) != self.frame_bytes:
            raise ValueError(
                "AEC near frame must be "
                f"{self.frame_bytes} bytes, "
                f"got {len(near_pcm)}"
            )

        far_pcm = (
            self._get_far_nowait()
        )

        near = np.frombuffer(
            near_pcm,
            dtype=np.int16,
        ).copy()

        far = np.frombuffer(
            far_pcm,
            dtype=np.int16,
        ).copy()

        clean = self.processor.process(
            near,
            far,
        )

        return np.asarray(
            clean,
            dtype=np.int16,
        ).tobytes()