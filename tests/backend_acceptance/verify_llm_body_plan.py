"""Verify LLM-directed body planning, dynamic plugin catalog discovery, and safety boundaries."""
import argparse
import http.server
import json
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host_smoke import BuiltHost
from kei_host.chat import parse_body_plan, parse_reply_envelope, parse_visual_plan, spoken_reply, read_public_turn, requests_stillness
from kei_host.package import ApiError, manifest


def make_zip(path: Path, files: dict[str, str]):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)


CUSTOM_MOTION_METADATA = """schemaVersion: 1
apiVersion: 1
id: example.custom-motion
version: "1.0.0"
name: "Custom Motion Provider"
requiresFeatures: [plugin-pages-v1]
permissions: [motion.catalog]
actions:
  - {id: catalog, scope: motion.catalog}
motionProvider:
  entryId: motion-provider
  catalogAction: catalog
entries:
  - id: motion-provider
    title: "Custom Motion Provider"
    slot: character-settings
    page: provider.html
    actions: [catalog]
"""

CUSTOM_MOTION_MAIN = """from pathlib import Path

def initialize(context):
    counter_path = Path(context.data_dir) / "catalog_calls.txt"

    def catalog(_request):
        count = int(counter_path.read_text("utf-8")) + 1 if counter_path.exists() else 1
        counter_path.write_text(str(count), encoding="utf-8")
        return {
            "state": "ready",
            "motions": [
                {"id": "custom-wave", "title": "Wave gently with one hand", "mask": ["leftUpperArm", "leftLowerArm", "leftHand"]},
                {"id": "custom-bow", "title": "Give a polite short bow", "mask": ["spine", "chest"]},
                {"id": "malformed-no-mask", "title": "Should be filtered out"},
            ],
            "callCount": count,
        }

    context.register("catalog", catalog)
"""

CUSTOM_MOTION_HTML = "<!doctype html><html><body>Custom motion provider</body></html>"


