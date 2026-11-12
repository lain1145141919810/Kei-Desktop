"""Verify that a streamed reply closes only after its final audio finishes."""

from __future__ import annotations

import asyncio

from audio.speech_controller import SpeechController


class FakePlayer:
    def set_mouth_sink(self, _sink: object) -> None:
        pass

    def set_playback_start_sink(self, _sink: object) -> None:
        pass


async def check_finalize_order() -> None:
    emitted: list[dict] = []
    playback_started = asyncio.Event()
    allow_playback_end = asyncio.Event()

    async def record(event: dict) -> None:
        emitted.append(event)

    controller = SpeechController(None, FakePlayer(), record)

    async def synthesize(_event: dict, stream: object) -> None:
        await stream.pcm_queue.put(b"pcm")
        await stream.pcm_queue.put(None)

    async def play(stream: object) -> None:
        playback_started.set()
        await allow_playback_end.wait()
        await controller._emit_tts_end(stream.event, status="completed")

    controller._synthesize_to_stream = synthesize
    controller._play_streamed = play
    turn_id = "stream-finalize-order"
    try:
        await controller.submit_event({
            "type": "tts.request", "turn_id": turn_id,
            "text": "A spoken sentence", "payload": {"segment_final": False},
        })
        await controller.submit_event({
            "type": "stream.finalize", "turn_id": turn_id,
            "text": None, "payload": {"segment_final": True},
        })
        await asyncio.wait_for(playback_started.wait(), 2)
        assert not emitted, "turn closed while its audio was still playing"

        allow_playback_end.set()
        await asyncio.wait_for(controller.ready_queue.join(), 2)
        assert [event["type"] for event in emitted] == ["tts.end", "tts.end"]
        assert [event["payload"]["segment_final"] for event in emitted] == [False, True]
        assert emitted[-1]["payload"]["reason"] == "streamed_turn_complete"
    finally:
        tasks = [controller._worker_task, controller._playback_worker_task]
        for task in tasks:
            if task is not None:
                task.cancel()
        await asyncio.gather(*(task for task in tasks if task is not None),
                             return_exceptions=True)


def test_finalize_follows_playback() -> None:
    asyncio.run(check_finalize_order())


if __name__ == "__main__":
    test_finalize_follows_playback()
    print("stream finalize order passed")
