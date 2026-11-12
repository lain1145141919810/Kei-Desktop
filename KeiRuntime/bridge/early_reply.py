"""Early (generation-time) reply streaming for the Kei voice path.

Why this module exists
----------------------
The Runtime already received AstrBot's answer deltas over SSE, but threw them
away and waited for the plugin's final ``assistant.reply`` before translating
and synthesizing. That put the whole translation + first-TTS-synthesis chain on
the post-generation critical path.

This module turns the *public answer* deltas into committed Chinese sentences
that can be translated and spoken while the model is still generating, while
guaranteeing the handover properties the audit demands:

* no half sentences (only punctuation-terminated sentences are committed),
* no missing tail (the authoritative final reply always plays whatever the
  stream did not),
* no duplicate playback (a per-turn ledger records exactly what was committed),
* no stale events (turns are isolated by voice turn id and can be closed).

Measured SSE facts this design relies on (see Kei_修改记录.md, M1-2):
* answer deltas are true increments with ``chain_type=None`` and ``streaming=True``,
* reasoning deltas are separated by ``chain_type='reasoning'``,
* the ``complete`` event equals the concatenation of the answer deltas,
* for tool turns, all answer text arrives *after* the tools finish, so simply
  gating on tool activity is enough to avoid speaking pre-tool chatter.
"""
from __future__ import annotations

import re

# Answer deltas whose chain_type is one of these are never user-facing answer
# text: reasoning, tool lifecycle, stats and stream control markers.
NON_ANSWER_CHAIN_TYPES = frozenset(
    {
        "reasoning",
        "tool_call",
        "tool_call_result",
        "tool_direct_result",
        "agent_stats",
        "tts_stats",
        "audio_chunk",
        "break",
        "json",
    }
)

# Marks the text collector mute for the rest of the turn; the final reply plays
# everything that was not committed.
TOOL_ACTIVITY_CHAIN_TYPES = frozenset(
    {"tool_call", "tool_call_result", "tool_direct_result"}
)

# Sentence terminators, identical to app.split_reply_for_translation so that
# streamed sentences and the final reply split into the same units.
SENTENCE_RE = re.compile(r".+?(?:[。！？!?；;]+|$)", re.S)

_WHITESPACE_RE = re.compile(r"\s+")
_FENCE_RE = re.compile(r"```.*?```", re.S)
_INLINE_CODE_RE = re.compile(r"`([^`]*)`")
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL_RE = re.compile(r"https?://\S+")
_MD_MARKS_RE = re.compile(r"[*#>|_~]+")


def normalize_segment(text: str) -> str:
    """Normalize one Chinese segment the way the final reply path does.

    Both the streamed sentence and the final reply segment go through this, so
    exact/lax comparison between them is meaningful.
    """
    return _WHITESPACE_RE.sub(" ", text or "").strip()


def compact_for_compare(text: str) -> str:
    """Drop whitespace and unify punctuation for prefix comparison."""
    compact = _WHITESPACE_RE.sub("", text or "")
    for source, target in (
        ("，", ","),
        ("。", "."),
        ("！", "!"),
        ("？", "?"),
        ("；", ";"),
        ("：", ":"),
        ("、", ","),
        ("\u3000", ""),
    ):
        compact = compact.replace(source, target)
    return compact


def clean_answer_text(text: str) -> str:
    """Light markdown cleanup for streamed text (mirrors plugin preparation)."""
    cleaned = _FENCE_RE.sub("", text)
    cleaned = _INLINE_CODE_RE.sub(r"\1", cleaned)
    cleaned = _MD_LINK_RE.sub(r"\1", cleaned)
    cleaned = _URL_RE.sub("", cleaned)
    cleaned = _MD_MARKS_RE.sub("", cleaned)
    return normalize_segment(cleaned)


def split_sentences(text: str) -> list[str]:
    """Split Chinese text into translation-sized semantic units."""
    text = normalize_segment(text)
    if not text:
        return []
    return [
        part.strip()
        for part in SENTENCE_RE.findall(text)
        if part.strip()
    ]


_CLAUSE_RE = re.compile(r".+?(?:[，,、：:]+|$)", re.S)
_TERMINATOR_RE = re.compile(r"[。！？!?；;]\s*$")


def _has_terminator(text: str) -> bool:
    return bool(_TERMINATOR_RE.search(text or ""))