def test_unit_parsers_and_no_hardcoded_hast_ids():
    allowed = ["custom-wave", "custom-bow", "custom-salute"]

    # 1. Valid body plans (0..3 steps, default speed/strength, bounded floats)
    assert parse_body_plan(None, allowed) == ([], [])
    assert parse_body_plan([], allowed) == ([], [])
    accepted, rejected = parse_body_plan([{"motion": "custom-wave"}], allowed)
    assert accepted == [{"motion": "custom-wave", "speed": 1.0, "strength": 0.9}] and rejected == []
    accepted, rejected = parse_body_plan([
        {"motion": "custom-wave", "speed": 1.25, "strength": 0.85, "phrase": "おはよう", "variant": "auto", "timing": "peak"},
        {"motion": "custom-bow", "speed": 0.6, "strength": 1.0, "phrase": "ありがとう", "timing": "onset"},
        {"motion": "custom-salute", "speed": 2.0, "strength": 0.1, "timing": "release"},
    ], allowed)
    assert len(accepted) == 3 and rejected == []
    assert accepted[0]["phrase"] == "おはよう" and accepted[0]["variant"] == "auto" and accepted[0]["timing"] == "peak"
    assert parse_body_plan([{"motion": "custom-wave", "timing": "invalid"}], allowed) is None
    assert parse_body_plan([{"motion": "custom-wave", "phrase": "   "}], allowed) is None
    assert parse_body_plan([{"motion": "custom-wave", "phrase": "x" * 81}], allowed) is None
    assert parse_body_plan([{"motion": "custom-wave", "variant": "v" * 49}], allowed) is None

    # 2. Unsupported motions are rejected, never accepted as performed
    accepted, rejected = parse_body_plan([{"motion": "backflip", "speed": 1.0, "strength": 0.9}], allowed)
    assert accepted == [] and rejected == [{"motion": "backflip", "reason": "unsupported_motion"}]
    accepted, rejected = parse_body_plan([
        {"motion": "custom-wave", "speed": 1.0, "strength": 0.9},
        {"motion": "fly-away", "speed": 1.0, "strength": 0.9},
    ], allowed)
    assert accepted == [{"motion": "custom-wave", "speed": 1.0, "strength": 0.9}]
    assert rejected == [{"motion": "fly-away", "reason": "unsupported_motion"}]

    # 3. Invalid schemas, bounds, booleans, >3 steps, and tool/MCP injection keys are rejected
    bad_bodies = [
        "custom-wave",
        {},
        [{"motion": "custom-wave"}] * 4,
        [{"motion": ""}],
        [{"motion": "   "}],
        [{"motion": "custom-wave", "speed": 0.59}],
        [{"motion": "custom-wave", "speed": 2.01}],
        [{"motion": "custom-wave", "strength": 0}],
        [{"motion": "custom-wave", "strength": -0.2}],
        [{"motion": "custom-wave", "strength": 1.01}],
        [{"motion": "custom-wave", "speed": True}],
        [{"motion": "custom-wave", "strength": False}],
        [{"motion": "custom-wave", "speed": float("nan")}],
        [{"motion": "custom-wave", "speed": float("inf")}],
        [{"motion": "custom-wave", "tool": "exec", "arguments": {"cmd": "calc"}}],
        [{"motion": "custom-wave", "mcp": {"serverId": "srv", "tool": "run"}}],
        [{"motion": "custom-wave", "command": "shutdown"}],
    ]
    for sample in bad_bodies:
        assert parse_body_plan(sample, allowed) is None, sample

    # 4. parse_reply_envelope: plain text passes through; embedded JSON extracts visible reply + validated plan
    text_reply, perf = parse_reply_envelope("おはよう！今日も一緒に頑張ろうね。", allowed)
    assert text_reply == "おはよう！今日も一緒に頑張ろうね。" and perf is None

    embedded = json.dumps({
        "reply": "おはよう！手を振るね。",
        "visual": {
            "face": "happy",
            "motion": "nod",
            "body": [{"motion": "custom-wave", "speed": 1.2, "strength": 0.9}],
        },
    }, ensure_ascii=False)
    visible, perf = parse_reply_envelope(embedded, allowed)
    assert visible == "おはよう！手を振るね。"
    assert perf == {
        "face": "happy",
        "motion": "nod",
        "body": [{"motion": "custom-wave", "speed": 1.2, "strength": 0.9}],
        "source": "embedded",
    }

    # Unsupported motion in embedded reply preserves clean visible reply and never accepts unsupported action
    unsupported_embedded = json.dumps({
        "reply": "バク宙はできないんだ。",
        "visual": {
            "face": "bashful",
            "motion": "shake",
            "body": [{"motion": "backflip", "speed": 1.0, "strength": 1.0}],
        },
    }, ensure_ascii=False)
    visible, perf = parse_reply_envelope(unsupported_embedded, allowed)
    assert visible == "バク宙はできないんだ。"
    assert perf["body"] == []
    assert perf["rejected"] == [{"motion": "backflip", "reason": "unsupported_motion"}]

    # Tool-injection attempt inside envelope visual/body is rejected without leaking raw JSON
    tool_attempt = json.dumps({
        "reply": "了解したよ。",
        "visual": {
            "face": "neutral",
            "motion": "none",
            "body": [{"motion": "custom-wave", "tool": "desktop.shell"}],
        },
    }, ensure_ascii=False)
    visible, perf = parse_reply_envelope(tool_attempt, allowed)
    assert visible == "了解したよ。"
    assert perf["body"] == [] and perf["source"] == "embedded-fallback"

    # Extra top-level tool key fails envelope recognition cleanly (never executes anything)
    extra_top = json.dumps({"reply": "hi", "tool": "mcp.call"})
    for invalid in (extra_top, '<think>SYNTHETIC_PRIVATE_MARKER</think>公開', '{"reply":"partial"'):
        try:
            parse_reply_envelope(invalid, allowed)
        except ApiError as exc:
            assert exc.code == "chat_protocol_error"
        else:
            raise AssertionError("Private or malformed envelope reached the visible reply")
    assert spoken_reply("（有些迟疑，轻轻挥手）早上好。我有点紧张（因为是第一次）。") == "早上好。我有点紧张（因为是第一次）。"
    assert spoken_reply("（轻轻挥手）") == ""
    assert requests_stillness("動かないでください。")
    assert requests_stillness("请不要挥手。")
    assert not requests_stillness("「動かないで」の意味を説明して。")
    assert spoken_reply("*waves her hand* Hello") == "Hello"
    assert spoken_reply("文字（温度 20 ℃）") == "文字（温度 20 ℃）"
    mixed = 'こんにちは。\n\n' + json.dumps({
        "reply": "こんにちは。", "visual": {"face": "smallSmile", "motion": "none", "body": []},
    }, ensure_ascii=False)
    visible, perf = parse_reply_envelope(mixed, allowed)
    assert visible == "こんにちは。" and perf["face"] == "smallSmile"
    assert parse_reply_envelope(mixed.replace(chr(34), "”"), allowed)[0] == "こんにちは。"
    assert read_public_turn(json.dumps({"reply": mixed})) == {"reply": "こんにちは。"}
    assert "SYNTHETIC_PRIVATE_MARKER" not in read_public_turn(json.dumps({
        "reply": "<think>SYNTHETIC_PRIVATE_MARKER</think>公開",
    }))["reply"]


    # 5. parse_visual_plan supports optional body while preserving exact legacy shape when omitted
    assert parse_visual_plan('{"face":"happy","motion":"nod"}', allowed) == {"face": "happy", "motion": "nod"}
    with_body = parse_visual_plan(json.dumps({
        "face": "happy",
        "motion": "nod",
        "body": [
            {"motion": "custom-wave", "speed": 1.1, "strength": 0.85},
            {"motion": "backflip", "speed": 1.0, "strength": 0.8},
        ],
    }), allowed)
    assert with_body == {
        "face": "happy",
        "motion": "nod",
        "body": [{"motion": "custom-wave", "speed": 1.1, "strength": 0.85}],
        "rejectedBody": [{"motion": "backflip", "reason": "unsupported_motion"}],
    }

    # 6. Manifest validation rejects invalid motionProvider declarations
    bad_manifests = [
        "motionProvider: bad\n",
        "motionProvider:\n  entryId: missing\n  catalogAction: catalog\n",
        "motionProvider:\n  entryId: motion-provider\n  catalogAction: undeclared\n",
    ]
    base_yaml = (
        "schemaVersion: 1\napiVersion: 1\nid: example.bad-motion\nversion: '1.0.0'\nname: Bad\n"
        "requiresFeatures: [plugin-pages-v1]\npermissions: [motion.catalog]\n"
        "actions:\n  - {id: catalog, scope: motion.catalog}\n"
        "entries:\n  - id: motion-provider\n    title: Provider\n    slot: character-settings\n"
        "    page: provider.html\n    actions: [catalog]\n"
    )
    with tempfile.TemporaryDirectory(prefix="kei-r21-mf-") as mf_tmp:
        mf_dir = Path(mf_tmp)
        (mf_dir / "main.py").write_text("def activate(_): pass\n", encoding="utf-8")
        (mf_dir / "provider.html").write_text("<!doctype html><html></html>", encoding="utf-8")
        for bad in bad_manifests:
            (mf_dir / "metadata.yaml").write_text(base_yaml + bad, encoding="utf-8")
            try:
                manifest(mf_dir)
                raise AssertionError(f"Expected ApiError for {bad}")
            except ApiError as exc:
                assert exc.code == "invalid_manifest", exc.code

    # 7. Host source must never hardcode HAST plugin ID or provider-specific motion IDs
    host_dir = ROOT / "kei_host"
    for py_file in host_dir.rglob("*.py"):
        source = py_file.read_text("utf-8")
        assert "kei.hastsec" not in source, f"Hardcoded kei.hastsec found in {py_file}"
        for forbidden in ("向上抬高", "挥手打招呼", "greeting-wave", "explain-open-palm", "hesitate-pause", "ack-nod", "indicate-direction", "complete-settle"):
            assert forbidden not in source, f"Hardcoded provider motion ID {forbidden!r} found in {py_file}"

    print("PASS unit parsers, safety boundaries, manifest validation, and zero hardcoded HAST IDs")


