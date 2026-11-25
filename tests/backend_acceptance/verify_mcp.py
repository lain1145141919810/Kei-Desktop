"""Verify MCP against two actual SDK transports and a brokered plugin."""
import argparse
import concurrent.futures
import ctypes
import io
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
import urllib.error
from pathlib import Path

from host_smoke import BuiltHost, terminate_owned

HERE = Path(__file__).resolve().parent


def wait_for(check, seconds=10):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if value := check():
            return value
        time.sleep(.07)
    raise AssertionError("Expected state did not appear")


def free_port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def listening(port):
    with socket.socket() as connection:
        connection.settimeout(.2)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def exists(pid):
    if os.name == "nt":
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def plugin_package():
    manifest = {
        "schemaVersion": 1, "apiVersion": 1, "id": "studio.mcp-test", "name": "MCP fixture",
        "version": "1.0.0", "permissions": ["mcp.call", "test.bridge"],
        "actions": [{"id": "bridge", "scope": "test.bridge"}],
        "entries": [{"id": "desktop", "slot": "extensions", "page": "index.html",
                     "title": "MCP fixture", "actions": ["bridge"]}],
    }
    module = '''from kei_sdk import MCPCallError

def initialize(context):
    def bridge(data):
        try:
            return context.call_mcp(
                data["serverId"], data["toolName"], data.get("arguments", {}),
                data["requestId"], confirmation=data.get("confirmation"),
            )
        except MCPCallError as error:
            return {"error": {"code": error.code, "details": error.details}}
    context.register("bridge", bridge)
'''
    with io.BytesIO() as output:
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("metadata.yaml", json.dumps(manifest))
            archive.writestr("main.py", module)
            archive.writestr("index.html", "<title>MCP fixture</title>")
        return output.getvalue()


