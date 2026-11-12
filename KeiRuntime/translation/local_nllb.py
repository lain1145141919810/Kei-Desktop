from __future__ import annotations

import asyncio
import re
import threading
import time
from collections import OrderedDict
from time import monotonic
from pathlib import Path

import ctranslate2
from transformers import AutoTokenizer


class JapaneseSpeechPostProcessor:
    """
    轻量级中文 -> 日语 TTS 后处理。

    目标：
    - 修正 NLLB 常见的书面/直译表达
    - 清理奇怪空格与 ASCII 标点
    - 不调用第二个模型
    - 不联网
    """

    _JP_CHARS = (
        r"\u3040-\u30ff"
        r"\u3400-\u4dbf"
        r"\u4e00-\u9fff"
    )

    _NUMBER_WORDS = {
        "1": "一",
        "2": "二",
        "3": "三",
        "4": "四",
        "5": "五",
        "6": "六",
        "7": "七",
        "8": "八",
        "9": "九",
        "10": "十",
    }

    def process(
        self,
        source_text: str,
        translated: str,
    ) -> str:

        source_text = (
            source_text or ""
        ).strip()

        text = (
            translated or ""
        ).strip()

        if not text:
            return ""

        # --------------------------------------------------
        # 1. 基础标点整理
        # --------------------------------------------------

        text = text.replace(
            ",",
            "、",
        )

        text = text.replace(
            ".",
            "。",
        )

        text = text.replace(
            "!",
            "！",
        )

        text = text.replace(
            "?",
            "？",
        )

        # 去掉日文字符之间奇怪的空格：
        #
        # "こ れ"
        # -> "これ"
        text = re.sub(
            rf"(?<=[{self._JP_CHARS}])"
            rf"\s+"
            rf"(?=[{self._JP_CHARS}])",
            "",
            text,
        )

        # 标点两侧不要空格。
        text = re.sub(
            r"\s*([、。！？])\s*",
            r"\1",
            text,
        )

        # 多余空格。
        text = re.sub(
            r"[ \t]+",
            " ",
            text,
        ).strip()

        # --------------------------------------------------
        # 2. 根据中文原文做上下文相关修正
        #
        # 不直接全局把所有「教師」改成「先生」，
        # 因为“教师”作为职业时，教師本身是正确的。
        # --------------------------------------------------

        if "老师" in source_text:
            text = text.replace(
                "教師",
                "先生",
            )

        if "后台" in source_text:
            text = text.replace(
                "後台",
                "バックグラウンド",
            )

        # “一句话 / 第二句话 / 第三句话”
        # NLLB 很容易误译成 “第2節”。
        if (
            "句话" in source_text
            or "句子" in source_text
        ):
            text = re.sub(
                r"第(10|[1-9])節",
                self._section_to_sentence,
                text,
            )

            text = text.replace(
                "最初の節",
                "一文目",
            )

            text = text.replace(
                "最初の文",
                "一文目",
            )

        # --------------------------------------------------
        # 3. 常见机械直译修正
        # --------------------------------------------------

        replacements = (
            (
                "双流水線が正常である場合",
                "二重パイプラインが正常なら",
            ),
            (
                "双流水線が正常なら",
                "二重パイプラインが正常なら",
            ),
            (
                "先発生成",
                "先に生成",
            ),
            (
                "播出時",
                "再生している間",
            ),
            (
                "播出中",
                "再生中",
            ),
            (
                "初めて開く速度",
                "最初に話し始めるまでの速さ",
            ),
            (
                "その間の休憩",
                "文と文の間",
            ),
            (
                "明らかに短縮される",
                "かなり短くなる",
            ),
        )

        for old, new in replacements:
            text = text.replace(
                old,
                new,
            )

        # --------------------------------------------------
        # 4. 中文语义辅助修正
        # --------------------------------------------------

        if (
            "播放的时候" in source_text
            or "播放时" in source_text
        ):
            text = text.replace(
                "再生している間にに",
                "再生している間に",
            )

        if "提前生成" in source_text:
            text = text.replace(
                "先に生成されるべきである",
                "先に生成されるようにする",
            )

        if "停顿" in source_text:
            text = text.replace(
                "休憩",
                "間",
            )

        # --------------------------------------------------
        # 5. TTS 用语尾稍微自然一点
        # --------------------------------------------------

        text = text.replace(
            "べきである。",
            "べきです。",
        )

        text = text.replace(
            "である。",
            "です。",
        )

        # 避免重复句号。
        text = re.sub(
            r"。+",
            "。",
            text,
        )

        return text.strip()

    def _section_to_sentence(
        self,
        match: re.Match,
    ) -> str:

        raw = match.group(1)

        number = (
            self._NUMBER_WORDS.get(
                raw,
                raw,
            )
        )

        return (
            f"{number}文目"
        )


