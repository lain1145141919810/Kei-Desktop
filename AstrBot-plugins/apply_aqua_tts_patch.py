"""Reapply Kei's AstrBot compatibility patches after a uv tool upgrade.

Run with the Python interpreter from the AstrBot uv tool environment. The
patch is intentionally strict: an unknown upstream version must be reviewed
instead of silently receiving a partial provider rewrite.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def _update(path: Path, replacements: list[tuple[str, str]]) -> bool:
    """Apply exact, idempotent replacements to one installed Python source.

    Args:
        path: Installed AstrBot source file.
        replacements: Original and patched source snippets.

    Returns:
        True when this invocation changed the file.

    Raises:
        RuntimeError: A source snippet differs from the reviewed upstream code.
    """
    original = path.read_text(encoding="utf-8")
    updated = original
    for before, after in replacements:
        if after in updated:
            continue
        if updated.count(before) != 1:
            raise RuntimeError(
                f"Review the changed AstrBot source before patching: {path}"
            )
        updated = updated.replace(before, after, 1)
    if updated == original:
        return False
    backup = path.with_name(path.name + ".before-kei")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(updated, encoding="utf-8")
    return True


def main() -> None:
    """Patch the installed provider and agent bridge without changing config."""
    root = (
        Path(os.environ["APPDATA"])
        / "uv"
        / "tools"
        / "astrbot"
        / "Lib"
        / "site-packages"
        / "astrbot"
    )
    provider = root / "core" / "provider" / "sources" / "gsv_selfhosted_source.py"
    default = root / "core" / "config" / "default.py"
    agent_bridge = root / "core" / "astr_agent_run_util.py"
    if not provider.is_file() or not default.is_file() or not agent_bridge.is_file():
        raise RuntimeError(f"AstrBot uv tool installation not found: {root}")

    provider_changes = [
        (
            '        self.timeout = provider_config.get("timeout", 60)\n',
            '        self.timeout = provider_config.get("timeout", 60)\n'
            '        self.api_mode = provider_config.get("api_mode", "gsv")\n',
        ),
        (
            '            await self._set_model_weights()\n            logger.info("[GSV TTS] 初始化完成")',
            "            # Aqua loads the model pair and voice registry at server startup.\n"
            '            if self.api_mode != "aqua":\n'
            "                await self._set_model_weights()\n"
            '            logger.info("[GSV TTS] 初始化完成")',
        ),
        (
            "        retries: int = 3,\n    ) -> bytes | None:",
            '        retries: int = 3,\n        method: str = "GET",\n    ) -> bytes | None:',
        ),
        (
            "                async with self.get_session().get(endpoint, params=params) as response:",
            "                async with self.get_session().request(\n"
            "                    method, endpoint, params=params\n"
            "                ) as response:",
        ),
        (
            '        endpoint = f"{self.api_base}/tts"\n',
            '        endpoint = f"{self.api_base}/tts"\n'
            '        if self.api_mode == "aqua":\n'
            '            endpoint += "/file"\n',
        ),
        (
            "        result = await self._make_request(endpoint, params)\n"
            "        if isinstance(result, bytes):",
            "        result = await self._make_request(\n"
            '            endpoint, params, method="POST" if self.api_mode == "aqua" else "GET"\n'
            "        )\n"
            "        if isinstance(result, bytes):\n"
            '            if self.api_mode == "aqua" and (\n'
            '                len(result) <= 44 or result[:4] != b"RIFF" or result[8:12] != b"WAVE"\n'
            "            ):\n"
            '                raise ValueError("TTS returned an invalid or empty WAV response")',
        ),
    ]
    default_changes = [
        (
            '                        "sovits_weights_path": "",\n                        "timeout": 60,',
            '                        "sovits_weights_path": "",\n'
            '                        "api_mode": "gsv",\n                        "timeout": 60,',
        )
    ]
    agent_bridge_changes = [
        (
            '                elif resp.type == "llm_result":\n'
            '                    chain = resp.data["chain"]\n'
            '                    if chain.type == "reasoning":\n'
            "                        # For non-streaming mode, we handle reasoning in astrbot/core/astr_agent_hooks.py.\n"
            "                        # For streaming mode, we yield content immediately when received a reasoning chunk but not in here, see below.\n"
            "                        continue\n",
            '                elif resp.type == "llm_result":\n'
            '                    chain = resp.data["chain"]\n'
            '                    if chain.type == "reasoning":\n'
            "                        # For non-streaming mode, we handle reasoning in astrbot/core/astr_agent_hooks.py.\n"
            "                        # For streaming mode, we yield content immediately when received a reasoning chunk but not in here, see below.\n"
            "                        continue\n"
            "                    # A complete-reply turn must not send text from a step\n"
            "                    # that still has tool work pending. The final agent step\n"
            "                    # will provide the user-visible answer.\n"
            "                    if (\n"
            '                        astr_event.get_extra("enable_streaming") is False\n'
            "                        and not agent_runner.done()\n"
            "                    ):\n"
            "                        continue\n",
        )
    ]
    changed = _update(provider, provider_changes)
    changed |= _update(default, default_changes)
    changed |= _update(agent_bridge, agent_bridge_changes)
    print(
        "Kei AstrBot patches updated."
        if changed
        else "Kei AstrBot patches already current."
    )


if __name__ == "__main__":
    main()