def verify(artifact, root):
    port = free_port()
    stdio_log, http_log = root / "stdio.log", root / "http.log"
    token = secrets.token_urlsafe(24)
    os.environ["KEI_FIXTURE_TOKEN"] = token
    config = dict(
        name="Fixture", enabled=True, timeoutSeconds=4, readOnlyTools=["echo"],
        pluginAccess={"studio.mcp-test": ["echo", "change"]},
    )
    stdio = {**config, "transport": "stdio", "command": sys.executable,
             "args": [str(HERE / "mcp_fixture.py"), "stdio", str(stdio_log)],
             "credentialRef": {"env": "KEI_FIXTURE_TOKEN", "target": "FIXTURE_STDIO_TOKEN"}}
    http = {**config, "transport": "streamable-http", "protocolMode": "legacy", "url": f"http://127.0.0.1:{port}/mcp",
            "credentialRef": {"env": "KEI_FIXTURE_TOKEN"}, "pluginAccess": {}}

    def start_http():
        child = subprocess.Popen([sys.executable, str(HERE / "mcp_fixture.py"), "http", str(http_log),
                                  "--port", str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(lambda: listening(port))
        return child

    def count(journal, kind, key):
        return journal.read_text("utf-8").splitlines().count(kind + " " + key) if journal.exists() else 0

    def invoke(host, ident, key, method="echo", mode=None, confirmed=False, **expected):
        return host.request("POST", f"/v1/mcp/servers/{ident}/call", {
            "requestId": key, "toolName": method, "arguments": {"key": key, "mode": mode},
            "confirmed": confirmed,
        }, **expected)

    current_http = start_http()
    try:
        with BuiltHost(artifact, root) as host, concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            req = host.request
            assert req("GET", "/v1/mcp/servers") == {"sdkVersion": "2.2.0", "sdkAvailable": True, "servers": []}
            req("PUT", "/v1/mcp/servers/a", stdio)
            req("PUT", "/v1/mcp/servers/b", http)
            catalogs = [req("GET", f"/v1/mcp/servers/{name}/tools") for name in ("a", "b")]
            assert [row["protocolVersion"] for row in catalogs] == ["2026-07-28", "2025-11-25"]
            assert all([item["name"] for item in itemset["tools"]] == ["echo", "change"] for itemset in catalogs)
            assert count(stdio_log, "list", "second") == count(http_log, "list", "second") == 1
            req("POST", "/v1/mcp/servers/a/refresh", {})
            assert count(stdio_log, "list", "second") == 2
            samples = [invoke(host, name, key) for name, key in (("a", "a-echo"), ("b", "b-echo"))]
            stdio_pid = samples[0]["result"]["structuredContent"]["pid"]
            assert [row["result"]["structuredContent"]["server"] for row in samples] == ["stdio", "http"]
            assert samples[0]["result"]["structuredContent"]["credentialPresent"]
            statuses = req("GET", "/v1/mcp/servers")
            assert all(row["state"] == "ready" for row in statuses["servers"])
            assert token not in json.dumps(statuses) and token not in (root / "mcp-servers.json").read_text("utf-8")
            print("PASS SDK transports, two-page listing/refresh, same-name routing, credentials and status", flush=True)

            tool_error = invoke(host, "a", "tool-error", mode="tool-error")
            assert tool_error["result"]["isError"] is True
            protocol_error = invoke(host, "b", "protocol-error", mode="protocol", status=502, error="mcp_protocol_error")
            assert protocol_error["error"]["details"]["protocolCode"] == -32602
            denied = invoke(host, "a", "confirm-denied", method="change", status=403, error="confirmation_required")
            assert count(stdio_log, "call", "confirm-denied") == 0
            print("PASS tool error, protocol error and side-effect confirmation", flush=True)

            timed = invoke(host, "a", "timeout", method="change", mode="slow", confirmed=True, status=504, error="mcp_timeout")
            assert timed["error"]["details"]["mayHaveRun"]
            invoke(host, "a", "timeout", method="change", mode="slow", confirmed=True, status=504, error="mcp_timeout")
            assert count(stdio_log, "call", "timeout") == 1
            future = pool.submit(invoke, host, "b", "cancel", "change", "slow", True, status=409, error="mcp_cancelled")
            wait_for(lambda: count(http_log, "call", "cancel"))
            assert req("POST", "/v1/mcp/cancel", {"requestId": "cancel"})["accepted"]
            assert future.result(timeout=12)["error"]["details"]["mayHaveRun"]
            assert count(http_log, "call", "cancel") == 1
            print("PASS timeout and cancellation without automatic replay", flush=True)

            req("POST", "/v1/plugins/install", plugin_package(), 201)
            mgr = "/v1/plugins/studio.mcp-test"
            req("POST", mgr + "/enable", {"grants": ["test.bridge"]})

            def open_page():
                return req("POST", "/v1/pages/open", {"pluginId": "studio.mcp-test", "entryId": "desktop"}, 201)

            def broker(page, ident, key, method="echo", arguments=None, confirmation=None, **expected):
                return req("POST", "/v1/pages/call", {"sessionId": page["sessionId"], "action": "bridge", "arguments": {
                    "serverId": ident, "toolName": method, "requestId": key,
                    "arguments": arguments or {}, "confirmation": confirmation,
                }}, **expected)

            page = open_page()
            assert broker(page, "a", "no-grant")["result"]["error"]["code"] == "mcp_scope_denied"
            req("POST", mgr + "/disable", {})
            req("POST", mgr + "/enable", {"grants": ["mcp.call", "test.bridge"]})
            page = open_page()
            assert broker(page, "b", "deny-server")["result"]["error"]["code"] == "mcp_scope_denied"
            assert broker(page, "a", "deny-tool", "unknown")["result"]["error"]["code"] == "mcp_scope_denied"
            assert broker(page, "a", "deny-mutation", "change")["result"]["error"]["code"] == "confirmation_required"
            assert broker(page, "a", "broker-read")["result"]["result"]["structuredContent"]["server"] == "stdio"
            token_request = {"pluginId": "studio.mcp-test", "serverId": "a", "toolName": "change",
                             "confirmed": True, "arguments": {"mode": "slow", "key": "plugin-slow"}}
            one_shot = {"key": "one-shot"}
            first_token = req("POST", "/v1/mcp/confirm", {**token_request, "arguments": one_shot})["confirmation"]
            assert broker(page, "a", "one-shot", "change", one_shot, first_token)["result"]["result"]
            assert broker(page, "a", "token-reused", "change", one_shot, first_token)["result"]["error"]["code"] == "confirmation_required"
            assert count(stdio_log, "call", "one-shot") == 1
            before_reconnect = req("POST", "/v1/mcp/confirm", {**token_request, "arguments": one_shot})["confirmation"]
            req("POST", "/v1/mcp/servers/a/reconnect", {})
            stdio_pid = invoke(host, "a", "read-after-reconnect")["result"]["structuredContent"]["pid"]
            assert broker(page, "a", "token-before-reconnect", "change", one_shot, before_reconnect)["result"]["error"]["code"] == "confirmation_required"
            confirmation = req("POST", "/v1/mcp/confirm", token_request)["confirmation"]
            before_disable = req("POST", "/v1/mcp/confirm", {**token_request, "arguments": one_shot})["confirmation"]
            future = pool.submit(broker, page, "a", "plugin-slow", "change",
                                 token_request["arguments"], confirmation, status=410, error="page_closed")
            wait_for(lambda: count(stdio_log, "call", "plugin-slow"))
            req("POST", mgr + "/disable", {})
            future.result(timeout=10)
            req("GET", "/v1/pages/events?sessionId=" + page["sessionId"], status=410, error="page_closed")
            survived = invoke(host, "a", "core-after-plugin")
            assert survived["result"]["structuredContent"]["pid"] == stdio_pid
            req("POST", mgr + "/enable", {"grants": ["mcp.call", "test.bridge"]})
            replacement_page = open_page()
            assert broker(replacement_page, "a", "token-before-disable", "change", one_shot, before_disable)["result"]["error"]["code"] == "confirmation_required"
            req("POST", mgr + "/disable", {})
            print("PASS MCP grant, tool allowlist, one-use confirmation and scoped plugin teardown", flush=True)

            lost = pool.submit(invoke, host, "b", "lost", "change", "slow", True, status=502, error="mcp_transport_error")
            wait_for(lambda: count(http_log, "call", "lost"))
            # Simulate transport loss while the confirmed mutation is still in flight.
            terminate_owned(current_http, force=True)
            current_http = None
            assert lost.result(timeout=12)["error"]["details"]["mayHaveRun"]
            assert invoke(host, "a", "independent")["result"]["structuredContent"]["server"] == "stdio"
            current_http = start_http()
            req("POST", "/v1/mcp/servers/b/reconnect", {})
            assert invoke(host, "b", "recovered")["result"]["structuredContent"]["server"] == "http"
            invoke(host, "b", "lost", method="change", mode="slow", confirmed=True, status=502, error="mcp_transport_error")
            assert count(http_log, "call", "lost") == 1
            print("PASS isolation during disconnect, explicit reconnect, and no replay of uncertain mutation", flush=True)

            req("POST", "/v1/mcp/servers/a/enabled", {"enabled": False})
            wait_for(lambda: not exists(stdio_pid))
            req("GET", "/v1/mcp/servers/a/tools", status=409, error="mcp_server_disabled")
            assert req("GET", "/v1/executors")["executors"]
            assert req("GET", "/v1/plugins")[0]["id"] == "studio.mcp-test"
            print("PASS stdio child cleanup on disable and preserved task/plugin services", flush=True)

        with BuiltHost(artifact, root) as host:
            req = host.request
            assert [item["state"] for item in req("GET", "/v1/mcp/servers")["servers"]] == ["disabled", "idle"]
            invoke(host, "b", "lost", method="change", mode="slow", confirmed=True, status=502, error="mcp_transport_error")
            assert count(http_log, "call", "lost") == 1
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(invoke, host, "b", "hard-restart", "change", "slow", True)
                wait_for(lambda: count(http_log, "call", "hard-restart"))
                terminate_owned(host.process, force=True)
                try:
                    pending.result(timeout=8)
                except (OSError, urllib.error.URLError):
                    pass
                else:
                    raise AssertionError("Pending request survived host termination")
        with BuiltHost(artifact, root) as host:
            req = host.request
            unknown = invoke(host, "b", "hard-restart", "change", "slow", True, status=409, error="mcp_outcome_unknown")
            assert unknown["error"]["details"]["mayHaveRun"]
            assert count(http_log, "call", "hard-restart") == 1
            req("DELETE", "/v1/mcp/servers/b")
            assert len(req("GET", "/v1/mcp/servers")["servers"]) == 1
            print("PASS registry and outcome persistence, including hard restart during a confirmed mutation", flush=True)
    finally:
        if current_http:
            terminate_owned(current_http)

    for row in samples + [tool_error]:
        row["result"]["structuredContent"].pop("pid", None)
    for row in statuses["servers"]:
        if "url" in row:
            row["url"] = "http://127.0.0.1:8001/mcp"
        if "command" in row:
            row["command"] = "<configured Python executable>"
    return {"catalogs": catalogs, "calls": samples, "toolError": tool_error,
            "errors": [protocol_error, denied, timed, unknown], "registry": statuses}


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("artifact", type=Path)
    cli.add_argument("--fixtures", type=Path)
    args = cli.parse_args()
    with tempfile.TemporaryDirectory(prefix="kei-mcp-test-") as temporary:
        fixtures = verify(args.artifact.resolve(), Path(temporary))
    if args.fixtures:
        args.fixtures.write_text(json.dumps(fixtures, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
