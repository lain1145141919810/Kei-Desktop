"""Launch registered Windows apps by catalog identity, never by model shell text."""

import hashlib
import json
import os
import re
import subprocess

DENIED = re.compile(
    r"uninstall|卸载|powershell|pwsh|command prompt|命令提示|terminal|终端|regedit|注册表|python|node\.js|wscript|cscript|mshta|rundll32|cmd\.exe|安装|installer",
    re.I,
)


def catalog():
    script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-StartApps | Select-Object Name,AppID) | ConvertTo-Json -Compress"
    process = subprocess.run(
        [
            os.path.join(
                os.environ["SystemRoot"],
                "System32/WindowsPowerShell/v1.0/powershell.exe",
            ),
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ],
        capture_output=True,
        timeout=20,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if process.returncode:
        raise RuntimeError("app_catalog_unavailable")
    rows = json.loads(process.stdout.decode("utf-8-sig"))
    if isinstance(rows, dict):
        rows = [rows]
    result = {}
    for row in rows:
        name, native = row.get("Name", ""), row.get("AppID", "")
        if (
            not name
            or not native
            or DENIED.search(name + " " + native)
            or any(c in native for c in "\r\n\x00")
        ):
            continue
        ident = hashlib.sha256(native.encode("utf-8")).hexdigest()[:16]
        result[ident] = {"id": ident, "name": name, "native": native}
    return result


def operate(action, app=""):
    if action not in {"list", "open"} or not isinstance(app, str) or len(app) > 200:
        return {"status": "rejected", "error": "invalid_app_request"}
    apps = catalog()
    matches = [
        v
        for v in apps.values()
        if not app or app.casefold() in v["name"].casefold() or app == v["id"]
    ]
    if action == "list":
        return {
            "status": "listed",
            "apps": [{"id": v["id"], "name": v["name"]} for v in matches[:120]],
        }
    exact = [
        v for v in matches if app == v["id"] or app.casefold() == v["name"].casefold()
    ]
    matches = exact or matches
    if not app or len(matches) != 1:
        return {
            "status": "needs_exact_app",
            "apps": [{"id": v["id"], "name": v["name"]} for v in matches[:20]],
        }
    selected = matches[0]
    # Shell resolves an already registered app; no model-supplied command, arguments or path.
    os.startfile("shell:AppsFolder\\" + selected["native"])
    return {
        "status": "launch_requested",
        "name": selected["name"],
        "note": "Windows accepted the launch request; this does not confirm playback or further UI actions.",
    }