class LoopbackPlannerServer:
    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        self.midflight_entered = threading.Event()
        self.midflight_release = threading.Event()
        parent = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                messages = payload.get("messages", [])
                system = messages[0]["content"] if messages else ""
                user = messages[-1]["content"] if messages else ""
                with parent.lock:
                    parent.requests.append({"system": system, "user": user})
                if "midflight-disable" in user:
                    parent.midflight_entered.set()
                    parent.midflight_release.wait(timeout=8)
                    content = json.dumps({
                        "reply": "無効化テストの返事だよ。",
                        "visual": {
                            "face": "gentle",
                            "motion": "nod",
                            "body": [{"motion": "custom-wave", "speed": 1.0, "strength": 0.9}],
                        },
                    }, ensure_ascii=False)
                elif "two-step" in user:
                    content = json.dumps({
                        "reply": "二段階で動くね！",
                        "visual": {
                            "face": "happy",
                            "motion": "nod",
                            "body": [
                                {"motion": "custom-wave", "speed": 1.2, "strength": 0.9},
                                {"motion": "custom-bow", "speed": 1.0, "strength": 0.8},
                            ],
                        },
                    }, ensure_ascii=False)
                elif "plain-visual" in user:
                    content = "普通の返事だよ。"
                elif '"kind": "reply"' in user:
                    content = json.dumps({
                        "face": "smallSmile",
                        "motion": "tilt",
                        "body": [
                            {"motion": "custom-wave", "speed": 1.0, "strength": 0.85},
                            {"motion": "unsupported-jump", "speed": 1.0, "strength": 0.85},
                        ],
                    })
                elif "unsupported-only" in user:
                    content = json.dumps({
                        "reply": "それはできないよ。",
                        "visual": {
                            "face": "bashful",
                            "motion": "shake",
                            "body": [{"motion": "backflip", "speed": 1.0, "strength": 0.9}],
                        },
                    }, ensure_ascii=False)
                else:
                    content = json.dumps({
                        "reply": "こんにちは！",
                        "visual": {
                            "face": "happy",
                            "motion": "nod",
                            "body": [{"motion": "custom-wave", "speed": 1.1, "strength": 0.9}],
                        },
                    }, ensure_ascii=False)
                body = json.dumps({"choices": [{"message": {"content": content}}]}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}/v1/chat/completions"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def wait_turn(host: BuiltHost, turn_id: str, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        turn = host.request("GET", f"/v1/chat/turns/{turn_id}")
        if turn["status"] not in ("queued", "running"):
            return turn
        time.sleep(0.03)
    raise AssertionError(f"Turn {turn_id} did not finish")


