"""Exercise chat and visual-plan provider interoperability against the built host."""
import argparse
import http.server
import json
import os
import socket
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host_smoke import BuiltHost
from kei_host.chat import VISUAL_FACES, VISUAL_MOTIONS, parse_visual_plan

ADAPTER_SOURCE = """import json, sys, time
from pathlib import Path

def send(**message):
    print(json.dumps(message), flush=True)

request = json.loads(sys.stdin.readline())
assert request["type"] == "start" and request["version"] == 1
task = request["task"]
send(type="progress", data={"stage": "started"})
if task["input"] == "exit":
    raise SystemExit(7)
if task["input"] == "slow":
    time.sleep(30)
if task["input"] == "ask":
    send(type="input", id="q1", prompt="Enter synthetic answer")
    answer = json.loads(sys.stdin.readline())
    assert answer["type"] == "input" and answer["id"] == "q1"
    response = "answer:" + answer["value"]
else:
    response = "done"
artifact = "work-" + task["requestId"] + ".txt"
Path(artifact).write_text(response, encoding="utf-8")
send(type="result", text=response, artifacts=[artifact])
"""


def test_parse_visual_plan():
    # 1. Preserve valid plain JSON across all allowlisted faces and motions.
    for face in VISUAL_FACES:
        assert parse_visual_plan(json.dumps({"face": face, "motion": "none"})) == {"face": face, "motion": "none"}
    for motion in VISUAL_MOTIONS:
        assert parse_visual_plan(json.dumps({"face": "neutral", "motion": motion})) == {"face": "neutral", "motion": motion}
    assert parse_visual_plan('  \r\n{\n  "face": "relieved",\n  "motion": "nod"\n}\r\n  ') == {
        "face": "relieved",
        "motion": "nod",
    }

    # 2. Accept a single unambiguous fenced JSON object matching the exact schema & allowlist.
    valid_fenced = [
        '```json\n{"face":"happy","motion":"nod"}\n```',
        '```JSON\r\n{"face": "thoughtful", "motion": "tilt"}\r\n```',
        '``` json \n{\n  "face": "worried",\n  "motion": "shake"\n}\n```',
        '```\n{"face":"smallSmile","motion":"none"}\n```',
        '  \n```json\n\n{"face":"gentle","motion":"nod"}\n\n```\n  ',
    ]
    for sample in valid_fenced:
        parsed = parse_visual_plan(sample)
        assert parsed is not None and set(parsed) == {"face", "motion"}, sample

    # 3. Reject prose, multiple/extra objects, wrong tags, duplicate keys, bad schemas, and invalid actions.
    invalid_samples = [
        None,
        123,
        "",
        "   ",
        "{}",
        "[]",
        '[{"face":"happy","motion":"nod"}]',
        'Sure! {"face":"happy","motion":"nod"}',
        '{"face":"happy","motion":"nod"} thanks!',
        'Here is the plan:\n```json\n{"face":"happy","motion":"nod"}\n```',
        '```json\n{"face":"happy","motion":"nod"}\n```\nHope that helps!',
        '```json\nNote: plan below\n{"face":"happy","motion":"nod"}\n```',
        '```json\n{"face":"happy","motion":"nod"}\n```\n```json\n{"face":"sad","motion":"shake"}\n```',
        '```json\n{"face":"happy","motion":"nod"}\n{"face":"sad","motion":"shake"}\n```',
        '{"face":"happy","motion":"nod"}\n{"face":"sad","motion":"shake"}',
        '{"face":"happy","motion":"nod"}{"face":"sad","motion":"shake"}',
        '```python\n{"face":"happy","motion":"nod"}\n```',
        '```yaml\n{"face":"happy","motion":"nod"}\n```',
        '```text\n{"face":"happy","motion":"nod"}\n```',
        '```jsonc\n{"face":"happy","motion":"nod"}\n```',
        '```json extra\n{"face":"happy","motion":"nod"}\n```',
        '```json {"face":"happy","motion":"nod"}\n```',
        '```json\n{"face":"happy","motion":"nod"}```',
        '```json\n{"face":"happy","motion":"nod"}',
        '````json\n{"face":"happy","motion":"nod"}\n````',
        '```json\n{"face":"happy","motion":"nod"}\n````',
        '```json\n```',
        '{"face":"sad","face":"happy","motion":"nod"}',
        '```json\n{"face":"happy","motion":"nod","motion":"shake"}\n```',
        '{"face":"happy","motion":"nod","extra":true}',
        '{"face":"happy"}',
        '{"motion":"nod"}',
        '{"face":null,"motion":"nod"}',
        '{"face":123,"motion":"nod"}',
        '{"face":"happy","motion":true}',
        '{"face":"inventedFace","motion":"nod"}',
        '{"face":"happy","motion":"spin"}',
        '{"face":"happy","motion":"nod","score":NaN}',
        '```json\n{"face":"inventedFace","motion":"nod"}\n```',
    ]
    for sample in invalid_samples:
        assert parse_visual_plan(sample) is None, f"Should reject: {sample!r}"
    return {
        "validPlainChecked": len(VISUAL_FACES) + len(VISUAL_MOTIONS) + 1,
        "validFencedChecked": len(valid_fenced),
        "invalidRejected": len(invalid_samples),
    }


