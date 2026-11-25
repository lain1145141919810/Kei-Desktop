"""Exercise executor discovery, availability, lifecycle, cancellation, isolation and real CLI interop."""
import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host_smoke import BuiltHost
from kei_host.execution.adapters import Native, Stdio, TaskFailure

READER_ADAPTER = r"""import json, os, subprocess, sys, time
from pathlib import Path

def send(**message):
    print(json.dumps(message, ensure_ascii=True), flush=True)

request = json.loads(sys.stdin.readline())
assert request["type"] == "start" and request["version"] == 1
task = request["task"]
mode = task["input"]

if mode.startswith("read:"):
    _, filename, line_no = mode.split(":", 2)
    send(type="progress", data={"stage": "reading", "file": filename})
    time.sleep(0.05)
    lines = Path(filename).read_text(encoding="utf-8").splitlines()
    picked = lines[int(line_no) - 1]
    send(type="progress", data={"stage": "extracted", "line": int(line_no)})
    artifact = "out-" + task["requestId"] + ".txt"
    Path(artifact).write_text(picked + "\n", encoding="utf-8")
    send(type="result", text=picked, artifacts=[artifact])
elif mode == "followup":
    prev = request["previous"]
    send(type="progress", data={"stage": "followup"})
    send(type="result", text="followup:" + prev["text"], artifacts=[])
elif mode == "ask":
    send(type="progress", data={"stage": "awaiting_input"})
    send(type="input", id="confirm-line", prompt="Provide synthetic confirmation token")
    answer = json.loads(sys.stdin.readline())
    assert answer["type"] == "input" and answer["id"] == "confirm-line"
    send(type="result", text="answered:" + answer["value"], artifacts=[])
elif mode == "crash_during_input":
    # A live descendant inherits stdout. The parent exit must still end input.
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(15)"])
    send(type="input", id="q-crash", prompt="Adapter will exit immediately")
    time.sleep(0.15)
    raise SystemExit(5)
elif mode == "exit":
    send(type="progress", data={"stage": "failing"})
    raise SystemExit(7)
elif mode == "deep_json":
    print("[" * 2500 + "]" * 2500, flush=True)
elif mode == "bad_json":
    print("{not-valid-json", flush=True)
elif mode == "long_line":
    print("x" * 70000, flush=True)
elif mode == "non_dict":
    print("[1, 2, 3]", flush=True)
elif mode == "nan_progress":
    print('{"type":"progress","data":{"bad":NaN}}', flush=True)
elif mode == "escape_artifact":
    send(type="result", text="escape", artifacts=["../outside.txt"])
elif mode == "empty_result":
    send(type="result", text="   ", artifacts=[])
elif mode == "extra_after_result":
    send(type="progress", data={"stage": "before_result"})
    send(type="result", text="FIRST_RESULT", artifacts=[])
    send(type="progress", data={"stage": "late_progress"})
    send(type="result", text="SECOND_RESULT", artifacts=[])
    print("x" * 400000, flush=True)
elif mode == "slow_with_child":
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    Path("child-pid-" + task["requestId"] + ".txt").write_text(str(child.pid), encoding="utf-8")
    send(type="progress", data={"stage": "sleeping", "childStarted": True})
    time.sleep(0.5)
    send(type="result", text="LATE_AFTER_CANCEL", artifacts=[])
    time.sleep(30)
elif mode == "slow_hold":
    send(type="progress", data={"stage": "holding"})
    time.sleep(30)
else:
    send(type="result", text="ok:" + mode, artifacts=[])
"""

CRASH_FAST_ADAPTER = "import sys\nraise SystemExit(9)\n"

MINIMAL_ADAPTER = r"""import json, sys, time
req = json.loads(sys.stdin.readline())
mode = req["task"]["input"]
print(json.dumps({"type": "progress", "data": {"stage": "minimal"}}), flush=True)
if mode == "undeclared_input":
    print(json.dumps({"type": "input", "id": "x", "prompt": "not allowed"}), flush=True)
    time.sleep(2)
elif mode == "slow":
    time.sleep(1.0)
    print(json.dumps({"type": "result", "text": "minimal-done", "artifacts": []}), flush=True)
else:
    print(json.dumps({"type": "result", "text": "minimal-ok", "artifacts": []}), flush=True)
"""


