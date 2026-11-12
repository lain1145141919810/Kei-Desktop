from __future__ import annotations

from emotion.affect import AffectVector


def affect_to_label(
    affect: AffectVector,
) -> str:

    v = affect.valence
    a = affect.arousal
    d = affect.dominance
    w = affect.warmth
    r = affect.restraint


    if (
        v > 0.45
        and a > 0.65
    ):
        return "excited"


    if (
        v > 0.35
        and w > 0.60
    ):

        if (
            d < -0.15
            and r > 0.65
        ):
            return "shy"

        return "happy"


    if (
        v < -0.40
        and a < 0.55
    ):
        return "sad"


    if (
        v < -0.30
        and a > 0.60
        and d > 0.10
    ):
        return "angry"


    if (
        abs(v) < 0.25
        and d > 0.20
        and r > 0.60
    ):
        return "serious"


    if (
        a > 0.70
        and d < 0.20
    ):
        return "surprised"


    return "neutral"