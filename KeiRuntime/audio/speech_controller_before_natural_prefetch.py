from __future__ import annotations

import asyncio
import time
from collections import deque

import numpy as np
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable

from .aqua_client import AquaTTSClient
from .player import AudioPlayer


EventSink = Callable[[dict], Awaitable[None]]


@dataclass
class _StreamSegment:
    """One TTS segment whose PCM may still be arriving from Aqua."""

    event: dict
    pcm_queue: asyncio.Queue[bytes | None] = field(
        default_factory=asyncio.Queue
    )
    error: BaseException | None = None
    total_bytes: int = 0
    synthesis_done_perf: float | None = None


class SpeechController:
    """
    Streaming prefetch pipeline.

    Pipeline A (single Aqua/GPU producer):
        tts.request
            -> Aqua stream
            -> per-segment PCM queue

    Pipeline B (single speaker consumer):
        per-segment PCM queue
            -> AudioPlayer.write()
            -> speaker

    Important behavior:
    - Segment 1 starts playing as soon as its first PCM arrives.
    - While segment 1 is still playing, Aqua can finish segment 1 and
      immediately start generating segment 2 into memory.
    - Playback order stays strictly serial.
    - Only one Aqua synthesis runs at a time (safe for RTX 3060 6 GB).
    """

    def __init__(
        self,
        aqua: AquaTTSClient,
        player: AudioPlayer,
        event_sink: EventSink,
    ):
        self.aqua = aqua
        self.player = player
        self.event_sink = event_sink

        # Incoming TTS segments waiting for the single Aqua worker.
        self.queue: asyncio.Queue[dict] = asyncio.Queue()

        # Segment handles waiting for playback.  A handle is published
        # BEFORE its full PCM is ready, so the first segment can stream
        # directly to the speaker.  The bounded depth prevents unlimited
        # prefetch memory growth on very long replies.
        self.ready_queue: asyncio.Queue[_StreamSegment] = (
            asyncio.Queue(maxsize=3)
        )

        self._worker_task: asyncio.Task | None = None
        self._playback_worker_task: asyncio.Task | None = None

        self._current_synthesis_task: asyncio.Task | None = None
        self._current_synthesis_event: dict | None = None

        self._current_speech_task: asyncio.Task | None = None
        self._current_event: dict | None = None

        # turn_id -> interrupt monotonic timestamp
        self._cancelled_turns: dict[str, float] = {}

        self.player.set_mouth_sink(self._on_mouth_level)
        self.player.set_playback_start_sink(
            self._on_playback_start
        )

    # ------------------------------------------------------------
    # lifecycle / state
    # ------------------------------------------------------------

    def _ensure_worker(self) -> None:
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(
                self._synthesis_worker()
            )

        if (
            self._playback_worker_task is None
            or self._playback_worker_task.done()
        ):
            self._playback_worker_task = asyncio.create_task(
                self._playback_worker()
            )

    def _cleanup_cancelled_turns(self) -> None:
        if not self._cancelled_turns:
            return

        now = time.perf_counter()
        stale = [
            turn_id
            for turn_id, marked_at in self._cancelled_turns.items()
            if now - marked_at > 300.0
        ]
        for turn_id in stale:
            self._cancelled_turns.pop(turn_id, None)

    def _mark_cancelled(self, turn_id: str | None) -> None:
        if turn_id:
            self._cancelled_turns[turn_id] = time.perf_counter()

    def _is_cancelled(self, event: dict) -> bool:
        turn_id = event.get("turn_id")
        return bool(
            turn_id
            and turn_id in self._cancelled_turns
        )

    @staticmethod
    def _segment_label(event: dict) -> str:
        payload = event.get("payload") or {}
        return (
            f"{payload.get('segment_index', 1)}/"
            f"{payload.get('segment_count', 1)}"
        )

    @property
    def is_speaking(self) -> bool:
        task = self._current_speech_task
        return (
            self._current_event is not None
            and task is not None
            and not task.done()
        )

    @property
    def current_turn_id(self) -> str | None:
        if self._current_event is None:
            return None
        return self._current_event.get("turn_id")

    # ------------------------------------------------------------
    # public input
    # ------------------------------------------------------------

    async def submit_event(self, event: dict) -> None:
        event_type = event.get("type")

        if event_type == "tts.request":
            self._cleanup_cancelled_turns()

            if self._is_cancelled(event):
                print(
                    "[Kei TTS] discard cancelled request:",
                    f"turn_id={event.get('turn_id')}",
                    f"segment={self._segment_label(event)}",
                )
                return

            self._ensure_worker()
            event["_tts_enqueued_perf"] = time.perf_counter()
            await self.queue.put(event)
            return

        if event_type == "interrupt":
            await self.interrupt(turn_id=event.get("turn_id"))

    async def interrupt(
        self,
        *,
        turn_id: str | None = None,
    ) -> bool:
        """
        Cancel current playback + current synthesis and invalidate all
        queued/prefetched segments belonging to the same turn.
        """
        playback_event = self._current_event
        synthesis_event = self._current_synthesis_event

        target_turn = turn_id
        if target_turn is None:
            if playback_event is not None:
                target_turn = playback_event.get("turn_id")
            elif synthesis_event is not None:
                target_turn = synthesis_event.get("turn_id")

        if target_turn is None:
            return False

        self._mark_cancelled(target_turn)

        playback_cancelled = False

        if (
            playback_event is not None
            and playback_event.get("turn_id") == target_turn
        ):
            task = self._current_speech_task
            if task is not None and not task.done():
                task.cancel()
                playback_cancelled = True

            # Immediate device-buffer discard for barge-in.
            await self.player.abort()

        if (
            synthesis_event is not None
            and synthesis_event.get("turn_id") == target_turn
        ):
            task = self._current_synthesis_task
            if task is not None and not task.done():
                task.cancel()

        print(
            "[Kei TTS] interrupt:",
            f"turn_id={target_turn}",
            f"playback_cancelled={playback_cancelled}",
        )

        return True

    # ------------------------------------------------------------
    # AudioPlayer callbacks
    # ------------------------------------------------------------

    async def _on_playback_start(self) -> None:
        source_event = self._current_event
        if source_event is None:
            return

        if source_event.get("_tts_start_emitted"):
            return

        now = time.perf_counter()
        source_event["_tts_start_emitted"] = True
        source_event["_speaker_start_perf"] = now

        reply_perf = source_event.get("_reply_received_perf")
        request_perf = source_event.get("_tts_request_perf")
        first_pcm_perf = source_event.get("_first_pcm_perf")
        ready_perf = source_event.get("_playback_ready_perf")

        def elapsed_ms(start: float | None) -> int | None:
            if start is None:
                return None
            return int((now - start) * 1000)

        request_to_speaker_ms = elapsed_ms(request_perf)
        first_pcm_to_speaker_ms = elapsed_ms(first_pcm_perf)
        ready_to_speaker_ms = elapsed_ms(ready_perf)
        reply_to_speaker_ms = elapsed_ms(reply_perf)

        print(
            "[Kei Latency]",
            f"turn_id={source_event.get('turn_id')}",
            f"segment={self._segment_label(source_event)}",
            "stage=speaker.start",
            f"tts_request_to_speaker={request_to_speaker_ms}ms",
            f"first_pcm_to_speaker={first_pcm_to_speaker_ms}ms",
            f"ready_to_speaker={ready_to_speaker_ms}ms",
            f"assistant_reply_to_speaker={reply_to_speaker_ms}ms",
        )

        payload = source_event.get("payload") or {}

        await self._emit(
            "tts.start",
            source_event,
            payload={
                "voice": payload.get("voice", "kei"),
                "sample_rate": 24000,
                "channels": 1,
                "dtype": "float32",
                "timing": "first_speaker_frame",
                "pipeline": "streaming_prefetch",
                "tts_request_to_speaker_ms": request_to_speaker_ms,
                "first_pcm_to_speaker_ms": first_pcm_to_speaker_ms,
                "ready_to_speaker_ms": ready_to_speaker_ms,
                "assistant_reply_to_speaker_ms": reply_to_speaker_ms,
                "source_text": payload.get("source_text"),
                "segment_index": payload.get("segment_index", 1),
                "segment_count": payload.get("segment_count", 1),
                "segment_final": payload.get("segment_final", True),
            },
        )

    async def _on_mouth_level(
        self,
        value: float,
        rms: float,
    ) -> None:
        source_event = self._current_event
        if source_event is None:
            return

        event = {
            "type": "tts.mouth",
            "session_id": source_event.get("session_id", "local"),
            "turn_id": source_event.get("turn_id"),
            "text": None,
            "payload": {
                "value": round(
                    max(0.0, min(1.0, float(value))),
                    4,
                ),
                "rms": round(max(0.0, float(rms)), 6),
                "sample_rate": 24000,
                "frame_ms": 30,
                "source": "audio_player",
                "final": False,
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        await self.event_sink(event)

    # ------------------------------------------------------------
    # event helpers
    # ------------------------------------------------------------

    async def _emit_mouth_zero(
        self,
        source_event: dict,
        *,
        reason: str,
    ) -> None:
        await self.event_sink(
            {
                "type": "tts.mouth",
                "session_id": source_event.get(
                    "session_id",
                    "local",
                ),
                "turn_id": source_event.get("turn_id"),
                "text": None,
                "payload": {
                    "value": 0.0,
                    "rms": 0.0,
                    "sample_rate": 24000,
                    "frame_ms": 30,
                    "source": "speech_controller",
                    "final": True,
                    "reason": reason,
                },
                "timestamp": datetime.now(
                    timezone.utc
                ).isoformat(),
            }
        )

    async def _emit(
        self,
        event_type: str,
        source_event: dict,
        *,
        payload: dict | None = None,
    ) -> None:
        await self.event_sink(
            {
                "type": event_type,
                "session_id": source_event.get(
                    "session_id",
                    "local",
                ),
                "turn_id": source_event.get("turn_id"),
                "text": source_event.get("text"),
                "payload": payload or {},
                "timestamp": datetime.now(
                    timezone.utc
                ).isoformat(),
            }
        )

    async def _emit_tts_end(
        self,
        event: dict,
        *,
        status: str,
        reason: str | None = None,
    ) -> None:
        now = time.perf_counter()
        speaker_start = event.get("_speaker_start_perf")
        reply_perf = event.get("_reply_received_perf")

        speaker_duration_ms = (
            int((now - speaker_start) * 1000)
            if speaker_start is not None
            else None
        )
        reply_to_end_ms = (
            int((now - reply_perf) * 1000)
            if reply_perf is not None
            else None
        )

        payload = event.get("payload") or {}

        print(
            "[Kei Latency]",
            f"turn_id={event.get('turn_id')}",
            f"segment={self._segment_label(event)}",
            "stage=tts.end",
            f"status={status}",
            f"speaker_duration={speaker_duration_ms}ms",
            f"assistant_reply_to_end={reply_to_end_ms}ms",
        )

        end_payload = {
            "status": status,
            "segment_index": payload.get("segment_index", 1),
            "segment_count": payload.get("segment_count", 1),
            "segment_final": payload.get("segment_final", True),
            "speaker_duration_ms": speaker_duration_ms,
            "assistant_reply_to_end_ms": reply_to_end_ms,
        }
        if reason is not None:
            end_payload["reason"] = reason

        await self._emit(
            "tts.end",
            event,
            payload=end_payload,
        )

    async def _emit_tts_error(
        self,
        event: dict,
        *,
        stage: str,
        exc: BaseException,
    ) -> None:
        payload = event.get("payload") or {}
        await self._emit(
            "tts.error",
            event,
            payload={
                "stage": stage,
                "segment_index": payload.get("segment_index", 1),
                "segment_count": payload.get("segment_count", 1),
                "segment_final": payload.get("segment_final", True),
                "error": repr(exc),
            },
        )

    # ------------------------------------------------------------
    # Pipeline A: Aqua streaming producer / prefetcher
    # ------------------------------------------------------------

    async def _synthesis_worker(self) -> None:
        while True:
            event = await self.queue.get()
            stream: _StreamSegment | None = None

            try:
                if self._is_cancelled(event):
                    print(
                        "[Kei TTS] skip cancelled synthesis:",
                        f"turn_id={event.get('turn_id')}",
                        f"segment={self._segment_label(event)}",
                    )
                    continue

                dequeued = time.perf_counter()
                enqueued = event.get("_tts_enqueued_perf")
                queue_wait_ms = (
                    int((dequeued - enqueued) * 1000)
                    if enqueued is not None
                    else None
                )

                print(
                    "[Kei Latency]",
                    f"turn_id={event.get('turn_id')}",
                    f"segment={self._segment_label(event)}",
                    "stage=synthesis.dequeue",
                    f"queue_wait={queue_wait_ms}ms",
                )

                # Publish a stream handle immediately.  Playback for the
                # first segment can now wait directly on its first PCM
                # chunk instead of waiting for full synthesis completion.
                stream = _StreamSegment(event=event)
                event["_stream_open_perf"] = time.perf_counter()
                await self.ready_queue.put(stream)

                print(
                    "[Kei Latency]",
                    f"turn_id={event.get('turn_id')}",
                    f"segment={self._segment_label(event)}",
                    "stage=stream.open",
                    f"prefetch_depth={self.ready_queue.qsize()}",
                )

                if self._is_cancelled(event):
                    stream.error = asyncio.CancelledError()
                    await stream.pcm_queue.put(None)
                    continue

                self._current_synthesis_event = event
                task = asyncio.create_task(
                    self._synthesize_to_stream(event, stream)
                )
                self._current_synthesis_task = task

                try:
                    await task

                except asyncio.CancelledError:
                    if self._is_cancelled(event):
                        print(
                            "[Kei TTS] synthesis cancelled:",
                            f"turn_id={event.get('turn_id')}",
                            f"segment={self._segment_label(event)}",
                        )
                        continue
                    raise

                except Exception as exc:
                    # Playback worker owns user-facing tts.error/tts.end.
                    # The exception is already stored on the stream.
                    print(
                        "[Kei TTS] synthesis failed:",
                        f"turn_id={event.get('turn_id')}",
                        f"segment={self._segment_label(event)}",
                        repr(exc),
                    )

            finally:
                if self._current_synthesis_event is event:
                    self._current_synthesis_event = None

                if (
                    self._current_synthesis_task is not None
                    and self._current_synthesis_task.done()
                ):
                    self._current_synthesis_task = None

                self.queue.task_done()

    async def _synthesize_to_stream(
        self,
        event: dict,
        stream: _StreamSegment,
    ) -> None:
        text = (event.get("text") or "").strip()
        if not text:
            exc = RuntimeError("Empty TTS text.")
            stream.error = exc
            await stream.pcm_queue.put(None)
            raise exc

        payload = event.get("payload") or {}
        event["_synthesis_started_perf"] = time.perf_counter()

        pending = bytearray()
        first_pcm_seen = False

        try:
            async for chunk in self.aqua.stream_pcm(
                text,
                voice=payload.get("voice"),
                text_language=payload.get("text_language"),
                preset=payload.get("preset"),
            ):
                if self._is_cancelled(event):
                    raise asyncio.CancelledError()

                pending.extend(chunk)

                aligned_size = len(pending) - len(pending) % 4
                if aligned_size == 0:
                    continue

                pcm = bytes(pending[:aligned_size])
                del pending[:aligned_size]

                if not first_pcm_seen:
                    first_pcm_seen = True
                    first_pcm_perf = time.perf_counter()
                    event["_first_pcm_perf"] = first_pcm_perf
                    event["_playback_ready_perf"] = first_pcm_perf

                    request_perf = event.get("_tts_request_perf")
                    reply_perf = event.get("_reply_received_perf")

                    request_to_pcm_ms = (
                        int((first_pcm_perf - request_perf) * 1000)
                        if request_perf is not None
                        else None
                    )
                    reply_to_pcm_ms = (
                        int((first_pcm_perf - reply_perf) * 1000)
                        if reply_perf is not None
                        else None
                    )

                    print(
                        "[Kei Latency]",
                        f"turn_id={event.get('turn_id')}",
                        f"segment={self._segment_label(event)}",
                        "stage=first_pcm",
                        f"tts_request_to_first_pcm={request_to_pcm_ms}ms",
                        f"assistant_reply_to_first_pcm={reply_to_pcm_ms}ms",
                        f"bytes={len(pcm)}",
                    )

                stream.total_bytes += len(pcm)

                # Unbounded per-segment queue on purpose: the GPU/Aqua
                # producer must be free to finish this segment and start
                # pre-generating the next one while the speaker consumes
                # PCM in real time.
                await stream.pcm_queue.put(pcm)

            if pending:
                raise RuntimeError(
                    "Aqua PCM stream ended with incomplete "
                    "float32 sample."
                )

            if not first_pcm_seen:
                raise RuntimeError(
                    "Aqua PCM stream returned no audio."
                )

        except asyncio.CancelledError as exc:
            stream.error = exc
            raise

        except Exception as exc:
            stream.error = exc
            raise

        finally:
            done_perf = time.perf_counter()
            stream.synthesis_done_perf = done_perf
            event["_synthesis_done_perf"] = done_perf

            # Always unblock playback, even on cancellation/error.
            await stream.pcm_queue.put(None)

            if first_pcm_seen:
                started = event.get("_synthesis_started_perf")
                request_perf = event.get("_tts_request_perf")

                synthesis_ms = (
                    int((done_perf - started) * 1000)
                    if started is not None
                    else None
                )
                request_to_done_ms = (
                    int((done_perf - request_perf) * 1000)
                    if request_perf is not None
                    else None
                )
                audio_duration_ms = int(
                    stream.total_bytes / 4 / 24000 * 1000
                )

                print(
                    "[Kei Latency]",
                    f"turn_id={event.get('turn_id')}",
                    f"segment={self._segment_label(event)}",
                    "stage=synthesis.done",
                    f"synthesis={synthesis_ms}ms",
                    f"tts_request_to_done={request_to_done_ms}ms",
                    f"audio_duration={audio_duration_ms}ms",
                    f"bytes={stream.total_bytes}",
                )

    # ------------------------------------------------------------
    # Pipeline B: serial streamed playback
    # ------------------------------------------------------------

    async def _playback_worker(self) -> None:
        while True:
            stream = await self.ready_queue.get()
            event = stream.event

            try:
                if self._is_cancelled(event):
                    print(
                        "[Kei TTS] skip cancelled playback:",
                        f"turn_id={event.get('turn_id')}",
                        f"segment={self._segment_label(event)}",
                    )
                    continue

                dequeued = time.perf_counter()
                stream_open = event.get("_stream_open_perf")
                stream_wait_ms = (
                    int((dequeued - stream_open) * 1000)
                    if stream_open is not None
                    else None
                )

                print(
                    "[Kei Latency]",
                    f"turn_id={event.get('turn_id')}",
                    f"segment={self._segment_label(event)}",
                    "stage=playback.dequeue",
                    f"stream_queue_wait={stream_wait_ms}ms",
                )

                self._current_event = event
                task = asyncio.create_task(
                    self._play_streamed(stream)
                )
                self._current_speech_task = task

                try:
                    await task

                except asyncio.CancelledError:
                    if self._is_cancelled(event):
                        await self._emit_mouth_zero(
                            event,
                            reason="cancelled",
                        )
                        await self._emit_tts_end(
                            event,
                            status="cancelled",
                            reason="interrupt",
                        )
                        continue
                    raise

                except Exception as exc:
                    await self._emit_mouth_zero(
                        event,
                        reason="error",
                    )
                    await self._emit_tts_error(
                        event,
                        stage="synthesis"
                        if stream.error is not None
                        else "playback",
                        exc=stream.error or exc,
                    )
                    await self._emit_tts_end(
                        event,
                        status="error",
                        reason="tts_error",
                    )

                    try:
                        await self.player.abort()
                    except Exception:
                        pass

            finally:
                if (
                    self._current_speech_task is not None
                    and self._current_speech_task.done()
                ):
                    self._current_speech_task = None

                if self._current_event is event:
                    self._current_event = None

                self.ready_queue.task_done()

    async def _play_streamed(
        self,
        stream: _StreamSegment,
    ) -> None:
        event = stream.event

        self.player.reset_mouth()

        event["_tts_start_emitted"] = False

        event.pop(
            "_speaker_start_perf",
            None,
        )


        played_any_pcm = False


        # --------------------------------------------------------
        # Leading silence trimming
        #
        # 24 kHz × 10 ms = 240 samples
        # float32 = 4 bytes/sample
        # --------------------------------------------------------

        frame_samples = 240
        frame_bytes = frame_samples * 4

        # Aqua 的真正静音 RMS 通常远低于这个值。
        #
        # 当前日志：
        # silence ~ 0.00002
        # very weak onset ~ 0.003-0.004
        # speech onset ~ 0.01+
        silence_threshold = 0.006

        # 不要直接切到第一个有声 frame，
        # 保留 30 ms，防止吃掉辅音起音。
        preroll_frames = 3

        # 最多自动去掉约 800 ms。
        # 防止异常音频被无限扫描。
        max_trim_frames = 80


        preroll: deque[bytes] = deque(
            maxlen=preroll_frames
        )

        scan_buffer = bytearray()

        voice_started = False

        silent_frames_seen = 0


        try:

            while True:

                pcm = await stream.pcm_queue.get()


                if pcm is None:
                    break


                if self._is_cancelled(event):
                    raise asyncio.CancelledError()


                # 已经找到真正的声音起点，
                # 后续 PCM 直接正常播放。
                if voice_started:

                    played_any_pcm = True

                    await self.player.write(
                        pcm
                    )

                    continue


                # 还处在 segment 开头：
                # 先扫描，不立刻交给声卡。
                scan_buffer.extend(
                    pcm
                )


                while (
                    not voice_started
                    and len(scan_buffer)
                    >= frame_bytes
                ):

                    frame = bytes(
                        scan_buffer[
                            :frame_bytes
                        ]
                    )

                    del scan_buffer[
                        :frame_bytes
                    ]


                    samples = np.frombuffer(
                        frame,
                        dtype=np.float32,
                    )


                    if samples.size:

                        rms = float(
                            np.sqrt(
                                np.mean(
                                    samples.astype(
                                        np.float64
                                    )
                                    ** 2
                                )
                            )
                        )

                    else:

                        rms = 0.0


                    force_start = (
                        silent_frames_seen
                        >= max_trim_frames
                    )


                    if (
                        rms >= silence_threshold
                        or force_start
                    ):

                        voice_started = True


                        # 保留最后约 30 ms 的静音，
                        # 让语音起音自然，不截辅音。
                        output = (
                            b"".join(
                                preroll
                            )
                            + frame
                            + bytes(
                                scan_buffer
                            )
                        )


                        scan_buffer.clear()


                        kept_preroll = len(
                            preroll
                        )

                        dropped_frames = max(
                            0,
                            silent_frames_seen
                            - kept_preroll,
                        )


                        preroll.clear()


                        trimmed_ms = (
                            dropped_frames
                            * 10
                        )


                        print(
                            "[Kei Audio]",
                            f"turn_id="
                            f"{event.get('turn_id')}",
                            f"segment="
                            f"{self._segment_label(event)}",
                            "leading_silence_trim",
                            f"trimmed={trimmed_ms}ms",
                            f"threshold="
                            f"{silence_threshold}",
                        )


                        if output:

                            played_any_pcm = True

                            # tts.start 会在这里通过
                            # AudioPlayer callback 触发。
                            await self.player.write(
                                output
                            )


                        break


                    # 还是静音。
                    #
                    # deque 只保留最后 30 ms；
                    # 更早的静音会自然被丢弃。
                    preroll.append(
                        frame
                    )

                    silent_frames_seen += 1


            # ----------------------------------------------------
            # Aqua 已经结束，但整段都没有超过阈值。
            #
            # 极端情况下不要直接丢失整条 TTS。
            # 把剩余的一点内容播放出来。
            # ----------------------------------------------------

            if not voice_started:

                remainder = (
                    b"".join(
                        preroll
                    )
                    + bytes(
                        scan_buffer
                    )
                )


                if remainder:

                    played_any_pcm = True

                    await self.player.write(
                        remainder
                    )


            if isinstance(
                stream.error,
                asyncio.CancelledError,
            ):
                raise asyncio.CancelledError()


            if stream.error is not None:

                raise RuntimeError(
                    "Aqua synthesis failed: "
                    f"{stream.error!r}"
                ) from stream.error


            if not played_any_pcm:

                raise RuntimeError(
                    "Aqua stream produced "
                    "no playable PCM."
                )


        except asyncio.CancelledError:

            await asyncio.shield(
                self.player.abort()
            )

            raise


        # Flush <10 ms remainder,
        # but keep PortAudio warm.
        await self.player.stop()


        await self._emit_mouth_zero(
            event,
            reason="completed",
        )


        await self._emit_tts_end(
            event,
            status="completed",
        )
