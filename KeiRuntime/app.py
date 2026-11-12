"""
Kei Runtime
===========

Kei 的本地实时运行时服务。

当前阶段职责
------------
1. 提供 Runtime 健康检查；
2. 接收 AstrBot 等模块发送的事件；
3. 为每一轮事件维护 session_id / turn_id；
4. 通过 WebSocket 将事件实时广播给桌面端 / 调试端；
5. 接收 tts.request，并交给 SpeechController；
6. SpeechController 通过 Aqua-TTS /tts 获取流式 PCM；
7. 通过 AudioPlayer 在本地扬声器播放；
8. 为后续 ASR、VAD、AEC、barge-in、Camera、Avatar 提供统一骨架。

端口约定
--------
17880 -> Aqua-TTS
17881 -> Kei Runtime

注意
----
assistant.reply 经翻译后生成 tts.request。
只有 KeiDesktop 连接时才允许本地语音播放；Bot 语音消息由 AstrBot 独立发送。
"""

from __future__ import annotations

import sys
# Logging must never terminate a worker on Windows legacy console encodings.
for _kei_log_stream in (sys.stdout, sys.stderr):
    if hasattr(_kei_log_stream, "reconfigure"):
        _kei_log_stream.reconfigure(errors="backslashreplace")



from emotion.analyzer import AffectAnalyzer
from emotion.api_analyzer import APIProsodyAnalyzer
from emotion.prosody_router import ProsodyAnalyzerRouter
from emotion.labels import affect_to_label
import re
from translation.local_nllb import (
    LocalNLLBTranslator
)

from translation.api_translator import (
    APITranslator
)

from translation.translator import (
    TranslatorRouter
)
from collections import deque
import time
from asr.faster_whisper_asr import FasterWhisperASR
from asr.speculative_asr import SpeculativeASR
from asr.streaming_asr import StreamingASR
from audio.aec import EchoCancellationProcessor
import asyncio
from input.silero_vad import SileroSpeechVAD
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4
from pathlib import Path

from bridge.reply_delivery import deduplicate_final_replies
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
import hmac
from input.voice_capture import VoiceCapture
from pydantic import BaseModel, Field

from audio.aqua_client import AquaTTSClient
from audio.player import AudioPlayer
from audio.speech_controller import SpeechController

from input.microphone import MicrophoneInput
from input.vad import EnergyVAD

import os

from bridge.reply_prefetch import ReplySentenceCollector
from bridge.scene_snapshot import AgentSceneSnapshot
from bridge.early_reply import (
    EarlyReplyLedger,
    StreamingSentenceBuffer,
)
from bridge.astrbot_client import AstrBotClient
from bridge.desktop_chat import DesktopChat
from bridge.executors import ExecutorManager
from bridge.bili_agent import BiliAgent

app = FastAPI(
    title="Kei Runtime",
    description="Local runtime and event bus for Kei.",
    version="0.2.0",
)


class RuntimeEvent(BaseModel):
    type: str
    session_id: str = "local"
    turn_id: str | None = None
    text: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


websocket_clients: list[WebSocket] = []
websocket_send_locks: dict[WebSocket, asyncio.Lock] = {}
desktop_clients: set[WebSocket] = set()
desktop_chat = DesktopChat() if os.getenv("KEI_DIRECT_DESKTOP", "1") == "1" else None
executor_manager = ExecutorManager()
bili_agent = BiliAgent()
if desktop_chat:
    desktop_chat.executor_context = executor_manager.context
desktop_playback_generation = 0
agent_scene_snapshot = AgentSceneSnapshot()


def local_playback_allowed(event: dict) -> bool:
    """Allow speech only for a connected Desktop's current playback generation."""
    return bool(desktop_clients) and event.get(
        "_desktop_generation"
    ) == desktop_playback_generation


async def detach_desktop(websocket: WebSocket) -> None:
    """Invalidate pending local audio when the last Desktop disconnects."""
    global desktop_playback_generation
    if websocket not in desktop_clients:
        return
    desktop_clients.discard(websocket)
    if desktop_clients:
        return
    if desktop_chat:
        await interrupt_agent_work()
        desktop_chat.disconnected()
    await executor_manager.release()
    desktop_playback_generation += 1
    print("[Kei Audio Route] Desktop disconnected; local playback disabled")
    # Both workers may be handling different turns. Stop their current work;
    # queued segments are rejected by the generation check when dequeued.
    targets = {
        event.get("turn_id")
        for event in (
            speech_controller._current_event,
            speech_controller._current_synthesis_event,
        )
        if event is not None and event.get("turn_id")
    }
    for turn_id in targets:
        await speech_controller.interrupt(turn_id=turn_id)


async def broadcast_event(
    event: dict[str, Any],
) -> None:
    dead_clients: list[WebSocket] = []

    for websocket in list(websocket_clients):
        try:
            lock = websocket_send_locks.get(websocket)
            if lock is None:
                continue
            async with lock:
                await websocket.send_json(event)
        except Exception:
            dead_clients.append(websocket)

    for websocket in dead_clients:
        if websocket in websocket_clients:
            websocket_clients.remove(websocket)
        websocket_send_locks.pop(websocket, None)
        await detach_desktop(websocket)


# ============================================================================
# Local Streaming TTS
# ============================================================================

aqua_client = AquaTTSClient(
    base_url="http://127.0.0.1:17880",
    voice="kei",
    text_language="日文",
    preset="balanced",
    recorded_utterances={
        "NAVI ログイン": Path(__file__).resolve().parent / "assets" / "voice" / "navi-login.wav",
        "NAVI……ログインしました": Path(__file__).resolve().parent / "assets" / "voice" / "navi-login-complete.wav",
    },
)

if desktop_chat and os.getenv("KEI_SPEECH_PREVIEW", "1") == "1":
    desktop_chat.speech_preview = aqua_client.preview

# ============================================================================
# AEC
# ============================================================================

aec_processor = EchoCancellationProcessor(
    sample_rate=48000,

    # 第一轮先让 AEC3 自动估算。
    stream_delay_ms=0,
)


# ============================================================================
# Audio Player
# ============================================================================

audio_player = AudioPlayer(
    sample_rate=24000,
    channels=1,

    far_sink=aec_processor.push_far,
    far_clear=aec_processor.clear_far,
)


speech_controller = SpeechController(
    aqua=aqua_client,
    player=audio_player,
    event_sink=broadcast_event,
    playback_allowed=local_playback_allowed,
)

# ============================================================================
# Microphone + VAD
# ============================================================================

microphone = MicrophoneInput(
    sample_rate=48000,
    channels=1,
    frame_ms=10,

    # None = Windows 默认输入设备
    device=None,
)

vad = SileroSpeechVAD(
    input_sample_rate=48000,

    # 必须连续多个 chunk 都像人声才开始。
    start_probability=0.60,

    # 概率降到这里以下才开始累计静音。
    end_probability=0.35,

    # 抗拍桌子、键盘等瞬时噪声。
    start_chunks=3,

    # Allow about 2 seconds of silence before ending speech (32 ms/chunk).
    end_chunks=63,
)

# ============================================================================
# Utterance merge window
# ============================================================================

# Hold finalized audio briefly so an immediate continuation can be merged.
# Keep the original pause tolerance; connection pooling is configured separately.
# Set KEI_UTTERANCE_MERGE_MS=0 to commit immediately.
UTTERANCE_MERGE_MS = int(
    os.getenv(
        "KEI_UTTERANCE_MERGE_MS",
        "400",
    )
)

pending_utterance: dict[str, Any] | None = None

# ============================================================================
# Near-field Speech Gate
# ============================================================================

NEAR_FIELD_REJECT_RMS = 550.0

# candidate → accepted
NEAR_FIELD_ACCEPT_RMS = 1000.0

# 已经 ignored 后，重新成为 accepted 要更严格
NEAR_FIELD_REENTER_RMS = 1100.0

# 特别明显的近场声音
NEAR_FIELD_STRONG_RMS = 1500

# 连续多少帧满足条件才确认
NEAR_FIELD_ACCEPT_CONFIRM_FRAMES = 4
NEAR_FIELD_REENTER_CONFIRM_FRAMES = 4
NEAR_FIELD_STRONG_CONFIRM_FRAMES = 2
# 10 ms / frame
# 20 frames = 200 ms rolling window
NEAR_FIELD_WINDOW_FRAMES = 20

# 至少积累 12 帧 = 120 ms 后再进行判断
NEAR_FIELD_MIN_FRAMES = 12
# ============================================================================
# User Speech Capture
# ============================================================================

# 麦克风：
# 48 kHz / mono / int16 / 10 ms per frame

MIC_SAMPLE_RATE = 48000
MIC_FRAME_MS = 10

# accepted 前保留最近 300 ms。
#
# 10 ms/frame × 30 = 300 ms
#
# 作用：
# Speech Gate 真正确认用户之前已经过去了一小段时间，
# pre-roll 可以把开头几个音节补回来。
SPEECH_PRE_ROLL_FRAMES = 30

# 单句最大 30 秒。
#
# 10 ms/frame × 3000 = 30 s
MAX_UTTERANCE_FRAMES = 3000
voice_capture = VoiceCapture("D:/KeiRuntime/data/voice-input.json")

# 后续 Stage 6B ASR 会从这里消费完整语音段。
UTTERANCE_QUEUE_MAXSIZE = 8

utterance_queue: asyncio.Queue[dict[str, Any]] = (
    asyncio.Queue(
        maxsize=UTTERANCE_QUEUE_MAXSIZE
    )
)

# ============================================================================
# ASR
# ============================================================================

from asr.selected_asr import SelectedASR

asr_engine = SelectedASR(FasterWhisperASR(
    model_size="small",
    device="cpu",
    compute_type="int8",
    language="zh",
    cpu_threads=4,
    download_root="models/faster-whisper",
    hotwords="凯伊 天童凯伊 AstrBot TTS 语音生成系统 独立上下文 联网搜索",
    hotwords_path="D:/KeiRuntime/data/asr-hotwords.json",
))

speculative_asr = (
    StreamingASR(asr_engine)
    if os.getenv("KEI_STREAMING_ASR", "0") == "1"
    else SpeculativeASR(asr_engine, enabled=os.getenv("KEI_SPECULATIVE_ASR", "1") == "1")
)
SPECULATIVE_SILENCE_MS = 800  # Final endpoint timing stays unchanged.

# ============================================================================
# AstrBot Bridge
# ============================================================================

ASTRBOT_BASE_URL = "http://127.0.0.1:6185"

ASTRBOT_API_KEY = os.getenv(
    "ASTRBOT_API_KEY",
    "",
).strip()


astrbot_client = (
    AstrBotClient(
        base_url=ASTRBOT_BASE_URL,
        api_key=ASTRBOT_API_KEY,
        username="kei-local-voice",
        session_id="kei-local-voice",
    )
    if ASTRBOT_API_KEY
    else None
)


ASTRBOT_INPUT_QUEUE_MAXSIZE = 8

astrbot_input_queue: asyncio.Queue[
    dict[str, Any]
] = asyncio.Queue(
    maxsize=ASTRBOT_INPUT_QUEUE_MAXSIZE
)

# ============================================================================
# Prosody Analyzer
# ============================================================================

PROSODY_MODE = os.getenv(
    "KEI_PROSODY_MODE",
    "local",
).strip().lower()

PROSODY_BASE_URL = os.getenv(
    "KEI_PROSODY_BASE_URL",
    os.getenv(
        "KEI_TRANSLATION_BASE_URL",
        "",
    ),
).strip()

PROSODY_API_KEY = os.getenv(
    "KEI_PROSODY_API_KEY",
    os.getenv(
        "KEI_TRANSLATION_API_KEY",
        "",
    ),
).strip()

PROSODY_MODEL = os.getenv(
    "KEI_PROSODY_MODEL",
    os.getenv(
        "KEI_TRANSLATION_MODEL",
        "",
    ),
).strip()

