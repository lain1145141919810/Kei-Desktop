"""Incremental CPU recognition with final-only publication and Whisper fallback."""

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from asr.speculative_asr import SpeculativeASR


@dataclass
class StreamTurn:
    turn: str
    sent: int = 0
    stream: object = None
    compute_ms: float = 0
    error: Exception | None = None
    final: asyncio.Future | None = None


class StreamingASR(SpeculativeASR):
    def __init__(self, engine, root="D:/KeiRuntime/models/streaming-zipformer-small"):
        super().__init__(engine)
        self.root = Path(root)
        self.recognizer = None
        self.current = None
        self.pending_chunks = 0

    async def load(self):
        try:
            await asyncio.shield(self._submit(self._load_streaming))
        except Exception as exc:  # noqa: BLE001 - Keep the working fallback available.
            print(f"[Kei ASR] streaming unavailable: {type(exc).__name__}", flush=True)
            await super().load()

    def _load_streaming(self):
        import sherpa_onnx

        self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(self.root / "tokens.txt"),
            encoder=str(next(self.root.glob("encoder*.int8.onnx"))),
            decoder=str(next(self.root.glob("decoder*.onnx"))),
            joiner=str(next(self.root.glob("joiner*.int8.onnx"))),
            num_threads=2,
            enable_endpoint_detection=False,
        )
        print("[Kei ASR] streaming CPU model ready", flush=True)

    def feed(self, turn, frames):
        if not self.recognizer or self.closing:
            return
        if self.current is None or self.current.turn != turn:
            self.current = StreamTurn(turn)
        state = self.current
        if state.error or len(frames) - state.sent < 32:
            return
        # Bounded work: a slow recognizer falls back instead of accumulating audio.
        if self.pending_chunks >= 4:
            state.error = RuntimeError("Streaming decoder backlog")
            return
        pcm = b"".join(frames[state.sent :])
        state.sent = len(frames)
        self.pending_chunks += 1
        future = self._submit(self._accept, state, pcm, False)
        future.add_done_callback(self._chunk_done)

    def _chunk_done(self, future):
        self.pending_chunks -= 1

    def _accept(self, state, pcm, final):
        if state.error:
            return None
        started = time.perf_counter()
        try:
            if state.stream is None:
                state.stream = self.recognizer.create_stream()
            samples = self.engine._pcm_48k_to_16k(pcm)
            if len(samples):
                state.stream.accept_waveform(16000, samples)
            if final:
                state.stream.accept_waveform(16000, np.zeros(8000, dtype=np.float32))
                state.stream.input_finished()
            while self.recognizer.is_ready(state.stream):
                self.recognizer.decode_stream(state.stream)
            return self.recognizer.get_result(state.stream)
        except Exception as exc:  # noqa: BLE001 - Preserve raw audio for fallback.
            state.error = exc
            return None
        finally:
            state.compute_ms += (time.perf_counter() - started) * 1000

    def invalidate(self):
        # A resumed syllable invalidates speculative Whisper, not a live stream.
        # Turn IDs and seal isolate streams; no partial text reaches the LLM.
        if not self.recognizer:
            super().invalidate()

    def propose(self, turn, frames, *, truncated=False):
        if self.recognizer:
            self.feed(turn, frames)
            return False
        return super().propose(turn, frames, truncated=truncated)

    def seal(self, turn, pcm, *, truncated=False):
        if not self.recognizer:
            return super().seal(turn, pcm, truncated=truncated)
        state = self.current
        self.current = None
        if state is None or state.turn != turn or state.error:
            return None
        state.final = self._submit(self._accept, state, pcm[state.sent * 960 :], True)
        return state

    async def transcribe(self, pcm, candidate=None):
        started = time.perf_counter()
        if isinstance(candidate, StreamTurn):
            text = await asyncio.shield(candidate.final)
            if text and not candidate.error:
                return {"text": text, "language": "zh", "language_probability": 1.0}, {
                    "mode": "streaming",
                    "decode_ms": round(candidate.compute_ms),
                    "final_wait_ms": round((time.perf_counter() - started) * 1000),
                }
            candidate = None
        result, metrics = await super().transcribe(pcm, candidate)
        metrics["mode"] = "whisper_fallback"
        return result, metrics