def test_dynamic_catalog_caching_invalidation_and_midflight_disable(artifact: Path):
    planner = LoopbackPlannerServer()
    try:
        with tempfile.TemporaryDirectory(prefix="kei-r21-body-") as tmp:
            tmp_dir = Path(tmp)
            plugin_zip = tmp_dir / "example.custom-motion-1.0.0.zip"
            make_zip(plugin_zip, {
                "metadata.yaml": CUSTOM_MOTION_METADATA,
                "main.py": CUSTOM_MOTION_MAIN,
                "provider.html": CUSTOM_MOTION_HTML,
            })
            chat_cfg = tmp_dir / "chat.json"
            chat_cfg.write_text(json.dumps({
                "endpoint": planner.url,
                "model": "fixture-r21",
                "timeoutSeconds": 10,
            }), encoding="utf-8")
            data_dir = tmp_dir / "data"
            with BuiltHost(artifact, data_dir, extra_args=["--chat-config", str(chat_cfg)]) as host:
                # 1. Before any motion plugin is installed, system prompt must NOT advertise body motions
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-1",
                    "requestId": "req-no-plugin",
                    "question": "おはよう",
                }, 202)
                turn = wait_turn(host, started["turnId"])
                assert turn["status"] == "completed"
                assert "custom-wave" not in planner.requests[-1]["system"]
                assert turn["performance"]["body"] == []
                assert turn["performance"]["rejected"] == [{"motion": "custom-wave", "reason": "unsupported_motion"}]

                # 2. Install & enable generic motion provider plugin
                host.request("POST", "/v1/plugins/install", plugin_zip.read_bytes(), 201)
                host.request("POST", "/v1/plugins/example.custom-motion/enable", {"grants": ["motion.catalog"]})

                # 3. Turn 1 with plugin enabled discovers custom-wave & custom-bow dynamically
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-1",
                    "requestId": "req-two-step",
                    "question": "two-step please",
                }, 202)
                turn = wait_turn(host, started["turnId"])
                assert turn["status"] == "completed"
                assert "custom-wave" in planner.requests[-1]["system"]
                assert "custom-bow" in planner.requests[-1]["system"]
                assert "malformed-no-mask" not in planner.requests[-1]["system"]
                assert turn["reply"] == "二段階で動くね！"
                assert turn["performance"]["body"] == [
                    {"motion": "custom-wave", "speed": 1.2, "strength": 0.9},
                    {"motion": "custom-bow", "speed": 1.0, "strength": 0.8},
                ]

                # 4. Turn 2 reuses cached catalog (plugin catalog action called only once)
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-1",
                    "requestId": "req-unsupported",
                    "question": "unsupported-only",
                }, 202)
                turn = wait_turn(host, started["turnId"])
                assert turn["reply"] == "それはできないよ。"
                assert turn["performance"]["body"] == []
                assert turn["performance"]["rejected"] == [{"motion": "backflip", "reason": "unsupported_motion"}]

                # Verify catalog caching: call counter file must still be 1!
                counter_files = list(data_dir.rglob("catalog_calls.txt"))
                assert len(counter_files) == 1
                assert int(counter_files[0].read_text("utf-8")) == 1

                # 5. Plain-text reply + /v1/chat/visual fallback also receives catalog & validates body
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-1",
                    "requestId": "req-plain",
                    "question": "plain-visual",
                }, 202)
                plain_turn = wait_turn(host, started["turnId"])
                assert plain_turn["reply"] == "普通の返事だよ。" and "performance" not in plain_turn
                visual = host.request("POST", "/v1/chat/visual", {
                    "kind": "reply",
                    "turnId": plain_turn["turnId"],
                    "conversationId": "conv-1",
                })
                assert visual["state"] == "ready", visual
                assert visual["body"] == [{"motion": "custom-wave", "speed": 1.0, "strength": 0.85}]
                assert visual["rejectedBody"] == [{"motion": "unsupported-jump", "reason": "unsupported_motion"}]
                assert int(counter_files[0].read_text("utf-8")) == 1

                # 6. Mid-flight plugin disable invalidates cache AND rejects late body plan on completion!
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-1",
                    "requestId": "req-midflight",
                    "question": "midflight-disable",
                }, 202)
                assert planner.midflight_entered.wait(timeout=5), "Planner did not enter mid-flight turn"
                host.request("POST", "/v1/plugins/example.custom-motion/disable", {})
                planner.midflight_release.set()
                late_turn = wait_turn(host, started["turnId"])
                assert late_turn["status"] == "completed"
                assert late_turn["reply"] == "無効化テストの返事だよ。"
                assert late_turn["performance"]["body"] == []
                assert late_turn["performance"]["rejected"] == [{"motion": "custom-wave", "reason": "unsupported_motion"}]

                # 7. Next turn after disable has NO motion catalog in system prompt
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-1",
                    "requestId": "req-after-disable",
                    "question": "hello after disable",
                }, 202)
                after_turn = wait_turn(host, started["turnId"])
                assert "custom-wave" not in planner.requests[-1]["system"]
                assert after_turn["performance"]["body"] == []

                # 8. Re-enable invalidates cache and refreshes catalog (counter becomes 2)
                host.request("POST", "/v1/plugins/example.custom-motion/enable", {"grants": ["motion.catalog"]})
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-1",
                    "requestId": "req-reenabled",
                    "question": "hello after reenable",
                }, 202)
                reenabled_turn = wait_turn(host, started["turnId"])
                assert reenabled_turn["performance"]["body"] == [{"motion": "custom-wave", "speed": 1.1, "strength": 0.9}]
                assert int(counter_files[0].read_text("utf-8")) == 2

        print("PASS dynamic catalog discovery, caching, invalidation, visual fallback, and mid-flight disable")
    finally:
        planner.close()


