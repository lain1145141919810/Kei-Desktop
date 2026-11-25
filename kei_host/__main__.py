"""Serve the versioned local API for the Electron main process or a test client."""
import argparse
import hmac
import json
import os
import re
import secrets
import socket
import threading
from contextlib import ExitStack, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import API_VERSION
from .chat import Chat, chat_route
from .attachments import Attachments
from .execution.routes import task_route
from .execution.tasks import TaskService
from .host import Host, write_json
from .mcp_client.routes import mcp_route
from .mcp_client.service import MCPService
from .model_providers import ModelProviders
from .package import FEATURES, MAX_ARCHIVE, ApiError
from .personas import PersonaService, persona_route

MAX_JSON = 65536
MAX_PAGE_JSON = 2 * 1024 * 1024
PLUGIN_ROUTE = re.compile(r"/v1/plugins/([a-z0-9_.-]+)(?:/(enable|disable|reload|config|upgrade))?")


def invalid_request(message):
    raise ApiError(422, "invalid_request", message)


def reject_constant(_constant):
    invalid_request("Non-finite numbers are not supported")


class LocalApiServer(ThreadingHTTPServer):
    def __init__(self, address, handler, *, request_limit=64):
        self.request_slots = threading.BoundedSemaphore(request_limit)
        super().__init__(address, handler)

    def process_request(self, request, address):
        if not self.request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.request_slots.release()


class ApiHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def log_message(self, format, *args):
        return

    def reply(self, status, **body):
        data = json.dumps({"apiVersion": API_VERSION, **body}, ensure_ascii=True, allow_nan=False).encode("ascii")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self, limit, media):
        if self.headers.get("Transfer-Encoding") is not None:
            raise ApiError(400, "invalid_body", "Transfer-Encoding is not supported")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            invalid_request("Invalid Content-Length")
        if length < 0:
            invalid_request("Invalid Content-Length")
        if length > limit:
            raise ApiError(413, "body_too_large", "Request exceeds the allowed size")
        if length and self.headers.get_content_type() != media:
            raise ApiError(415, "invalid_content_type", f"Expected {media}")
        data = self.rfile.read(length)
        if len(data) != length:
            invalid_request("Incomplete body")
        return data

    def read_json(self, limit=MAX_JSON):
        data = self.read_body(limit, "application/json")
        try:
            parsed = json.loads(data, parse_constant=reject_constant) if data else {}
            json.dumps(parsed, allow_nan=False)
        except (ValueError, UnicodeError, RecursionError):
            invalid_request("Body must be a JSON object")
        if not isinstance(parsed, dict):
            invalid_request("Body must be a JSON object")
        return parsed

    def authenticate(self):
        token = self.headers.get("Authorization", "").encode("utf-8")
        if self.headers.get("Origin") or not hmac.compare_digest(token, self.server.authorization):
            raise ApiError(401, "unauthorized", "Use an authenticated local client")

    def dispatch(self):
        try:
            self.authenticate()
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query, max_num_fields=4)
            method, path = self.command, parsed.path
            body = None
            upgrade = PLUGIN_ROUTE.fullmatch(path)
            if method == "POST" and (path == "/v1/plugins/install" or (upgrade and upgrade.group(2) == "upgrade")):
                body = self.read_body(MAX_ARCHIVE, "application/zip")
            elif method in ("POST", "DELETE", "PUT"):
                body = self.read_json(MAX_PAGE_JSON if path == "/v1/pages/call" or path.startswith("/v1/models/invoke/") else MAX_JSON)
            if path == "/v1/executors" or path.startswith(("/v1/tasks", "/v1/computer/")):
                status, data = task_route(self.server.tasks, method, path, query, body, event_cursor)
            elif method == "POST" and path == "/v1/attachments":
                status, data = 201, self.server.attachments.register(body)
            elif path == "/v1/personas" or path.startswith("/v1/personas/"):
                status, data = persona_route(self.server.personas, method, path, body)
            elif path.startswith("/v1/chat/"):
                status, data = chat_route(self.server.chat, method, path, query, body)
            elif path.startswith("/v1/mcp/"):
                status, data = mcp_route(self.server.mcp, method, path, body)
            elif path == "/v1/models" and method == "GET":
                status, data = 200, self.server.models.status()
            elif path.startswith("/v1/models/selection/") and method == "PUT":
                status, data = 200, self.server.models.set(path.removeprefix("/v1/models/selection/"), body)
            elif path.startswith("/v1/models/invoke/") and method == "POST":
                status, data = 200, self.server.models.invoke(path.removeprefix("/v1/models/invoke/"), body)
            elif method == "POST" and path == "/v1/pages/call":
                status, data = self.route(method, path, query, body)
            else:
                with self.server.host.guard:
                    status, data = self.route(method, path, query, body)
            self.reply(status, data=data)
        except ApiError as error:
            failure = {"code": error.code, "message": error.message}
            if getattr(error, "details", None):
                failure["details"] = error.details
            self.reply(error.status, error=failure)
        except (ValueError, RecursionError):
            self.reply(422, error={"code": "invalid_request", "message": "Invalid URL or JSON payload"})
        except socket.timeout:
            self.reply(408, error={"code": "request_timeout", "message": "Request timed out"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self.reply(500, error={"code": "storage_error", "message": "Host could not complete the operation"})

    def route(self, method, path, query, body):
        host = self.server.host
        if method == "GET":
            if path == "/v1/status":
                return 200, {"state": "ready", "epoch": host.epoch, "installed": len(host.manifests), "pluginFeatures": list(FEATURES)}
            if path == "/v1/plugins":
                return 200, [host.info(key) for key in sorted(host.manifests)]
            if path == "/v1/entries":
                return 200, host.entries()
            if path == "/v1/events":
                return 200, host.read_events(event_cursor(query))
            if path == "/v1/pages/events":
                session_id = query.get("sessionId", [""])[0]
                session = host.session(session_id)
                after = max(event_cursor(query), session["openedCursor"])
                return 200, host.read_events(after, session["pluginId"])
        if method == "POST":
            if path == "/v1/plugins/install":
                return 201, host.install(body)
            if path == "/v1/pages/open":
                return 201, host.open_page(body.get("pluginId"), body.get("entryId"))
            if path == "/v1/pages/call":
                return 200, host.call_page(body.get("sessionId"), body.get("action"), body.get("arguments", {}), body.get("context"))
            if path == "/v1/pages/capture/cancel":
                return 200, host.cancel_capture(body.get("sessionId"))
            if path == "/v1/pages/close":
                return 200, host.close_page(body.get("sessionId"))
        if match := PLUGIN_ROUTE.fullmatch(path):
            plugin_id, action = match.groups()
            if method == "GET" and action is None:
                return 200, host.detail(plugin_id)
            if method == "PUT" and action == "config":
                return 200, host.configure(plugin_id, body.get("values"))
            if method == "POST" and action == "upgrade":
                return 200, host.upgrade(plugin_id, body)
            if method == "POST" and action == "enable":
                return 200, host.enable(plugin_id, body.get("grants", []))
            if method == "POST" and action == "disable":
                return 200, host.disable(plugin_id)
            if method == "POST" and action == "reload":
                return 200, host.reload(plugin_id)
            if method == "DELETE" and action is None:
                return 200, host.uninstall(plugin_id, body.get("retainData", True))
        raise ApiError(404, "route_not_found", "Unknown host operation")

    do_GET = do_POST = do_DELETE = do_PUT = dispatch


def event_cursor(query):
    try:
        after = int(query.get("after", ["0"])[0])
    except ValueError:
        invalid_request("after must be a non-negative integer")
    if after < 0:
        invalid_request("after must be a non-negative integer")
    return after


@contextmanager
def data_lock(root):
    with (root / ".host.lock").open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise SystemExit("Kei data directory is already in use") from error
        yield


def default_data():
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "KeiDesktop"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "kei-desktop"


def main():
    parser = argparse.ArgumentParser(description="Kei plugin host")
    parser.add_argument("--data-dir", type=Path, default=default_data())
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--chat-config", type=Path, help="Operator chat provider JSON")
    parser.add_argument("--executor-dir", type=Path, help="Trusted directory with external executor manifests")
    parser.add_argument("--executor-config", type=Path, help="Operator JSON for built-in executors")
    args = parser.parse_args()
    root = args.data_dir.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = root / "connection.json"
    with data_lock(root), ExitStack() as cleanup:
        descriptor.unlink(missing_ok=True)
        config_path = args.executor_config or root / "executors.json"
        config = json.loads(config_path.read_text("utf-8-sig")) if config_path.exists() else {}
        if not isinstance(config, dict):
            parser.error("Executor config must contain a JSON object")
        tasks = TaskService(root, args.executor_dir, config)
        cleanup.callback(tasks.close)
        mcp = MCPService(root)
        cleanup.callback(mcp.close)
        chat = Chat(root, args.chat_config or root / "chat.json")
        cleanup.callback(chat.close)
        attachments = Attachments(root, tasks.workspace)
        cleanup.callback(attachments.close)
        host = Host(root, mcp, chat, attachments)
        chat.host = host
        personas = PersonaService(root, host=host, chat=chat)
        chat.motion_catalog = host.motion_catalog
        chat.persona_context = personas.effective_context
        token = secrets.token_urlsafe(32)
        try:
            with LocalApiServer(("127.0.0.1", args.port), ApiHandler) as server:
                server.host = host
                server.tasks = tasks
                server.mcp = mcp
                server.chat = chat
                server.attachments = attachments
                server.personas = personas
                server.models = ModelProviders(host)
                server.authorization = b"Bearer " + token.encode("ascii")
                port = server.server_address[1]
                write_json(descriptor, {"apiVersion": API_VERSION, "url": f"http://127.0.0.1:{port}", "token": token})
                print(f"Kei plugin host API {API_VERSION} ready on 127.0.0.1:{port}", flush=True)
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    pass
        finally:
            descriptor.unlink(missing_ok=True)
            with host.guard:
                host.close()


if __name__ == "__main__":
    main()
