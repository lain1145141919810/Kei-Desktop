"""Run the installed AstrBot CLI with output owned by the child process."""

import os
import sys
from pathlib import Path

if __name__ == "__main__":
    log_path = Path(
        os.environ.get(
            "KEI_ASTRBOT_LOG_PATH",
            str(Path(__file__).parent / "launcher-logs" / "astrbot-live.log"),
        )
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # Replace inherited pipes before importing AstrBot and configuring loguru.
    # Redirect descriptors too, so native writes use the same regular file.
    with log_path.open("a", encoding="utf-8", errors="replace", buffering=1) as log:
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)
        sys.stdout = log
        sys.stderr = log
        from astrbot.cli.__main__ import cli

        cli()
