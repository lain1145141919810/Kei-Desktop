"""Small Windows desktop input adapter for Kei's local voice session."""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes


class _KeyboardInput(ctypes.Structure):
    _fields_ = [
        ("virtual_key", wintypes.WORD),
        ("scan_code", wintypes.WORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("extra_info", ctypes.c_size_t),
    ]


class _InputUnion(ctypes.Union):
    _fields_ = [("keyboard", _KeyboardInput), ("padding", ctypes.c_byte * 32)]


class _Input(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("value", _InputUnion)]


_KEYUP = 0x0002
_UNICODE = 0x0004
_VIRTUAL_KEYS = {
    "ctrl": 0x11,
    "shift": 0x10,
    "alt": 0x12,
    "win": 0x5B,
    "enter": 0x0D,
    "tab": 0x09,
    "esc": 0x1B,
    "backspace": 0x08,
    "delete": 0x2E,
    "space": 0x20,
    "up": 0x26,
    "down": 0x28,
    "left": 0x25,
    "right": 0x27,
    "home": 0x24,
    "end": 0x23,
    "pageup": 0x21,
    "pagedown": 0x22,
    "f5": 0x74,
}
_MOUSE_BUTTONS = {
    "click": (0x0002, 0x0004),
    "right_click": (0x0008, 0x0010),
}


def get_foreground_window() -> int:
    """Return the current foreground window handle.

    Returns:
        The foreground window handle, or zero when none is active.
    """
    if sys.platform != "win32":
        return 0
    get_window = ctypes.windll.user32.GetForegroundWindow
    get_window.restype = wintypes.HWND
    return int(get_window() or 0)


def _send_key(virtual_key: int = 0, scan_code: int = 0, flags: int = 0) -> None:
    item = _Input(
        type=1,
        value=_InputUnion(keyboard=_KeyboardInput(virtual_key, scan_code, flags, 0, 0)),
    )
    if ctypes.windll.user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(item)) != 1:
        raise OSError("Windows rejected keyboard input")


def perform_screen_action(
    action: str,
    *,
    expected_foreground: int = 0,
    x: int = 0,
    y: int = 0,
    text: str = "",
    keys: str = "",
    amount: int = 0,
) -> None:
    """Apply one bounded action to the current Windows desktop.

    Args:
        action: One of click, double_click, right_click, scroll, key, or type.
        expected_foreground: Foreground window handle captured with the screenshot.
        x: Physical screen X coordinate for mouse actions.
        y: Physical screen Y coordinate for mouse actions.
        text: Unicode text to type.
        keys: Plus-separated virtual keys, such as ctrl+a.
        amount: Mouse wheel detents, limited to a small range.

    Raises:
        RuntimeError: The host is not Windows.
        ValueError: The requested action is invalid or exceeds its limits.
        OSError: Windows rejects an input event.
    """
    if sys.platform != "win32":
        raise RuntimeError("Desktop input is available only on Windows")
    if not expected_foreground or get_foreground_window() != expected_foreground:
        raise RuntimeError("Foreground window changed since the screen was viewed")
    user32 = ctypes.windll.user32

    if action in {"click", "double_click", "right_click"}:
        if not user32.SetCursorPos(x, y):
            raise OSError("Windows rejected the mouse position")
        down, up = _MOUSE_BUTTONS["right_click" if action == "right_click" else "click"]
        for _ in range(2 if action == "double_click" else 1):
            user32.mouse_event(down, 0, 0, 0, 0)
            user32.mouse_event(up, 0, 0, 0, 0)
            if action == "double_click":
                time.sleep(0.08)
        return

    if action == "scroll":
        if not -5 <= amount <= 5 or amount == 0:
            raise ValueError("Scroll amount must be between -5 and 5, excluding zero")
        if not user32.SetCursorPos(x, y):
            raise OSError("Windows rejected the mouse position")
        user32.mouse_event(0x0800, 0, 0, amount * 120, 0)
        return

    if action == "key":
        names = [name.strip().lower() for name in keys.split("+")]
        if not 1 <= len(names) <= 3 or any(
            name not in _VIRTUAL_KEYS
            and not (len(name) == 1 and name.isascii() and name.isalnum())
            for name in names
        ):
            raise ValueError("Unsupported key combination")
        codes = [
            _VIRTUAL_KEYS[name] if name in _VIRTUAL_KEYS else ord(name.upper())
            for name in names
        ]
        try:
            for code in codes:
                _send_key(code)
        finally:
            for code in reversed(codes):
                _send_key(code, flags=_KEYUP)
        return

    if action == "type":
        if not text or len(text) > 500:
            raise ValueError("Text length must be between 1 and 500 characters")
        encoded = text.encode("utf-16-le")
        for index in range(0, len(encoded), 2):
            code_unit = int.from_bytes(encoded[index : index + 2], "little")
            _send_key(scan_code=code_unit, flags=_UNICODE)
            _send_key(scan_code=code_unit, flags=_UNICODE | _KEYUP)
        return

    raise ValueError("Unsupported desktop action")