class LocalNLLBTranslator:
    """
    Local Chinese -> Japanese translation.

    Source:
        Simplified Chinese / zho_Hans

    Target:
        Japanese / jpn_Jpan

    Backend:
        NLLB-200 distilled 600M
        CTranslate2 INT8
        CPU
    """

    # Only report decoder queueing that is long enough to matter for latency.
    SLOW_DECODE_WAIT_MS = 2000

    def __init__(
        self,
        *,
        model_path: str,
        tokenizer_path: str,
        cpu_threads: int = 4,
    ):

        self.model_path = str(
            Path(
                model_path
            ).resolve()
        )

        self.tokenizer_path = str(
            Path(
                tokenizer_path
            ).resolve()
        )

        self.cpu_threads = (
            cpu_threads
        )

        self.tokenizer = None
        self.translator = None

        self.postprocessor = (
            JapaneseSpeechPostProcessor()
        )

        # 防止 Runtime startup warmup
        # 和真实第一条翻译同时进入 load()。
        self._load_lock = (
            threading.Lock()
        )

        self._warmup_lock = (
            threading.Lock()
        )

        self._warmed = False
        # In-memory only; exact sentence matches retain the existing decoder.
        self._translation_cache = OrderedDict()
        self._cache_lock = threading.Lock()
        self._decode_lock = threading.Lock()
        self._cache_limit = 128
        self._cache_ttl = 600.0

    def load(
        self,
    ) -> None:

        if (
            self.tokenizer is not None
            and self.translator is not None
        ):
            return

        with self._load_lock:

            if (
                self.tokenizer
                is not None
                and self.translator
                is not None
            ):
                return

            print(
                "[Kei Translation] "
                "loading NLLB..."
            )

            # 新版 transformers 可以修复
            # tokenizer regex warning。
            #
            # 如果当前版本不支持该参数，
            # 自动回退，避免启动失败。
            self.tokenizer = (
                AutoTokenizer.from_pretrained(
                    self.tokenizer_path,
                    src_lang="zho_Hans",
                    tgt_lang="jpn_Jpan",
                    local_files_only=True,
                )
            )
            self.translator = (
                ctranslate2.Translator(
                    self.model_path,

                    device="cpu",

                    compute_type="int8",

                    # 实时场景只处理一句。
                    inter_threads=1,

                    intra_threads=(
                        self.cpu_threads
                    ),
                )
            )

            print(
                "[Kei Translation] "
                "NLLB ready"
            )

    def _translate_raw_sync(
        self,
        text: str,
    ) -> str:

        if (
            self.tokenizer is None
            or self.translator is None
        ):
            self.load()

        text = text.strip()

        if not text:
            return ""

        encoded = self.tokenizer(
            text,
            add_special_tokens=True,
        )

        source_tokens = (
            self.tokenizer
            .convert_ids_to_tokens(
                encoded[
                    "input_ids"
                ]
            )
        )

        target_prefix = [
            [
                "jpn_Jpan"
            ]
        ]

        # Greedy decoding occasionally loops on a single token. Bound decoding,
        # suppress repeated n-grams, and retry with beam search before publishing.
        limit = min(256, max(48, len(source_tokens) * 3))
        for beam in (4, 6):
            results = self.translator.translate_batch(
                [source_tokens], target_prefix=target_prefix, beam_size=beam,
                max_decoding_length=limit, repetition_penalty=1.1,
                no_repeat_ngram_size=4, return_scores=False,
            )
            output_tokens = results[0].hypotheses[0][1:]
            output_ids = self.tokenizer.convert_tokens_to_ids(output_tokens)
            translated = self.tokenizer.decode(output_ids, skip_special_tokens=True).strip()
            compact = re.sub(r"\s+", "", translated)
            repetitive = bool(re.search(r"(.)\1{7,}|(.{2,8})\2{4,}", compact))
            exhausted = len(output_tokens) >= limit - 1
            if translated and not repetitive and not exhausted:
                return translated
            print(f"[Kei Translation] retry invalid decoding: beam={beam} tokens={len(output_tokens)}")
        raise RuntimeError("NLLB returned repetitive or truncated translation; withheld from subtitles/TTS")

    def _translate_sync(self, text: str) -> str:
        # Prefetch and committed translation share one decoder, and recheck
        # the cache after waiting so identical work is never decoded twice.
        waited = time.perf_counter()
        with self._decode_lock:
            wait_ms = int((time.perf_counter() - waited) * 1000)
            if wait_ms >= self.SLOW_DECODE_WAIT_MS:
                # Queueing behind another decode is the one thing that can make
                # early playback miss its window, so surface it when it happens.
                print(
                    "[Kei Translation] decoder busy:",
                    f"waited={wait_ms}ms",
                    f"chars={len(text)}",
                )
            return self._translate_cached_sync(text)

    def _translate_cached_sync(
        self,
        text: str,
    ) -> str:

        source_text = (
            text.strip()
        )

        if not source_text:
            return ""

        with self._cache_lock:
            cached = self._translation_cache.pop(source_text, None)
            if cached is not None and monotonic() - cached[0] < self._cache_ttl:
                self._translation_cache[source_text] = cached
                print("[Kei Translation] cache hit")
                return cached[1]

        raw = (
            self._translate_raw_sync(
                source_text
            )
        )

        polished = (
            self.postprocessor.process(
                source_text,
                raw,
            )
        )

        if polished != raw:

            print(
                "[Kei Translation] "
                "postprocess:"
            )

            print(
                "  raw:",
                repr(
                    raw
                ),
            )

            print(
                "  out:",
                repr(
                    polished
                ),
            )

        if polished:
            with self._cache_lock:
                self._translation_cache[source_text] = (monotonic(), polished)
                self._translation_cache.move_to_end(source_text)
                while len(self._translation_cache) > self._cache_limit:
                    self._translation_cache.popitem(last=False)
        return polished

    def _warmup_sync(
        self,
    ) -> None:

        if self._warmed:
            return

        with self._warmup_lock:

            if self._warmed:
                return

            print(
                "[Kei Translation] "
                "warmup starting..."
            )

            self.load()

            # 极短文本即可让：
            #
            # tokenizer
            # CTranslate2 runtime
            # CPU thread pool
            #
            # 完成第一次真实初始化。
            result = (
                self._translate_raw_sync(
                    "你好。"
                )
            )

            self._warmed = True

            print(
                "[Kei Translation] "
                "warmup ready:",
                repr(
                    result
                ),
            )

    async def warmup(
        self,
    ) -> None:
        """
        Runtime startup background warmup.
        """

        await asyncio.to_thread(
            self._warmup_sync
        )

    async def translate_zh_to_ja(
        self,
        text: str,
    ) -> str:
        """
        Don't block the FastAPI asyncio loop.
        """

        return await asyncio.to_thread(
            self._translate_sync,
            text,
        )