def wait_task(host, task_id, target_statuses, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = host.request("GET", f"/v1/tasks/{task_id}")
        if task["status"] in target_statuses:
            return task
        time.sleep(0.05)
    raise AssertionError(f"Task {task_id} did not reach {target_statuses} (last={task['status']})")


def all_events(host, task_id):
    events = []
    cursor = 0
    while True:
        page = host.request("GET", f"/v1/tasks/{task_id}/events?after={cursor}")
        events.extend(page["events"])
        cursor = page["cursor"]
        if not page["hasMore"]:
            break
    seqs = [e["sequence"] for e in events]
    assert seqs == list(range(1, len(events) + 1)), f"Out-of-order sequences: {seqs}"
    return events


def pid_alive(pid):
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x100000 | 0x0400, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return bool(ok and code.value == 259)  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False


def verify_unit_contracts(tmp_root):
    # 1. Native Codex unavailability reasons
    ws = tmp_root / "ws-unit"
    ws.mkdir()
    assert Native("codex", {}).unavailable(ws) == "codex_not_configured"
    assert Native("codex", {"codex_executable": str(tmp_root / "missing-codex.exe")}).unavailable(ws) == "cli_missing"
    fake_exe = tmp_root / "fake-codex.exe"
    fake_exe.write_bytes(b"MZ-synthetic")
    assert Native("codex", {"codex_executable": str(fake_exe), "codex_model": "bad model!"}).unavailable(ws) == "invalid_executor_config"
    assert Native("codex", {
        "codex_executable": str(fake_exe),
        "codex_validated_workspace": str(ws),
        "codex_verified_sha256": "0" * 64,
    }).unavailable(ws) == "codex_permission_validation_failed"

    # 2. Native DSH unavailability reason when entry missing
    assert Native("dsh", {"dsh_entry": str(tmp_root / "missing-dsh.js")}).unavailable(ws) == "cli_missing"

    # 3. Non-dict Stdio manifest cleanly rejected with ValueError
    for bad in ([], "nope", 42, None):
        try:
            Stdio(bad)
            raise AssertionError(f"Expected ValueError for {bad!r}")
        except ValueError:
            pass

    # 4. Spawn-time FileNotFoundError maps cleanly to TaskFailure("cli_missing")
    vanished = Stdio({
        "id": "acme.vanished", "name": "Vanished", "apiVersion": 1,
        "command": [str(tmp_root / "never-existed-r19.exe")], "capabilities": ["progress"],
    })

    class DummyContext:
        request = {"workspace": str(ws)}

    try:
        asyncio.run(vanished.run(DummyContext(), None))
        raise AssertionError("Expected TaskFailure('cli_missing')")
    except TaskFailure as error:
        assert error.code == "cli_missing", error.code

    return {
        "codexReasonCodesChecked": [
            "codex_not_configured", "cli_missing", "invalid_executor_config", "codex_permission_validation_failed",
        ],
        "dshMissingReason": "cli_missing",
        "stdioNonDictManifestRejected": True,
        "stdioSpawnFileNotFoundMapsToCliMissing": True,
    }


def verify(artifact, real_dsh=False, codex_config=None):
    report = {
        "evidenceSeparation": {
            "fixtureAdapter": "deterministic-offline-fixture",
            "dsh": "real-cli-executed" if real_dsh else "not-requested",
            "codex": "real-cli-executed" if codex_config else "unavailable-not-configured",
        },
        "unitContracts": {},
        "fixtureCoverage": {},
        "adapters": {},
    }

    with tempfile.TemporaryDirectory(prefix="kei-exec-interop-") as tmp:
        root = Path(tmp)
        report["unitContracts"] = verify_unit_contracts(root)
        print("PASS Group 1: unit contracts & reason codes")

        adapters_dir = root / "adapters"
        adapters_dir.mkdir()
        reader_py = root / "acme_reader.py"
        reader_py.write_text(READER_ADAPTER, encoding="utf-8")
        crash_py = root / "acme_crash.py"
        crash_py.write_text(CRASH_FAST_ADAPTER, encoding="utf-8")
        minimal_py = root / "acme_minimal.py"
        minimal_py.write_text(MINIMAL_ADAPTER, encoding="utf-8")

        (adapters_dir / "acme-reader.json").write_text(json.dumps({
            "id": "acme.reader", "name": "Acme Fixture Reader", "apiVersion": 1,
            "command": [sys.executable, str(reader_py)],
            "capabilities": ["progress", "cancel", "input", "attachments", "artifacts", "followUp"],
        }), encoding="utf-8")
        (adapters_dir / "acme-crash.json").write_text(json.dumps({
            "id": "acme.crashfast", "name": "Acme Crash Fast", "apiVersion": 1,
            "command": [sys.executable, str(crash_py)],
            "capabilities": ["progress", "cancel"],
        }), encoding="utf-8")
        (adapters_dir / "acme-missing.json").write_text(json.dumps({
            "id": "acme.missing", "name": "Acme Missing CLI", "apiVersion": 1,
            "command": [str(root / "nonexistent-acme-tool.exe")],
            "capabilities": ["progress", "cancel"],
        }), encoding="utf-8")
        (adapters_dir / "acme-minimal.json").write_text(json.dumps({
            "id": "acme.minimal", "name": "Acme Minimal", "apiVersion": 1,
            "command": [sys.executable, str(minimal_py)],
            "capabilities": ["progress"],
        }), encoding="utf-8")

        data = root / "host-main"
        data.mkdir()
        ws = data / "workspace"
        ws.mkdir()
        (ws / "synthetic-lines.txt").write_text(
            "LINE-1: alpha-001\nLINE-2: bravo-002\nLINE-3: kei-r19-target-line-7391\nLINE-4: delta-004\n",
            encoding="utf-8",
        )
        ws_alpha = ws / "ws-alpha"
        ws_beta = ws / "ws-beta"
        ws_alpha.mkdir()
        ws_beta.mkdir()
        (ws_alpha / "synthetic-lines.txt").write_text("L1\nL2\nALPHA-LINE-3-1111\n", encoding="utf-8")
        (ws_beta / "synthetic-lines.txt").write_text("L1\nL2\nBETA-LINE-3-2222\n", encoding="utf-8")

        with BuiltHost(artifact, data, ("--executor-dir", str(adapters_dir))) as host:
            # Group 2: Discovery, benign read task, identity, ordered progress, artifacts, followUp, idempotency
            discovered = host.request("GET", "/v1/executors")
            by_id = {item["id"]: item for item in discovered["executors"]}
            assert {"dsh", "codex", "acme.reader", "acme.crashfast", "acme.missing", "acme.minimal"} <= set(by_id)
            assert by_id["acme.reader"]["available"] is True and by_id["acme.reader"]["reason"] is None
            assert by_id["acme.missing"]["available"] is False and by_id["acme.missing"]["reason"] == "cli_missing"
            assert by_id["codex"]["available"] is False and by_id["codex"]["reason"] == "codex_not_configured"

            # Record sanitized built-in discovery descriptors
            report["adapters"]["dsh"] = {
                "evidenceClass": "discovery-only",
                "available": by_id["dsh"]["available"],
                "reason": by_id["dsh"]["reason"],
                "capabilities": by_id["dsh"]["capabilities"],
                "options": by_id["dsh"].get("options"),
            }
            report["adapters"]["codex"] = {
                "evidenceClass": "unavailable-not-configured",
                "executed": False,
                "available": by_id["codex"]["available"],
                "reason": by_id["codex"]["reason"],
                "capabilities": by_id["codex"]["capabilities"],
                "missingPrerequisites": [
                    "Authorized Windows codex.exe binary (not installed on host PATH or standard directories)",
                    "Operator --executor-config / executors.json specifying codex_executable, codex_verified_sha256, codex_validated_workspace, and optional codex_model",
                ],
                "optInCommand": "python tests/backend_acceptance/verify_executor_interop.py dist/kei-host.pyz --codex-config <path/to/executors.json>",
            }

            # Missing executable submit rejected cleanly with 503 cli_missing
            host.request("POST", "/v1/tasks", {
                "executorId": "acme.missing", "requestId": "miss-1", "conversationId": "conv-f", "input": "hi",
            }, status=503, error="cli_missing")

            # Benign synthetic-file read task on independent fixture adapter acme.reader
            body_read = {
                "executorId": "acme.reader",
                "requestId": "read-1",
                "conversationId": "conv-f",
                "input": "read:synthetic-lines.txt:3",
                "attachments": ["synthetic-lines.txt"],
            }
            sub = host.request("POST", "/v1/tasks", body_read, status=202)
            assert sub["executorId"] == "acme.reader" and sub["requestId"] == "read-1" and sub["conversationId"] == "conv-f"
            # Idempotent repeat returns 200 with exact same task ID; changed body returns 409 request_conflict
            repeat = host.request("POST", "/v1/tasks", body_read, status=200)
            assert repeat["id"] == sub["id"]
            host.request("POST", "/v1/tasks", {**body_read, "input": "read:synthetic-lines.txt:2"}, status=409, error="request_conflict")

            done = wait_task(host, sub["id"], {"succeeded", "failed", "cancelled"})
            assert done["status"] == "succeeded"
            assert done["result"]["text"] == "LINE-3: kei-r19-target-line-7391"
            assert done["result"]["artifacts"] == ["out-read-1.txt"]
            evts = all_events(host, sub["id"])
            assert [e["type"] for e in evts] == [
                "task.queued", "task.started", "task.progress", "task.progress", "task.succeeded",
            ]
            assert [e["data"]["stage"] for e in evts if e["type"] == "task.progress"] == ["reading", "extracted"]

            # Follow-up task scoped to same conversation & workspace
            fu = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "fu-1", "conversationId": "conv-f",
                "input": "followup", "followUpTaskId": done["id"],
            }, status=202)
            fu_done = wait_task(host, fu["id"], {"succeeded", "failed"})
            assert fu_done["status"] == "succeeded" and fu_done["result"]["text"] == "followup:LINE-3: kei-r19-target-line-7391"
            host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "fu-bad", "conversationId": "conv-other",
                "input": "followup", "followUpTaskId": done["id"],
            }, status=409, error="invalid_follow_up")

            # Unsupported capability checks on acme.minimal
            host.request("POST", "/v1/tasks", {
                "executorId": "acme.minimal", "requestId": "min-att", "conversationId": "conv-m",
                "input": "ok", "attachments": ["synthetic-lines.txt"],
            }, status=409, error="unsupported_capability")
            host.request("POST", "/v1/tasks", {
                "executorId": "acme.minimal", "requestId": "min-fu", "conversationId": "conv-f",
                "input": "ok", "followUpTaskId": done["id"],
            }, status=409, error="unsupported_capability")
            min_slow = host.request("POST", "/v1/tasks", {
                "executorId": "acme.minimal", "requestId": "min-slow", "conversationId": "conv-m", "input": "slow",
            }, status=202)
            wait_task(host, min_slow["id"], {"running", "succeeded"})
            host.request("POST", f"/v1/tasks/{min_slow['id']}/cancel", {}, status=409, error="unsupported_capability")
            assert wait_task(host, min_slow["id"], {"succeeded"})["result"]["text"] == "minimal-done"
            min_bad = host.request("POST", "/v1/tasks", {
                "executorId": "acme.minimal", "requestId": "min-in", "conversationId": "conv-m", "input": "undeclared_input",
            }, status=202)
            assert wait_task(host, min_bad["id"], {"failed"})["error"]["code"] == "adapter_protocol_error"
            print("PASS Group 2 & 3: independent registration, benign read, follow-up, missing CLI, unsupported capabilities")

            # Group 4: Input request lifecycle + crash-during-input regression
            ask_sub = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "ask-1", "conversationId": "conv-in", "input": "ask",
            }, status=202)
            waiting = wait_task(host, ask_sub["id"], {"waiting_for_input", "failed"})
            assert waiting["status"] == "waiting_for_input" and waiting["inputRequest"]["id"] == "confirm-line"
            host.request("POST", f"/v1/tasks/{waiting['id']}/input", {"inputId": "wrong", "value": "x"}, status=409, error="input_not_pending")
            host.request("POST", f"/v1/tasks/{waiting['id']}/input", {"inputId": "confirm-line", "value": "   "}, status=422, error="invalid_task")
            host.request("POST", f"/v1/tasks/{waiting['id']}/input", {"inputId": "confirm-line", "value": "yes-r19"})
            ask_done = wait_task(host, waiting["id"], {"succeeded", "failed"})
            assert ask_done["status"] == "succeeded" and ask_done["result"]["text"] == "answered:yes-r19"
            seq_before_late_in = ask_done["sequence"]
            host.request("POST", f"/v1/tasks/{waiting['id']}/input", {"inputId": "confirm-line", "value": "late"}, status=409, error="input_not_pending")
            assert host.request("GET", f"/v1/tasks/{waiting['id']}")["sequence"] == seq_before_late_in

            # Targeted Regression: child crashes while host is waiting_for_input -> must fail promptly with adapter_exited!
            t_crash_in = time.monotonic()
            crash_in_sub = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "ask-crash", "conversationId": "conv-in", "input": "crash_during_input",
            }, status=202)
            crash_in_done = wait_task(host, crash_in_sub["id"], {"failed", "succeeded"}, timeout=4.0)
            crash_in_elapsed = round(time.monotonic() - t_crash_in, 3)
            assert crash_in_done["status"] == "failed" and crash_in_done["error"]["code"] == "adapter_exited", crash_in_done
            assert crash_in_done["inputRequest"] is None and crash_in_done["error"]["mayHaveSideEffects"] is True
            assert crash_in_elapsed < 2.5, f"crash_during_input hung ({crash_in_elapsed}s)"
            host.request("POST", f"/v1/tasks/{crash_in_done['id']}/input", {"inputId": "q-crash", "value": "late"}, status=409, error="input_not_pending")
            print(f"PASS Group 4: input request lifecycle + crash-during-input fast recovery ({crash_in_elapsed}s)")

            # Group 5: Process failure, instant crash, protocol violations, artifact escape, empty result, extra output after result
            failure_cases = [
                ("acme.reader", "exit", "adapter_exited"),
                ("acme.crashfast", "go", "adapter_exited"),
                ("acme.reader", "deep_json", "adapter_protocol_error"),
                ("acme.reader", "bad_json", "adapter_protocol_error"),
                ("acme.reader", "long_line", "adapter_protocol_error"),
                ("acme.reader", "non_dict", "adapter_protocol_error"),
                ("acme.reader", "nan_progress", "adapter_protocol_error"),
                ("acme.reader", "escape_artifact", "invalid_artifacts"),
                ("acme.reader", "empty_result", "invalid_result"),
            ]
            for idx, (exec_id, inp, expected_code) in enumerate(failure_cases):
                ft = host.request("POST", "/v1/tasks", {
                    "executorId": exec_id, "requestId": f"fail-{idx}", "conversationId": "conv-fail", "input": inp,
                }, status=202)
                fd = wait_task(host, ft["id"], {"failed", "succeeded"})
                assert fd["status"] == "failed" and fd["error"]["code"] == expected_code, (inp, fd)
                assert fd["error"]["mayHaveSideEffects"] is True

            # Extra stdout lines after result cannot alter terminal task or emit post-terminal events
            ear = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "ear-1", "conversationId": "conv-fail", "input": "extra_after_result",
            }, status=202)
            ear_done = wait_task(host, ear["id"], {"succeeded", "failed"})
            assert ear_done["status"] == "succeeded" and ear_done["result"]["text"] == "FIRST_RESULT"
            ear_evts = all_events(host, ear["id"])
            assert [e["type"] for e in ear_evts] == ["task.queued", "task.started", "task.progress", "task.succeeded"]
            print("PASS Group 5: process failure, instant crash, deep JSON/protocol errors, artifact sandbox, post-result immutability")

            # Group 6: Requested vs confirmed cancellation (running + grandchild reap, waiting_for_input, queued) & late output immutability
            # 6a. Running task with grandchild process + late result attempt
            can_sub = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "can-run", "conversationId": "conv-can", "input": "slow_with_child",
            }, status=202)
            # Wait until progress confirms grandchild spawned
            deadline = time.monotonic() + 8.0
            while time.monotonic() < deadline:
                evs = all_events(host, can_sub["id"])
                if any(e["type"] == "task.progress" and e["data"].get("childStarted") for e in evs):
                    break
                time.sleep(0.05)
            pid_file = ws / "child-pid-can-run.txt"
            child_pid = int(pid_file.read_text(encoding="utf-8").strip())

            can_req = host.request("POST", f"/v1/tasks/{can_sub['id']}/cancel", {}, status=202)
            assert can_req["accepted"] is True and can_req["confirmed"] is False and can_req["task"]["status"] == "cancelling"
            can_done = wait_task(host, can_sub["id"], {"cancelled", "succeeded", "failed"})
            assert can_done["status"] == "cancelled" and can_done["result"] is None
            assert can_done["error"] == {"code": "cancelled", "mayHaveSideEffects": True}
            can_again = host.request("POST", f"/v1/tasks/{can_sub['id']}/cancel", {}, status=200)
            assert can_again["accepted"] is False and can_again["confirmed"] is True
            # Wait past the 0.5s late-result window and verify terminal immutability + grandchild death
            time.sleep(0.6)
            can_after = host.request("GET", f"/v1/tasks/{can_sub['id']}")
            assert can_after["status"] == "cancelled" and can_after["sequence"] == can_done["sequence"] and can_after["result"] is None
            assert not pid_alive(child_pid), f"Grandchild PID {child_pid} outlived cancelled task!"
            can_evts = all_events(host, can_sub["id"])
            assert [e["type"] for e in can_evts] == ["task.queued", "task.started", "task.progress", "task.cancel_requested", "task.cancelled"]

            # 6b. Cancel while waiting_for_input
            ask_can = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "can-wait", "conversationId": "conv-can", "input": "ask",
            }, status=202)
            wait_task(host, ask_can["id"], {"waiting_for_input"})
            ask_can_req = host.request("POST", f"/v1/tasks/{ask_can['id']}/cancel", {}, status=202)
            assert ask_can_req["accepted"] is True and ask_can_req["confirmed"] is False and ask_can_req["task"]["inputRequest"] is None
            host.request("POST", f"/v1/tasks/{ask_can['id']}/input", {"inputId": "confirm-line", "value": "too-late"}, status=409, error="input_not_pending")
            ask_can_done = wait_task(host, ask_can["id"], {"cancelled", "failed", "succeeded"})
            assert ask_can_done["status"] == "cancelled" and ask_can_done["error"]["mayHaveSideEffects"] is True

            # 6c. Cancel while queued (saturate 3 workers, cancel 4th before it starts -> mayHaveSideEffects: False)
            holders = [
                host.request("POST", "/v1/tasks", {
                    "executorId": "acme.reader", "requestId": f"hold-{i}", "conversationId": "conv-q", "input": "slow_hold",
                }, status=202)
                for i in range(3)
            ]
            for h in holders:
                wait_task(host, h["id"], {"running"})
            queued_4th = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "queued-4", "conversationId": "conv-q", "input": "read:synthetic-lines.txt:3",
            }, status=202)
            assert queued_4th["status"] == "queued"
            q_req = host.request("POST", f"/v1/tasks/{queued_4th['id']}/cancel", {}, status=202)
            assert q_req["accepted"] is True and q_req["confirmed"] is False and q_req["task"]["status"] == "cancelling"
            for h in holders:
                host.request("POST", f"/v1/tasks/{h['id']}/cancel", {}, status=202)
            for h in holders:
                assert wait_task(host, h["id"], {"cancelled"})["status"] == "cancelled"
            q_done = wait_task(host, queued_4th["id"], {"cancelled", "succeeded", "failed"})
            assert q_done["status"] == "cancelled" and q_done["error"]["mayHaveSideEffects"] is False, q_done
            assert [e["type"] for e in all_events(host, queued_4th["id"])] == ["task.queued", "task.cancel_requested", "task.cancelled"]
            print("PASS Group 6: requested vs confirmed cancel (running+grandchild, waiting_for_input, queued), late-output immutability")

            # Group 7: Concurrent task isolation across workspaces & conversations (including simultaneous failure)
            with ThreadPoolExecutor(max_workers=3) as pool:
                f_alpha = pool.submit(host.request, "POST", "/v1/tasks", {
                    "executorId": "acme.reader", "requestId": "conc-alpha", "conversationId": "conv-iso-alpha",
                    "workspace": "ws-alpha", "input": "read:synthetic-lines.txt:3", "attachments": ["synthetic-lines.txt"],
                }, 202)
                f_beta = pool.submit(host.request, "POST", "/v1/tasks", {
                    "executorId": "acme.reader", "requestId": "conc-beta", "conversationId": "conv-iso-beta",
                    "workspace": "ws-beta", "input": "read:synthetic-lines.txt:3", "attachments": ["synthetic-lines.txt"],
                }, 202)
                f_fail = pool.submit(host.request, "POST", "/v1/tasks", {
                    "executorId": "acme.reader", "requestId": "conc-fail", "conversationId": "conv-iso-fail",
                    "workspace": ".", "input": "exit",
                }, 202)
                t_alpha, t_beta, t_fail = f_alpha.result(), f_beta.result(), f_fail.result()

            d_alpha = wait_task(host, t_alpha["id"], {"succeeded", "failed"})
            d_beta = wait_task(host, t_beta["id"], {"succeeded", "failed"})
            d_fail = wait_task(host, t_fail["id"], {"succeeded", "failed"})
            assert d_alpha["status"] == "succeeded" and d_alpha["result"]["text"] == "ALPHA-LINE-3-1111"
            assert d_beta["status"] == "succeeded" and d_beta["result"]["text"] == "BETA-LINE-3-2222"
            assert d_fail["status"] == "failed" and d_fail["error"]["code"] == "adapter_exited"
            assert (ws_alpha / "out-conc-alpha.txt").exists() and not (ws_alpha / "out-conc-beta.txt").exists()
            assert (ws_beta / "out-conc-beta.txt").exists() and not (ws_beta / "out-conc-alpha.txt").exists()
            assert [t["id"] for t in host.request("GET", "/v1/tasks?conversationId=conv-iso-alpha")] == [t_alpha["id"]]
            assert [t["id"] for t in host.request("GET", "/v1/tasks?conversationId=conv-iso-beta")] == [t_beta["id"]]
            print("PASS Group 7: concurrent task isolation (workspaces, artifacts, conversations, fault isolation)")

        # Group 5b: Bounded task timeout on a separate 2-second-timeout host instance
        data_to = root / "host-timeout"
        data_to.mkdir()
        (data_to / "executors.json").write_text(json.dumps({"timeoutSeconds": 2}), encoding="utf-8")
        with BuiltHost(artifact, data_to, ("--executor-dir", str(adapters_dir))) as host:
            t0 = time.monotonic()
            to_sub = host.request("POST", "/v1/tasks", {
                "executorId": "acme.reader", "requestId": "to-1", "conversationId": "conv-to", "input": "slow_hold",
            }, status=202)
            to_done = wait_task(host, to_sub["id"], {"failed", "succeeded"}, timeout=8.0)
            to_elapsed = round(time.monotonic() - t0, 3)
            assert to_done["status"] == "failed" and to_done["error"]["code"] == "task_timed_out", to_done
            print(f"PASS Group 5b: bounded task timeout ({to_elapsed}s)")

        report["fixtureCoverage"] = {
            "adapterId": "acme.reader",
            "hostOrUiBranchRequired": False,
            "benignReadExactLine": "LINE-3: kei-r19-target-line-7391",
            "missingExecutableReason": "cli_missing",
            "inputRequestAndCrashDuringInput": {"status": "PASS", "crashDetectSeconds": crash_in_elapsed},
            "processAndProtocolFailuresChecked": len(failure_cases),
            "boundedTimeoutSeconds": to_elapsed,
            "cancellationModes": ["running_with_grandchild", "waiting_for_input", "queued_no_side_effects"],
            "lateOutputImmutable": True,
            "concurrentIsolation": "PASS",
        }

        # Optional Real CLI Execution: DSH (only if requested and locally available & authorized)
        if real_dsh:
            data_dsh = root / "host-real-dsh"
            data_dsh.mkdir()
            ws_dsh = data_dsh / "workspace"
            ws_dsh.mkdir()
            (ws_dsh / "synthetic-lines.txt").write_text(
                "LINE-1: alpha-001\nLINE-2: bravo-002\nLINE-3: kei-r19-target-line-7391\nLINE-4: delta-004\n",
                encoding="utf-8",
            )
            with BuiltHost(artifact, data_dsh) as host:
                dsh_desc = next(e for e in host.request("GET", "/v1/executors")["executors"] if e["id"] == "dsh")
                if not dsh_desc["available"]:
                    report["adapters"]["dsh"] = {
                        "evidenceClass": "unavailable",
                        "executed": False,
                        "available": False,
                        "reason": dsh_desc["reason"],
                        "capabilities": dsh_desc["capabilities"],
                    }
                else:
                    t0 = time.monotonic()
                    sub_r = host.request("POST", "/v1/tasks", {
                        "executorId": "dsh",
                        "requestId": "r19-dsh-benign-read",
                        "conversationId": "r19-real-dsh",
                        "input": "Read synthetic-lines.txt in the workspace and return only line 3 verbatim.",
                        "attachments": ["synthetic-lines.txt"],
                        "options": {"model": "flash"},
                    }, status=202)
                    done_r = wait_task(host, sub_r["id"], {"succeeded", "failed", "cancelled"}, timeout=90.0)
                    read_s = round(time.monotonic() - t0, 3)
                    evts_r = all_events(host, sub_r["id"])
                    assert done_r["status"] == "succeeded", done_r
                    assert "kei-r19-target-line-7391" in done_r["result"]["text"], done_r["result"]
                    assert done_r["id"] == sub_r["id"] and done_r["requestId"] == "r19-dsh-benign-read"
                    assert done_r["executorId"] == "dsh" and done_r["conversationId"] == "r19-real-dsh"
                    # Input capability is False for DSH; /input must refuse with 409 input_not_pending
                    host.request("POST", f"/v1/tasks/{done_r['id']}/input", {"inputId": "q1", "value": "x"}, status=409, error="input_not_pending")
                    # Terminal immutability check
                    seq_done_r = done_r["sequence"]
                    assert host.request("POST", f"/v1/tasks/{done_r['id']}/cancel", {}, status=200) == {
                        "accepted": False, "confirmed": False, "task": done_r,
                    }

                    # Real DSH cancellation: requested (accepted=True, confirmed=False) -> confirmed (cancelled) + post-terminal immutability
                    sub_c = host.request("POST", "/v1/tasks", {
                        "executorId": "dsh",
                        "requestId": "r19-dsh-cancel",
                        "conversationId": "r19-real-dsh",
                        "input": "Read synthetic-lines.txt and write a detailed 40-paragraph analysis of every token.",
                        "attachments": ["synthetic-lines.txt"],
                        "options": {"model": "flash"},
                    }, status=202)
                    wait_task(host, sub_c["id"], {"running", "succeeded", "failed"}, timeout=20.0)
                    t_c = time.monotonic()
                    req_c = host.request("POST", f"/v1/tasks/{sub_c['id']}/cancel", {}, status=202)
                    assert req_c["accepted"] is True and req_c["confirmed"] is False and req_c["task"]["status"] == "cancelling"
                    fin_c = wait_task(host, sub_c["id"], {"cancelled", "succeeded", "failed"}, timeout=20.0)
                    can_s = round(time.monotonic() - t_c, 3)
                    assert fin_c["status"] == "cancelled" and fin_c["result"] is None
                    assert fin_c["error"] == {"code": "cancelled", "mayHaveSideEffects": True}
                    again_c = host.request("POST", f"/v1/tasks/{sub_c['id']}/cancel", {}, status=200)
                    assert again_c["accepted"] is False and again_c["confirmed"] is True
                    evts_c = all_events(host, sub_c["id"])
                    assert [e["type"] for e in evts_c] == ["task.queued", "task.started", "task.cancel_requested", "task.cancelled"]
                    time.sleep(1.0)
                    after_c = host.request("GET", f"/v1/tasks/{sub_c['id']}")
                    assert after_c["status"] == "cancelled" and after_c["sequence"] == fin_c["sequence"] and after_c["result"] is None

                    report["adapters"]["dsh"] = {
                        "evidenceClass": "real-cli-executed",
                        "executed": True,
                        "available": True,
                        "reason": None,
                        "capabilities": dsh_desc["capabilities"],
                        "unsupportedOperations": ["input"],
                        "benignReadTask": {
                            "status": done_r["status"],
                            "elapsedSeconds": read_s,
                            "returnedExactTargetLine": done_r["result"]["text"] == "LINE-3: kei-r19-target-line-7391",
                            "model": (done_r["result"].get("metadata") or {}).get("model"),
                            "orderedEvents": [e["type"] for e in evts_r],
                            "terminalSequence": seq_done_r,
                        },
                        "cancellation": {
                            "requested": {"httpStatus": 202, "accepted": True, "confirmed": False, "status": "cancelling"},
                            "confirmed": {"status": "cancelled", "mayHaveSideEffects": True, "elapsedSeconds": can_s},
                            "repeatCancel": {"httpStatus": 200, "accepted": False, "confirmed": True},
                            "orderedEvents": [e["type"] for e in evts_c],
                            "postTerminalImmutableAfter1s": True,
                        },
                    }
                    print(f"PASS Real CLI (DSH): benign read ({read_s}s) + requested/confirmed cancel ({can_s}s)")

        # Optional Real CLI Execution: Codex (only when owner supplies explicit --codex-config)
        if codex_config:
            cfg = json.loads(Path(codex_config).read_text(encoding="utf-8-sig"))
            data_codex = root / "host-real-codex"
            data_codex.mkdir()
            with BuiltHost(artifact, data_codex, ("--executor-config", str(Path(codex_config).resolve()))) as host:
                codex_desc = next(e for e in host.request("GET", "/v1/executors")["executors"] if e["id"] == "codex")
                if not codex_desc["available"]:
                    report["adapters"]["codex"] = {
                        "evidenceClass": "unavailable-after-config",
                        "executed": False,
                        "available": False,
                        "reason": codex_desc["reason"],
                        "capabilities": codex_desc["capabilities"],
                    }
                else:
                    ws_codex = Path(cfg["workspace"])
                    sample_file = ws_codex / "kei-r19-synthetic-lines.txt"
                    sample_file.write_text(
                        "LINE-1: alpha-001\nLINE-2: bravo-002\nLINE-3: kei-r19-target-line-7391\nLINE-4: delta-004\n",
                        encoding="utf-8",
                    )
                    try:
                        t0 = time.monotonic()
                        sub_x = host.request("POST", "/v1/tasks", {
                            "executorId": "codex",
                            "requestId": "r19-codex-benign-read",
                            "conversationId": "r19-real-codex",
                            "input": "Read kei-r19-synthetic-lines.txt in the workspace and return only line 3 verbatim.",
                            "attachments": ["kei-r19-synthetic-lines.txt"],
                        }, status=202)
                        done_x = wait_task(host, sub_x["id"], {"succeeded", "failed", "cancelled"}, timeout=90.0)
                        evts_x = all_events(host, sub_x["id"])
                        assert done_x["status"] == "succeeded" and "kei-r19-target-line-7391" in done_x["result"]["text"]
                        report["adapters"]["codex"] = {
                            "evidenceClass": "real-cli-executed",
                            "executed": True,
                            "available": True,
                            "reason": None,
                            "capabilities": codex_desc["capabilities"],
                            "unsupportedOperations": ["input"],
                            "benignReadTask": {
                                "status": done_x["status"],
                                "elapsedSeconds": round(time.monotonic() - t0, 3),
                                "orderedEvents": [e["type"] for e in evts_x],
                            },
                        }
                    finally:
                        sample_file.unlink(missing_ok=True)

    report["allPassed"] = True
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--real-dsh", action="store_true", help="Run benign read + cancel task against locally installed DSH CLI")
    parser.add_argument("--codex-config", type=Path, help="Operator-supplied executors.json for opt-in real Codex verification")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = verify(args.artifact.resolve(), real_dsh=args.real_dsh, codex_config=args.codex_config)
    if args.out:
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
