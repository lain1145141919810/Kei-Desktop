"""Start the Kei Runtime with its log written by Python itself.

``Start-Process -RedirectStandardOutput`` hands stdout to a pipe owned by the
launcher; when that reader goes away the Runtime's ``print`` calls block, which
looks exactly like a stall in the pipeline. This launcher opens the log file
directly so logging can never block the service.
"""
from __future__ import annotations

import io
import os
import sys

LOG_PATH = os.getenv("KEI_LOG_PATH", r"D:\KeiDesktop\launcher-logs\runtime.out.log")

log = open(LOG_PATH, "a", encoding="utf-8", errors="replace", buffering=1)
sys.stdout = log
sys.stderr = log


def _flush() -> None:
    try:
        log.flush()
    except Exception:
        pass


import atexit  # noqa: E402

atexit.register(_flush)

if __name__ == "__main__":
    import uvicorn

    host = os.getenv("KEI_HOST", "127.0.0.1")
    port = int(os.getenv("KEI_PORT", "17881"))
    uvicorn.run(
        "app:app",
        host=host,
        port=port,
        log_config=None,
        access_log=True,
    )
