"""Install LumenAct into the published host and verify its page and lifecycle contract."""
import argparse
import hashlib
import json
import tempfile
import time
from pathlib import Path

from host_smoke import BuiltHost

PLUGIN = "kei.lumenact"
ROUTE = "/v1/plugins/" + PLUGIN
GRANTS = {"grants": ["lumenact.select", "lumenact.preview", "lumenact.settings"]}


def page(host, admin=False):
    return host.request("POST", "/v1/pages/open",
                        {"pluginId": PLUGIN, "entryId": "expression-admin" if admin else "expression-provider"},
                        status=201)


def call(host, session, action, args=None, **expect):
    response = host.request("POST", "/v1/pages/call",
                            {"sessionId": session["sessionId"], "action": action, "arguments": args or {}}, **expect)
    return response.get("result")


def complete(host, session, action, args):
    result = call(host, session, action, args)
    job_id = result.get("jobId")
    deadline = time.monotonic() + 40
    while result["state"] == "pending" and time.monotonic() < deadline:
        time.sleep(.12)
        result = call(host, session, action + ".poll", {"jobId": job_id})
    assert result["state"] != "pending", "selection exceeded 40 seconds"
    return result


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(host, zipfile, resources=None):
    assert host.request("GET", "/v1/entries") == []
    host.request("POST", "/v1/plugins/install", zipfile.read_bytes(), status=201)
    assert host.request("GET", "/v1/entries") == []
    host.request("POST", ROUTE + "/enable", {"grants": ["lumenact.preview"]})
    restricted = page(host)
    call(host, restricted, "select", {"intent": "微笑"}, status=403, error="scope_denied")
    host.request("POST", ROUTE + "/disable")
    host.request("POST", ROUTE + "/enable", GRANTS)
    stage, admin = page(host), page(host, True)
    call(host, stage, "settings.get", status=403, error="scope_denied")
    print("PASS independent ZIP, opt-in activation and separate settings/select grants")

    status = call(host, admin, "status")
    assert status["selectorState"] == "assets_missing"
    assert {row["id"] for row in status["samples"]} == {"0", "5", "23", "77"}
    assert complete(host, stage, "select", {"intent": "开心地微笑"}) == {"state": "fallback", "code": "assets_missing"}
    fixed = complete(host, admin, "preview", {"clipId": "5"})
    events = host.events(stage)["events"]
    event = next(e["data"]["data"] for e in events
                 if e["type"] == "plugin.message" and e["data"]["topic"] == "lumenact.preview")
    assert fixed["selection"]["selector"] == "fixed" and event["clip"]["clipId"] == "5"
    curve = event["clip"]
    assert curve["fps"] == 30 and curve["frames"] == 89 and curve["targets"] == ["surprised"]
    assert max(curve["tracks"][0]) - min(curve["tracks"][0]) > .1
    print("PASS missing ONNX returns base fallback and true authored fixed preview retains sample variation")

    queued = call(host, stage, "select", {"intent": "中断テスト"})
    call(host, stage, "select.cancel", {"jobId": queued["jobId"]})
    assert call(host, stage, "select.poll", {"jobId": queued["jobId"]})["code"] == "job_closed"
    print("PASS cancelled asynchronous selection cannot deliver a late result")

    settings = call(host, admin, "settings.get")["values"]
    reserved = {**settings, "mapping": {"aa": ["mouth_smile_1"]}}
    assert call(host, admin, "settings.save", {"values": reserved})["code"] == "mapping_reserved"
    settings = {**settings, "selector_mode": "onnx" if resources else "fixed",
                "resource_root": str(resources) if resources else "",
                "mapping": {"happy": ["mouth_smile_1", "eye_cool_L"], "missingBrow": ["eyebrow_up_L"]}}
    reply = call(host, admin, "settings.save", {"values": settings})
    assert reply["state"] == "ready" and reply["pendingReload"]
    host.request("POST", ROUTE + "/reload")
    call(host, stage, "select", {"intent": "微笑"}, status=410, error="page_closed")
    stage, admin = page(host), page(host, True)
    assert call(host, admin, "settings.get") == {"state": "ready", "values": settings, "pendingReload": False}
    selected = complete(host, stage, "select", {"intent": "开心地微笑，温和友好", "text": "你好，见到你真开心。"})
    assert selected["state"] == "ready" and selected["clip"]["label"] == "微笑", selected
    assert set(selected["clip"]["targets"]) == {"happy", "missingBrow"}
    assert len(set(selected["clip"]["tracks"][0])) > 2
    if resources:
        assert selected["selection"]["model"] == "RBT3-Lumen-38M-v6" and selected["selection"]["selector"] == "onnx"
        print("PASS official ONNX selects a real curve from the pinned full catalog")
    else:
        assert selected["selection"]["selector"] == "fixed"
        print("PASS offline fixed selector and custom morph map")
    print("PASS saved settings, reserved weights rejection and old session revocation on reload")

    host.request("POST", ROUTE + "/disable")
    assert host.request("GET", "/v1/entries") == []
    call(host, stage, "select", {"intent": "微笑"}, status=410, error="page_closed")
    host.request("DELETE", ROUTE, {"retainData": False})
    assert host.request("GET", "/v1/entries") == []
    print("PASS disable and uninstall withdraw all entries and old selection requests")
    return {**selected, "clip": {key: value for key, value in selected["clip"].items() if key != "tracks"}}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("host", type=Path)
    cli.add_argument("plugin", type=Path)
    cli.add_argument("--resources", type=Path)
    cli.add_argument("--result", type=Path)
    args = cli.parse_args()
    host_path = args.host.resolve()
    before = digest(host_path)
    with tempfile.TemporaryDirectory(prefix="kei-lumenact-api-") as temp:
        with BuiltHost(host_path, Path(temp)) as host:
            result = verify(host, args.plugin.resolve(), args.resources.resolve() if args.resources else None)
    assert digest(host_path) == before
    result["hostSha256"] = before
    if args.result:
        args.result.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