def _shed_clauses(commit: list[str], max_chars: int, index: int = 0) -> tuple[list[str], str]:
    """Shed whole leading clauses of an over-long sentence inside ``commit``.

    Only used when the model is still writing one very long sentence: the
    leading clauses are already final text (a model never rewrites earlier
    characters), so they can be translated and spoken immediately. The trailing
    open clause is held back for the next delta.

    Returns ``(kept_commit, held)`` where ``held`` is prepended to the buffer.
    """
    sentence = commit[index]
    clauses = [
        part.strip()
        for part in _CLAUSE_RE.findall(sentence)
        if part.strip()
    ]
    if len(clauses) < 2:
        # No internal boundary available: wait for real punctuation instead.
        return commit, ""

    if _has_terminator(clauses[-1]):
        head, tail = clauses, ""
    else:
        head, tail = clauses[:-1], clauses[-1]
    if not head:
        return commit, ""

    kept: list[str] = []
    total = 0
    held = ""
    for clause in head:
        if kept and total + len(clause) > max_chars:
            held += clause
            continue
        kept.append(clause)
        total += len(clause)
    if not kept:
        return commit, ""
    if len(kept) == len(head) and not held and not tail:
        # Nothing was actually shed.
        return commit, ""
    if not held and not tail:
        return commit, ""
    return (
        commit[:index] + ["".join(kept)] + commit[index + 1:],
        held + tail,
    )


def _clause_split(sentences: list[str], max_chars: int) -> list[str]:
    """Mirror app.split_reply_for_translation's long-sentence fallback.

    Keeping this identical to the final reply path is what makes streamed
    sentences and final segments line up segment-for-segment.
    """
    result: list[str] = []
    for sentence in sentences:
        if len(sentence) <= max_chars:
            result.append(sentence)
            continue
        buffer = ""
        for clause in [
            part.strip()
            for part in _CLAUSE_RE.findall(sentence)
            if part.strip()
        ]:
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


class StreamingSentenceBuffer:
    """Accumulate SSE answer deltas and emit punctuation-complete sentences.

    The trailing (still-open) sentence is always withheld, so a half sentence is
    never committed. A long run without punctuation is committed at
    ``max_buffer_chars`` so a pathological reply cannot starve the turn.
    """

    def __init__(self, *, min_emit_chars: int = 9, max_buffer_chars: int = 72):
        self.min_emit_chars = max(1, int(min_emit_chars))
        self.max_buffer_chars = max(self.min_emit_chars, int(max_buffer_chars))
        self.buffer = ""
        self.muted = False
        self.mute_reason = ""

    def mute(self, reason: str) -> None:
        self.muted = True
        self.mute_reason = reason
        self.buffer = ""

    def feed(self, item: dict) -> list[str]:
        """Feed one SSE item and return newly committed, closed sentences."""
        if self.muted:
            return []

        chain_type = item.get("chain_type")
        if chain_type in TOOL_ACTIVITY_CHAIN_TYPES:
            self.mute("tool_activity")
            return []
        if chain_type in NON_ANSWER_CHAIN_TYPES:
            return []
        if item.get("type") != "plain":
            return []
        if chain_type not in (None, "", "plain"):
            return []

        data = item.get("data")
        if not isinstance(data, str) or not data:
            return []

        self.buffer = self.buffer + data if item.get("streaming") else data
        if len(self.buffer) > 8192:
            self.mute("buffer_budget")
            return []

        # An open code fence makes the cleaned text unstable; wait it out.
        if self.buffer.count("```") % 2:
            return []

        cleaned = clean_answer_text(self.buffer)
        raw = split_sentences(cleaned)
        if not raw:
            return []

        if len(raw) > 1:
            commit = raw[:-1]
            remainder = raw[-1]
            if commit and not _has_terminator(commit[-1]):
                # Never commit a sentence the model has not finished.
                remainder = commit[-1] + remainder
                commit = commit[:-1]
        else:
            commit = []
            remainder = raw[-1]

        # A still-growing long sentence: shed its complete leading clauses so
        # early synthesis can start before the whole sentence is finished.
        for index, sentence in enumerate(commit):
            if len(sentence) <= self.max_buffer_chars:
                continue
            trimmed, held = _shed_clauses(commit, self.max_buffer_chars, index)
            if trimmed is commit:
                continue
            commit = trimmed
            remainder = held + remainder
            break
        else:
            if not commit and len(remainder) > self.max_buffer_chars:
                trimmed, held = _shed_clauses([remainder], self.max_buffer_chars, 0)
                if trimmed is not [remainder] and trimmed and trimmed[0] != remainder:
                    commit = trimmed
                    remainder = held

        # Preserve the prefix: skipping a short sentence makes later commits
        # cease to be a prefix of the authoritative reply.
        ready = []
        pending_short = ""
        for sentence in commit:
            pending_short += sentence
            if len(pending_short) >= self.min_emit_chars:
                ready.append(pending_short)
                pending_short = ""
        remainder = pending_short + remainder
        # Never force an unfinished, punctuation-free sentence into speech.
        # The authoritative reply handles it; do not discard its prefix either.
        self.buffer = remainder
        return ready