class MockProvider:
    """Deterministic local loopback provider controllable per-test."""

    def __init__(self):
        self.lock = threading.Lock()
        self.chat_handler = lambda req: (200, {"choices": [{"message": {"content": "synthetic-ok"}}]})
        self.visual_handler = lambda req: (200, {"choices": [{"message": {"content": '{"face":"relieved","motion":"nod"}'}}]})
        self.calls = []
        provider = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(length)
                payload = json.loads(raw_body.decode("utf-8"))
                messages = payload.get("messages", [])
                is_visual = bool(messages) and str(messages[0].get("content", "")).startswith("Choose one face")
                req_info = {
                    "is_visual": is_visual,
                    "has_auth": bool(self.headers.get("Authorization")),
                    "auth_header": self.headers.get("Authorization"),
                    "messages": messages,
                }
                with provider.lock:
                    provider.calls.append({"is_visual": is_visual, "has_auth": req_info["has_auth"]})
                    fn = provider.visual_handler if is_visual else provider.chat_handler
                result = fn(req_info)
                if callable(result):
                    result(self)
                    return
                status, body = result
                encoded = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                    self.wfile.flush()
                except OSError:
                    pass

        class QuietServer(http.server.ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                return

        self.server = QuietServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1/chat/completions"

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()


def wait_turn(host, turn_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        turn = host.request("GET", f"/v1/chat/turns/{turn_id}")
        if turn["status"] not in ("queued", "running"):
            return turn
        time.sleep(0.03)
    raise AssertionError(f"Turn {turn_id} did not reach terminal state")


def wait_task(host, task_id, target_statuses, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = host.request("GET", f"/v1/tasks/{task_id}")
        if task["status"] in target_statuses:
            return task
        time.sleep(0.05)
    raise AssertionError(f"Task {task_id} did not reach {target_statuses}")


def closed_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def verify(artifact):
    summary = {"parser": test_parse_visual_plan(), "groups": {}}
    print("PASS parser regression matrix:", summary["parser"])

    with tempfile.TemporaryDirectory(prefix="kei-chat-interop-") as tmp:
        root = Path(tmp)
        adapters_dir = root / "adapters"
        adapters_dir.mkdir()
        adapter_py = root / "fixture_adapter.py"
        adapter_py.write_text(ADAPTER_SOURCE, encoding="utf-8")
        (adapters_dir / "fixture.json").write_text(
            json.dumps({
                "id": "studio.fixture",
                "name": "Interop fixture",
                "apiVersion": 1,
                "command": [sys.executable, str(adapter_py)],
                "capabilities": ["cancel", "input", "progress", "artifacts"],
            }),
            encoding="utf-8",
        )

        # Group A: Plain JSON, single fenced JSON, invalid visual plans preserving reply,
        # work visual privacy, and cross-conversation stale rejection.
        with MockProvider() as provider:
            data_a = root / "host-a"
            data_a.mkdir()
            (data_a / "chat.json").write_text(
                json.dumps({"endpoint": provider.endpoint, "model": "mock-a", "timeoutSeconds": 6}),
                encoding="utf-8",
            )
            with BuiltHost(artifact, data_a, ("--executor-dir", str(adapters_dir))) as host:
                provider.chat_handler = lambda _req: (200, {"choices": [{"message": {"content": "reply-usable-text"}}]})
                turn = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-a", "requestId": "req-1", "question": "hello",
                }, status=202)
                done = wait_turn(host, turn["turnId"])
                assert done["status"] == "completed" and done["reply"] == "reply-usable-text"

                # Plain JSON visual plan
                provider.visual_handler = lambda _req: (200, {"choices": [{"message": {"content": '{"face":"relieved","motion":"nod"}'}}]})
                assert host.request("POST", "/v1/chat/visual", {"kind": "reply", "turnId": done["turnId"]}) == {
                    "state": "ready", "face": "relieved", "motion": "nod",
                }

                # Single unambiguous fenced JSON visual plan (reply + all 3 work stages)
                seen_work_contexts = {}
                def fenced_visual(req):
                    payload = json.loads(req["messages"][-1]["content"])
                    if payload["kind"] != "reply":
                        seen_work_contexts[payload["kind"]] = payload["context"]
                    plans = {
                        "reply": '```json\n{"face":"happy","motion":"nod"}\n```',
                        "work-input": '```JSON\r\n{"face":"thoughtful","motion":"tilt"}\r\n```',
                        "work-success": '```\n{"face":"happy","motion":"nod"}\n```',
                        "work-error": '``` json \n{"face":"worried","motion":"shake"}\n```',
                    }
                    return (200, {"choices": [{"message": {"content": plans[payload["kind"]]}}]})

                provider.visual_handler = fenced_visual
                assert host.request("POST", "/v1/chat/visual", {
                    "kind": "reply", "turnId": done["turnId"], "conversationId": "conv-a",
                }) == {"state": "ready", "face": "happy", "motion": "nod"}
                assert host.request("POST", "/v1/chat/visual", {"kind": "work-input"}) == {
                    "state": "ready", "face": "thoughtful", "motion": "tilt",
                }
                assert host.request("POST", "/v1/chat/visual", {"kind": "work-success"}) == {
                    "state": "ready", "face": "happy", "motion": "nod",
                }
                assert host.request("POST", "/v1/chat/visual", {"kind": "work-error"}) == {
                    "state": "ready", "face": "worried", "motion": "shake",
                }
                assert all(ctx.startswith("A local work session ") for ctx in seen_work_contexts.values())

                # Invalid visual plans rejected while text reply remains completely intact
                invalid_payloads = [
                    'Here:\n```json\n{"face":"happy","motion":"nod"}\n```',
                    '```json\n{"face":"happy","motion":"nod"}\n```\nExtra prose',
                    '```json\n{"face":"happy","motion":"nod"}\n```\n```json\n{"face":"sad","motion":"shake"}\n```',
                    '{"face":"happy","motion":"nod"}{"face":"sad","motion":"shake"}',
                    '```python\n{"face":"happy","motion":"nod"}\n```',
                    '{"face":"sad","face":"happy","motion":"nod"}',
                    '{"face":"invented","motion":"nod"}',
                    '{"face":"happy","motion":"jump"}',
                ]
                for bad in invalid_payloads:
                    provider.visual_handler = lambda _req, text=bad: (200, {"choices": [{"message": {"content": text}}]})
                    res = host.request("POST", "/v1/chat/visual", {"kind": "reply", "turnId": done["turnId"]})
                    assert res == {"state": "fallback", "code": "invalid_visual_plan"}, (bad, res)
                stored = host.request("GET", f"/v1/chat/turns/{done['turnId']}")
                assert stored["status"] == "completed" and stored["reply"] == "reply-usable-text"

                # Cross-conversation visual request rejected without calling upstream provider
                calls_before = len(provider.calls)
                stale = host.request("POST", "/v1/chat/visual", {
                    "kind": "reply", "turnId": done["turnId"], "conversationId": "conv-b",
                })
                assert stale == {"state": "fallback", "code": "conversation_changed"}
                assert len(provider.calls) == calls_before, "stale cross-conversation visual call must not hit provider"
                host.request("POST", "/v1/chat/visual", {
                    "kind": "reply", "turnId": done["turnId"], "conversationId": "bad conv!",
                }, status=422, error="invalid_visual_context")

                # Executor work lifecycle stays usable while visual provider returns invalid plans
                provider.visual_handler = lambda _req: (200, {"choices": [{"message": {"content": "prose + invalid"}}]})
                task_ask = host.request("POST", "/v1/tasks", {
                    "executorId": "studio.fixture", "requestId": "w-ask", "conversationId": "conv-a", "input": "ask",
                }, status=202)
                waiting = wait_task(host, task_ask["id"], {"waiting_for_input"})
                assert host.request("POST", "/v1/chat/visual", {"kind": "work-input"}) == {
                    "state": "fallback", "code": "invalid_visual_plan",
                }
                assert waiting["inputRequest"]["id"] == "q1"
                host.request("POST", f"/v1/tasks/{waiting['id']}/input", {"inputId": "q1", "value": "ok-answer"})
                succeeded = wait_task(host, waiting["id"], {"succeeded"})
                assert succeeded["result"]["text"] == "answer:ok-answer" and len(succeeded["result"]["artifacts"]) == 1
                assert host.request("POST", "/v1/chat/visual", {"kind": "work-success"}) == {
                    "state": "fallback", "code": "invalid_visual_plan",
                }

                task_fail = host.request("POST", "/v1/tasks", {
                    "executorId": "studio.fixture", "requestId": "w-exit", "conversationId": "conv-a", "input": "exit",
                }, status=202)
                failed = wait_task(host, task_fail["id"], {"failed"})
                assert failed["error"]["code"] == "adapter_exited"
                assert host.request("POST", "/v1/chat/visual", {"kind": "work-error"}) == {
                    "state": "fallback", "code": "invalid_visual_plan",
                }

            summary["groups"]["fencedAndInvalidVisual"] = "PASS"
            print("PASS Group A: plain + fenced JSON, invalid visual fallback, privacy, cross-conv guard, work usability")

        # Group B: Provider timeout (headers timeout + slow-headers+slow-body wall-clock deadline + visual timeout)
        with MockProvider() as provider:
            data_b = root / "host-b"
            data_b.mkdir()
            (data_b / "chat.json").write_text(
                json.dumps({"endpoint": provider.endpoint, "model": "mock-timeout", "timeoutSeconds": 1}),
                encoding="utf-8",
            )
            with BuiltHost(artifact, data_b) as host:
                # 1. Complete one turn first so we can also test visual timeout on a completed turn
                provider.chat_handler = lambda _req: (200, {"choices": [{"message": {"content": "before-timeout"}}]})
                ok_turn = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-t", "requestId": "rt-0", "question": "prime",
                }, status=202)["turnId"])
                assert ok_turn["status"] == "completed"

                # 2. Stalled headers timeout on chat turn
                def stall(_req):
                    time.sleep(2.2)
                    return (200, {"choices": [{"message": {"content": "too-late"}}]})
                provider.chat_handler = stall
                t0 = time.monotonic()
                timed = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-t", "requestId": "rt-1", "question": "slow-headers",
                }, status=202)["turnId"])
                elapsed_headers = time.monotonic() - t0
                assert timed["status"] == "failed" and timed["error"]["code"] == "chat_timeout", timed
                assert elapsed_headers < 3.0, elapsed_headers

                # 3. Slow headers (0.65s) + slow body (0.75s) = 1.4s > timeoutSeconds=1 -> must still hit chat_timeout
                def trickle_handler(_req):
                    def respond(h):
                        time.sleep(0.65)
                        body = json.dumps({"choices": [{"message": {"content": "trickle"}}]}).encode("utf-8")
                        try:
                            h.send_response(200)
                            h.send_header("Content-Type", "application/json")
                            h.send_header("Content-Length", str(len(body)))
                            h.end_headers()
                            h.wfile.write(body[:12])
                            h.wfile.flush()
                            time.sleep(0.75)
                            h.wfile.write(body[12:])
                            h.wfile.flush()
                        except OSError:
                            pass
                    return respond
                provider.chat_handler = trickle_handler
                timed2 = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-t", "requestId": "rt-2", "question": "slow-trickle",
                }, status=202)["turnId"])
                assert timed2["status"] == "failed" and timed2["error"]["code"] == "chat_timeout", timed2

                def partial_headers(_req):
                    def respond(h):
                        try:
                            h.wfile.write(b"HTTP/1.1 200 OK\r\nX-Partial: ")
                            for _ in range(10):
                                h.wfile.write(b"a")
                                h.wfile.flush()
                                time.sleep(.22)
                        except OSError:
                            pass
                    return respond
                provider.chat_handler = partial_headers
                began = time.monotonic()
                partial = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-t", "requestId": "rt-headers", "question": "partial-header",
                }, status=202)["turnId"])
                assert partial["status"] == "failed" and partial["error"]["code"] == "chat_timeout", partial
                assert time.monotonic() - began < 1.7

                # 4. Visual timeout falls back without damaging the completed turn reply
                provider.visual_handler = stall
                vis_timeout = host.request("POST", "/v1/chat/visual", {"kind": "reply", "turnId": ok_turn["turnId"]})
                assert vis_timeout == {"state": "fallback", "code": "chat_timeout"}, vis_timeout
                assert host.request("GET", f"/v1/chat/turns/{ok_turn['turnId']}")["reply"] == "before-timeout"

                # A third visual job is rejected while two response readers
                # are waiting. Both timeout paths must release their slots.
                blocked = threading.Barrier(3)
                def block_visual(_req):
                    def respond(h):
                        h.wfile.write(b"HTTP/1.1 200 OK\r\nX-Partial: ")
                        h.wfile.flush()
                        blocked.wait(timeout=3)
                        time.sleep(1.25)
                        h.close_connection = True
                    return respond
                provider.visual_handler = block_visual
                def visual_job():
                    return host.request("POST", "/v1/chat/visual", {"kind": "work-input"})
                with ThreadPoolExecutor(max_workers=2) as pool:
                    first, second = pool.submit(visual_job), pool.submit(visual_job)
                    blocked.wait(timeout=3)
                    assert visual_job() == {"state": "fallback", "code": "visual_busy"}
                    assert all(job.result(timeout=3) == {"state": "fallback", "code": "chat_timeout"}
                               for job in (first, second))
                provider.visual_handler = lambda _req: (200, {"choices": [{"message": {
                    "content": '{"face":"thoughtful","motion":"tilt"}',
                }}]})
                assert visual_job() == {"state": "ready", "face": "thoughtful", "motion": "tilt"}

                # 5. Recovery after timeout
                def recover_with_close(_req):
                    def respond(h):
                        data = b'{"choices":[{"message":{"content":"recovered-ok"}}]}'
                        h.send_response(200)
                        h.send_header("Connection", "close")
                        h.send_header("Content-Length", str(len(data)))
                        h.end_headers()
                        h.wfile.write(data)
                        h.wfile.flush()
                        h.close_connection = True
                    return respond
                provider.chat_handler = recover_with_close
                rec = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-t", "requestId": "rt-3", "question": "after-timeout",
                }, status=202)["turnId"])
                assert rec["status"] == "completed" and rec["reply"] == "recovered-ok"

            summary["groups"]["providerTimeout"] = {"status": "PASS", "headersTimeoutSeconds": round(elapsed_headers, 3)}
            print("PASS Group B: provider timeout (headers, wall-clock trickle, visual fallback, recovery)")

        # Group C: Provider unavailable & error taxonomy (unconfigured, missing credential, 401, 503, refused, protocol, empty, huge)
        # C1: Unconfigured host (no chat.json) + executor work still works!
        data_unconf = root / "host-unconf"
        data_unconf.mkdir()
        with BuiltHost(artifact, data_unconf, ("--executor-dir", str(adapters_dir))) as host:
            t_unconf = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                "conversationId": "conv-u", "requestId": "ru-1", "question": "hello",
            }, status=202)["turnId"])
            assert t_unconf["status"] == "failed" and t_unconf["error"]["code"] == "chat_provider_unconfigured"
            assert host.request("POST", "/v1/chat/visual", {"kind": "work-error"}) == {
                "state": "fallback", "code": "chat_provider_unconfigured",
            }
            w_unconf = host.request("POST", "/v1/tasks", {
                "executorId": "studio.fixture", "requestId": "wu-1", "conversationId": "conv-u", "input": "ok",
            }, status=202)
            assert wait_task(host, w_unconf["id"], {"succeeded"})["result"]["text"] == "done"

        # C2: Missing credentialRef env var + present credentialRef (secret never echoed)
        with MockProvider() as provider:
            os.environ.pop("KEI_R18_TEST_MISSING_CRED", None)
            data_cred_missing = root / "host-cred-missing"
            data_cred_missing.mkdir()
            (data_cred_missing / "chat.json").write_text(
                json.dumps({
                    "endpoint": provider.endpoint, "model": "mock-cred", "credentialRef": "KEI_R18_TEST_MISSING_CRED",
                }),
                encoding="utf-8",
            )
            with BuiltHost(artifact, data_cred_missing) as host:
                t_mc = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-c", "requestId": "rc-1", "question": "hello",
                }, status=202)["turnId"])
                assert t_mc["status"] == "failed" and t_mc["error"]["code"] == "chat_credential_unavailable"
                assert host.request("POST", "/v1/chat/visual", {"kind": "work-success"}) == {
                    "state": "fallback", "code": "chat_credential_unavailable",
                }
                assert len(provider.calls) == 0, "missing credential must fail before contacting endpoint"

            # Present synthetic credential -> Authorization sent, never leaked in API responses
            secret_marker = "synthetic-r18-do-not-leak-token"
            os.environ["KEI_R18_TEST_PRESENT_CRED"] = secret_marker
            try:
                seen_auth = []
                def check_auth(req):
                    seen_auth.append(req["auth_header"])
                    return (200, {"choices": [{"message": {"content": "auth-ok"}}]})
                provider.chat_handler = check_auth
                data_cred_ok = root / "host-cred-ok"
                data_cred_ok.mkdir()
                (data_cred_ok / "chat.json").write_text(
                    json.dumps({
                        "endpoint": provider.endpoint, "model": "mock-cred", "credentialRef": "KEI_R18_TEST_PRESENT_CRED",
                    }),
                    encoding="utf-8",
                )
                with BuiltHost(artifact, data_cred_ok) as host:
                    t_ok = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                        "conversationId": "conv-c2", "requestId": "rc-2", "question": "hello",
                    }, status=202)["turnId"])
                    assert t_ok["status"] == "completed" and t_ok["reply"] == "auth-ok"
                    assert seen_auth == ["Bearer " + secret_marker]
                    assert secret_marker not in json.dumps(t_ok)
            finally:
                os.environ.pop("KEI_R18_TEST_PRESENT_CRED", None)

        # C3: HTTP 401, HTTP 503, malformed JSON, deeply nested JSON (RecursionError), empty reply, oversized reply
        with MockProvider() as provider:
            data_err = root / "host-err"
            data_err.mkdir()
            (data_err / "chat.json").write_text(
                json.dumps({"endpoint": provider.endpoint, "model": "mock-err", "timeoutSeconds": 4}),
                encoding="utf-8",
            )
            with BuiltHost(artifact, data_err) as host:
                cases = [
                    ("401", lambda _r: (401, {"error": "nope"}), "chat_provider_unauthorized"),
                    ("503", lambda _r: (503, {"error": "down"}), "chat_provider_error"),
                    ("badjson", lambda _r: (200, b"not-json"), "chat_protocol_error"),
                    ("deepjson", lambda _r: (200, (b"[" * 2500) + (b"]" * 2500)), "chat_protocol_error"),
                    ("empty", lambda _r: (200, {"choices": [{"message": {"content": "   \n"}}]}), "chat_empty_reply"),
                    ("huge", lambda _r: (200, b'{"choices":[{"message":{"content":"' + (b"a" * (1024 * 1024 + 32)) + b'"}}]}'), "chat_response_too_large"),
                ]
                for idx, (label, handler, expected_code) in enumerate(cases):
                    provider.chat_handler = handler
                    provider.visual_handler = handler
                    res_turn = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                        "conversationId": "conv-e", "requestId": f"re-{idx}", "question": label,
                    }, status=202)["turnId"])
                    assert res_turn["status"] == "failed" and res_turn["error"]["code"] == expected_code, (label, res_turn)
                    res_vis = host.request("POST", "/v1/chat/visual", {"kind": "work-error"})
                    assert res_vis == {"state": "fallback", "code": expected_code}, (label, res_vis)

        # C4: Refused connection on closed loopback port
        dead_port = closed_loopback_port()
        data_refused = root / "host-refused"
        data_refused.mkdir()
        (data_refused / "chat.json").write_text(
            json.dumps({"endpoint": f"http://127.0.0.1:{dead_port}/v1/chat/completions", "model": "mock-dead", "timeoutSeconds": 3}),
            encoding="utf-8",
        )
        with BuiltHost(artifact, data_refused) as host:
            t_dead = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                "conversationId": "conv-d", "requestId": "rd-1", "question": "unreachable",
            }, status=202)["turnId"])
            assert t_dead["status"] == "failed" and t_dead["error"]["code"] == "chat_connection_failed", t_dead
            assert host.request("POST", "/v1/chat/visual", {"kind": "work-error"}) == {
                "state": "fallback", "code": "chat_connection_failed",
            }
        summary["groups"]["providerUnavailable"] = "PASS"
        print("PASS Group C: unconfigured, missing/present credential, 401, 503, refused, malformed/nested, empty, oversized")

        # Group D: Late responses after cancellation (fast cancel on Windows!) and conversation switch
        with MockProvider() as provider:
            data_late = root / "host-late"
            data_late.mkdir()
            (data_late / "chat.json").write_text(
                json.dumps({"endpoint": provider.endpoint, "model": "mock-late", "timeoutSeconds": 8}),
                encoding="utf-8",
            )
            with BuiltHost(artifact, data_late) as host:
                started = threading.Event()
                release = threading.Event()

                def slow_cancel_handler(_req):
                    started.set()
                    release.wait(timeout=6)
                    return (200, {"choices": [{"message": {"content": "LATE-CANCELLED-REPLY"}}]})

                provider.chat_handler = slow_cancel_handler
                turn = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-cancel", "requestId": "rcan-1", "question": "cancel-me",
                }, status=202)
                assert started.wait(timeout=3), "provider did not receive request"

                t0 = time.monotonic()
                cancel_reply = host.request("POST", f"/v1/chat/turns/{turn['turnId']}/cancel", {}, status=202)
                assert cancel_reply["accepted"] is True
                cancelled = wait_turn(host, turn["turnId"], timeout=3.0)
                cancel_elapsed = time.monotonic() - t0
                assert cancelled["status"] == "cancelled" and cancelled["reply"] is None
                assert cancelled["error"]["code"] == "chat_cancelled"
                assert cancel_elapsed < 1.0, f"Cancel took too long ({cancel_elapsed:.3f}s) - socket abort failed"

                # Release upstream late reply and verify cancelled turn is never overwritten
                release.set()
                time.sleep(0.15)
                still_cancelled = host.request("GET", f"/v1/chat/turns/{turn['turnId']}")
                assert still_cancelled["status"] == "cancelled" and still_cancelled["reply"] is None

                # Visual endpoint must refuse a cancelled turn
                host.request("POST", "/v1/chat/visual", {
                    "kind": "reply", "turnId": turn["turnId"],
                }, status=422, error="invalid_visual_context")

                # Follow-up turn in same conversation works immediately (no lingering conversation_busy)
                provider.chat_handler = lambda _req: (200, {"choices": [{"message": {"content": "after-cancel-ok"}}]})
                follow = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-cancel", "requestId": "rcan-2", "question": "next",
                }, status=202)["turnId"])
                assert follow["status"] == "completed" and follow["reply"] == "after-cancel-ok"

                # A socket may be readable even though the response header or
                # a chunk header is still incomplete.
                for mode, wire in [
                    ("headers", b"HTTP/1.1 200 OK\r\nContent-Type: application/"),
                    ("chunk", b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10"),
                ]:
                    started, release = threading.Event(), threading.Event()
                    def partial_response(_req):
                        def respond(h):
                            h.wfile.write(wire)
                            h.wfile.flush()
                            started.set()
                            release.wait(timeout=6)
                            h.close_connection = True
                        return respond
                    provider.chat_handler = partial_response
                    pending = host.request("POST", "/v1/chat/ask", {
                        "conversationId": "conv-cancel", "requestId": "partial-" + mode, "question": mode,
                    }, status=202)
                    assert started.wait(timeout=3)
                    began = time.monotonic()
                    try:
                        host.request("POST", f"/v1/chat/turns/{pending['turnId']}/cancel", {}, status=202)
                        result = wait_turn(host, pending["turnId"], timeout=3.0)
                        assert result["status"] == "cancelled" and result["reply"] is None
                        assert time.monotonic() - began < 1
                    finally:
                        release.set()
                provider.chat_handler = lambda _req: (200, {"choices": [{"message": {"content": "slots-cleared"}}]})
                recovered = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-cancel", "requestId": "after-partial", "question": "recover",
                }, status=202)["turnId"])
                assert recovered["reply"] == "slots-cleared"

                # Conversation isolation under delayed response
                conv_a_started = threading.Event()
                conv_a_release = threading.Event()
                def gated_by_question(req):
                    q = req["messages"][-1]["content"]
                    if q == "from-conv-a":
                        conv_a_started.set()
                        conv_a_release.wait(timeout=6)
                        return (200, {"choices": [{"message": {"content": "late-conv-a-reply"}}]})
                    return (200, {"choices": [{"message": {"content": "fast-conv-b-reply"}}]})

                provider.chat_handler = gated_by_question
                turn_a = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-iso-a", "requestId": "ri-a", "question": "from-conv-a",
                }, status=202)
                assert conv_a_started.wait(timeout=3)
                assert host.request("GET", "/v1/chat/turns?conversationId=conv-iso-b") == []

                turn_b = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-iso-b", "requestId": "ri-b", "question": "from-conv-b",
                }, status=202)["turnId"])
                assert turn_b["status"] == "completed" and turn_b["reply"] == "fast-conv-b-reply"

                conv_a_release.set()
                done_a = wait_turn(host, turn_a["turnId"])
                assert done_a["status"] == "completed" and done_a["reply"] == "late-conv-a-reply"
                turns_b = host.request("GET", "/v1/chat/turns?conversationId=conv-iso-b")
                assert [t["turnId"] for t in turns_b] == [turn_b["turnId"]]
                assert host.request("POST", "/v1/chat/visual", {
                    "kind": "reply", "turnId": done_a["turnId"], "conversationId": "conv-iso-b",
                }) == {"state": "fallback", "code": "conversation_changed"}

            summary["groups"]["cancelAndConversationSwitch"] = {
                "status": "PASS", "cancelConfirmSeconds": round(cancel_elapsed, 3),
            }
            print(f"PASS Group D: fast cancel ({cancel_elapsed:.3f}s), late reply discarded, conversation isolation")

    summary["allPassed"] = True
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = verify(args.artifact.resolve())
    if args.out:
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
