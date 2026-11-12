"""Supervise the scheduled-activity service while AstrBot is running."""

import asyncio
import json
import logging
import subprocess
import time
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)
ROOT = Path("D:/KeiRuntime/data/bilibili")


async def supervise_runtime():
    """Recover an absent Runtime and a stopped scheduler without enabling paused activity.

    Returns:
        Never normally returns; cancellation shuts down the supervisor only.
    """
    state = {"checks": 0, "recoveries": 0, "last_error": "", "last_recovery": None}
    status_path = ROOT / "supervisor-health.json"
    if status_path.exists():
        try:
            state.update(json.loads(status_path.read_text("utf-8")))
        except (ValueError, OSError):
            pass
    failures = 0
    async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
        while True:
            proc = None
            try:
                config = json.loads((ROOT / "config.json").read_text("utf-8-sig"))
                state["checks"] += 1
                if not config.get("schedule", {}).get("enabled"):
                    state["status"] = "disabled"
                else:
                    token = (
                        (ROOT.parent / "desktop-bridge.token")
                        .read_text("utf-8")
                        .strip()
                    )
                    headers = {"X-Kei-Bridge": token}
                    try:
                        response = await client.get(
                            "http://127.0.0.1:17881/bilibili", headers=headers
                        )
                        response.raise_for_status()
                        status = response.json()
                        if status.get("scheduler_alive") is False:
                            repaired = await client.post(
                                "http://127.0.0.1:17881/bilibili",
                                headers=headers,
                                json={"action": "repair"},
                            )
                            repaired.raise_for_status()
                            state["last_recovery"] = time.time()
                            state["recoveries"] += 1
                        failures = 0
                        state["status"] = "healthy"
                        state["last_error"] = ""
                    except (httpx.HTTPError, ValueError):
                        failures += 1
                        state["status"] = "unreachable"
                        if failures >= 2:
                            logger.warning(
                                "[Kei Supervisor] Runtime unreachable; invoking startup recovery"
                            )
                            proc = await asyncio.create_subprocess_exec(
                                "powershell.exe",
                                "-NoProfile",
                                "-ExecutionPolicy",
                                "Bypass",
                                "-File",
                                str(ROOT.parents[1] / "Ensure-KeiRuntime.ps1"),
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                                creationflags=subprocess.CREATE_NO_WINDOW,
                            )
                            await asyncio.wait_for(proc.wait(), 210)
                            # Judge recovery by the authenticated service, not a launcher exit code.
                            verified = await client.get(
                                "http://127.0.0.1:17881/bilibili", headers=headers
                            )
                            verified.raise_for_status()
                            if not verified.json().get("scheduler_alive"):
                                raise RuntimeError("scheduler_not_ready")
                            state["last_recovery"] = time.time()
                            state["recoveries"] += 1
                            state["status"] = "recovered"
                            failures = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                state["last_error"] = type(exc).__name__
                state["status"] = "error"
                logger.warning("[Kei Supervisor] Check failed: %s", type(exc).__name__)
            finally:
                if proc is not None and proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                state["last_check"] = time.time()
                try:
                    ROOT.mkdir(parents=True, exist_ok=True)
                    temporary = status_path.with_suffix(".tmp")
                    temporary.write_text(json.dumps(state), encoding="utf-8")
                    temporary.replace(status_path)
                except OSError:
                    logger.warning("[Kei Supervisor] Cannot persist health state")
            await asyncio.sleep(30)
