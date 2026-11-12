"""Overlap ASR with endpoint waiting without publishing provisional text."""

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass


@dataclass
class Candidate:
    turn: str
    pcm: bytes
    future: asyncio.Future
    valid: bool = True


class SpeculativeASR:
    def __init__(self, engine, *, enabled=True):
        self.engine = engine
        self.enabled = enabled
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kei-asr")
        self.candidate = None
        self.inflight = None
        self.closing = False

    def _submit(self, function, *args):
        future = asyncio.get_running_loop().run_in_executor(
            self.executor, function, *args
        )
        # Invalidated candidates may never be awaited. Always retrieve failures.
        future.add_done_callback(
            lambda done: None if done.cancelled() else done.exception()
        )
        self.inflight = future
        return future

    async def load(self):
        await asyncio.shield(self._submit(self.engine.load))

    def _decode(self, pcm):
        started = time.perf_counter()
        result = self.engine.transcribe(pcm)
        return result, round((time.perf_counter() - started) * 1000)

    def invalidate(self):
        if self.candidate:
            self.candidate.valid = False
            self.candidate = None

    def observe_manual_pause(self, turn, frames, *, speech_probability,
                             end_probability, silence_ms, threshold_ms=800):
        """Prepare privately during a pause; renewed speech invalidates it."""
        if not turn or speech_probability > end_probability:
            self.invalidate()
            return False
        if silence_ms >= threshold_ms:
            return self.propose(turn, frames)
        return False

    def propose(self, turn, frames, *, truncated=False):
        if not self.enabled or self.closing or truncated or self.candidate:
            return False
        if self.inflight and not self.inflight.done():
            return False
        pcm = b"".join(frames)
        if not pcm:
            return False
        self.candidate = Candidate(turn, pcm, self._submit(self._decode, pcm))
        print(
            f"[Kei ASR] speculative.start turn_id={turn} audio_ms={len(pcm) // 96}",
            flush=True,
        )
        return True

    def seal(self, turn, pcm, *, truncated=False):
        candidate = self.candidate
        self.candidate = None
        if (
            candidate
            and candidate.valid
            and candidate.turn == turn
            and not truncated
            and pcm.startswith(candidate.pcm)
        ):
            # The caller invalidates on any renewed VAD activity before sealing.
            return candidate
        if candidate:
            candidate.valid = False
        return None

    async def transcribe(self, pcm, candidate=None):
        started = time.perf_counter()
        if candidate and candidate.valid:
            try:
                result, decode_ms = await asyncio.shield(candidate.future)
                if result.get("text", "").strip():
                    return result, {
                        "speculative_reused": True,
                        "decode_ms": decode_ms,
                        "final_wait_ms": round((time.perf_counter() - started) * 1000),
                    }
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - Failed speculation must fall back to final ASR.
                print(
                    f"[Kei ASR] speculative.fallback error={type(exc).__name__}",
                    flush=True,
                )
        result, decode_ms = await asyncio.shield(self._submit(self._decode, pcm))
        return result, {
            "speculative_reused": False,
            "decode_ms": decode_ms,
            "final_wait_ms": round((time.perf_counter() - started) * 1000),
        }

    async def close(self):
        self.closing = True
        self.invalidate()
        # Native inference is not cancellable; wait off the event-loop thread.
        await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=True)