PROSODY_ENDPOINT = os.getenv(
    "KEI_PROSODY_ENDPOINT",
    "/v1/chat/completions",
).strip()


local_prosody_analyzer = AffectAnalyzer()

api_prosody_analyzer = None

if (
    PROSODY_BASE_URL
    and PROSODY_API_KEY
    and PROSODY_MODEL
):
    api_prosody_analyzer = APIProsodyAnalyzer(
        base_url=PROSODY_BASE_URL,
        api_key=PROSODY_API_KEY,
        model=PROSODY_MODEL,
        endpoint=PROSODY_ENDPOINT,
    )


prosody_analyzer = ProsodyAnalyzerRouter(
    mode=PROSODY_MODE,
    local_analyzer=local_prosody_analyzer,
    api_analyzer=api_prosody_analyzer,
)
# ============================================================================
# Translation
# ============================================================================

TRANSLATION_MODE = os.getenv(
    "KEI_TRANSLATION_MODE",
    "local",
).strip().lower()


# ============================================================================
# Local Translator
# ============================================================================

LOCAL_TRANSLATION_MODEL_PATH = os.getenv(
    "KEI_LOCAL_TRANSLATION_MODEL_PATH",
    "models/nllb-200-distilled-600M-int8",
).strip()

LOCAL_TRANSLATION_TOKENIZER_PATH = os.getenv(
    "KEI_LOCAL_TRANSLATION_TOKENIZER_PATH",
    "models/nllb-200-distilled-600M-int8",
).strip()

LOCAL_TRANSLATION_CPU_THREADS = int(
    os.getenv(
        "KEI_LOCAL_TRANSLATION_CPU_THREADS",
        "4",
    )
)

local_translator = LocalNLLBTranslator(
    model_path=LOCAL_TRANSLATION_MODEL_PATH,
    tokenizer_path=LOCAL_TRANSLATION_TOKENIZER_PATH,
    cpu_threads=LOCAL_TRANSLATION_CPU_THREADS,
)


# ============================================================================
# API Translator
# ============================================================================

TRANSLATION_API_BASE_URL = os.getenv(
    "KEI_TRANSLATION_BASE_URL",
    "",
).strip()

TRANSLATION_API_KEY = os.getenv(
    "KEI_TRANSLATION_API_KEY",
    "",
).strip()

TRANSLATION_API_MODEL = os.getenv(
    "KEI_TRANSLATION_MODEL",
    "",
).strip()

TRANSLATION_API_ENDPOINT = os.getenv(
    "KEI_TRANSLATION_ENDPOINT",
    "/v1/chat/completions",
).strip()


api_translator = (
    APITranslator(
        base_url=TRANSLATION_API_BASE_URL,
        api_key=TRANSLATION_API_KEY,
        model=TRANSLATION_API_MODEL,
        endpoint=TRANSLATION_API_ENDPOINT,
    )
    if (
        TRANSLATION_API_BASE_URL
        and TRANSLATION_API_KEY
        and TRANSLATION_API_MODEL
    )
    else None
)


# ============================================================================
# Translator Router
# ============================================================================

translator = TranslatorRouter(
    mode=TRANSLATION_MODE,
    local_translator=local_translator,
    api_translator=api_translator,
)


# ============================================================================
# Translation Queue
# ============================================================================

TRANSLATION_QUEUE_MAXSIZE = 8

translation_queue: asyncio.Queue[
    dict[str, Any]
] = asyncio.Queue(
    maxsize=TRANSLATION_QUEUE_MAXSIZE
)

# ============================================================================
# Generation-time streaming TTS (early playback)
# ============================================================================

# When enabled, committed answer sentences observed on the AstrBot SSE stream
# are translated and spoken while the model is still generating. The final
# assistant.reply then plays only what the stream did not already reach.
#
# Set KEI_EARLY_TTS=0 to restore the previous behaviour (wait for the complete
# reply) without touching any other code path.
EARLY_TTS_ENABLED = os.getenv(
    "KEI_EARLY_TTS",
    "1",
).strip().lower() not in ("0", "false", "no", "off")

# Upper bound on sentences spoken ahead of the authoritative reply. Bounding it
# keeps the translation queue (maxsize=8) from ever dropping a real segment and
# limits the work wasted if the turn is cancelled.
EARLY_TTS_MAX_SEGMENTS = int(
    os.getenv(
        "KEI_EARLY_TTS_MAX_SEGMENTS",
        "4",
    )
)

# Seed sharing for turn correlation, and how long an unclaimed seed stays valid.
TURN_SEED_TTL_SECONDS = float(
    os.getenv(
        "KEI_TURN_SEED_TTL_SECONDS",
        "120",
    )
)

# Segment length used by the final reply splitter; the streaming ledger mirrors
# it so both paths agree on segment boundaries.
LEDGER_MAX_CHARS = 72

# Sentinel text used by the end-of-turn marker item. It never reaches TTS; the
# translation worker recognises it by the item's ``finalize`` flag.
STREAM_FINALIZE_MARKER = "\u2063"  # invisible separator, non-empty by contract

early_reply_ledger = EarlyReplyLedger(
    max_segments=EARLY_TTS_MAX_SEGMENTS,
    max_chars=LEDGER_MAX_CHARS,
)

# voice_turn_id seeds handed to AstrBot for the next local-voice request.
turn_seed_pending: list[tuple[str, float]] = []
turn_seed_claimed: dict[str, float] = {}
# agent turn_id -> voice_turn_id, so an interrupt on either id cancels both.
turn_id_links: dict[str, str] = {}
# The voice turn whose AstrBot request is currently in flight.
active_voice_turn_id: str | None = None


def register_turn_seed(voice_turn_id: str, *, source: str = "") -> None:
    """Remember a Runtime voice turn so the plugin can publish it back."""
    if not voice_turn_id:
        return

    now = time.perf_counter()

    # Drop expired seeds; a stale seed must never be bound to a later turn.
    cutoff = now - TURN_SEED_TTL_SECONDS
    turn_seed_pending[:] = [
        item for item in turn_seed_pending if item[1] >= cutoff
    ]
    turn_seed_claimed.clear()
    turn_seed_pending.append((voice_turn_id, now))

    print(
        "[Kei Turn] seed registered:",
        f"voice_turn_id={voice_turn_id}",
        f"source={source or 'unknown'}",
        f"pending={len(turn_seed_pending)}",
    )


def claim_turn_seed() -> str | None:
    """Claim the oldest unclaimed Runtime voice turn (called by the plugin)."""
    now = time.perf_counter()
    cutoff = now - TURN_SEED_TTL_SECONDS

    while turn_seed_pending:
        voice_turn_id, registered = turn_seed_pending.pop(0)
        if registered < cutoff:
            continue
        turn_seed_claimed[voice_turn_id] = now
        print(
            "[Kei Turn] seed claimed:",
            f"voice_turn_id={voice_turn_id}",
            f"age={int((now - registered) * 1000)}ms",
        )
        return voice_turn_id

    return None


def link_turn_ids(agent_turn_id: str, voice_turn_id: str) -> None:
    """Bind an AstrBot agent turn to its Runtime voice turn."""
    if not agent_turn_id or not voice_turn_id:
        return
    turn_id_links[agent_turn_id] = voice_turn_id
    print(
        "[Kei Turn] linked:",
        f"agent_turn_id={agent_turn_id}",
        f"voice_turn_id={voice_turn_id}",
    )


def resolve_turn_ids(turn_id: str) -> set[str]:
    """All ids that refer to the same logical turn."""
    related = {turn_id}
    linked = turn_id_links.get(turn_id)
    if linked:
        related.add(linked)
    for agent_turn_id, voice_turn_id in turn_id_links.items():
        if voice_turn_id == turn_id:
            related.add(agent_turn_id)
    return {item for item in related if item}


def forget_turn_ids(turn_id: str) -> None:
    """Drop correlation entries once a turn is fully finished."""
    for item in resolve_turn_ids(turn_id):
        turn_seed_claimed.pop(item, None)
    for agent_turn_id, voice_turn_id in list(turn_id_links.items()):
        if turn_id in (agent_turn_id, voice_turn_id):
            turn_id_links.pop(agent_turn_id, None)


def note_stream_answer_delta(voice_turn_id: str, elapsed_ms: int) -> None:
    """Record the first visible answer delta for latency accounting."""
    print(
        "[Kei Latency]",
        f"voice_turn_id={voice_turn_id}",
        "stage=stream.first_answer_delta",
        f"elapsed={elapsed_ms}ms",
    )


def commit_early_sentence(
    voice_turn_id: str,
    sentence: str,
    elapsed_ms: int,
    *,
    session_id: str = "kei-local-voice",
) -> bool:
    """Queue one streamed sentence for translation/speech ahead of the reply."""
    if not desktop_clients:
        return False
    queued = early_reply_ledger.commit(voice_turn_id, [sentence])
    if not queued:
        return False

    item = queued[0]

    print(
        "[Kei Latency]",
        f"voice_turn_id={voice_turn_id}",
        "stage=stream.early_segment",
        f"sequence={item['segment_index']}",
        f"elapsed={elapsed_ms}ms",
        repr(item["text"]),
    )

    enqueue_translation(
        session_id=session_id,
        turn_id=voice_turn_id,
        text=item["text"],
        payload={
            "source": "astrbot.stream",
            "early": True,
            "segment_index": item["segment_index"],
        },
        reply_received_perf=time.perf_counter(),
    )
    return True


def early_reply_payload(voice_turn_id: str) -> dict[str, Any]:
    """Describe the streaming state of a turn for the incoming final reply."""
    state = early_reply_ledger.turns.get(voice_turn_id)
    if not state:
        return {
            "early_segments": 0,
            "early_sequence": 0,
        }
    return {
        "early_segments": len(state["committed"]),
        "early_sequence": state["sequence"],
        "early_muted": state["muted"],
        "early_mute_reason": state["mute_reason"],
    }


def note_stream_mute(voice_turn_id: str, reason: str) -> None:
    """Record that this turn can no longer be spoken early."""
    print(
        "[Kei Latency]",
        f"voice_turn_id={voice_turn_id}",
        "stage=stream.muted",
        f"reason={reason}",
    )


def plan_streamed_tail(
    turn_id: str,
    source_text: str,
    *,
    reply_payload: dict | None = None,
) -> tuple[str, dict | None]:
    """Return the part of the final reply that still needs to be spoken.

    ``("", None)`` means this turn never streamed anything, so the caller must
    keep the original behaviour (play the whole reply).
    """
    state = early_reply_ledger.turns.get(turn_id)
    if not state or not state["committed"]:
        return source_text, None

    plan = early_reply_ledger.plan_tail(turn_id, source_text)
    tail = "".join(plan["tail"])

    print(
        "[Kei Latency]",
        f"turn_id={turn_id}",
        "stage=stream.handover",
        f"played={len(plan['played'])}",
        f"remaining={len(plan['tail'])}",
        f"total={plan['total']}",
        f"divergent={plan['divergent']}",
    )

    if plan["divergent"]:
        # The upstream text no longer matches what was spoken. Never replay the
        # spoken part; report it so the mismatch is visible in the log.
        print(
            "[Kei Stream] divergent final text:",
            f"turn_id={turn_id}",
            f"played={plan['committed_count']}",
            f"final_segments={plan['total']}",
        )

    for item in plan["tail"]:
        print(
            "[Kei Stream] remaining segment:",
            f"turn_id={turn_id}",
            repr(item),
        )

    return tail, plan

# ============================================================================
# Background Tasks
# ============================================================================

microphone_task: asyncio.Task | None = None
asr_task: asyncio.Task | None = None
astrbot_task: asyncio.Task | None = None
translation_task: asyncio.Task | None = None

# Prosody is intentionally NOT on the critical Translation -> TTS path.
# Each reply gets a short-lived background task.
prosody_tasks: set[asyncio.Task] = set()


