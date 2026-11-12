from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _clamp(
    value: float,
    minimum: float,
    maximum: float,
) -> float:
    return max(
        minimum,
        min(maximum, float(value)),
    )


@dataclass
class AffectVector:
    """
    Continuous affect representation.

    valence:
        -1.0 negative
         0.0 neutral
        +1.0 positive

    arousal:
         0.0 calm
         1.0 highly activated

    dominance:
        -1.0 hesitant / submissive
        +1.0 assertive / dominant

    intensity:
         0.0 weak
         1.0 strong

    warmth:
         0.0 distant / cold
         1.0 warm / intimate

    certainty:
         0.0 uncertain
         1.0 confident

    restraint:
         0.0 expressive
         1.0 restrained
    """

    valence: float = 0.0
    arousal: float = 0.25
    dominance: float = 0.0

    intensity: float = 0.25

    warmth: float = 0.55
    certainty: float = 0.55
    restraint: float = 0.70


    def clamp(self) -> "AffectVector":

        self.valence = _clamp(
            self.valence,
            -1.0,
            1.0,
        )

        self.arousal = _clamp(
            self.arousal,
            0.0,
            1.0,
        )

        self.dominance = _clamp(
            self.dominance,
            -1.0,
            1.0,
        )

        self.intensity = _clamp(
            self.intensity,
            0.0,
            1.0,
        )

        self.warmth = _clamp(
            self.warmth,
            0.0,
            1.0,
        )

        self.certainty = _clamp(
            self.certainty,
            0.0,
            1.0,
        )

        self.restraint = _clamp(
            self.restraint,
            0.0,
            1.0,
        )

        return self


    def to_dict(
        self,
    ) -> dict[str, float]:

        self.clamp()

        return {
            "valence":
                round(self.valence, 3),

            "arousal":
                round(self.arousal, 3),

            "dominance":
                round(self.dominance, 3),

            "intensity":
                round(self.intensity, 3),

            "warmth":
                round(self.warmth, 3),

            "certainty":
                round(self.certainty, 3),

            "restraint":
                round(self.restraint, 3),
        }


    @classmethod
    def from_mapping(
        cls,
        data: dict[str, Any],
    ) -> "AffectVector":

        affect = cls()

        for field in (
            "valence",
            "arousal",
            "dominance",
            "intensity",
            "warmth",
            "certainty",
            "restraint",
        ):

            if field not in data:
                continue

            try:
                setattr(
                    affect,
                    field,
                    float(data[field]),
                )

            except (
                TypeError,
                ValueError,
            ):
                pass

        return affect.clamp()