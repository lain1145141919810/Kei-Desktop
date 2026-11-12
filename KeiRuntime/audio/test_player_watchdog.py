"""Check speaker diagnostics without opening a real audio device."""

from __future__ import annotations

import io
import queue
import threading
from concurrent.futures import Future
from contextlib import redirect_stdout
from unittest.mock import patch

from audio import player as player_module


def captured_warnings(write_delays: list[float]) -> list[str]:
    now = [100.0]

    class FakeStream:
        def write(self, _frame: bytes) -> bool:
            now[0] += write_delays.pop(0)
            return False

    class FakeLoop:
        def call_soon_threadsafe(self, *_args: object) -> None:
            pass

    frames: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
    for _ in write_delays:
        frames.put(bytes(960))
    frames.put(None)
    output = io.StringIO()
    done: Future[None] = Future()
    audio = player_module.AudioPlayer()
    with (
        patch.object(player_module.time, "perf_counter", lambda: now[0]),
        redirect_stdout(output),
    ):
        audio._speaker_worker(FakeStream(), frames, done, FakeLoop(), threading.Event())
    done.result()
    return output.getvalue().splitlines()


def test_repeated_moderate_blocks_are_summarized() -> None:
    warnings = captured_warnings([0.025] * 6)
    assert len(warnings) == 2
    assert "count=5" in warnings[-1]


def test_severe_block_is_reported_immediately() -> None:
    warnings = captured_warnings([0.025, 0.65, 0.025])
    assert any("portaudio_write_blocked=650.0ms" in line for line in warnings)


if __name__ == "__main__":
    test_repeated_moderate_blocks_are_summarized()
    test_severe_block_is_reported_immediately()
    print("player watchdog passed")