async def analyze_reply_prosody(
    normalized_event: dict[str, Any],
    source_text: str,
    payload: dict[str, Any],
) -> None:
    try:
        started = time.perf_counter()

        observation = await prosody_analyzer.analyze(
            source_text,
            payload,
        )

        utterance_affect = observation.affect
        affect_dict = utterance_affect.to_dict()
        affect_label = affect_to_label(
            utterance_affect
        )

        latency_ms = int(
            (
                time.perf_counter()
                - started
            )
            * 1000
        )

        print(
            "[Kei Prosody]",
            f"turn_id={normalized_event['turn_id']}",
            f"label={affect_label}",
            f"V={affect_dict['valence']}",
            f"A={affect_dict['arousal']}",
            f"I={affect_dict['intensity']}",
            f"W={affect_dict['warmth']}",
            f"source={observation.source}",
            f"latency={latency_ms}ms",
        )

        await broadcast_event(
            {
                "type": "assistant.affect",
                "session_id": normalized_event[
                    "session_id"
                ],
                "turn_id": normalized_event[
                    "turn_id"
                ],
                "text": None,
                "payload": {
                    "affect": affect_dict,
                    "affect_label": affect_label,
                    "scope": "utterance",
                    "confidence":
                        observation.confidence,
                    "source":
                        observation.source,
                    "latency_ms":
                        latency_ms,
                },
                "timestamp": datetime.now(
                    timezone.utc
                ).isoformat(),
            }
        )

    except asyncio.CancelledError:
        raise

    except Exception as exc:
        print(
            "[Kei Prosody] failed:",
            repr(exc),
        )

        await broadcast_event(
            {
                "type": "prosody.error",
                "session_id": normalized_event.get(
                    "session_id",
                    "local",
                ),
                "turn_id": normalized_event.get(
                    "turn_id"
                ),
                "text": None,
                "payload": {
                    "error": repr(exc),
                },
                "timestamp": datetime.now(
                    timezone.utc
                ).isoformat(),
            }
        )


def schedule_reply_prosody(
    normalized_event: dict[str, Any],
    source_text: str,
    payload: dict[str, Any],
) -> None:
    task = asyncio.create_task(
        analyze_reply_prosody(
            normalized_event,
            source_text,
            payload,
        )
    )

    prosody_tasks.add(task)
    task.add_done_callback(
        prosody_tasks.discard
    )


def authenticate_voice(request):
    try:
        token = Path("D:/KeiRuntime/data/desktop-bridge.token").read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if not token or not hmac.compare_digest(request.headers.get("X-Kei-Bridge", ""), token):
        raise HTTPException(401, "Unauthorized")


@app.get("/voice-input")
async def voice_input_status(request: Request):
    authenticate_voice(request)
    return voice_capture.status()


@app.post("/desktop/storage")
async def desktop_storage(request: Request):
    authenticate_voice(request)
    from bridge.context_storage import manage
    try:
        return await manage(desktop_chat,executor_manager,await request.json())
    except ValueError as exc:
        raise HTTPException(409,str(exc)) from exc


@app.post("/desktop/thread")
async def desktop_thread(request: Request):
    authenticate_voice(request)
    body = await request.json()
    if not desktop_chat or desktop_chat.turn_lock.locked() or not astrbot_input_queue.empty():
        raise HTTPException(409, "Wait for the current turn")
    turns = body.get("turns", [])
    if not isinstance(turns,list) or len(turns)>512 or not all(isinstance(t,str) and len(t)<=256 for t in turns):
        raise HTTPException(400, "Invalid turn identifiers")
    entries = body.get("entries", [])
    if not isinstance(entries,list) or not all(isinstance(e,dict) and e.get("role") in ("user","assistant") and isinstance(e.get("content"),str) and e.get("status")=="completed" for e in entries):
        raise HTTPException(400,"Invalid transcript")
    legacy = body.get("legacy_id")
    if legacy is not None and (not isinstance(legacy,str) or len(legacy)>128):
        raise HTTPException(400,"Invalid thread")
    try:
        return {"thread": await desktop_chat.select_thread(turns, body.get("new") is True, entries, legacy)}
    except LookupError:
        raise HTTPException(404, "No matching runtime transcript")

@app.get("/executors")
async def executor_status(request: Request):
    authenticate_voice(request)
    return executor_manager.status()


@app.post("/executors/run")
async def executor_run(request: Request):
    """Run an authenticated AstrBot task using the existing bounded executor."""
    import json

    authenticate_voice(request)
    body = await request.json()
    if not isinstance(body, dict) or set(body) - {'request', 'scope', 'task_id'}:
        raise HTTPException(400, 'Invalid executor request')
    prompt, scope, task_id = body.get('request'), body.get('scope'), body.get('task_id')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000:
        raise HTTPException(400, 'Invalid task text')
    if not isinstance(scope, str) or not re.fullmatch(r'astrbot-[0-9a-f]{64}', scope):
        raise HTTPException(400, 'Invalid AstrBot scope')
    if task_id is not None and (not isinstance(task_id, str) or not re.fullmatch(r'[0-9a-f]{32}', task_id)):
        raise HTTPException(400, 'Invalid task identifier')
    if executor_manager.active or executor_manager.lock.locked():
        raise HTTPException(409, 'Executor busy; do not automatically retry')
    if executor_manager.config['backend'] == 'astrbot':
        raise HTTPException(409, 'Select Codex or DSH executor first')
    try:
        return json.loads(await executor_manager.run(prompt, scope, task_id))
    except ValueError as exc:
        raise HTTPException(400, 'Invalid task scope or continuation') from exc


@app.get('/bilibili')
async def bilibili_status(request: Request):
    authenticate_voice(request)
    return bili_agent.status()


@app.post('/bilibili')
async def bilibili_control(request: Request):
    authenticate_voice(request)
    body = await request.json()
    if not isinstance(body, dict) or set(body) != {'action'}:
        raise HTTPException(400, 'Expected action only')
    try:
        return await bili_agent.control(body['action'])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post('/bilibili/understand')
async def bilibili_understand(request: Request):
    """Return read-only video observations to authenticated local clients."""
    authenticate_voice(request)
    body = await request.json()
    if not isinstance(body, dict) or set(body) != {'bvid'}:
        raise HTTPException(400, 'Expected bvid only')
    try:
        return await bili_agent.understand_video(body['bvid'])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, 'video_understanding_failed') from exc


@app.post("/executors")
async def executor_control(request: Request):
    authenticate_voice(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "Expected object")
    action = body.get("action")
    try:
        if action == "reload-models":
            if executor_manager.active:
                raise HTTPException(409, "Wait for the active task")
            return await executor_manager.reload_catalog()
        if action == "subagents":
            if executor_manager.active:
                raise HTTPException(409, "Wait for the active task")
            return await executor_manager.set_children(body.get("settings"))
        if action == "select":
            if executor_manager.active:
                raise HTTPException(409, "请先取消或等待当前任务结束")
            return await executor_manager.select(body.get("backend"))
        if action == "cancel":
            await executor_manager.stop_session()
        elif action == "release":
            await executor_manager.release()
        else:
            raise HTTPException(400, "Unknown action")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return executor_manager.status()


@app.post("/voice-input")
async def voice_input_control(request: Request):
    authenticate_voice(request)
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("Expected object")
        return await voice_capture.request(body.get("action"), body.get("mode"))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (asyncio.TimeoutError, asyncio.QueueFull) as exc:
        raise HTTPException(503, "Microphone controls unavailable") from exc


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "kei-runtime",
        "voice_capture": voice_capture.status(),
        "version": "0.2.0",
        "websocket_clients": len(websocket_clients),
        "desktop_clients": len(desktop_clients),
        "desktop_direct": desktop_chat.health() if desktop_chat else {"enabled": False},
        "asr_speculation": {
            "engine": asr_engine.health(),
            "enabled": speculative_asr.enabled,
            "start_silence_ms": SPECULATIVE_SILENCE_MS,
            "mode": "streaming" if isinstance(speculative_asr, StreamingASR) and speculative_asr.recognizer else "speculative_" + asr_engine.active,
        },
        "local_playback_enabled": bool(desktop_clients),
        "streaming_tts": True,
        "aqua_base_url": "http://127.0.0.1:17880",
        "microphone": {
            "running": microphone._running,
            "stream_active": bool(microphone._stream and microphone._stream.active),
            "frames_received": microphone.frames_received,
            "last_frame_age_ms": (
                round((time.monotonic() - microphone.last_frame_perf) * 1000)
                if microphone.last_frame_perf is not None else None
            ),
            "restart_count": microphone.restart_count,
        },
        "workers": {
            name: bool(task and not task.done())
            for name, task in (
                ("microphone", microphone_task), ("asr", asr_task),
                ("astrbot", astrbot_task), ("translation", translation_task),
            )
        },
    }

active_agent_turn_id = None
pending_reply_turn_id = None
cancelled_agent_turns = set()
astrbot_send_task = None
agent_stop_tasks = set()

async def stop_agent_in_background(send_task):
    try:
        if desktop_chat and desktop_chat.session_id:
            if desktop_chat.tool_session:
                await desktop_chat.tool_session.stop_session()
        else:
            await astrbot_client.stop_session()
    except Exception as exc:
        print("[Kei AstrBot] stop failed:", ascii(str(exc)))
    finally:
        # Capture the old task; a late stop must never cancel a new request.
        if not send_task.done():
            send_task.cancel()

async def interrupt_agent_work():
    global active_agent_turn_id, pending_reply_turn_id, active_voice_turn_id
    targets = {turn for turn in (active_agent_turn_id, pending_reply_turn_id,
                                speech_controller.current_turn_id,
                                active_voice_turn_id) if turn}
    # Speech may already be streaming under the Runtime voice turn id, which is
    # a different id from the AstrBot agent turn. Cancel every related id so no
    # streamed segment survives a barge-in.
    for turn in list(targets):
        targets |= resolve_turn_ids(turn)
    if not targets and (astrbot_send_task is None or astrbot_send_task.done()):
        return
    agent_scene_snapshot.clear()
    for turn in targets:
        cancelled_agent_turns.add(turn)
        event = {"type": "interrupt", "session_id": "local-microphone", "turn_id": turn,
                 "text": None, "payload": {"reason": "vad_barge_in"},
                 "timestamp": datetime.now(timezone.utc).isoformat()}
        await broadcast_event(event)
        await speech_controller.submit_event(event)
    active_agent_turn_id = pending_reply_turn_id = None
    active_voice_turn_id = None
    if astrbot_client and astrbot_send_task and not astrbot_send_task.done():
        stop_task = asyncio.create_task(stop_agent_in_background(astrbot_send_task))
        agent_stop_tasks.add(stop_task)
        stop_task.add_done_callback(agent_stop_tasks.discard)
    while not astrbot_input_queue.empty():
        astrbot_input_queue.get_nowait()
        astrbot_input_queue.task_done()

def enqueue_translation(
    *,
    session_id: str,
    turn_id: str,
    text: str,
    payload: dict | None = None,
    reply_received_perf: float | None = None,
    segment_offset: int = 0,
    segment_total: int | None = None,
    finalize: bool = False,
) -> bool:
    """Queue one translation unit. Shared by the stream and final reply paths."""
    source_text = (text or "").strip()
    if not source_text or not desktop_clients:
        return False

    translation_item = {
        "session_id": session_id,
        "turn_id": turn_id,
        "text": source_text,
        "_desktop_generation": desktop_playback_generation,

        # Affect no longer blocks TTS. Keep only any explicit upstream value.
        "affect": (payload or {}).get("affect") or {},
        "affect_label": (payload or {}).get("affect_label", "neutral"),
        "reply_payload": payload or {},

        # Streaming bookkeeping: which semantic index this unit is, and whether
        # the item carries the end-of-turn marker.
        "segment_offset": int(segment_offset),
        "segment_total": segment_total,
        "finalize": bool(finalize),

        # Internal monotonic timing; never broadcast.
        "_reply_received_perf": (
            reply_received_perf
            if reply_received_perf is not None
            else time.perf_counter()
        ),
    }

    if translation_queue.full():
        try:
            dropped = translation_queue.get_nowait()
            translation_queue.task_done()
            print(
                "[Kei Translation] dropped old request:",
                dropped.get("turn_id"),
            )
        except asyncio.QueueEmpty:
            pass

    translation_queue.put_nowait(translation_item)
    return True


