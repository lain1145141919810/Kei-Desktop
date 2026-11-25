"""MCP registry, call receipts, scoped clients, and connection ownership."""
import asyncio
import hashlib
import json
import logging
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass

from ..host import write_json
from ..package import ApiError, identifier
from .config import server_id, tool_name, validate
from .connection import Connection, MCPFailure, SDK_VERSION, public_error, sdk_available


def canonical(value):
    return json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":"))


def call_body(body):
    request_id = body.get("requestId")
    name = body.get("toolName")
    arguments = body.get("arguments", {})
    if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 100:
        raise ApiError(422, "invalid_mcp_call", "Provide a stable requestId")
    if not tool_name(name) or not isinstance(arguments, dict):
        raise ApiError(422, "invalid_mcp_call", "Provide a toolName and arguments object")
    return request_id, name, arguments


@dataclass
class Active:
    server: str
    generation: str
    task: asyncio.Task
    dispatched: bool = False


class MCPService:
    def __init__(self, root):
        # Keep server/provider diagnostics in the sanitized API envelope.
        logger = logging.getLogger("mcp")
        logger.addHandler(logging.NullHandler())
        logger.propagate = False
        self.path = root / "mcp-servers.json"
        raw = json.loads(self.path.read_text("utf-8")) if self.path.exists() else {}
        if not isinstance(raw, dict) or not all(map(server_id, raw)):
            raise ValueError("Invalid saved MCP registry")
        self.configs = {key: validate(value) for key, value in raw.items()}
        self.connections = {}
        self.active = {}
        self.confirmations = {}
        self.revoked = set()
        self.db = sqlite3.connect(root / "mcp-calls.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS calls (
                owner TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
                state TEXT NOT NULL, response TEXT, PRIMARY KEY (owner, request_id)
            );
        """)
        with self.db:
            self.db.execute("UPDATE calls SET state='unknown' WHERE state='pending'")
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="kei-mcp", daemon=True)
        self.thread.start()

    def sync(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result()

    def close(self):
        self.sync(self.shutdown())
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join()
        self.loop.close()
        self.db.close()

    async def shutdown(self):
        calls = [item.task for item in self.active.values()]
        for task in calls:
            task.cancel()
        if calls:
            await asyncio.gather(*calls, return_exceptions=True)
        await asyncio.gather(*(connection.close() for connection in self.connections.values()))

    def config(self, ident):
        if ident not in self.configs:
            raise ApiError(404, "mcp_server_not_found", "MCP server is not configured")
        return self.configs[ident]

    def public(self, ident):
        config = self.config(ident)
        connection = self.connections.get(ident)
        # Command arguments are operator input and are excluded from diagnostics.
        safe = {key: value for key, value in config.items() if key not in {"args"}}
        return {
            "id": ident, **safe, "state": "disabled" if not config["enabled"] else
            connection.state if connection else "idle",
            "diagnostics": connection.diagnostics if connection and config["enabled"] else {},
        }

    async def list_servers(self):
        return {
            "sdkVersion": SDK_VERSION, "sdkAvailable": sdk_available(),
            "servers": [self.public(ident) for ident in sorted(self.configs)],
        }

    async def stop_server(self, ident):
        self.confirmations = {key: row for key, row in self.confirmations.items() if row[2] != ident}
        connection = self.connections.pop(ident, None)
        active = [item.task for item in self.active.values() if item.server == ident]
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        if connection is not None:
            await connection.close()

    def save(self, configs):
        write_json(self.path, configs)
        self.configs = configs

    async def put(self, ident, value):
        config = validate(value)
        if self.configs.get(ident) != config:
            self.save({**self.configs, ident: config})
            await self.stop_server(ident)
        return self.public(ident)

    async def set_enabled(self, ident, enabled):
        config = self.config(ident)
        if type(enabled) is not bool:
            raise ApiError(422, "invalid_mcp_config", "enabled must be a boolean")
        return await self.put(ident, {**config, "enabled": enabled})

    async def delete(self, ident):
        self.config(ident)
        self.save({key: value for key, value in self.configs.items() if key != ident})
        await self.stop_server(ident)
        return {"id": ident, "removed": True}

    def connection(self, ident):
        config = self.config(ident)
        if not config["enabled"]:
            raise ApiError(409, "mcp_server_disabled", "MCP server is disabled")
        if ident not in self.connections:
            self.connections[ident] = Connection(config)
        return self.connections[ident]

    async def tools(self, ident, refresh=False):
        connection = self.connection(ident)
        inventory = await connection.list(refresh)
        return {
            "serverId": ident,
            "protocolVersion": connection.diagnostics["protocolVersion"],
            "tools": list(inventory.values()),
        }

    async def reconnect(self, ident):
        self.config(ident)
        await self.stop_server(ident)
        return await self.tools(ident, True)

    def allow(self, plugin, ident, name):
        if plugin and name not in self.config(ident)["pluginAccess"].get(plugin, []):
            raise ApiError(403, "mcp_scope_denied", "Plugin is not authorized for this server and tool")

    async def authorize(self, body):
        plugin, ident, name = body.get("pluginId"), body.get("serverId"), body.get("toolName")
        arguments = body.get("arguments", {})
        if not identifier(plugin) or not server_id(ident) or not tool_name(name) or not isinstance(arguments, dict):
            raise ApiError(422, "invalid_mcp_call", "Confirmation requires pluginId, serverId, toolName, and arguments")
        if body.get("confirmed") is not True:
            raise ApiError(403, "confirmation_required", "The user must confirm the MCP operation")
        self.allow(plugin, ident, name)
        now = time.monotonic()
        self.confirmations = {key: row for key, row in self.confirmations.items() if row[0] > now}
        if len(self.confirmations) >= 256:
            raise ApiError(429, "mcp_confirmation_limit", "Finish existing confirmations first")
        token = secrets.token_urlsafe(24)
        self.confirmations[token] = (now + 60, plugin, ident, name, canonical(arguments))
        return {"confirmation": token, "expiresInSeconds": 60}

    def check_confirmation(self, config, ident, name, arguments, plugin, body):
        if name in config["readOnlyTools"] and body.get("forceConfirmation") is not True:
            return
        if plugin:
            token = body.get("confirmation")
            row = self.confirmations.get(token) if isinstance(token, str) else None
            if row is not None and row[0] > time.monotonic() and row[1:] == (plugin, ident, name, canonical(arguments)):
                del self.confirmations[token]
                return
        elif body.get("confirmed") is True:
            return
        raise ApiError(403, "confirmation_required", "The user must confirm this MCP tool call")

    def receipt(self, key, digest):
        row = self.db.execute("SELECT digest,state,response FROM calls WHERE owner=? AND request_id=?", key).fetchone()
        if row is None:
            return None
        old_digest, state, response = row
        if old_digest != digest:
            raise ApiError(409, "request_conflict", "Request ID is already bound to different arguments")
        if state == "unknown":
            raise MCPFailure(409, "mcp_outcome_unknown", "Prior request may have run; it was not replayed", mayHaveRun=True)
        if state == "pending":
            raise ApiError(409, "mcp_call_in_progress", "Request is already in progress")
        result = json.loads(response)
        if state == "error":
            raise MCPFailure(result["status"], result["code"], result["message"], **result["details"])
        return result

    def complete(self, key, state, result):
        with self.db:
            self.db.execute("UPDATE calls SET state=?,response=? WHERE owner=? AND request_id=?",
                            (state, canonical(result), *key))

    async def cancel(self, request_id, owner="desktop"):
        item = self.active.get((owner, request_id))
        if item is None:
            return {"accepted": False}
        item.task.cancel()
        return {"accepted": True}

    async def release(self, generation, plugin=None):
        if plugin is not None:
            self.confirmations = {key: row for key, row in self.confirmations.items() if row[1] != plugin}
        self.revoked.add(generation)
        calls = [item.task for item in self.active.values() if item.generation == generation]
        for task in calls:
            task.cancel()
        # Running page handlers own the wait and consume the corresponding result.
        if calls:
            await asyncio.gather(*calls, return_exceptions=True)

    async def forget_generation(self, generation):
        self.revoked.discard(generation)

    async def call(self, ident, body, plugin=None, generation="desktop"):
        request_id, name, arguments = call_body(body)
        if generation in self.revoked:
            raise ApiError(410, "mcp_consumer_closed", "Plugin MCP access has ended")
        self.allow(plugin, ident, name)
        if len(self.active) >= 64:
            raise ApiError(429, "mcp_queue_full", "Too many ongoing MCP operations")
        owner = "plugin:" + plugin if plugin else "desktop"
        key = (owner, request_id)
        digest = hashlib.sha256(canonical([ident, name, arguments]).encode()).hexdigest()
        if previous := self.receipt(key, digest):
            return previous
        connection = self.connection(ident)
        # An in-memory reservation prevents concurrent discovery for the same receipt.
        if key in self.active:
            raise ApiError(409, "mcp_call_in_progress", "Request is already in progress")
        activity = Active(ident, generation, asyncio.current_task())
        self.active[key] = activity
        receipt_exists = False
        try:
            tools = await connection.list()
            if name not in tools:
                raise ApiError(404, "mcp_tool_not_found", "Tool is not in this server's catalog")
            self.check_confirmation(connection.config, ident, name, arguments, plugin, body)
            with self.db:
                self.db.execute("INSERT INTO calls VALUES(?,?,?,'pending',NULL)", (*key, digest))
            receipt_exists = True
            client = await connection.get()
            async with asyncio.timeout(connection.config["timeoutSeconds"]):
                activity.dispatched = True
                tool_result = await client.session.call_tool(name, arguments)
            result = {"serverId": ident, "toolName": name, "requestId": request_id,
                      "result": tool_result.model_dump(mode="json", by_alias=True, exclude_none=True)}
            if len(canonical(result)) > 2 * 1024 * 1024:
                raise MCPFailure(502, "mcp_result_too_large", "MCP tool result exceeds 2 MiB", mayHaveRun=True)
            self.complete(key, "success", result)
            return result
        except asyncio.CancelledError as error:
            failure = MCPFailure(409, "mcp_cancelled", "MCP request was cancelled", mayHaveRun=activity.dispatched)
            self.fail(key, failure, receipt_exists)
            raise failure from error
        except Exception as error:
            failure = public_error(error, dispatched=activity.dispatched)
            if failure.code == "mcp_transport_error":
                connection.invalidate(failure.code)
            self.fail(key, failure, receipt_exists)
            if failure is error:
                raise
            raise failure from error
        finally:
            del self.active[key]

    def fail(self, key, failure, receipt_exists):
        if receipt_exists:
            self.complete(key, "error", {"status": failure.status, "code": failure.code,
                                        "message": failure.message, "details": getattr(failure, "details", {})})
