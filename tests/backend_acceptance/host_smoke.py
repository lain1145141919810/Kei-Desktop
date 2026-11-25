"""Exercise the built host with an independently authored ZIP using only public HTTP."""
import argparse
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def changed_package(plugin, old, new, member="metadata.yaml"):
    output = io.BytesIO()
    with zipfile.ZipFile(plugin) as source, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for filename in source.namelist():
            data = source.read(filename)
            target.writestr(filename, data.replace(old, new) if filename == member else data)
    return output.getvalue()


def terminate_owned(process, *, force=False):
    if process.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=10)
        elif force:
            process.kill()
        else:
            process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


class BuiltHost:
    def __init__(self, artifact, data, extra_args=()):
        self.artifact, self.data, self.extra_args = artifact, data, list(extra_args)
        self.process = None

    def __enter__(self):
        file = self.data / "connection.json"
        file.unlink(missing_ok=True)
        self.process = subprocess.Popen(
            [sys.executable, str(self.artifact), "--data-dir", str(self.data), "--port", "0", *self.extra_args],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        try:
            end = time.monotonic() + 8
            while time.monotonic() < end:
                if self.process.poll() is not None:
                    raise RuntimeError(self.process.stderr.read().decode(errors="replace"))
                if file.exists():
                    self.connection = json.loads(file.read_text("utf-8"))
                    return self
                time.sleep(.05)
            raise RuntimeError("Host did not start")
        except Exception:
            self.__exit__()
            raise

    def __exit__(self, *_args):
        terminate_owned(self.process)
        self.process.stderr.close()

    def request(self, method, path, body=None, status=200, error=None, authorized=True):
        headers = {}
        if authorized:
            headers["Authorization"] = "Bearer " + self.connection["token"]
        if isinstance(body, bytes):
            headers["Content-Type"] = "application/zip"
        elif body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(self.connection["url"] + path, data=body, method=method, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as failure:
            response = failure
        with response:
            payload = json.loads(response.read())
            assert response.status == status, (method, path.split("?")[0], response.status, payload)
        assert payload["apiVersion"] == 1
        if error:
            assert payload["error"]["code"] == error, payload
            return payload
        return payload["data"]

    def page(self, entry_id, **kwargs):
        return self.request(
            "POST", "/v1/pages/open", {"pluginId": "studio.counter", "entryId": entry_id}, **kwargs,
        )

    def call(self, page, action, **kwargs):
        return self.request(
            "POST", "/v1/pages/call", {"sessionId": page["sessionId"], "action": action}, **kwargs,
        )

    def events(self, page, status=200, error=None):
        return self.request(
            "GET", "/v1/pages/events?sessionId=" + page["sessionId"] + "&after=0",
            status=status, error=error,
        )


def run(artifact, plugin):
    before = digest(artifact)
    package = plugin.read_bytes()
    route = "/v1/plugins/studio.counter"
    all_grants = {"grants": ["counter.read", "counter.write"]}
    with tempfile.TemporaryDirectory(prefix="kei-v1-test-") as root:
        data_dir = Path(root)
        with BuiltHost(artifact, data_dir) as host:
            req = host.request
            assert req("GET", "/v1/status")["installed"] == 0
            assert req("GET", "/v1/entries") == []
            req("GET", "/v1/plugins", status=401, error="unauthorized", authorized=False)
            print("PASS empty host with authenticated loopback API")

            unsupported = changed_package(plugin, b"apiVersion: 1", b"apiVersion: 99")
            unsupported_result = req("POST", "/v1/plugins/install", unsupported, 422, "unsupported_api")
            req("POST", "/v1/plugins/install", b"invalid ZIP", 422, "invalid_archive")
            assert req("GET", "/v1/plugins") == []
            assert req("POST", "/v1/plugins/install", package, 201)["enabled"] is False
            req("POST", "/v1/plugins/install", package, 409, "plugin_exists")
            req("POST", route + "/enable", {"grants": ["external.tool"]}, 422, "invalid_grants")
            assert req("GET", "/v1/entries") == []
            print("PASS install validation and disabled-by-default")

            req("POST", route + "/enable", {"grants": ["counter.read"]})
            entries = req("GET", "/v1/entries")
            assert {entry["slot"] for entry in entries} == {"extensions", "admin"}
            desktop, admin = host.page("desktop-counter", status=201), host.page("admin-counter", status=201)
            assert 'id="increment"' in desktop["html"] and 'id="reset"' in admin["html"]
            assert host.call(desktop, "current") == {"result": {"value": 0}}
            denied_result = host.call(desktop, "increment", status=403, error="scope_denied")
            req("POST", route + "/disable", {})
            stale_result = host.call(desktop, "current", status=410, error="page_closed")
            host.events(admin, status=410, error="page_closed")
            assert req("GET", "/v1/entries") == []
            host.page("admin-counter", status=409, error="plugin_disabled")
            print("PASS both page routes, grant denial, and open-page revocation")

            req("POST", route + "/enable", all_grants)
            desktop, admin = host.page("desktop-counter", status=201), host.page("admin-counter", status=201)
            host.call(admin, "increment", status=403, error="scope_denied")
            assert host.call(desktop, "increment") == {"result": {"value": 1}}
            messages = host.events(admin)
            assert messages["events"][-1]["data"] == {"topic": "counter.changed", "data": {"value": 1}}
            assert all(evt["type"] != "plugin.message" for evt in req("GET", "/v1/events")["events"])
            for _ in range(2):
                req("POST", route + "/reload", {})
                host.call(desktop, "current", status=410, error="page_closed")
                host.events(admin, status=410, error="page_closed")
                assert len(req("GET", "/v1/entries")) == 2
                desktop, admin = host.page("desktop-counter", status=201), host.page("admin-counter", status=201)
                assert host.call(desktop, "current") == {"result": {"value": 1}}
                assert host.events(admin)["events"] == []
            print("PASS scoped action and event delivery, two reloads without stale pages or past events")

        with BuiltHost(artifact, data_dir) as host:
            req = host.request
            assert req("GET", "/v1/plugins")[0]["enabled"]
            host.call(desktop, "current", status=410, error="page_closed")
            desktop, admin = host.page("desktop-counter", status=201), host.page("admin-counter", status=201)
            assert host.call(admin, "current") == {"result": {"value": 1}}
            req("DELETE", route, {"retainData": True})
            assert req("GET", "/v1/entries") == []
            host.events(desktop, status=410, error="page_closed")
            host.call(admin, "current", status=410, error="page_closed")
            host.page("desktop-counter", status=404, error="plugin_not_found")
            req("POST", "/v1/plugins/install", package, 201)
            req("POST", route + "/enable", all_grants)
            admin = host.page("admin-counter", status=201)
            assert host.call(admin, "current") == {"result": {"value": 1}}
            assert host.call(admin, "reset") == {"result": {"value": 0}}
            req("DELETE", route, {"retainData": False})
            assert not (data_dir / "plugin-data" / "studio.counter").exists()
            print("PASS restart persistence and uninstall with open pages, retaining or deleting data")

            broken = changed_package(
                plugin, b'    context.register("reset", lambda _args: save(0))',
                b'    raise RuntimeError("fixture activation error")', member="main.py",
            )
            req("POST", "/v1/plugins/install", broken, 201)
            failed_result = req("POST", route + "/enable", all_grants, 422, "activation_failed")
            assert req("GET", "/v1/entries") == []
            assert req("GET", "/v1/plugins")[0]["lastError"] == "activation_failed"
            lifecycle = req("GET", "/v1/events")
            assert lifecycle["events"][-1]["type"] == "plugin.activation_failed"
            assert lifecycle["reset"] is False
            print("PASS failed activation leaves no active entry or page")

    assert digest(artifact) == before
    print("PASS same host artifact SHA-256 before install and after lifecycle")
    return {
        "hostArtifactSha256": before, "entries": {"apiVersion": 1, "data": entries},
        "actionResult": {"apiVersion": 1, "data": {"result": {"value": 1}}},
        "pageEvents": {"apiVersion": 1, "data": {**messages, "epoch": "example-epoch"}},
        "lifecycleEvents": {"apiVersion": 1, "data": {**lifecycle, "epoch": "example-epoch"}},
        "errors": [unsupported_result, denied_result, stale_result, failed_result],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("plugin", type=Path)
    parser.add_argument("--fixtures", type=Path)
    args = parser.parse_args()
    fixtures = run(args.artifact.resolve(), args.plugin.resolve())
    if args.fixtures:
        args.fixtures.write_text(json.dumps(fixtures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
