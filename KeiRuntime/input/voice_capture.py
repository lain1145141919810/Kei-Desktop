"""Frame-owned manual capture controls alongside the existing automatic VAD."""
import asyncio
import json
from pathlib import Path
from uuid import uuid4


class VoiceCapture:
    def __init__(self, path, *, max_frames=3000):
        self.path = Path(path)
        try:
            self.mode = json.loads(self.path.read_text(encoding="utf-8"))["mode"]
        except (OSError, ValueError, KeyError, TypeError):
            self.mode = "auto"
        if self.mode not in {"auto", "manual"}:
            self.mode = "auto"
        self.max_frames = max_frames
        self.frames = []
        self.turn = None
        self.has_speech = False
        self.generation = 0
        self.commands = asyncio.Queue(maxsize=8)

    def status(self):
        return {"mode": self.mode, "recording": self.turn is not None,
                "duration_ms": len(self.frames) * 10, "max_seconds": self.max_frames / 100}

    async def request(self, action, mode=None):
        if action not in {"mode", "toggle"} or (action == "mode" and mode not in {"auto", "manual"}):
            raise ValueError("Invalid voice control")
        future = asyncio.get_running_loop().create_future()
        self.commands.put_nowait((action, mode, future))
        return await asyncio.wait_for(future, 2)

    async def discard(self, reason, emit):
        turn = self.turn
        self.turn = None
        self.frames = []
        self.has_speech = False
        if turn:
            await emit({"type": "user.speech.end", "session_id": "local-microphone",
                        "turn_id": turn, "payload": {"mode": "manual", "status": "discarded", "reason": reason}})

    async def finish(self, reason, commit, emit):
        turn, frames, spoken = self.turn, self.frames, self.has_speech
        self.turn = None
        self.frames = []
        self.has_speech = False
        if not turn:
            return
        accepted = spoken and len(frames) >= 20
        await emit({"type": "user.speech.end", "session_id": "local-microphone", "turn_id": turn,
                    "payload": {"mode": "manual", "reason": reason, "status": "submitted" if accepted else "discarded"}})
        if accepted:
            await commit(turn, frames, reason == "limit")

    async def drain(self, available, commit, emit, interrupt, invalidate):
        """Apply controls only at microphone frame boundaries to avoid mode races."""
        while not self.commands.empty():
            action, mode, future = self.commands.get_nowait()
            try:
                if future.cancelled():
                    continue
                if not available:
                    raise ValueError("Desktop is not connected")
                if action == "mode":
                    if mode != self.mode:
                        self.path.parent.mkdir(parents=True, exist_ok=True)
                        temporary = self.path.with_suffix(".tmp")
                        temporary.write_text(json.dumps({"mode": mode}), encoding="utf-8")
                        temporary.replace(self.path)
                        await self.discard("mode_changed", emit)
                        invalidate()
                        self.mode = mode
                        self.generation += 1
                elif self.mode != "manual":
                    raise ValueError("Select manual mode before recording")
                elif self.turn:
                    await self.finish("key", commit, emit)
                else:
                    invalidate()
                    await interrupt()
                    self.generation += 1
                    self.turn = uuid4().hex
                    self.frames = []
                    self.has_speech = False
                    await emit({"type": "user.speech.start", "session_id": "local-microphone", "turn_id": self.turn,
                                "payload": {"source": "microphone", "mode": "manual"}})
                if not future.done():
                    future.set_result(self.status())
                await emit({"type": "voice.capture.state", "payload": self.status()})
            except Exception as exc:
                if not future.done():
                    future.set_exception(exc)
            finally:
                self.commands.task_done()

    async def feed(self, frame, speech, commit, emit, incremental=None):
        if not self.turn:
            return
        self.frames.append(frame)
        self.has_speech |= speech
        if incremental:
            incremental(self.turn, self.frames)
        if len(self.frames) >= self.max_frames:
            await self.finish("limit", commit, emit)
            await emit({"type": "voice.capture.state", "payload": self.status()})