def test_real_hastsec_catalog_and_cache(artifact: Path, hastsec_zip: Path, hastsec_root: Path):
    planner = LoopbackPlannerServer()
    try:
        with tempfile.TemporaryDirectory(prefix="kei-r21-hast-") as tmp:
            tmp_dir = Path(tmp)
            chat_cfg = tmp_dir / "chat.json"
            chat_cfg.write_text(json.dumps({
                "endpoint": planner.url,
                "model": "fixture-r21-hast",
                "timeoutSeconds": 10,
            }), encoding="utf-8")
            with BuiltHost(artifact, tmp_dir / "data", extra_args=["--chat-config", str(chat_cfg)]) as host:
                host.request("POST", "/v1/plugins/install", hastsec_zip.read_bytes(), 201)
                host.request("POST", "/v1/plugins/kei.hastsec/enable", {
                    "grants": ["hastsec.solve", "hastsec.preview", "hastsec.settings"],
                })
                host.request("PUT", "/v1/plugins/kei.hastsec/config", {"values": {"resource_root": str(hastsec_root)}})
                host.request("POST", "/v1/plugins/kei.hastsec/reload", {})

                t0 = time.perf_counter()
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-hast",
                    "requestId": "req-hast-1",
                    "question": "おはよう",
                }, 202)
                wait_turn(host, started["turnId"])
                cold_prompt_ms = (time.perf_counter() - t0) * 1000
                sys_prompt = planner.requests[-1]["system"]
                assert "left-向上抬高" in sys_prompt and "left-挥手打招呼" in sys_prompt and "right-挥手打招呼" in sys_prompt

                # Second turn reuses cached HAST-SEC catalog
                t1 = time.perf_counter()
                started = host.request("POST", "/v1/chat/ask", {
                    "conversationId": "conv-hast",
                    "requestId": "req-hast-2",
                    "question": "またね",
                }, 202)
                wait_turn(host, started["turnId"])
                warm_prompt_ms = (time.perf_counter() - t1) * 1000
                print(
                    f"PASS real kei.hastsec dynamic catalog injection "
                    f"(cold turn+catalog={cold_prompt_ms:.1f}ms, warm cached turn={warm_prompt_ms:.1f}ms)"
                )
    finally:
        planner.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--hastsec-zip", type=Path, default=None)
    parser.add_argument("--hastsec-root", type=Path, default=None)
    args = parser.parse_args()
    artifact = args.artifact.resolve()
    test_unit_parsers_and_no_hardcoded_hast_ids()
    test_dynamic_catalog_caching_invalidation_and_midflight_disable(artifact)
    if args.hastsec_zip and args.hastsec_root:
        test_real_hastsec_catalog_and_cache(artifact, args.hastsec_zip.resolve(), args.hastsec_root.resolve())


if __name__ == "__main__":
    main()
