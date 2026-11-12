from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import numpy as np
import sounddevice as sd

from .mouth_level import MouthLevelEstimator


FarSink = Callable[
    [bytes],
    Awaitable[None],
]

FarClear = Callable[
    [],
    None,
]

MouthSink = Callable[
    [float, float],
    Awaitable[None],
]

PlaybackStartSink = Callable[
    [],
    Awaitable[None],
]


class AudioPlayer:
    """
    Kei Runtime PCM player.

    Aqua input:
        24000 Hz
        mono
        float32

    Speaker:
        24000 Hz
        mono
        float32

    AEC far reference:
        48000 Hz
        mono
        int16
        10 ms
    """

    def __init__(
        self,
        sample_rate: int = 24000,
        channels: int = 1,
        device: int | None = None,
        *,
        far_sink: FarSink | None = None,
        far_clear: FarClear | None = None,
        mouth_sink: MouthSink | None = None,
        playback_start_sink:
            PlaybackStartSink | None = None,
    ):
        self.sample_rate = sample_rate
        self.channels = channels
        self.device = device

        self.far_sink = far_sink
        self.far_clear = far_clear
        self.mouth_sink = mouth_sink
        self.playback_start_sink = (
            playback_start_sink
        )

        # True only after the first real speaker frame
        # of the CURRENT utterance is about to be written.
        self._utterance_playback_started = False

        # 30 ms analysis frame ≈ 33 mouth updates / second.
        # This is close to a typical avatar render update rate
        # while avoiding a 100 Hz WebSocket event flood.
        self._mouth_estimator = MouthLevelEstimator(
            sample_rate=self.sample_rate,
            frame_ms=30,
        )

        self._stream = None

        self._stream_lock = (
            asyncio.Lock()
        )

        # Aqua float32:
        #
        # 24kHz × 10ms
        # = 240 samples
        #
        # float32:
        # 240 × 4 = 960 bytes
        self._frame_samples = (
            self.sample_rate // 100
        )

        self._frame_bytes = (
            self._frame_samples
            * 4
            * self.channels
        )

        self._pending = bytearray()


    def set_mouth_sink(
        self,
        sink: MouthSink | None,
    ) -> None:
        """
        Install / replace the realtime mouth-level callback.
        """
        self.mouth_sink = sink

    def set_playback_start_sink(
        self,
        sink: PlaybackStartSink | None,
    ) -> None:
        """
        Install / replace the callback fired immediately before
        the first speaker frame of each utterance.
        """
        self.playback_start_sink = sink

    def reset_mouth(
        self,
    ) -> None:
        """
        Clear per-utterance mouth/playback state.
        """
        self._mouth_estimator.reset()
        self._utterance_playback_started = False

    async def _notify_playback_start(
        self,
    ) -> None:
        if self._utterance_playback_started:
            return

        self._utterance_playback_started = True

        if self.playback_start_sink is None:
            return

        await self.playback_start_sink()

    async def _process_mouth(
        self,
        pcm_float32: bytes,
    ) -> None:
        """
        Analyze played PCM and emit smoothed mouth values.

        Callback failures must never interrupt audio playback.
        """
        if self.mouth_sink is None:
            return

        frames = self._mouth_estimator.feed(
            pcm_float32
        )

        for mouth_frame in frames:
            try:
                await self.mouth_sink(
                    mouth_frame.value,
                    mouth_frame.rms,
                )
            except Exception as exc:
                print(
                    "[Kei Audio] mouth sink failed:",
                    repr(exc),
                )

    async def start(
        self,
    ) -> None:
        """
        Ensure the low-latency output stream is open and active.

        Normal utterance completion keeps this stream alive.
        Barge-in abort still destroys it so queued audio is discarded.
        """

        async with self._stream_lock:

            stream = self._stream

            if stream is None:
                stream = sd.RawOutputStream(
                    samplerate=self.sample_rate,
                    channels=self.channels,
                    dtype="float32",
                    device=self.device,
                    latency="low",
                )

                self._stream = stream

            if not stream.active:
                await asyncio.to_thread(
                    stream.start
                )

    @staticmethod
    def _upsample_24k_to_48k(
        samples: np.ndarray,
    ) -> np.ndarray:
        """
        Exact 2x linear interpolation.

        240 samples
            ↓
        480 samples
        """

        if samples.size == 0:
            return np.empty(
                0,
                dtype=np.float32,
            )

        result = np.empty(
            samples.size * 2,
            dtype=np.float32,
        )

        # 原始 sample。
        result[0::2] = samples

        if samples.size == 1:
            result[1] = samples[0]

            return result

        # 两个 sample 中间插值。
        result[1:-1:2] = (
            samples[:-1]
            + samples[1:]
        ) * 0.5

        result[-1] = samples[-1]

        return result

    def _make_far_reference(
        self,
        pcm_float32: bytes,
    ) -> bytes:
        """
        Aqua:
            24k float32

        ↓

        AEC:
            48k int16
        """

        samples = np.frombuffer(
            pcm_float32,
            dtype=np.float32,
        )

        samples_48k = (
            self._upsample_24k_to_48k(
                samples
            )
        )

        samples_48k = np.clip(
            samples_48k,
            -1.0,
            1.0,
        )

        pcm_int16 = (
            samples_48k
            * 32767.0
        ).astype(
            np.int16
        )

        return pcm_int16.tobytes()

    async def _play_frame(
        self,
        frame: bytes,
    ) -> None:
        """
        播放一个 10ms Aqua frame，
        同时给 AEC 一份 reference。
        """

        await self.start()

        # --------------------------------------------
        # AEC far reference
        # --------------------------------------------

        if self.far_sink is not None:

            far = (
                self._make_far_reference(
                    frame
                )
            )

            await self.far_sink(
                far
            )

        # --------------------------------------------
        # Speaker
        # --------------------------------------------

        stream = self._stream

        if stream is None:
            return

        # This is the synchronization point used by Desktop:
        # stream is already active, and the first real PCM frame
        # is about to be submitted to PortAudio.
        await self._notify_playback_start()

        await asyncio.to_thread(
            stream.write,
            frame,
        )

        # Analyze the same PCM that has just been handed to the
        # speaker.  The estimator internally aggregates 30 ms.
        await self._process_mouth(
            frame
        )

    async def write(
        self,
        pcm: bytes,
    ) -> None:

        if not pcm:
            return

        self._pending.extend(
            pcm
        )

        # Aqua HTTP chunk 边界不固定，
        # 所以自己切成 10ms。
        while (
            len(self._pending)
            >= self._frame_bytes
        ):

            frame = bytes(
                self._pending[
                    :self._frame_bytes
                ]
            )

            del self._pending[
                :self._frame_bytes
            ]

            await self._play_frame(
                frame
            )

    async def stop(
        self,
    ) -> None:
        """
        Finish the current utterance WITHOUT closing PortAudio.

        Keeping the output stream alive removes repeated device-open
        latency between normal replies.
        """

        # 最后可能不足 10 ms。
        if self._pending:

            remainder = bytes(
                self._pending
            )

            self._pending.clear()

            await self.start()

            # AEC reference 需要完整 10ms，
            # 所以 reference 用 0 padding。
            if self.far_sink is not None:

                padded = (
                    remainder
                    + bytes(
                        self._frame_bytes
                        - len(remainder)
                    )
                )

                far = (
                    self._make_far_reference(
                        padded
                    )
                )

                await self.far_sink(
                    far
                )

            stream = self._stream

            if stream is not None:

                await self._notify_playback_start()

                await asyncio.to_thread(
                    stream.write,
                    remainder,
                )

                await self._process_mouth(
                    remainder
                )

        # Intentionally do not stop/close the stream here.
        # It stays warm for the next utterance.

    async def close(
        self,
    ) -> None:
        """
        Runtime shutdown: actually release the speaker device.
        """

        self._pending.clear()
        self._mouth_estimator.reset()
        self._utterance_playback_started = False

        async with self._stream_lock:
            stream = self._stream
            self._stream = None

        if stream is None:
            return

        try:
            if stream.active:
                await asyncio.to_thread(
                    stream.stop
                )
        except Exception:
            pass

        try:
            await asyncio.to_thread(
                stream.close
            )
        except Exception:
            pass

    async def abort(
        self,
    ) -> None:
        """
        Barge-in：
        立即停止 Speaker，
        清理尚未播放和尚未消费的 far reference。
        """

        self._pending.clear()
        self._mouth_estimator.reset()
        self._utterance_playback_started = False

        if self.far_clear is not None:
            self.far_clear()

        async with self._stream_lock:

            stream = self._stream
            self._stream = None

        if stream is None:
            return

        try:
            await asyncio.to_thread(
                stream.abort
            )

        except Exception:
            pass

        finally:
            try:
                await asyncio.to_thread(
                    stream.close
                )

            except Exception:
                pass