@app.post("/turns/claim")
async def claim_turn():
    """Hand the plugin the Runtime voice turn id for the request it just began.

    The Runtime generates the voice turn id before it calls AstrBot, but the
    AstrBot plugin is what publishes the final reply. Without this handshake the
    two sides would use different ids for the same turn and an interrupt could
    not cancel streamed speech. Returns ``voice_turn_id: null`` when no seed is
    pending, in which case the plugin keeps its previous behaviour.
    """
    voice_turn_id = claim_turn_seed()
    return {
        "status": "ok" if voice_turn_id else "empty",
        "voice_turn_id": voice_turn_id,
    }


@app.post("/events")
async def receive_event(event: RuntimeEvent):
    from bridge.channel_route import belongs_to_desktop
    if not belongs_to_desktop(event.session_id, event.payload or {}):
        return {"status": "accepted", "route": "external", "turn_id": event.turn_id}
    return await receive_desktop_event(event)


@deduplicate_final_replies
async def receive_desktop_event(
    event: RuntimeEvent,
):
    global active_agent_turn_id, pending_reply_turn_id
    event_received_perf = time.perf_counter()

    turn_id = event.turn_id or uuid4().hex

    normalized_event = {
        "type": event.type,
        "session_id": event.session_id,
        "turn_id": turn_id,
        "text": event.text,
        "payload": event.payload,
        "timestamp": datetime.now(
            timezone.utc
        ).isoformat(),
    }

    # Explicit manual input uses the same post-ASR queue. Existing event types
    # keep their broadcast-only behavior; never silently discard a question.
    if event.type == "user.message":
        text = (event.text or "").strip()
        if not text:
            return {"status": "rejected", "reason": "empty_text"}
        if turn_id in cancelled_agent_turns:
            return {"status": "discarded", "reason": "cancelled_turn"}
        if astrbot_input_queue.full():
            return {"status": "rejected", "reason": "input_queue_full"}
        astrbot_input_queue.put_nowait({
            "turn_id": turn_id, "text": text, "source": "manual",
            "_input_received_perf": event_received_perf,
        })

    if turn_id in cancelled_agent_turns and event.type not in ("interrupt", "task.cancel"):
        return {"status": "discarded", "reason": "cancelled_turn"}
    if (
        event.type in ("interrupt", "task.cancel")
        and agent_scene_snapshot.current
        and agent_scene_snapshot.current["turn_id"] == turn_id
    ):
        agent_scene_snapshot.clear()
    if event.type.startswith("agent."):
        normalized_event["payload"] = dict(normalized_event["payload"] or {})
        normalized_event["payload"]["scene_revision"] = agent_scene_snapshot.record(
            normalized_event
        )
    if event.type == "agent.begin":
        active_agent_turn_id = turn_id
        claimed = (event.payload or {}).get("voice_turn_id")
        if claimed:
            link_turn_ids(turn_id, claimed)
    elif event.type == "assistant.reply":
        pending_reply_turn_id = turn_id
    elif event.type == "agent.done" and active_agent_turn_id == turn_id:
        if event.payload.get("has_reply"):
            pending_reply_turn_id = turn_id
        active_agent_turn_id = None

    # ============================================================
    # 1. Broadcast original event
    # ============================================================

    await broadcast_event(
        normalized_event
    )

    print(
        "[Kei Runtime] dispatch to SpeechController:",
        normalized_event["type"],
    )

    # tts.request / interrupt 等原有事件继续正常工作。
    await speech_controller.submit_event(
        {**normalized_event, "_desktop_generation": desktop_playback_generation}
    )

    # ============================================================
    # 2. assistant.reply -> Translation Queue
    # ============================================================

    if normalized_event["type"] == "assistant.reply":

        payload = (
            normalized_event.get("payload")
            or {}
        )

        source_text = (
            payload.get("tts_text")
            or normalized_event.get("text")
            or ""
        ).strip()

        # Generation-time streaming may already have translated and spoken part
        # of this turn. Only the remainder is played here, and the tail carries
        # the end-of-turn marker so Desktop still clears the dialogue at the
        # right moment.
        tail_text, plan = plan_streamed_tail(
            turn_id,
            source_text,
            reply_payload=payload,
        )

        if plan is not None:
            payload = {
                **payload,
                "early_segments": plan["committed_count"],
                "early_remaining": len(plan["tail"]),
                "early_divergent": plan["divergent"],
                "segment_offset": plan["sequence"],
            }

        if source_text and not tail_text and plan is not None:
            # Every sentence was already spoken while the model was generating.
            # Keep the turn open until those queued segments finish, then let
            # the marker item close the turn exactly like a spoken tail would.
            print(
                "[Kei Latency]",
                f"turn_id={turn_id}",
                "stage=stream.finalize",
                f"played={len(plan['played'])}",
                f"total={plan['total']}",
                f"divergent={plan['divergent']}",
            )
            enqueue_translation(
                session_id=normalized_event["session_id"],
                turn_id=turn_id,
                text=STREAM_FINALIZE_MARKER,
                payload=payload,
                reply_received_perf=event_received_perf,
                segment_offset=plan["sequence"],
                finalize=True,
            )
            schedule_reply_prosody(
                normalized_event,
                source_text,
                payload,
            )
            return {
                "status": "accepted",
                "turn_id": turn_id,
                "event": normalized_event,
            }

        if source_text and tail_text:

            # ----------------------------------------------------
            # Critical path FIRST:
            # assistant.reply -> translation_queue -> TTS
            # ----------------------------------------------------
            enqueue_translation(
                session_id=normalized_event["session_id"],
                turn_id=turn_id,
                text=tail_text,
                payload=payload,
                reply_received_perf=event_received_perf,
                segment_offset=(plan["sequence"] if plan else 0),
                finalize=True,
            )

            queued_perf = time.perf_counter()

            print(
                "[Kei Latency]",
                f"turn_id={normalized_event['turn_id']}",
                "stage=assistant.reply->translation_queue",
                f"elapsed={int((queued_perf - event_received_perf) * 1000)}ms",
            )

            print(
                "[Kei Translation] queued:",
                f"turn_id="
                f"{normalized_event['turn_id']}",
                repr(tail_text),
            )

            # ----------------------------------------------------
            # Non-critical path:
            # Prosody runs independently and only feeds Avatar.
            # ----------------------------------------------------
            schedule_reply_prosody(
                normalized_event,
                source_text,
                payload,
            )

    return {
        "status": "accepted",
        "turn_id": turn_id,
        "event": normalized_event,
    }


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
):
    await websocket.accept()
    is_desktop = websocket.query_params.get("client") == "kei-desktop"
    send_lock = asyncio.Lock()
    websocket_send_locks[websocket] = send_lock

    try:
        async with send_lock:
            websocket_clients.append(websocket)
            if is_desktop:
                desktop_clients.add(websocket)
            await websocket.send_json(
                {
                    "type": "runtime.connected",
                    "session_id": "runtime",
                    "turn_id": None,
                    "text": None,
                    "payload": {
                        "version": "0.2.0",
                        "streaming_tts": True,
                    },
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
            )
            if is_desktop:
                snapshot = agent_scene_snapshot.event()
                snapshot["timestamp"] = datetime.now(timezone.utc).isoformat()
                await websocket.send_json(snapshot)
        if is_desktop:
            print("[Kei Audio Route] Desktop connected; local playback enabled")
            if desktop_chat:
                await desktop_chat.connected()

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        pass

    finally:
        if websocket in websocket_clients:
            websocket_clients.remove(websocket)
        websocket_send_locks.pop(websocket, None)
        await detach_desktop(websocket)

async def commit_utterance(
    turn_id: str,
    frames: list,
    truncated: bool,
) -> None:
    """Queue one complete user utterance for ASR.

    Kept separate from the microphone loop so a finalized utterance can be held
    briefly and merged with a continuation (see UTTERANCE_MERGE_MS).
    """
    utterance_pcm = b"".join(frames)
    utterance_frame_count = len(frames)
    utterance_duration_ms = utterance_frame_count * MIC_FRAME_MS

    utterance_info = {
        "session_id": "local-microphone",
        "turn_id": turn_id,
        "pcm": utterance_pcm,
        "sample_rate": MIC_SAMPLE_RATE,
        "channels": 1,
        "dtype": "int16",
        "frame_ms": MIC_FRAME_MS,
        "frames": utterance_frame_count,
        "duration_ms": utterance_duration_ms,
        "bytes": len(utterance_pcm),
        "truncated": truncated,
        "_asr_candidate": speculative_asr.seal(
            turn_id, utterance_pcm, truncated=truncated,
        ),
    }

    # Queue 满了时丢最旧的一句，
    # 保证实时系统不会因为 ASR 消费慢而卡住。
    if utterance_queue.full():
        try:
            utterance_queue.get_nowait()
            utterance_queue.task_done()
        except asyncio.QueueEmpty:
            pass

    utterance_queue.put_nowait(utterance_info)

    print(
        "[Kei Capture] utterance ready:",
        f"turn_id={turn_id}",
        f"duration={utterance_duration_ms}ms",
        f"bytes={len(utterance_pcm)}",
        f"truncated={truncated}",
    )

    # WebSocket 只广播 metadata。
    #
    # 不把几十/几百 KB PCM 直接塞进 JSON。
    await broadcast_event(
        {
            "type": "user.speech.audio_ready",
            "session_id": "local-microphone",
            "turn_id": turn_id,
            "text": None,
            "payload": {
                "source": "microphone",
                "sample_rate": MIC_SAMPLE_RATE,
                "channels": 1,
                "dtype": "int16",
                "duration_ms": utterance_duration_ms,
                "frames": utterance_frame_count,
                "bytes": len(utterance_pcm),
                "truncated": truncated,
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


async def microphone_vad_loop():
    """
    Microphone
        ↓
    AEC
        ↓
    Silero VAD
        ↓
    Rolling RMS / p75 Speech Gate
        ↓
    user.speech.start / end
        ↓
    interrupt active TTS
    """
    global pending_utterance

    accept_streak = 0
    reenter_streak = 0
    strong_streak = 0
    active_user_turn_id = None
    accepted_user_speech = False

    # accepted 之前的短时环形缓冲
    speech_pre_roll = deque(
        maxlen=SPEECH_PRE_ROLL_FRAMES
    )

    # accepted 后真正的一整句用户音频
    utterance_frames = []

    # 防止异常语音无限增长
    utterance_truncated = False

    # 当前是否处在 Silero 判定的一段语音中
    speech_segment_active = False

    # Speech Gate 状态：
    #
    # idle
    # candidate
    # ignored
    # accepted
    gate_state = "idle"

    # 最近约 200 ms 的 RMS
    rms_history = deque(
        maxlen=NEAR_FIELD_WINDOW_FRAMES
    )
    capture_generation = voice_capture.generation
    input_restart_count = microphone.restart_count

    try:
        await microphone.start()

        async for frame in microphone.frames():
            await voice_capture.drain(bool(desktop_clients), commit_utterance, broadcast_event,
                                      interrupt_agent_work, speculative_asr.invalidate)
            if capture_generation != voice_capture.generation:
                capture_generation = voice_capture.generation
                if active_user_turn_id:
                    await broadcast_event({"type": "user.speech.end", "session_id": "local-microphone",
                                           "turn_id": active_user_turn_id,
                                           "payload": {"status": "discarded", "reason": "mode_changed"}})
                vad.reset()
                speculative_asr.invalidate()
                pending_utterance = None
                accept_streak = reenter_streak = strong_streak = 0
                active_user_turn_id = None
                accepted_user_speech = speech_segment_active = False
                gate_state = "idle"
                rms_history.clear()
                utterance_frames = []
                utterance_truncated = False
                speech_pre_roll.clear()
            if desktop_chat and not desktop_clients:
                await voice_capture.discard("desktop_disconnected", broadcast_event)
                vad.reset()
                speculative_asr.invalidate()
                pending_utterance = None
                utterance_frames.clear()
                speech_pre_roll.clear()
                accepted_user_speech = False
                active_user_turn_id = None
                speech_segment_active = False
                gate_state = "idle"
                continue
            if microphone.restart_count != input_restart_count:
                await voice_capture.discard("microphone_reconnected", broadcast_event)
                input_restart_count = microphone.restart_count
                if accepted_user_speech and active_user_turn_id is not None:
                    await broadcast_event({
                        "type": "user.speech.end", "session_id": "local-microphone",
                        "turn_id": active_user_turn_id, "text": None,
                        "payload": {"reason": "microphone_reconnected", "status": "discarded"},
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                vad.reset()
                speculative_asr.invalidate()
                pending_utterance = None
                accept_streak = reenter_streak = strong_streak = 0
                active_user_turn_id = None
                accepted_user_speech = speech_segment_active = False
                gate_state = "idle"
                rms_history.clear()
                utterance_frames = []
                utterance_truncated = False
                speech_pre_roll.clear()
                print("[Kei Capture] Reset stale speech state after microphone recovery")

            # ============================================
            # AEC
            # ============================================

            raw_frame = frame

            clean_frame = aec_processor.process(
                raw_frame
            )
            if voice_capture.mode == "manual":
                vad.process(clean_frame)
                if not isinstance(speculative_asr, StreamingASR):
                    speculative_asr.observe_manual_pause(
                        voice_capture.turn if voice_capture.has_speech else None,
                        voice_capture.frames,
                        speech_probability=vad.last_probability,
                        end_probability=vad.end_probability,
                        silence_ms=vad.silence_duration_ms,
                        threshold_ms=SPECULATIVE_SILENCE_MS,
                    )
                await voice_capture.feed(clean_frame, vad.last_probability >= 0.60,
                                         commit_utterance, broadcast_event,
                                         speculative_asr.feed if isinstance(speculative_asr, StreamingASR) else None)
                continue

            # ============================================
            # Utterance merge deadline
            # ============================================
            #
            # A finalized utterance waits here briefly so a natural in-question
            # pause can still be joined to what follows.

            if (
                pending_utterance is not None
                and time.perf_counter()
                >= pending_utterance["_merge_deadline_perf"]
            ):
                await commit_utterance(
                    pending_utterance["turn_id"],
                    pending_utterance["frames"],
                    pending_utterance["truncated"],
                )
                pending_utterance = None

            # ============================================
            # User Speech Capture
            # ============================================

            if accepted_user_speech:

                # Gate 已经确认这是用户。
                #
                # 从这一帧开始持续写入完整语音段。
                if (
                    len(utterance_frames)
                    < MAX_UTTERANCE_FRAMES
                ):
                    utterance_frames.append(
                        clean_frame
                    )
                    if isinstance(speculative_asr, StreamingASR) and active_user_turn_id:
                        speculative_asr.feed(active_user_turn_id, utterance_frames)

                else:
                    if not utterance_truncated:
                        print(
                            "[Kei Capture] maximum utterance "
                            "length reached (30s)"
                        )

                        utterance_truncated = True

            else:

                # 尚未 accepted。
                #
                # 永远保留最近 300 ms，
                # 防止 Gate 确认过程中吃掉句首。
                speech_pre_roll.append(
                    clean_frame
                )
            playback_active = (
                speech_controller.is_speaking
            )

            # ============================================
            # Temporary AEC diagnostics
            # ============================================

            now = time.monotonic()

            if playback_active:

                if (
                    now
                    - microphone_vad_loop.last_debug
                    >= 1.0
                ):

                    raw_rms = EnergyVAD.rms(
                        raw_frame
                    )

                    clean_debug_rms = EnergyVAD.rms(
                        clean_frame
                    )

                    print(
                        "[Kei AEC]",
                        f"raw={raw_rms:.1f}",
                        f"clean={clean_debug_rms:.1f}",
                    )

                    microphone_vad_loop.last_debug = now

            # ============================================
            # Silero VAD
            # ============================================

            vad_event = vad.process(
                clean_frame
            )

            # A renewed voice probability invalidates provisional recognition,
            # even before the near-field gate accepts a continuation.
            if vad.last_probability > vad.end_probability:
                speculative_asr.invalidate()
            elif (
                accepted_user_speech
                and active_user_turn_id
                and vad.silence_duration_ms >= SPECULATIVE_SILENCE_MS
            ):
                speculative_asr.propose(
                    active_user_turn_id, utterance_frames, truncated=utterance_truncated,
                )

            clean_rms = EnergyVAD.rms(
                clean_frame
            )

            # ============================================
            # SILERO SPEECH START
            # ============================================

            if vad_event == "start":

                speech_segment_active = True
                gate_state = "candidate"

                rms_history.clear()

                accepted_user_speech = False
                active_user_turn_id = None

                accept_streak = 0
                reenter_streak = 0
                strong_streak = 0

                print(
                    "[Kei Speech Gate] candidate:",
                    f"p={vad.last_probability:.3f}",
                )

            # ============================================
            # SPEECH GATE
            #
            # 注意：
            # 不是只在 vad_event == start 时判断。
            #
            # 只要 Silero 认为当前仍处于语音段，
            # 每一帧都会重新更新 rolling RMS。
            # ============================================

            if speech_segment_active:

                rms_history.append(
                    clean_rms
                )

                # 至少先积累约 80 ms
                if (
                    len(rms_history)
                    >= NEAR_FIELD_MIN_FRAMES
                ):

                    sorted_rms = sorted(
                        rms_history
                    )

                    # 75% 分位数
                    p75_index = int(
                        0.75
                        * (len(sorted_rms) - 1)
                    )

                    gate_rms = sorted_rms[
                        p75_index
                    ]

                    # ============================================
                    # Speech Gate state machine
                    # ============================================

                    should_accept = False


                    # --------------------------------------------
                    # 1. 强近场快速通道
                    # --------------------------------------------

                    if gate_rms >= NEAR_FIELD_STRONG_RMS:

                        strong_streak += 1

                    else:

                        strong_streak = 0


                    if (
                        strong_streak
                        >= NEAR_FIELD_STRONG_CONFIRM_FRAMES
                    ):

                        should_accept = True


                    # --------------------------------------------
                    # 2. candidate → accepted
                    # --------------------------------------------

                    elif (
                        gate_state == "candidate"
                        and len(rms_history) >= NEAR_FIELD_WINDOW_FRAMES
                    ):
                        if gate_rms >= NEAR_FIELD_ACCEPT_RMS:
                            accept_streak += 1
                            if accept_streak >= NEAR_FIELD_ACCEPT_CONFIRM_FRAMES:
                                should_accept = True
                        elif gate_rms < NEAR_FIELD_REJECT_RMS:
                            gate_state = "ignored"

                            accept_streak = 0
                            reenter_streak = 0
                            strong_streak = 0

                            print(
                                "[Kei Speech Gate] ignored:",
                                f"instant={clean_rms:.1f}",
                                f"p75={gate_rms:.1f}",
                            )
                        else:
                            accept_streak = 0


                    # --------------------------------------------
                    # 3. ignored → accepted
                    # --------------------------------------------

                    elif gate_state == "ignored":

                        if gate_rms >= NEAR_FIELD_REENTER_RMS:

                            reenter_streak += 1

                        else:

                            reenter_streak = 0

                        if (
                            reenter_streak
                            >= NEAR_FIELD_REENTER_CONFIRM_FRAMES
                        ):

                            should_accept = True


                    # ============================================
                    # ACCEPT
                    # ============================================

                    if (
                        should_accept
                        and
                        gate_state != "accepted"
                    ):

                        old_state = gate_state

                        gate_state = "accepted"
                        accepted_user_speech = True

                        continuation_merged = False

                        # ========================================
                        # Merge with a held utterance, if any
                        # ========================================
                        #
                        # Speech resumed inside the merge window: this is the
                        # continuation of the same question, so the audio is
                        # joined and transcribed once instead of being split
                        # into two turns.

                        if pending_utterance is not None:

                            merged_turn_id = pending_utterance["turn_id"]

                            utterance_frames = list(
                                pending_utterance["frames"]
                            )

                            utterance_truncated = pending_utterance["truncated"]

                            held_frames = len(utterance_frames)

                            pending_utterance = None

                            active_user_turn_id = merged_turn_id

                            continuation_merged = True

                            print(
                                "[Kei Capture] merged continuation:",
                                f"turn_id={merged_turn_id}",
                                f"held_frames={held_frames}",
                            )

                            speech_pre_roll.clear()

                            # Execution continues through the VAD and start
                            # handling below for this same frame; the normal
                            # capture initialisation is skipped because the
                            # merged frames are already in place.

                        else:

                            # ========================================
                            # Start Complete Utterance Capture
                            # ========================================

                            # 把 Gate 确认之前最近约 300 ms 的音频
                            # 作为这句话的开头。
                            utterance_frames = list(
                                speech_pre_roll
                            )

                            utterance_truncated = False

                            print(
                                "[Kei Capture] started:",
                                f"pre_roll_frames={len(utterance_frames)}",
                                f"pre_roll_ms="
                                f"{len(utterance_frames) * MIC_FRAME_MS}",
                            )

                        print(
                            "[Kei Speech Gate] accepted:",
                            f"from={old_state}",
                            f"instant={clean_rms:.1f}",
                            f"p75={gate_rms:.1f}",
                        )

                        if not continuation_merged:

                            # ========================================
                            # USER SPEECH START
                            # ========================================

                            active_user_turn_id = uuid4().hex

                            speech_start_event = {
                                "type": "user.speech.start",
                                "session_id": "local-microphone",
                                "turn_id": active_user_turn_id,
                                "text": None,
                                "payload": {
                                    "source": "microphone",
                                    "vad": "silero",
                                    "silero_probability":
                                        vad.last_probability,
                                    "instant_rms":
                                        clean_rms,
                                    "gate_rms_p75":
                                        gate_rms,
                                },
                                "timestamp":
                                    datetime.now(
                                        timezone.utc
                                    ).isoformat(),
                            }

                            await broadcast_event(
                                speech_start_event
                            )

                            # ========================================
                            # BARGE-IN
                            # ========================================

                            await interrupt_agent_work()


                    # ============================================
                    # REJECT / IGNORE
                    # ============================================

                    elif (
                        gate_state == "candidate"
                        and
                        len(rms_history)
                        >= NEAR_FIELD_WINDOW_FRAMES
                        and
                        gate_rms < NEAR_FIELD_REJECT_RMS
                    ):

                        gate_state = "ignored"

                        accept_streak = 0
                        reenter_streak = 0
                        strong_streak = 0

                        print(
                            "[Kei Speech Gate] ignored:",
                            "voice detected but far",
                            f"instant={clean_rms:.1f}",
                            f"p75={gate_rms:.1f}",
                            f"reject_threshold="
                            f"{NEAR_FIELD_REJECT_RMS:.1f}",
                        )

                    # ====================================
                    # HYSTERESIS AREA
                    # ====================================
                    #
                    # 500 <= p75 < 700
                    #
                    # 不 accept
                    # 不 reject
                    #
                    # 继续观察后续帧。
                    #
                    # 如果之前已经 ignored，
                    # 后面用户靠近导致 p75 >= 700，
                    # 上面的 ACCEPT 分支仍然可以触发。
                    # ===================================
            
            # ============================================
            # SILERO SPEECH END
            # ============================================

            if vad_event == "end":

                # 只有真正 accepted 的用户语音，
                # 才发送 user.speech.end。
                #
                # 远场 ignored 语音不应该制造
                # 一个没有 start 的 end。

                if (
                    accepted_user_speech
                    and
                    active_user_turn_id
                    is not None
                ):

                    speech_end_event = {
                        "type":
                            "user.speech.end",

                        "session_id":
                            "local-microphone",

                        "turn_id":
                            active_user_turn_id,

                        "text":
                            None,

                        "payload": {
                            "source":
                                "microphone",

                            "vad":
                                "silero",
                        },

                        "timestamp":
                            datetime.now(
                                timezone.utc
                            ).isoformat(),
                    }

                    await broadcast_event(
                        speech_end_event
                    )

                    # ========================================
                    # Hold, don't commit yet
                    # ========================================
                    #
                    # A natural pause inside one question must not split it into
                    # two turns. Keep the audio briefly: if speech resumes within
                    # UTTERANCE_MERGE_MS the merge branch below appends it, and
                    # the deadline check at the top of the loop commits it
                    # unchanged when nothing follows.

                    if UTTERANCE_MERGE_MS > 0:
                        if pending_utterance is not None:
                            # Two finalizations in a row: commit the older one
                            # so audio is never reordered or lost.
                            await commit_utterance(
                                pending_utterance["turn_id"],
                                pending_utterance["frames"],
                                pending_utterance["truncated"],
                            )
                        pending_utterance = {
                            "turn_id": active_user_turn_id,
                            "frames": list(utterance_frames),
                            "truncated": utterance_truncated,
                            "_merge_deadline_perf":
                                time.perf_counter()
                                + UTTERANCE_MERGE_MS / 1000.0,
                        }
                        print(
                            "[Kei Capture] held for merge:",
                            f"turn_id={active_user_turn_id}",
                            f"frames={len(utterance_frames)}",
                            f"window={UTTERANCE_MERGE_MS}ms",
                        )
                    else:
                        await commit_utterance(
                            active_user_turn_id,
                            utterance_frames,
                            utterance_truncated,
                        )

                # ========================================
                # RESET STATE
                # ========================================

                speech_segment_active = False

                accepted_user_speech = False

                active_user_turn_id = None

                gate_state = "idle"

                rms_history.clear()

                utterance_frames = []
                utterance_truncated = False

                speech_pre_roll.clear()

    except asyncio.CancelledError:
        raise

    except Exception as exc:

        print(
            "[Kei Mic] microphone/VAD failed:",
            repr(exc),
        )

    finally:
        await voice_capture.discard("microphone_stopped", broadcast_event)
        speculative_asr.invalidate()
        await microphone.stop()

async def asr_worker():
    """
    utterance_queue
        ↓
    Faster Whisper
        ↓
    user.transcript
    """

    try:
        # 模型加载可能很慢，
        # 不能阻塞 FastAPI event loop。
        await speculative_asr.load()

        while True:

            utterance = await utterance_queue.get()

            try:
                turn_id = utterance["turn_id"]

                print(
                    "[Kei ASR] transcribing:",
                    f"turn_id={turn_id}",
                    f"duration={utterance['duration_ms']}ms",
                )

                await broadcast_event(
                    {
                        "type": "asr.start",
                        "session_id":
                            utterance["session_id"],
                        "turn_id":
                            turn_id,
                        "text":
                            None,
                        "payload": {
                            "duration_ms":
                                utterance["duration_ms"],
                        },
                        "timestamp":
                            datetime.now(
                                timezone.utc
                            ).isoformat(),
                    }
                )

                started = time.perf_counter()

                result, asr_timing = await speculative_asr.transcribe(
                    utterance["pcm"], utterance.get("_asr_candidate"),
                )
                print(f"[Kei ASR] final_ready turn_id={turn_id} {asr_timing}", flush=True)

                latency_ms = int(
                    (
                        time.perf_counter()
                        - started
                    )
                    * 1000
                )

                text = (
                    result["text"]
                    .strip()
                )

                if not text:

                    print(
                        "[Kei ASR] empty transcript:",
                        turn_id,
                    )

                    await broadcast_event(
                        {
                            "type": "asr.empty",
                            "session_id":
                                utterance["session_id"],
                            "turn_id":
                                turn_id,
                            "text":
                                None,
                            "payload": {
                                "latency_ms":
                                    latency_ms,
                            },
                            "timestamp":
                                datetime.now(
                                    timezone.utc
                                ).isoformat(),
                        }
                    )

                    continue

                print(
                    "[Kei ASR] transcript:",
                    repr(text),
                    f"latency={latency_ms}ms",
                )

                await broadcast_event(
                    {
                        "type": "user.transcript",

                        "session_id":
                            utterance["session_id"],

                        "turn_id":
                            turn_id,

                        "text":
                            text,

                        "payload": {
                            "source":
                                "microphone",

                            "asr":
                                result.get("engine", asr_engine.active),

                            **asr_timing,

                            "model":
                                asr_engine.model_size,

                            "language":
                                result["language"],

                            "language_probability":
                                result[
                                    "language_probability"
                                ],

                            "audio_duration_ms":
                                utterance[
                                    "duration_ms"
                                ],

                            "latency_ms":
                                latency_ms,
                        },

                        "timestamp":
                            datetime.now(
                                timezone.utc
                            ).isoformat(),
                    }
                )

            
    
                # ============================================================
                # user.transcript -> AstrBot input queue
                # ============================================================

                astrbot_item = {
                    "turn_id": turn_id,
                    "text": text,
                }

                if astrbot_input_queue.full():

                    try:
                        dropped = (
                            astrbot_input_queue.get_nowait()
                        )

                        astrbot_input_queue.task_done()

                        print(
                            "[Kei AstrBot] dropped old request:",
                            dropped.get("turn_id"),
                        )

                    except asyncio.QueueEmpty:
                        pass

                astrbot_input_queue.put_nowait(
                    astrbot_item
                )

                print(
                    "[Kei AstrBot] queued:",
                    f"turn_id={turn_id}",
                    repr(text),
                )

            except Exception as exc:

                print(
                    "[Kei ASR] transcription failed:",
                    repr(exc),
                )

                await broadcast_event(
                    {
                        "type":
                            "asr.error",

                        "session_id":
                            utterance.get(
                                "session_id",
                                "local-microphone",
                            ),

                        "turn_id":
                            utterance.get(
                                "turn_id"
                            ),

                        "text":
                            None,

                        "payload": {
                            "error": repr(exc)
                        },

                        "timestamp":
                            datetime.now(
                                timezone.utc
                            ).isoformat(),
                    }
                )

            finally:
                utterance_queue.task_done()
 
    except asyncio.CancelledError:
        raise

    except Exception as exc:
        print(
            "[Kei ASR] worker failed:",
            repr(exc),
        )

async def run_desktop_turn(text: str, turn_id: str):
    """Speak independent Japanese sentences through the existing local TTS queue."""
    global pending_reply_turn_id, active_agent_turn_id
    started = time.perf_counter()
    generation = desktop_playback_generation
    sequence = 0

    async def sentence_ready(sentence):
        nonlocal sequence
        if turn_id in cancelled_agent_turns or generation != desktop_playback_generation:
            raise asyncio.CancelledError()
        while translation_queue.full():
            await asyncio.sleep(0.02)
        if not enqueue_translation(
            session_id="kei-desktop", turn_id=turn_id, text=sentence,
            payload={"source_language": "ja", "source": "desktop_direct"},
            reply_received_perf=started, segment_offset=sequence, finalize=False,
        ):
            raise asyncio.CancelledError()
        sequence += len(split_reply_for_translation(sentence))
        if sequence == 1:
            print(f"[Kei Direct] turn={turn_id} first_sentence={round((time.perf_counter()-started)*1000)}ms")

    desktop_chat.thread_event = broadcast_event
    async def run_tool(request, session, task_id=None, model=None, child_roles=None):
        if executor_manager.config['backend'] != 'astrbot':
            desktop_chat.tool_session = executor_manager
            backend = executor_manager.config['backend']
            await receive_event(RuntimeEvent(type="agent.tool.start", session_id="kei-desktop",
                turn_id=turn_id, payload={"tool_name": backend + "_task"}))
            try:
                return await executor_manager.run(request, session, task_id, model=model, child_roles=child_roles)
            finally:
                desktop_chat.tool_session = None
                await receive_event(RuntimeEvent(type="agent.tool.end", session_id="kei-desktop",
                    turn_id=turn_id, payload={"tool_name": backend + "_task"}))
        client = AstrBotClient(base_url=ASTRBOT_BASE_URL, api_key=ASTRBOT_API_KEY,
                               session_id="kei-desktop-task-" + session)
        desktop_chat.tool_session = client
        fragments = []

        def collect(item):
            if item.get("type") == "plain" and item.get("chain_type") in (None, "", "plain"):
                if isinstance(item.get("data"), str):
                    fragments.append(item["data"])

        await receive_event(RuntimeEvent(type="agent.tool.start", session_id="kei-desktop",
                                         turn_id=turn_id, payload={"tool_name": "astrbot_task"}))
        try:
            await client.send_message(request, voice_turn_id=turn_id, on_stream_event=collect)
            return "".join(fragments) or "The task returned no visible result; do not claim success."
        finally:
            desktop_chat.tool_session = None
            await client.close()
            await receive_event(RuntimeEvent(type="agent.tool.end", session_id="kei-desktop",
                                             turn_id=turn_id, payload={"tool_name": "astrbot_task"}))

    async def search_event(kind, search_turn):
        await receive_event(RuntimeEvent(
            type=kind, session_id="kei-desktop", turn_id=search_turn,
            payload={"tool_name": "desktop_web_search", "activity": "searching"},
        ))

    desktop_chat.tool_event_sink = search_event
    await receive_event(RuntimeEvent(type="agent.begin", session_id="kei-desktop", turn_id=turn_id,
                                     payload={"source": "desktop_direct", "activity": "thinking"}))
    try:
        answer = await desktop_chat.answer(text, turn_id, sentence_ready, run_tool)
        await receive_event(RuntimeEvent(type="agent.done", session_id="kei-desktop", turn_id=turn_id,
                                         payload={"status": "completed", "has_reply": True}))
        pending_reply_turn_id = turn_id
        await broadcast_event({"type": "assistant.reply", "session_id": "kei-desktop", "turn_id": turn_id,
                               "text": answer, "payload": {"source_language": "ja", "direct_tts": True},
                               "timestamp": datetime.now(timezone.utc).isoformat()})
        while translation_queue.full():
            await asyncio.sleep(0.02)
        enqueue_translation(session_id="kei-desktop", turn_id=turn_id, text=STREAM_FINALIZE_MARKER,
                            payload={"source_language": "ja"}, segment_offset=sequence, finalize=True)
    except BaseException as exc:
        if active_agent_turn_id == turn_id:
            active_agent_turn_id = None
        if pending_reply_turn_id == turn_id:
            pending_reply_turn_id = None
        cancelled_agent_turns.add(turn_id)
        await speech_controller.interrupt(turn_id=turn_id)
        await receive_event(RuntimeEvent(type="task.cancel", session_id="kei-desktop", turn_id=turn_id,
                                         payload={"reason": type(exc).__name__}))
        raise


async def astrbot_worker():
    """
    Stage 6C

    ASR transcript
        ↓
    astrbot_input_queue
        ↓
    AstrBot OpenAPI
        ↓
    AstrBot Agent
        ↓
    astrbot_plugin_kei
        ↓
    assistant.reply
    """

    global astrbot_send_task, active_voice_turn_id
    if astrbot_client is None:

        print(
            "[Kei AstrBot] disabled: "
            "ASTRBOT_API_KEY is not set"
        )

        return


    print(
        "[Kei AstrBot] bridge ready"
    )


    try:

        while True:

            item = await (
                astrbot_input_queue.get()
            )

            try:

                text = (
                    item["text"]
                    .strip()
                )

                voice_turn_id = (
                    item["turn_id"]
                )


                print(
                    "[Kei AstrBot] send:",
                    f"voice_turn_id={voice_turn_id}",
                    repr(text),
                )


                await broadcast_event(
                    {
                        "type":
                            "astrbot.request",

                        "session_id":
                            "kei-local-voice",

                        "turn_id":
                            voice_turn_id,

                        "text":
                            text,

                        "payload": {
                            "source":
                                item.get("source", "microphone"),

                            "voice_turn_id":
                                voice_turn_id,
                        },

                        "timestamp":
                            datetime.now(
                                timezone.utc
                            ).isoformat(),
                    }
                )


                started = time.perf_counter()
                input_received = item.get("_input_received_perf")
                if input_received is not None:
                    print(f"[Kei Latency] voice_turn_id={voice_turn_id} "
                          f"stage=astrbot.input_queue elapsed={int((started-input_received)*1000)}ms")

                if desktop_chat and not desktop_clients and item.get("source", "microphone") == "microphone":
                    continue
                if desktop_chat and desktop_clients:
                    active_voice_turn_id = voice_turn_id
                    astrbot_send_task = asyncio.create_task(run_desktop_turn(text, voice_turn_id))
                    try:
                        await astrbot_send_task
                    except asyncio.CancelledError:
                        if asyncio.current_task().cancelling():
                            raise
                    finally:
                        astrbot_send_task = None
                        active_voice_turn_id = None
                    continue

                collector = ReplySentenceCollector(limit=2)
                prefetch_queue = asyncio.Queue(maxsize=2)

                # Generation-time streaming: committed answer sentences are
                # translated and spoken while the model is still generating.
                early_active = EARLY_TTS_ENABLED and TRANSLATION_MODE == "local"
                stream_buffer = (
                    StreamingSentenceBuffer(max_buffer_chars=LEDGER_MAX_CHARS)
                    if early_active
                    else None
                )
                stream_state = {"first_delta_logged": False, "mutated": False}

                if early_active:
                    register_turn_seed(voice_turn_id, source=item.get("source", "microphone"))
                    active_voice_turn_id = voice_turn_id

                def collect_stream(
                    item,
                    stream_buffer=stream_buffer,
                    stream_state=stream_state,
                    voice_turn_id=voice_turn_id,
                    started=started,
                    collector=collector,
                    prefetch_queue=prefetch_queue,
                ):
                    if TRANSLATION_MODE != "local":
                        return

                    if stream_buffer is not None and not stream_state["mutated"]:
                        # First visible answer delta is the true start of the
                        # user-facing answer, separate from reasoning.
                        if (not stream_state["first_delta_logged"]
                                and item.get("type") == "plain"
                                and item.get("chain_type") in (None, "", "plain")
                                and isinstance(item.get("data"), str)
                                and item["data"].strip()):
                            stream_state["first_delta_logged"] = True
                            note_stream_answer_delta(
                                voice_turn_id,
                                int((time.perf_counter() - started) * 1000),
                            )

                        sentences = stream_buffer.feed(item)

                        if stream_buffer.muted:
                            early_reply_ledger.note_mute(
                                voice_turn_id,
                                stream_buffer.mute_reason,
                            )
                            note_stream_mute(
                                voice_turn_id,
                                stream_buffer.mute_reason,
                            )
                            stream_state["mutated"] = True

                        for sentence in sentences:
                            if not early_reply_ledger.can_emit(voice_turn_id):
                                break
                            if commit_early_sentence(
                                voice_turn_id,
                                sentence,
                                int((time.perf_counter() - started) * 1000),
                            ):
                                stream_state["mutated"] = True

                    for sentence in collector.feed(item):
                        if not prefetch_queue.full():
                            prefetch_queue.put_nowait(sentence)
                            print(f"[Kei Latency] voice_turn_id={voice_turn_id} "
                                  f"stage=translation.prefetch.queued elapsed={int((time.perf_counter()-started)*1000)}ms")

                async def prefetch_translation(
                    prefetch_queue=prefetch_queue,
                    voice_turn_id=voice_turn_id,
                    started=started,
                ):
                    while True:
                        sentence = await prefetch_queue.get()
                        try:
                            await translator.translate_zh_to_ja(sentence)
                            print(f"[Kei Latency] voice_turn_id={voice_turn_id} "
                                  f"stage=translation.prefetch.ready elapsed={int((time.perf_counter()-started)*1000)}ms")
                        except Exception as exc:
                            print(f"[Kei Translation] prefetch skipped: {type(exc).__name__}")
                        finally:
                            prefetch_queue.task_done()

                prefetch_task = asyncio.create_task(prefetch_translation())
                astrbot_send_task = asyncio.create_task(astrbot_client.send_message(
                    text, voice_turn_id=voice_turn_id, on_stream_event=collect_stream))
                try:
                    await astrbot_send_task
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling():
                        raise
                    print("[Kei AstrBot] active request interrupted")
                    continue
                finally:
                    prefetch_task.cancel()
                    await asyncio.gather(prefetch_task, return_exceptions=True)
                    astrbot_send_task = None
                    # Stream bookkeeping for this turn is only needed until the
                    # authoritative reply has been handed over above.
                    early_reply_ledger.discard(voice_turn_id)
                    forget_turn_ids(voice_turn_id)
                    if active_voice_turn_id == voice_turn_id:
                        active_voice_turn_id = None

                elapsed_ms = int(
                    (
                        time.perf_counter()
                        - started
                    )
                    * 1000
                )


                print(
                    "[Kei AstrBot] request completed:",
                    f"voice_turn_id={voice_turn_id}",
                    f"elapsed={elapsed_ms}ms",
                )


            except Exception as exc:

                print(
                    "[Kei AstrBot] request failed:",
                    repr(exc),
                )


                await broadcast_event(
                    {
                        "type":
                            "astrbot.error",

                        "session_id":
                            "kei-local-voice",

                        "turn_id":
                            item.get(
                                "turn_id"
                            ),

                        "text":
                            None,

                        "payload": {
                            "error":
                                repr(exc),
                        },

                        "timestamp":
                            datetime.now(
                                timezone.utc
                            ).isoformat(),
                    }
                )


            finally:

                astrbot_input_queue.task_done()


    except asyncio.CancelledError:

        raise

def split_reply_for_translation(
    text: str,
    max_chars: int = 72,
) -> list[str]:
    """Split Chinese into translation-sized semantic units.

    Translation quality has priority here.  We keep complete Chinese sentences
    together whenever possible; comma-level splitting is only a fallback for
    unusually long sentences.  Low-latency TTS splitting happens *after* the
    Japanese translation, not here.
    """
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []

    sentences = [
        part.strip()
        for part in re.findall(r".+?(?:[。！？!?；;]+|$)", text)
        if part.strip()
    ]

    result: list[str] = []
    for sentence in sentences:
        if len(sentence) <= max_chars:
            result.append(sentence)
            continue

        # Only very long sentences fall back to clause boundaries.
        clauses = [
            part.strip()
            for part in re.findall(r".+?(?:[，,、：:]+|$)", sentence)
            if part.strip()
        ]
        buffer = ""
        for clause in clauses:
            if not buffer:
                buffer = clause
                continue
            if len(buffer) + len(clause) <= max_chars:
                buffer += clause
                continue
            result.append(buffer.strip())
            buffer = clause
        if buffer:
            result.append(buffer.strip())

    return result


def normalize_japanese_for_tts(text: str) -> str:
    """TTS-only Japanese cleanup.

    The visible assistant.translation stays untouched.  This function only
    prepares the text sent to Aqua-TTS.
    """
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""

    # Remove accidental spaces *inside* Japanese/CJK text while preserving
    # ordinary ASCII word spacing when it is genuinely needed.
    jp = r"\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f"
    text = re.sub(fr"(?<=[{jp}])\s+(?=[{jp}])", "", text)
    text = re.sub(fr"(?<=[{jp}])\s+(?=[、。，！？：；])", "", text)
    text = re.sub(fr"(?<=[、。，！？：；])\s+(?=[{jp}])", "", text)

    # GPT-SoVITS produced an ~0.6 s pause for sentence-initial 「先生、」.
    # Keep punctuation in assistant.translation/subtitles, remove it only on
    # the audio path.
    text = re.sub(r"^先生[、，]\s*", "先生", text)
    return text


def _choose_japanese_cut(
    text: str,
    *,
    target_chars: int,
    max_chars: int,
    min_chars: int,
) -> int:
    """Choose a natural Japanese cut point inside the requested window."""
    limit = min(len(text), max_chars)
    if len(text) <= max_chars:
        return len(text)

    candidates: list[tuple[int, int, int]] = []

    # Highest priority: explicit minor punctuation.
    for pos in range(min_chars, limit + 1):
        if text[pos - 1] in "、，,：:；;":
            candidates.append((0, abs(pos - target_chars), -pos))

    # Next: Japanese particles / grammatical boundaries.  Longer endings get
    # priority over one-character particles.
    strong_boundaries = (
        "ために", "までに", "ならば", "けれど", "けど",
        "ので", "から", "まで", "ても", "では", "には",
    )
    weak_boundaries = (
        "は", "が", "を", "に", "で", "と", "へ", "も", "の",
    )

    for pos in range(min_chars, limit + 1):
        prefix = text[:pos]
        if any(prefix.endswith(token) for token in strong_boundaries):
            candidates.append((1, abs(pos - target_chars), -pos))
        elif any(prefix.endswith(token) for token in weak_boundaries):
            candidates.append((2, abs(pos - target_chars), -pos))

    if candidates:
        priority, distance, neg_pos = min(candidates)
        return -neg_pos

    # Last resort.  This is intentionally rare because translation units are
    # already sentence-sized and Japanese punctuation/particles are preferred.
    return limit


def split_japanese_for_tts(
    text: str,
    *,
    first_utterance: bool,
) -> list[str]:
    """Split translated Japanese into low-latency Aqua-TTS units.

    First utterance: target ~12 chars, hard ceiling 17.
    Later utterances: target ~18 chars, hard ceiling 22.
    """
    text = normalize_japanese_for_tts(text)
    if not text:
        return []

    # Keep sentence-ending punctuation attached to the preceding text.
    major_parts = [
        part.strip()
        for part in re.findall(r".+?(?:[。！？!?]+|$)", text)
        if part.strip()
    ]

    output: list[str] = []
    is_first_piece = first_utterance

    for part in major_parts:
        remaining = part
        while remaining:
            if is_first_piece:
                target_chars = 12
                max_chars = 17
                min_chars = 7
            else:
                target_chars = 18
                max_chars = 22
                min_chars = 9

            if len(remaining) <= max_chars:
                piece = remaining.strip()
                remaining = ""
            else:
                cut = _choose_japanese_cut(
                    remaining,
                    target_chars=target_chars,
                    max_chars=max_chars,
                    min_chars=min_chars,
                )
                piece = remaining[:cut].strip()
                remaining = remaining[cut:].strip()

            if piece:
                output.append(piece)
                is_first_piece = False

    # Avoid a tiny final fragment when merging it back remains within a modest
    # bound.  This improves prosody without making the first utterance long.
    if len(output) >= 2 and len(output[-1]) < 6:
        merged = output[-2] + output[-1]
        merge_limit = 22 if len(output) > 2 or not first_utterance else 17
        if len(merged) <= merge_limit:
            output[-2] = merged
            output.pop()

    return output


async def translation_worker():
    """assistant.reply -> semantic translation -> one Aqua utterance per Japanese semantic segment."""
    print(
        "[Kei Translation] worker ready:",
        f"mode={TRANSLATION_MODE}",
    )

    try:
        while True:
            item = await translation_queue.get()

            try:
                turn_id = item["turn_id"]
                if not local_playback_allowed(item):
                    continue
                session_id = item["session_id"]
                reply_received_perf = item.get("_reply_received_perf")
                source_text = item["text"].strip()

                if not source_text:
                    continue

                # End-of-turn marker: the streamed sentences were already spoken
                # earlier in this turn, so all that is left is to close the turn
                # in the same order a spoken final segment would.
                if item.get("finalize") and source_text == STREAM_FINALIZE_MARKER:
                    if turn_id in cancelled_agent_turns:
                        continue
                    await speech_controller.submit_event(
                        {
                            "type": "stream.finalize",
                            "_desktop_generation": item["_desktop_generation"],
                            "session_id": session_id,
                            "turn_id": turn_id,
                            "text": None,
                            "payload": {
                                "status": "completed",
                                "segment_final": True,
                                "segment_index": int(item.get("segment_offset", 0)) or 1,
                                "segment_count": int(item.get("segment_offset", 0)) or 1,
                                "reason": "streamed_turn_complete",
                            },
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        }
                    )
                    continue

                semantic_segments = split_reply_for_translation(source_text)
                if not semantic_segments:
                    continue

                semantic_count = len(semantic_segments)
                sequence_offset = int(item.get("segment_offset", 0) or 0)
                # Only the authoritative reply carries the end of the turn. An
                # early item is never the final segment, whatever its index.
                turn_final_item = bool(item.get("finalize"))
                tts_sequence_index = sequence_offset

                print(
                    "[Kei Chunker]",
                    f"turn_id={turn_id}",
                    "mode=translation-semantic",
                    f"segments={semantic_count}",
                    f"sequence_offset={sequence_offset}",
                    f"turn_final={turn_final_item}",
                )

                for semantic_zero_index, segment in enumerate(semantic_segments):
                    if turn_id in cancelled_agent_turns or not local_playback_allowed(item):
                        break
                    semantic_index = semantic_zero_index + 1
                    semantic_final = (
                        turn_final_item
                        and semantic_zero_index == semantic_count - 1
                    )
                    translation_started_perf = time.perf_counter()

                    if reply_received_perf is not None:
                        reply_elapsed_ms = int(
                            (translation_started_perf - reply_received_perf) * 1000
                        )
                    else:
                        reply_elapsed_ms = None

                    print(
                        "[Kei Translation]",
                        f"turn_id={turn_id}",
                        f"semantic_segment={semantic_index}/{semantic_count}",
                        repr(segment),
                    )

                    await broadcast_event(
                        {
                            "type": "translation.start",
                            "session_id": session_id,
                            "turn_id": turn_id,
                            "text": segment,
                            "payload": {
                                "source_language": item.get("reply_payload", {}).get("source_language", "zh"),
                                "target_language": "ja",
                                "mode": "direct-ja" if item.get("reply_payload", {}).get("source_language") == "ja" else TRANSLATION_MODE,
                                "segment_index": semantic_index,
                                "segment_count": semantic_count,
                                "segment_final": semantic_final,
                                "reply_elapsed_ms": reply_elapsed_ms,
                            },
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        }
                    )

                    started = time.perf_counter()
                    direct_japanese = item.get("reply_payload", {}).get("source_language") == "ja"
                    translated_text = (segment if direct_japanese else
                                       await translator.translate_zh_to_ja(segment)).strip()

                    if turn_id in cancelled_agent_turns or not local_playback_allowed(item):
                        break
                    if not translated_text:
                        raise RuntimeError("Translator returned empty text")

                    translation_done_perf = time.perf_counter()
                    latency_ms = int((translation_done_perf - started) * 1000)

                    if reply_received_perf is not None:
                        reply_to_translation_ms = int(
                            (translation_done_perf - reply_received_perf) * 1000
                        )
                    else:
                        reply_to_translation_ms = None

                    print(
                        "[Kei Latency]",
                        f"turn_id={turn_id}",
                        f"semantic_segment={semantic_index}/{semantic_count}",
                        f"translation={latency_ms}ms",
                        f"reply_to_translation={reply_to_translation_ms}ms",
                    )

                    # Broadcast the complete Japanese translation.  This is the
                    # text Desktop/subtitles should treat as the translation.
                    translation_event = {
                        "type": "assistant.translation",
                        "session_id": session_id,
                        "turn_id": turn_id,
                        "text": translated_text,
                        "payload": {
                            "source": "translation",
                            "source_text": segment,
                            "source_language": "ja" if direct_japanese else "zh",
                            "target_language": "ja",
                            "mode": "direct-ja" if direct_japanese else TRANSLATION_MODE,
                            "latency_ms": latency_ms,
                            "segment_index": semantic_index,
                            "segment_count": semantic_count,
                            "segment_final": semantic_final,
                        },
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                    await broadcast_event(translation_event)

                    affect = item.get("affect") or {}
                    affect_label = item.get("affect_label", "neutral")

                    tts_text = normalize_japanese_for_tts(translated_text)

                    # IMPORTANT:
                    # Do not split one Japanese semantic sentence into multiple
                    # independent Aqua-TTS requests.  Each request resets
                    # GPT-SoVITS prosody / acoustic context and sounds choppy
                    # even when playback itself is gapless.
                    #
                    # Aqua already performs true V3 streaming internally, so
                    # one complete Japanese semantic sentence should stay one
                    # TTS utterance.
                    tts_parts = [tts_text] if tts_text else []

                    if not tts_parts:
                        continue

                    print(
                        "[Kei TTS Scheduler]",
                        f"turn_id={turn_id}",
                        f"semantic_segment={semantic_index}/{semantic_count}",
                        "mode=semantic-utterance",
                        "parts=1",
                        repr(tts_text),
                    )

                    for part_zero_index, tts_part in enumerate(tts_parts):
                        tts_part_index = part_zero_index + 1
                        tts_part_count = len(tts_parts)
                        tts_part_final = tts_part_index == tts_part_count
                        overall_final = semantic_final and tts_part_final
                        tts_sequence_index += 1

                        tts_event = {
                            "type": "tts.request",
                            "session_id": session_id,
                            "turn_id": turn_id,
                            "text": tts_part,
                            "payload": {
                                "source": "assistant.translation",
                                "language": "ja",
                                # Keep the complete Chinese semantic segment for
                                # subtitles; do not expose the TTS-only rewrite as
                                # the user's visible translation.
                                "source_text": segment,
                                "translated_text": translated_text,
                                "translation_mode": "direct-ja" if direct_japanese else TRANSLATION_MODE,
                                "segment_index": semantic_index,
                                "segment_count": semantic_count,
                                "segment_final": overall_final,
                                "semantic_segment_final": semantic_final,
                                "tts_part_index": tts_part_index,
                                "tts_part_count": tts_part_count,
                                "tts_part_final": tts_part_final,
                                "tts_sequence_index": tts_sequence_index,
                                "affect": affect,
                                "affect_label": affect_label,
                            },
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        }

                        # Broadcast only public fields.  Internal monotonic timing
                        # values are attached afterwards for SpeechController.
                        await broadcast_event(tts_event)

                        tts_request_perf = time.perf_counter()
                        tts_event["_reply_received_perf"] = reply_received_perf
                        tts_event["_translation_started_perf"] = (
                            translation_started_perf
                        )
                        tts_event["_translation_done_perf"] = translation_done_perf
                        tts_event["_tts_request_perf"] = tts_request_perf

                        print(
                            "[Kei Translation]",
                            "translation -> tts.request:",
                            f"turn_id={turn_id}",
                            f"semantic_segment={semantic_index}/{semantic_count}",
                            f"tts_part={tts_part_index}/{tts_part_count}",
                            f"tts_seq={tts_sequence_index}",
                            repr(tts_part),
                        )

                        # submit_event only queues work.  Translation can continue
                        # while SpeechController synthesizes/prefetches earlier TTS
                        # pieces.
                        await speech_controller.submit_event({
                            **tts_event,
                            "_desktop_generation": item["_desktop_generation"],
                        })

            except Exception as exc:
                print(
                    "[Kei Translation] failed:",
                    repr(exc),
                )
                await broadcast_event(
                    {
                        "type": "translation.error",
                        "session_id": item.get("session_id", "local"),
                        "turn_id": item.get("turn_id"),
                        "text": None,
                        "payload": {
                            "error": repr(exc),
                            "source_text": item.get("text", ""),
                        },
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                )
            finally:
                translation_queue.task_done()

    except asyncio.CancelledError:
        raise


microphone_vad_loop.last_debug = 0.0
microphone_vad_loop.last_vad_debug = 0.0

@app.on_event("startup")
async def runtime_startup():

    global microphone_task
    global asr_task
    global astrbot_task
    global translation_task

    # ============================================================
    # 1. Warm up local NLLB BEFORE microphone / ASR start
    # ============================================================

    if desktop_chat is None and TRANSLATION_MODE in {
        "local",
        "local_api_fallback",
        "api_local_fallback",
    }:
        try:
            print(
                "[Kei Runtime] warming up NLLB...",
                f"mode={TRANSLATION_MODE}",
            )

            # Force the heavyweight tokenizer / CTranslate2 model load before
            # microphone/VAD starts.  A lazy warmup is not sufficient here; if
            # loading happens on the first real reply it can starve PortAudio.
            await asyncio.to_thread(local_translator.load)

            warmup_method = getattr(local_translator, "warmup", None)
            if warmup_method is not None:
                await warmup_method()
            else:
                # Older LocalNLLBTranslator versions have no warmup() method.
                await local_translator.translate_zh_to_ja("你好。")

            print("[Kei Runtime] NLLB warmup ready")

        except Exception as exc:
            print(
                "[Kei Runtime] NLLB warmup failed:",
                repr(exc),
            )

    # ============================================================
    # 2. Start realtime workers
    # ============================================================

    executor_manager.start()
    bili_agent.start()
    if desktop_chat:
        await desktop_chat.start()
        # Exercise real synthesis before accepting speech; never play warmup PCM.
        try:
            async with asyncio.timeout(30):
                async for _ in aqua_client.stream_pcm("準備ができました。"):
                    pass
            print("[Kei TTS] full synthesis warmup ready")
        except Exception as exc:
            print(f"[Kei TTS] warmup deferred: {type(exc).__name__}")

    microphone_task = asyncio.create_task(
        microphone_vad_loop()
    )

    asr_task = asyncio.create_task(
        asr_worker()
    )

    astrbot_task = asyncio.create_task(
        astrbot_worker()
    )

    translation_task = asyncio.create_task(
        translation_worker()
    )

    print(
        "[Kei Runtime] microphone/VAD task started"
    )

    print(
        "[Kei Runtime] ASR worker started"
    )

    print(
        "[Kei Runtime] AstrBot bridge started"
    )

    print(
        "[Kei Runtime] Translation worker started"
    )

@app.on_event("shutdown")
async def runtime_shutdown():
    aqua_client.preview.clear()

    global microphone_task
    global asr_task
    global astrbot_task
    global translation_task


    tasks = [
        task
        for task in (
            microphone_task,
            asr_task,
            astrbot_task,
            translation_task,
        )
        if task is not None
    ]


    for task in tasks:
        task.cancel()


    if tasks:

        await asyncio.gather(
            *tasks,
            return_exceptions=True,
        )

    # Stop short-lived Prosody tasks before closing the analyzer.
    active_prosody_tasks = list(
        prosody_tasks
    )

    for task in active_prosody_tasks:
        task.cancel()

    if active_prosody_tasks:
        await asyncio.gather(
            *active_prosody_tasks,
            return_exceptions=True,
        )

    prosody_tasks.clear()


    microphone_task = None
    asr_task = None
    astrbot_task = None
    translation_task = None


    await microphone.stop()


    print(
        "[Kei Runtime] microphone/VAD stopped"
    )

    print(
        "[Kei Runtime] ASR worker stopped"
    )

    print(
        "[Kei Runtime] AstrBot worker stopped"
    )

    print(
        "[Kei Runtime] Translation worker stopped"
    )

    # Normal utterances keep the low-latency output stream alive.
    # Runtime shutdown is the place where it is actually closed.
    await audio_player.close()
    await speculative_asr.close()


    if astrbot_client is not None:
        await astrbot_client.close()


    if desktop_chat:
        await desktop_chat.close()
    await executor_manager.close()
    await bili_agent.close()
    await translator.close()
    await prosody_analyzer.close()