class EarlyReplyLedger:
    """Per-turn record of what was already committed for translation/speech."""

    def __init__(self, max_segments: int = 6, max_chars: int = 72):
        self.max_segments = max(0, int(max_segments))
        self.max_chars = max(0, int(max_chars))
        self.turns: dict[str, dict] = {}

    def state(self, turn_id: str) -> dict:
        return self.turns.setdefault(
            turn_id,
            {
                "committed": [],
                "sequence": 0,
                "emitted": 0,
                "finalized": False,
                "divergent": False,
                "muted": False,
                "mute_reason": "",
            },
        )

    def note_mute(self, turn_id: str, reason: str) -> None:
        state = self.state(turn_id)
        state["muted"] = True
        state["mute_reason"] = reason

    def can_emit(self, turn_id: str) -> bool:
        state = self.state(turn_id)
        if state["finalized"] or state["muted"]:
            return False
        if self.max_segments <= 0:
            return False
        return state["emitted"] < self.max_segments

    def commit(self, turn_id: str, sentences: list[str]) -> list[dict]:
        """Record committed sentences and return queue-ready descriptors."""
        state = self.state(turn_id)
        queued: list[dict] = []
        if state["finalized"] or state["muted"]:
            return queued
        for sentence in sentences:
            normalized = normalize_segment(sentence)
            if not normalized:
                continue
            if state["emitted"] >= self.max_segments:
                state["muted"] = True
                state["mute_reason"] = "segment_budget"
                break
            state["emitted"] += 1
            state["sequence"] += 1
            state["committed"].append(normalized)
            queued.append(
                {
                    "text": normalized,
                    "segment_index": state["sequence"],
                }
            )
        return queued

    def played_text(self, turn_id: str) -> str:
        return "".join(self.state(turn_id)["committed"])

    def plan_tail(self, turn_id: str, final_text: str) -> dict:
        """Decide which final segments still need to be spoken.

        The committed prefix is matched against the *compacted* final segments
        rather than by segment count, because the final reply path additionally
        clause-splits any sentence longer than ``max_chars`` while the stream
        path commits whole sentences. Matching on compact text keeps the
        handover correct for both shapes, including a partial trailing segment.

        When the upstream text no longer matches what was already spoken the
        prefix is *not* dropped and ``divergent`` is reported, so the turn
        degrades to the original behaviour instead of muting the answer.
        """
        state = self.state(turn_id)
        normalized_final = normalize_segment(final_text)
        final_segments = split_sentences(normalized_final)
        if self.max_chars:
            final_segments = _clause_split(final_segments, self.max_chars)
        committed = list(state["committed"])
        streamed = normalize_segment(" ".join(committed))

        prefix_compact = "".join(compact_for_compare(x) for x in committed)
        played: list[str] = []
        drop_count = 0
        partial_tail = ""

        if prefix_compact and final_segments:
            if final_segments and compact_for_compare(streamed) == compact_for_compare(
                normalized_final
            ):
                # Streamed text and authoritative text agree completely.
                played = list(final_segments)
                drop_count = len(final_segments)
            else:
                accumulated = ""
                matched = False
                for segment in final_segments:
                    accumulated += compact_for_compare(segment)
                    drop_count += 1
                    if accumulated == prefix_compact:
                        matched = True
                        break
                    if not prefix_compact.startswith(accumulated):
                        matched = False
                        break

                if matched:
                    played = list(final_segments[:drop_count])
                else:
                    # The committed text may cover only part of one final
                    # segment (long-sentence clause splitting).
                    drop_count = 0
                    accumulated = ""
                    for segment in final_segments:
                        candidate = accumulated + compact_for_compare(segment)
                        if prefix_compact.startswith(candidate):
                            accumulated = candidate
                            played.append(segment)
                            drop_count += 1
                            continue
                        if candidate.startswith(prefix_compact):
                            consumed = len(prefix_compact) - len(accumulated)
                            # compact_for_compare removes whitespace, so its
                            # length cannot be used as an index into original text.
                            original_end = 0
                            compact_count = 0
                            for original_end, character in enumerate(segment, 1):
                                compact_count += len(compact_for_compare(character))
                                if compact_count >= consumed:
                                    break
                            remainder = segment[original_end:]
                            if remainder.strip():
                                partial_tail = remainder.strip()
                            drop_count += 1
                        else:
                            # The committed prefix is not part of the final text
                            # at all, so nothing can be dropped from the head
                            # and an already-spoken sentence may be repeated.
                            # Repeating one sentence is strictly better than
                            # muting the user's answer, and this always means the
                            # upstream text changed after we spoke it (for
                            # example a plugin rewrote the reply).
                            state["divergent"] = True
                        break

        if state["divergent"]:
            played, drop_count, partial_tail = [], 0, ""
        tail = ([partial_tail] if partial_tail else []) + final_segments[drop_count:]
        state["finalized"] = True
        return {
            "tail": tail,
            "played": played,
            "divergent": state["divergent"],
            "first_index": len(played) + 1,
            "sequence": state["sequence"],
            "committed_count": len(committed),
            "total": len(final_segments),
        }

    def discard(self, turn_id: str) -> None:
        self.turns.pop(turn_id, None)
