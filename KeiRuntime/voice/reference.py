from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from emotion.affect import AffectVector


@dataclass
class VoiceReference:
    """
    One GPT-SoVITS reference sample.
    """

    id: str

    # Aqua voice registry 中未来使用的 voice id。
    voice_id: str

    # 可选：
    # 原始参考音频路径。
    audio_path: str | None

    # GPT-SoVITS reference prompt。
    prompt_text: str

    # reference audio language
    prompt_language: str

    # 这条参考音频对应的情感位置。
    affect: AffectVector

    # 仅用于调试/人工查看。
    label: str = "neutral"

    enabled: bool = True


    def to_dict(
        self,
    ) -> dict[str, Any]:

        return {
            "id":
                self.id,

            "voice_id":
                self.voice_id,

            "audio_path":
                self.audio_path,

            "prompt_text":
                self.prompt_text,

            "prompt_language":
                self.prompt_language,

            "label":
                self.label,

            "enabled":
                self.enabled,

            "affect":
                self.affect.to_dict(),
        }