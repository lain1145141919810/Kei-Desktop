"""Focused checks for the local-only, on-demand screen tools."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from astrbot_plugin_kei.main import KeiPlugin
from astrbot_plugin_kei.screen_control import perform_screen_action


class _Event:
    def __init__(self, sender: str = "kei-local-voice", platform: str = "webchat"):
        self.sender = sender
        self.platform = platform
        self.extra = {}

    def get_platform_name(self):
        return self.platform

    def get_sender_id(self):
        return self.sender

    def get_extra(self, key, default=None):
        return self.extra.get(key, default)

    def set_extra(self, key, value):
        self.extra[key] = value


class ScreenToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.plugin = KeiPlugin.__new__(KeiPlugin)
        self.plugin.screen_vision_provider_id = "vision-test"
        self.provider = SimpleNamespace(
            text_chat=AsyncMock(
                return_value=SimpleNamespace(
                    completion_text="设置按钮位于 (640, 360)。"
                )
            )
        )
        self.plugin.context = SimpleNamespace(
            get_provider_by_id=Mock(return_value=self.provider)
        )

    async def test_local_view_uses_vision_only_when_called(self):
        event = _Event()
        with (
            patch(
                "astrbot_plugin_kei.main.ImageGrab.grab",
                return_value=Image.new("RGB", (1920, 1080)),
            ),
            patch("astrbot_plugin_kei.main.get_foreground_window", return_value=42),
        ):
            result = await self.plugin.kei_view_screen(event, "找设置")
        self.assertIn("设置按钮", result)
        self.assertEqual(
            event.get_extra("kei_screen_snapshot")["view_size"], (1440, 810)
        )
        self.assertEqual(event.get_extra("kei_screen_snapshot")["foreground"], 42)
        self.assertTrue(
            self.provider.text_chat.await_args.kwargs["image_urls"][0].startswith(
                "data:image/jpeg;base64,"
            )
        )

    async def test_remote_event_cannot_view_or_control(self):
        event = _Event(sender="qq-user", platform="qq")
        self.assertIn("仅限本机", await self.plugin.kei_view_screen(event))
        self.assertIn(
            "仅限本机", await self.plugin.kei_screen_action(event, "click", 10, 10)
        )
        self.plugin.context.get_provider_by_id.assert_not_called()

    async def test_action_requires_fresh_view_and_scales_coordinates(self):
        event = _Event()
        self.assertIn(
            "先调用", await self.plugin.kei_screen_action(event, "click", 640, 360)
        )
        event.set_extra(
            "kei_screen_snapshot",
            {
                "captured_at": time.monotonic(),
                "view_size": (1280, 720),
                "physical_size": (1920, 1080),
                "foreground": 42,
            },
        )
        with patch("astrbot_plugin_kei.main.perform_screen_action") as perform:
            self.assertIn(
                "超出了", await self.plugin.kei_screen_action(event, "click", 1280, 0)
            )
            self.assertIn(
                "已执行", await self.plugin.kei_screen_action(event, "click", 640, 360)
            )
            perform.assert_called_once_with(
                "click",
                expected_foreground=42,
                x=960,
                y=540,
                text="",
                keys="",
                amount=0,
            )
            self.assertIn(
                "先调用", await self.plugin.kei_screen_action(event, "click", 640, 360)
            )
        event.set_extra(
            "kei_screen_snapshot",
            {
                "captured_at": time.monotonic() - 61,
                "view_size": (1280, 720),
                "physical_size": (1920, 1080),
                "foreground": 42,
            },
        )
        self.assertIn(
            "先调用", await self.plugin.kei_screen_action(event, "click", 10, 10)
        )

    def test_action_rejects_changed_foreground_window(self):
        with (
            patch("astrbot_plugin_kei.screen_control.sys.platform", "win32"),
            patch(
                "astrbot_plugin_kei.screen_control.get_foreground_window",
                return_value=41,
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "Foreground window changed"):
                perform_screen_action("click", expected_foreground=42, x=100, y=100)


if __name__ == "__main__":
    unittest.main()
