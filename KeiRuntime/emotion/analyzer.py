from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from emotion.affect import AffectVector


@dataclass
class AffectObservation:
    affect: AffectVector
    confidence: float
    source: str


class AffectAnalyzer:
    """
    Lightweight affect analyzer.

    Priority:
        explicit upstream affect
        ↓
        continuous text inference
        ↓
        neutral-ish observation

    This is deliberately conservative.
    """


    def analyze(
        self,
        text: str,
        payload: dict[str, Any] | None = None,
    ) -> AffectObservation:

        payload = payload or {}
        text = (text or "").strip()


        # ========================================================
        # 1. Explicit affect from AstrBot / future models
        # ========================================================

        explicit = payload.get("affect")

        if isinstance(
            explicit,
            dict,
        ):

            affect = (
                AffectVector
                .from_mapping(explicit)
            )

            return AffectObservation(
                affect=affect,
                confidence=1.0,
                source="explicit",
            )


        # ========================================================
        # 2. Continuous text inference
        # ========================================================

        affect = AffectVector()

        confidence = 0.15


        # --------------------------------------------------------
        # Positive / negative valence
        # --------------------------------------------------------

        positive = (
            "太好了",
            "很好",
            "不错",
            "开心",
            "高兴",
            "喜欢",
            "成功",
            "真棒",
            "谢谢",
            "放心",
            "没问题",
            "当然",
            "可以呀",
        )

        negative = (
            "难过",
            "伤心",
            "遗憾",
            "可惜",
            "失败",
            "抱歉",
            "对不起",
            "讨厌",
            "糟糕",
            "生气",
            "担心",
            "害怕",
        )


        for word in positive:

            if word in text:
                affect.valence += 0.18
                affect.warmth += 0.05
                confidence += 0.07


        for word in negative:

            if word in text:
                affect.valence -= 0.20
                confidence += 0.07


        # --------------------------------------------------------
        # Arousal
        # --------------------------------------------------------

        high_arousal = (
            "终于",
            "居然",
            "竟然",
            "快看",
            "真的吗",
            "怎么会",
            "太棒了",
            "成功了",
            "可恶",
        )

        calm_words = (
            "慢慢",
            "没关系",
            "别急",
            "稍等",
            "冷静",
            "休息",
        )


        for word in high_arousal:

            if word in text:
                affect.arousal += 0.15
                affect.intensity += 0.10
                confidence += 0.06


        for word in calm_words:

            if word in text:
                affect.arousal -= 0.08
                affect.restraint += 0.05
                confidence += 0.04


        # --------------------------------------------------------
        # Dominance / certainty
        # --------------------------------------------------------

        assertive = (
            "必须",
            "一定",
            "确定",
            "当然",
            "请务必",
            "不能",
            "我会",
        )

        uncertain = (
            "也许",
            "可能",
            "大概",
            "似乎",
            "好像",
            "我想",
            "不知道",
            "不确定",
        )


        for word in assertive:

            if word in text:
                affect.dominance += 0.12
                affect.certainty += 0.12
                confidence += 0.05


        for word in uncertain:

            if word in text:
                affect.dominance -= 0.10
                affect.certainty -= 0.15
                confidence += 0.05


        # --------------------------------------------------------
        # Warmth
        # --------------------------------------------------------

        warm = (
            "老师",
            "谢谢",
            "辛苦了",
            "欢迎回来",
            "陪你",
            "放心",
            "没关系",
        )


        for word in warm:

            if word in text:
                affect.warmth += 0.10
                confidence += 0.04


        # --------------------------------------------------------
        # Shy / hesitant textual patterns
        # --------------------------------------------------------

        hesitant = (
            "那个……",
            "那个...",
            "其实……",
            "不好意思",
            "有点",
        )


        for word in hesitant:

            if word in text:
                affect.dominance -= 0.12
                affect.certainty -= 0.08
                affect.restraint += 0.10
                affect.warmth += 0.05
                confidence += 0.06


        # --------------------------------------------------------
        # Punctuation
        # --------------------------------------------------------

        exclamation_count = (
            text.count("！")
            + text.count("!")
        )

        question_count = (
            text.count("？")
            + text.count("?")
        )

        ellipsis_count = (
            text.count("……")
            + text.count("...")
        )


        affect.arousal += min(
            exclamation_count,
            3,
        ) * 0.08

        affect.intensity += min(
            exclamation_count,
            3,
        ) * 0.06


        if question_count:

            affect.certainty -= min(
                question_count,
                2,
            ) * 0.04


        if ellipsis_count:

            affect.arousal -= 0.05
            affect.restraint += 0.08
            affect.certainty -= 0.04


        # --------------------------------------------------------
        # Derive intensity partly from emotional distance
        # --------------------------------------------------------

        affect.intensity += (
            abs(affect.valence)
            * 0.25
        )

        affect.intensity += (
            affect.arousal
            * 0.15
        )


        affect.clamp()

        confidence = max(
            0.0,
            min(1.0, confidence),
        )


        return AffectObservation(
            affect=affect,
            confidence=confidence,
            source="heuristic",
        )