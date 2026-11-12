from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator

import sounddevice as sd


class MicrophoneInput:
    """
    Kei Runtime 麦克风 PCM 输入。

    默认格式：
        48000 Hz
        mono
        int16
        20 ms / frame

    48000 Hz 在 Windows 音频设备上通常兼容性较好，
    后续如果 ASR 需要 16000 Hz，再单独重采样。
    """

    def __init__(
        self,
        *,
        sample_rate: int = 48000,
        channels: int = 1,
        frame_ms: int = 20,
        device: int | None = None,
        queue_size: int = 100,
        frame_timeout_seconds: float = 3.0,
    ):
        self.sample_rate = sample_rate
        self.channels = channels
        self.frame_ms = frame_ms
        self.device = device
        self.frame_timeout_seconds = frame_timeout_seconds
        self.frames_received = 0
        self.last_frame_perf = None
        self.restart_count = 0

        self.blocksize = (
            self.sample_rate
            * self.frame_ms
            // 1000
        )

        self._queue: asyncio.Queue[bytes] = (
            asyncio.Queue(
                maxsize=queue_size
            )
        )

        self._stream = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._running = False

    def _push_frame(
        self,
        data: bytes,
    ) -> None:
        """
        在 asyncio event loop 中执行。

        如果处理速度偶尔跟不上，
        丢弃最旧的一帧，优先保留实时数据。
        """

        self.frames_received += 1
        self.last_frame_perf = time.monotonic()
        if self._queue.full():
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except asyncio.QueueEmpty:
                pass

        try:
            self._queue.put_nowait(
                data
            )
        except asyncio.QueueFull:
            pass

    def _audio_callback(
        self,
        indata,
        frames,
        time_info,
        status,
    ) -> None:
        """
        PortAudio 回调线程。

        这里绝对不要做复杂计算，
        只负责把 PCM 交回 asyncio loop。
        """

        if status:
            print(
                "[Kei Mic] PortAudio:",
                status,
            )

        loop = self._loop

        if loop is None:
            return

        data = bytes(
            indata
        )

        loop.call_soon_threadsafe(
            self._push_frame,
            data,
        )

    async def start(
        self,
    ) -> None:
        if self._running:
            return

        self._loop = (
            asyncio.get_running_loop()
        )

        self._stream = sd.RawInputStream(
            samplerate=self.sample_rate,
            blocksize=self.blocksize,
            device=self.device,
            channels=self.channels,
            dtype="int16",
            callback=self._audio_callback,
        )

        try:
            await asyncio.to_thread(self._stream.start)
        except BaseException:
            stream = self._stream
            self._stream = None
            await asyncio.to_thread(stream.close)
            raise

        self._running = True

        print(
            "[Kei Mic] started:",
            f"{self.sample_rate} Hz,"
            f" {self.channels} ch,"
            f" {self.frame_ms} ms/frame,"
            f" device={self.device}",
        )

    async def stop(
        self,
    ) -> None:
        self._running = False

        stream = self._stream
        self._stream = None

        if stream is None:
            return

        try:
            await asyncio.to_thread(
                stream.stop
            )
        finally:
            await asyncio.to_thread(
                stream.close
            )

        print(
            "[Kei Mic] stopped"
        )

    async def frames(
        self,
    ) -> AsyncIterator[bytes]:
        """
        持续返回麦克风 PCM frame。
        """

        while self._running:
            try:
                data = await asyncio.wait_for(
                    self._queue.get(), timeout=self.frame_timeout_seconds
                )
            except asyncio.TimeoutError:
                if not self._running:
                    break
                print("[Kei Mic] No input frames; reopening the microphone")
                # A disconnected input stream can remain 'active' without callbacks.
                stream = self._stream
                self._stream = None
                self._running = False
                if stream is not None:
                    try:
                        await asyncio.to_thread(stream.abort)
                    except Exception as exc:
                        print("[Kei Mic] Failed to abort stale input:", repr(exc))
                    try:
                        await asyncio.to_thread(stream.close)
                    except Exception as exc:
                        print("[Kei Mic] Failed to close stale input:", repr(exc))
                while not self._queue.empty():
                    self._queue.get_nowait()
                    self._queue.task_done()
                while True:
                    try:
                        await self.start()
                        self.restart_count += 1
                        break
                    except Exception as exc:
                        print("[Kei Mic] Reopen failed; retrying:", repr(exc))
                        await asyncio.sleep(1.0)
                continue

            try:
                yield data
            finally:
                self._queue.task_done()
