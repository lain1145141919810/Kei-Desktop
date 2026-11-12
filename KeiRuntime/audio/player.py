from __future__ import annotations

import asyncio
import queue
import threading
import time
from concurrent.futures import Future
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
    [float],
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

        # A speaker thread drains PCM independently of the asyncio loop.
        # Aqua inference and websocket work can pause that loop for hundreds
        # of milliseconds; already queued audio must keep playing.
        self._writer_queue: queue.SimpleQueue[bytes | None] | None = None
        self._writer_thread: threading.Thread | None = None
        self._writer_done: Future[None] | None = None
        self._writer_abort = threading.Event()
        self._playback_start_task: asyncio.Task | None = None

        # Mouth/WebSocket updates are intentionally decoupled from
        # the realtime speaker path. A slow websocket client must
        # never stall 10 ms PortAudio writes.
        self._mouth_queue: asyncio.Queue[
            tuple[float, float] | None
        ] = asyncio.Queue(maxsize=8)

        self._mouth_worker_task: asyncio.Task | None = None


    def _ensure_mouth_worker(self) -> None:
        if self.mouth_sink is None:
            return

        if (
            self._mouth_worker_task is None
            or self._mouth_worker_task.done()
        ):
            self._mouth_worker_task = asyncio.create_task(
                self._mouth_worker()
            )

    def _clear_mouth_queue(self) -> None:
        while True:
            try:
                self._mouth_queue.get_nowait()
                self._mouth_queue.task_done()
            except asyncio.QueueEmpty:
                break

    async def _mouth_worker(self) -> None:
        while True:
            item = await self._mouth_queue.get()

            try:
                if item is None:
                    return

                sink = self.mouth_sink
                if sink is None:
                    continue

                value, rms = item

                try:
                    await sink(
                        value,
                        rms,
                    )
                except Exception as exc:
                    print(
                        "[Kei Audio] mouth sink failed:",
                        repr(exc),
                    )

            finally:
                self._mouth_queue.task_done()


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
        self._clear_mouth_queue()
        self._utterance_playback_started = False

    async def _notify_playback_start(
        self,
        speaker_perf: float,
    ) -> None:
        if self._utterance_playback_started:
            return

        self._utterance_playback_started = True

        if self.playback_start_sink is None:
            return

        await self.playback_start_sink(
            speaker_perf
        )

    def _process_mouth(
        self,
        pcm_float32: bytes,
    ) -> None:
        """
        Analyze played PCM and enqueue mouth values without
        blocking the audio clock.

        Visual/WebSocket backpressure may drop intermediate lip-sync
        updates, but it must never starve PortAudio.
        """
        if self.mouth_sink is None:
            return

        frames = self._mouth_estimator.feed(
            pcm_float32
        )

        if not frames:
            return

        self._ensure_mouth_worker()

        for mouth_frame in frames:
            item = (
                float(mouth_frame.value),
                float(mouth_frame.rms),
            )

            try:
                self._mouth_queue.put_nowait(
                    item
                )

            except asyncio.QueueFull:
                # Keep the newest visual state.
                try:
                    self._mouth_queue.get_nowait()
                    self._mouth_queue.task_done()
                except asyncio.QueueEmpty:
                    pass

                try:
                    self._mouth_queue.put_nowait(
                        item
                    )
                except asyncio.QueueFull:
                    pass


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

    def _dispatch_playback_start(self, speaker_perf: float) -> None:
        self._playback_start_task = asyncio.create_task(
            self._notify_playback_start(speaker_perf)
        )

    async def _deliver_far(self, far: bytes) -> None:
        sink = self.far_sink
        if sink is None:
            return
        started = time.perf_counter()
        try:
            await sink(far)
        except Exception as exc:
            print("[Kei Audio] far sink failed:", repr(exc))
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        if elapsed_ms > 20.0:
            print(
                "[Kei Audio Watchdog]",
                f"far_sink_blocked={elapsed_ms:.1f}ms",
            )

    def _speaker_worker(
        self,
        stream,
        frames: queue.SimpleQueue[bytes | None],
        done: Future[None],
        loop: asyncio.AbstractEventLoop,
        abort_event: threading.Event,
    ) -> None:
        started = False
        writes = 0
        blocked_write_count = 0
        blocked_write_max_ms = 0.0
        last_blocked_write_log = 0.0
        try:
            while True:
                wait_start = time.perf_counter()
                frame = frames.get()
                wait_ms = (time.perf_counter() - wait_start) * 1000.0
                if frame is None or abort_event.is_set():
                    break

                if started and wait_ms > 50.0:
                    print(
                        "[Kei Audio Watchdog]",
                        f"speaker_queue_starved={wait_ms:.1f}ms",
                    )

                if not started:
                    started = True
                    loop.call_soon_threadsafe(
                        self._dispatch_playback_start,
                        time.perf_counter(),
                    )

                if self.far_sink is not None:
                    reference_frame = frame
                    if len(frame) < self._frame_bytes:
                        reference_frame += bytes(
                            self._frame_bytes - len(frame)
                        )
                    far = self._make_far_reference(reference_frame)
                    loop.call_soon_threadsafe(
                        lambda reference=far: asyncio.create_task(
                            self._deliver_far(reference)
                        )
                    )

                write_start = time.perf_counter()
                underflowed = bool(stream.write(frame))
                writes += 1
                write_ms = (time.perf_counter() - write_start) * 1000.0
                if write_ms > 20.0:
                    blocked_write_count += 1
                    blocked_write_max_ms = max(blocked_write_max_ms, write_ms)
                    now = time.perf_counter()
                    if write_ms >= 100.0 or now - last_blocked_write_log >= 1.0:
                        print(
                            "[Kei Audio Watchdog]",
                            f"portaudio_write_blocked={blocked_write_max_ms:.1f}ms",
                            f"count={blocked_write_count}",
                        )
                        blocked_write_count = 0
                        blocked_write_max_ms = 0.0
                        last_blocked_write_log = now
                if underflowed and writes > 1:
                    print("[Kei Audio Watchdog] speaker_underflow=true")

                if abort_event.is_set():
                    break
                loop.call_soon_threadsafe(self._process_mouth, frame)
            if blocked_write_count:
                print(
                    "[Kei Audio Watchdog]",
                    f"portaudio_write_blocked={blocked_write_max_ms:.1f}ms",
                    f"count={blocked_write_count}",
                )
            done.set_result(None)
        except BaseException as exc:
            done.set_exception(exc)

    async def _ensure_writer(self) -> None:
        if self._writer_queue is not None:
            return
        await self.start()
        stream = self._stream
        if stream is None:
            raise RuntimeError("Speaker stream did not start")

        frames: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        done: Future[None] = Future()
        abort_event = threading.Event()
        loop = asyncio.get_running_loop()
        thread = threading.Thread(
            target=self._speaker_worker,
            args=(stream, frames, done, loop, abort_event),
            name="KeiSpeakerWriter",
            daemon=True,
        )
        self._writer_queue = frames
        self._writer_done = done
        self._writer_abort = abort_event
        self._writer_thread = thread
        thread.start()

    async def _play_frame(self, frame: bytes) -> None:
        await self._ensure_writer()
        assert self._writer_queue is not None
        self._writer_queue.put(frame)

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

        if self._pending:
            remainder = bytes(self._pending)
            self._pending.clear()
            await self._play_frame(remainder)

        frames = self._writer_queue
        done = self._writer_done
        thread = self._writer_thread
        if frames is None or done is None or thread is None:
            return

        frames.put(None)
        try:
            await asyncio.shield(asyncio.wrap_future(done))
        except asyncio.CancelledError:
            await self.abort()
            raise
        finally:
            if self._writer_thread is thread:
                thread.join()
                self._writer_queue = None
                self._writer_done = None
                self._writer_thread = None

        start_task = self._playback_start_task
        self._playback_start_task = None
        if start_task is not None:
            await start_task

        # Keep PortAudio warm for the next utterance.

    async def close(
        self,
    ) -> None:
        """
        Runtime shutdown: actually release the speaker device.
        """

        await self.stop()
        self._mouth_estimator.reset()
        self._clear_mouth_queue()
        self._utterance_playback_started = False

        mouth_task = self._mouth_worker_task
        self._mouth_worker_task = None

        if (
            mouth_task is not None
            and not mouth_task.done()
        ):
            mouth_task.cancel()

            try:
                await mouth_task
            except asyncio.CancelledError:
                pass

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
        self._writer_abort.set()
        frames = self._writer_queue
        done = self._writer_done
        thread = self._writer_thread
        if frames is not None:
            frames.put(None)

        async with self._stream_lock:

            stream = self._stream
            self._stream = None

        if stream is not None:
            try:
                await asyncio.to_thread(stream.abort)
            except Exception:
                pass

        if done is not None:
            try:
                await asyncio.wrap_future(done)
            except Exception:
                pass
        if thread is not None:
            await asyncio.to_thread(thread.join)

        self._writer_queue = None
        self._writer_done = None
        self._writer_thread = None
        start_task = self._playback_start_task
        self._playback_start_task = None
        if start_task is not None:
            start_task.cancel()
        self._mouth_estimator.reset()
        self._clear_mouth_queue()
        self._utterance_playback_started = False
        if self.far_clear is not None:
            self.far_clear()

        if stream is not None:
            try:
                await asyncio.to_thread(stream.close)
            except Exception:
                pass
