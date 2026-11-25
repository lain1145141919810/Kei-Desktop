"""Backend acceptance tests for chat service configuration, keyless local endpoints, connection probe, and secret redaction."""
import argparse
import http.server
import json
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host_smoke import BuiltHost


class ProbeMockProvider:
    def __init__(self, *, required_bearer=None, status=200, reply="OK"):
        self.required_bearer = required_bearer
        self.status = status
        self.reply = reply
        self.seen_auth = []
        self.calls = 0
        self.payload = None
        parent = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                parent.payload = json.loads(self.rfile.read(length).decode("utf-8"))
                auth = self.headers.get("Authorization")
                parent.seen_auth.append(auth)
                parent.calls += 1
                if parent.required_bearer and auth != f"Bearer {parent.required_bearer}":
                    body = json.dumps({"error": "unauthorized"}).encode("utf-8")
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                body = json.dumps({"choices": [{"message": {"content": parent.reply}}]}).encode("utf-8")
                self.send_response(parent.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
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


def closed_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_turn(host, turn_id, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        turn = host.request("GET", f"/v1/chat/turns/{turn_id}")
        if turn["status"] not in ("queued", "running"):
            return turn
        time.sleep(0.03)
    raise AssertionError(f"Turn {turn_id} timed out")


def verify(artifact: Path):
    secret_val = "sk-synthetic-r24-never-expose-9876543210"
    os.environ["KEI_R24_TEST_KEY"] = secret_val
    os.environ.pop("KEI_R24_MISSING_KEY", None)
    try:
        with tempfile.TemporaryDirectory(prefix="kei-r24-chatcfg-") as tmp:
            root = Path(tmp)
            data_dir = root / "host"
            data_dir.mkdir()
            # Pre-seed a vision section in chat.json to confirm PUT /v1/chat/config preserves vision!
            (data_dir / "chat.json").write_text(json.dumps({
                "vision": {"endpoint": "https://example.invalid/v1/chat/completions", "model": "vision-preserve-test"},
            }), encoding="utf-8")

            with ProbeMockProvider(required_bearer=None, reply="local-keyless-ok") as keyless_srv, \
                 ProbeMockProvider(required_bearer=secret_val, reply="auth-ok") as auth_srv:

                with BuiltHost(artifact, data_dir) as host:
                    # 1. Initially unconfigured chat, vision preserved
                    st0 = host.request("GET", "/v1/chat/config")
                    assert st0["configured"] is False and st0["state"] == "unconfigured" and st0["hasVision"] is True
                    assert st0["configFileName"] == "chat.json"

                    # 2. Explicit validation errors (non-loopback HTTP, embedded URL creds, bad env name, bad timeout)
                    host.request("PUT", "/v1/chat/config", {
                        "endpoint": "http://example.com/v1/chat/completions", "model": "m",
                    }, status=422, error="insecure_chat_endpoint")
                    host.request("PUT", "/v1/chat/config", {
                        "endpoint": "https://user:pass@example.com/v1/chat/completions", "model": "m",
                    }, status=422, error="insecure_chat_endpoint")
                    host.request("PUT", "/v1/chat/config", {
                        "endpoint": keyless_srv.endpoint, "model": "m", "credentialRef": "sk-raw-secret-not-env",
                    }, status=422, error="invalid_credential_ref")
                    host.request("PUT", "/v1/chat/config", {
                        "endpoint": keyless_srv.endpoint, "model": "m", "timeoutSeconds": 121,
                    }, status=422, error="invalid_chat_timeout")

                    for invalid_url in ("http://[::1", "http://127.0.0.1:99999/v1", "https://example.com/v1?"):
                        host.request("PUT", "/v1/chat/config", {
                            "endpoint": invalid_url, "model": "invalid",
                        }, status=422, error="invalid_chat_endpoint")
                    host.request("PUT", "/v1/chat/config", {
                        "clear": True, "unexpected": "field",
                    }, status=422, error="invalid_chat_config")

                    options = {"thinking": {"type": "disabled"}}
                    (data_dir / "imported-chat-profiles.json").write_text(json.dumps([
                        {"endpoint": keyless_srv.endpoint, "model": "profile-model", "timeoutSeconds": 120, "extra_body": options},
                        {"endpoint": keyless_srv.endpoint, "model": "disabled-model", "enabled": False},
                    ]), encoding="utf-8")
                    profiles = host.request("GET", "/v1/chat/config")["profiles"]
                    assert len(profiles) == 1 and profiles[0]["extra_body"] == options
                    result = host.request("POST", "/v1/chat/config/test", profiles[0])
                    assert result["ok"] and keyless_srv.payload["thinking"] == options["thinking"]
                    host.request("POST", "/v1/chat/config/test", {
                        **profiles[0], "extra_body": {"messages": []},
                    }, status=422, error="invalid_chat_extra_body")

                    # 3. Draft connection test BEFORE saving: missing credentialRef env var
                    probe_missing = host.request("POST", "/v1/chat/config/test", {
                        "endpoint": auth_srv.endpoint, "model": "mock-auth", "credentialRef": "KEI_R24_MISSING_KEY",
                    })
                    assert probe_missing["ok"] is False and probe_missing["code"] == "chat_credential_unavailable"
                    assert probe_missing["credentialRef"] == "KEI_R24_MISSING_KEY" and probe_missing["credentialPresent"] is False
                    assert probe_missing["isConnectionProbeOnly"] is True
                    assert host.request("GET", "/v1/chat/config")["configured"] is False, "Draft test must not save"

                    # 4. Draft connection test against unreachable local port -> actionable connection_failed
                    probe_dead = host.request("POST", "/v1/chat/config/test", {
                        "endpoint": f"http://127.0.0.1:{closed_port()}/v1/chat/completions", "model": "local-down",
                    })
                    assert probe_dead["ok"] is False and probe_dead["code"] == "chat_connection_failed"
                    assert probe_dead["hint"] and probe_dead["isLocalEndpoint"] is True

                    # 5. Compatible keyless local endpoint: probe succeeds, save hot-reloads immediately without restart!
                    probe_local = host.request("POST", "/v1/chat/config/test", {
                        "endpoint": keyless_srv.endpoint, "model": "local-qwen", "credentialRef": "",
                    })
                    assert probe_local["ok"] is True and probe_local["isLocalEndpoint"] is True and probe_local["credentialRef"] is None
                    assert probe_local["isConnectionProbeOnly"] is True

                    saved_local = host.request("PUT", "/v1/chat/config", {
                        "endpoint": keyless_srv.endpoint, "model": "local-qwen", "credentialRef": "", "timeoutSeconds": 12,
                    })
                    assert saved_local["configured"] is True and saved_local["state"] == "ready"
                    assert saved_local["isLocalEndpoint"] is True and saved_local["hasVision"] is True

                    t1 = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                        "conversationId": "conv-r24", "requestId": "req-local-1", "question": "hello local",
                    }, status=202)["turnId"])
                    assert t1["status"] == "completed" and t1["reply"] == "local-keyless-ok"
                    assert keyless_srv.seen_auth[-1] is None, "Keyless local endpoint must not send Authorization header"

                    # 6. Switch to credentialRef-backed endpoint -> probes auth, saves, never leaks secret value!
                    probe_auth = host.request("POST", "/v1/chat/config/test", {
                        "endpoint": auth_srv.endpoint, "model": "remote-compat", "credentialRef": "KEI_R24_TEST_KEY",
                    })
                    assert probe_auth["ok"] is True and probe_auth["credentialRef"] == "KEI_R24_TEST_KEY" and probe_auth["credentialPresent"] is True
                    assert secret_val not in json.dumps(probe_auth)

                    saved_auth = host.request("PUT", "/v1/chat/config", {
                        "endpoint": auth_srv.endpoint, "model": "remote-compat", "credentialRef": "KEI_R24_TEST_KEY", "timeoutSeconds": 15,
                    })
                    assert saved_auth["state"] == "ready" and saved_auth["credentialPresent"] is True
                    assert secret_val not in json.dumps(saved_auth)

                    t2 = wait_turn(host, host.request("POST", "/v1/chat/ask", {
                        "conversationId": "conv-r24", "requestId": "req-auth-1", "question": "hello auth",
                    }, status=202)["turnId"])
                    assert t2["status"] == "completed" and t2["reply"] == "auth-ok"
                    assert auth_srv.seen_auth[-1] == f"Bearer {secret_val}"

                    # Verify host events and chat.json on disk contain ZERO secret values and preserved vision!
                    events = host.request("GET", "/v1/events?after=0")
                    assert any(e["type"] == "chat.configured" for e in events["events"])
                    assert secret_val not in json.dumps(events)
                    raw_disk = (data_dir / "chat.json").read_text("utf-8")
                    assert secret_val not in raw_disk
                    disk_obj = json.loads(raw_disk)
                    assert disk_obj["vision"]["model"] == "vision-preserve-test"
                    assert disk_obj["credentialRef"] == "KEI_R24_TEST_KEY"

                # 7. Restart host against SAME data_dir -> verify persistence across restart & clear!
                with BuiltHost(artifact, data_dir) as host2:
                    st_after = host2.request("GET", "/v1/chat/config")
                    assert st_after["configured"] is True and st_after["state"] == "ready"
                    assert st_after["model"] == "remote-compat" and st_after["credentialRef"] == "KEI_R24_TEST_KEY"
                    assert st_after["hasVision"] is True

                    cleared = host2.request("PUT", "/v1/chat/config", {"clear": True})
                    assert cleared["configured"] is False and cleared["state"] == "unconfigured" and cleared["hasVision"] is True
                    assert json.loads((data_dir / "chat.json").read_text("utf-8"))["vision"]["model"] == "vision-preserve-test"

        print("PASS verify_chat_config: validation, keyless local endpoint, credentialRef probe, hot-reload, vision preservation, persistence, secret redaction")
    finally:
        os.environ.pop("KEI_R24_TEST_KEY", None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    verify(args.artifact.resolve())
