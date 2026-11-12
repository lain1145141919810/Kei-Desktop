"""Keep the main log directory within a bounded retention budget."""

import json
import msvcrt
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "launcher-logs"
LIMIT = 500_000_000
TARGET = 450_000_000


def prune(root=ROOT, limit=LIMIT, target=TARGET):
    """Delete oldest closed logs after the directory exceeds its budget.

    Args:
        root: Directory containing logs, without traversing child directories.
        limit: Maximum retained bytes before cleanup.
        target: Retained bytes after cleanup, leaving growth headroom.

    Returns:
        A dictionary containing remaining size and cleanup counts.
    """
    root = root.resolve(strict=True)
    entries = []
    for path in root.iterdir():
        if path.is_symlink() or not path.is_file():
            continue
        try:
            stat = path.stat()
            entries.append((stat.st_mtime_ns, path, stat.st_size))
        except FileNotFoundError:
            continue
    total = sum(size for _, _, size in entries)
    removed = 0
    blocked = 0
    if total > limit:
        for _, path, size in sorted(entries):
            if total <= target:
                break
            # Only actual log files directly inside the fixed directory qualify.
            if path.suffix != ".log" or path.resolve().parent != root:
                continue
            try:
                path.unlink()
            except FileNotFoundError:
                total -= size
            except OSError:
                # Windows denies deletion while a service holds the file open.
                blocked += 1
            else:
                total -= size
                removed += 1
    return {"bytes": total, "limit": limit, "removed": removed,
            "blocked": blocked, "over_limit": total > limit}


if __name__ == "__main__":
    ROOT.mkdir(exist_ok=True)
    with (ROOT.parent / "log-retention.lock").open("a+b") as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SystemExit(0) from None
        while True:
            try:
                result = prune()
                result["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                state = ROOT.parent / "log-retention-status.json"
                temporary = state.with_suffix(".tmp")
                temporary.write_text(json.dumps(result), encoding="utf-8")
                temporary.replace(state)
            except OSError:
                pass
            time.sleep(10)
