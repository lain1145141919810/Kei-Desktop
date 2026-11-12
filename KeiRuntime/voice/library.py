from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from emotion.affect import AffectVector
from voice.reference import VoiceReference


class VoiceReferenceLibrary:
    """
    Continuous affect -> nearest voice reference.

    Labels are NOT used for selection.
    Only continuous affect distance is used.
    """

    DEFAULT_WEIGHTS = {
        "valence": 1.30,
        "arousal": 1.45,
        "dominance": 0.70,
        "intensity": 1.20,
        "warmth": 1.10,
        "certainty": 0.55,
        "restraint": 0.85,
    }


    def __init__(
        self,
        *,
        config_path: str,
        weights: dict[str, float] | None = None,
    ):

        self.config_path = Path(
            config_path
        )

        self.weights = (
            weights
            or self.DEFAULT_WEIGHTS.copy()
        )

        self.references: list[
            VoiceReference
        ] = []

        self.load()


    def load(self) -> None:

        with self.config_path.open(
            "r",
            encoding="utf-8",
        ) as file:

            data = json.load(file)


        references = []

        for item in data.get(
            "references",
            [],
        ):

            if not item.get(
                "enabled",
                True,
            ):
                continue

            affect = (
                AffectVector
                .from_mapping(
                    item.get(
                        "affect",
                        {},
                    )
                )
            )

            reference = VoiceReference(
                id=item["id"],

                voice_id=item.get(
                    "voice_id",
                    item["id"],
                ),

                audio_path=item.get(
                    "audio_path"
                ),

                prompt_text=item.get(
                    "prompt_text",
                    "",
                ),

                prompt_language=item.get(
                    "prompt_language",
                    "日文",
                ),

                affect=affect,

                label=item.get(
                    "label",
                    "neutral",
                ),

                enabled=True,
            )

            references.append(
                reference
            )


        if not references:

            raise RuntimeError(
                "Voice reference library "
                "contains no enabled references"
            )


        self.references = references

        print(
            "[Kei Voice] reference library loaded:",
            len(self.references),
        )


    def _distance(
        self,
        target: AffectVector,
        reference: AffectVector,
    ) -> float:

        dimensions = (
            "valence",
            "arousal",
            "dominance",
            "intensity",
            "warmth",
            "certainty",
            "restraint",
        )

        total = 0.0
        weight_total = 0.0


        for name in dimensions:

            weight = self.weights.get(
                name,
                1.0,
            )

            target_value = getattr(
                target,
                name,
            )

            reference_value = getattr(
                reference,
                name,
            )

            difference = (
                target_value
                - reference_value
            )

            total += (
                weight
                * difference
                * difference
            )

            weight_total += weight


        if weight_total <= 0:
            return 0.0


        return math.sqrt(
            total / weight_total
        )


    def select(
        self,
        affect: AffectVector
        | dict[str, Any],
    ) -> tuple[
        VoiceReference,
        float,
    ]:

        if isinstance(
            affect,
            dict,
        ):

            affect = (
                AffectVector
                .from_mapping(
                    affect
                )
            )


        best_reference = None
        best_distance = float("inf")


        for reference in self.references:

            distance = self._distance(
                affect,
                reference.affect,
            )

            if distance < best_distance:

                best_reference = reference
                best_distance = distance


        if best_reference is None:

            raise RuntimeError(
                "No voice reference available"
            )


        return (
            best_reference,
            best_distance,
        )