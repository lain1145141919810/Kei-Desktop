from __future__ import annotations

import time

from emotion.affect import AffectVector
from emotion.analyzer import AffectObservation


class AffectStateManager:
    """
    Persistent affect state with:

    - inertia
    - temporal decay
    - smooth transitions
    - per-session state
    """


    def __init__(
        self,
        *,
        half_life_seconds: float = 90.0,
    ):
        self.half_life_seconds = (
            half_life_seconds
        )

        self.baseline = AffectVector()

        self._states: dict[
            str,
            AffectVector
        ] = {}

        self._timestamps: dict[
            str,
            float
        ] = {}


    def _decay(
        self,
        session_id: str,
        now: float,
    ) -> AffectVector:

        state = self._states.get(
            session_id
        )

        if state is None:

            state = AffectVector(
                **self.baseline.to_dict()
            )

            return state


        previous_time = (
            self._timestamps.get(
                session_id,
                now,
            )
        )

        elapsed = max(
            0.0,
            now - previous_time,
        )


        if self.half_life_seconds <= 0:

            return state


        retention = (
            0.5
            ** (
                elapsed
                / self.half_life_seconds
            )
        )


        baseline = self.baseline


        return AffectVector(
            valence=(
                baseline.valence
                + (
                    state.valence
                    - baseline.valence
                )
                * retention
            ),

            arousal=(
                baseline.arousal
                + (
                    state.arousal
                    - baseline.arousal
                )
                * retention
            ),

            dominance=(
                baseline.dominance
                + (
                    state.dominance
                    - baseline.dominance
                )
                * retention
            ),

            intensity=(
                baseline.intensity
                + (
                    state.intensity
                    - baseline.intensity
                )
                * retention
            ),

            warmth=(
                baseline.warmth
                + (
                    state.warmth
                    - baseline.warmth
                )
                * retention
            ),

            certainty=(
                baseline.certainty
                + (
                    state.certainty
                    - baseline.certainty
                )
                * retention
            ),

            restraint=(
                baseline.restraint
                + (
                    state.restraint
                    - baseline.restraint
                )
                * retention
            ),
        ).clamp()


    def update(
        self,
        session_id: str,
        observation: AffectObservation,
    ) -> AffectVector:

        now = time.monotonic()

        current = self._decay(
            session_id,
            now,
        )

        observed = observation.affect


        # ========================================================
        # Adaptive update gain
        # ========================================================
        #
        # 普通句子只轻微推动状态。
        # 明显、高置信度的情绪才推动得更多。
        #

        gain = (
            0.12
            + 0.42
            * observation.confidence
            * max(
                observed.intensity,
                0.20,
            )
        )

        gain = max(
            0.08,
            min(0.55, gain),
        )


        def blend(
            old: float,
            new: float,
        ) -> float:

            return (
                old
                + (new - old)
                * gain
            )


        updated = AffectVector(
            valence=blend(
                current.valence,
                observed.valence,
            ),

            arousal=blend(
                current.arousal,
                observed.arousal,
            ),

            dominance=blend(
                current.dominance,
                observed.dominance,
            ),

            intensity=blend(
                current.intensity,
                observed.intensity,
            ),

            warmth=blend(
                current.warmth,
                observed.warmth,
            ),

            certainty=blend(
                current.certainty,
                observed.certainty,
            ),

            restraint=blend(
                current.restraint,
                observed.restraint,
            ),
        ).clamp()


        self._states[
            session_id
        ] = updated

        self._timestamps[
            session_id
        ] = now


        return updated


    def get(
        self,
        session_id: str,
    ) -> AffectVector:

        now = time.monotonic()

        state = self._decay(
            session_id,
            now,
        )

        self._states[
            session_id
        ] = state

        self._timestamps[
            session_id
        ] = now

        return state