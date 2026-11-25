"""Long-lived, independently managed official MCP SDK connections."""
import asyncio
import contextlib
import importlib.metadata
import os
from pathlib import Path
import shutil

from ..package import ApiError

SDK_VERSION = "2.2.0"


def sdk_available():
    try:
        return importlib.metadata.version("mcp") == SDK_VERSION
    except importlib.metadata.PackageNotFoundError:
        return False


class MCPFailure(ApiError):
    def __init__(self, status, code, message, **details):
        super().__init__(status, code, message)
        self.details = details


def public_error(error, *, dispatched=False):
    if isinstance(error, ApiError):
        return error
    if isinstance(error, BaseExceptionGroup):
        leaves = [public_error(item, dispatched=dispatched) for item in error.exceptions]
        return next((item for item in leaves if item.code == "mcp_transport_error"), leaves[0])
    if isinstance(error, TimeoutError):
        return MCPFailure(504, "mcp_timeout", "MCP deadline expired", mayHaveRun=dispatched)
    if error.__class__.__name__ in {"McpError", "MCPError"}:
        from mcp.types import CONNECTION_CLOSED, REQUEST_TIMEOUT

        data = getattr(error, "error", None)
        code = getattr(error, "code", None) or getattr(data, "code", None)
        if code == REQUEST_TIMEOUT:
            return MCPFailure(504, "mcp_timeout", "MCP deadline expired", mayHaveRun=dispatched)
        if code == CONNECTION_CLOSED or getattr(error, "message", None) == "Session terminated":
            return MCPFailure(502, "mcp_transport_error", "MCP session is unavailable", mayHaveRun=dispatched)
        return MCPFailure(502, "mcp_protocol_error", "MCP server reported a protocol error",
                          protocolCode=code if isinstance(code, int) else None, mayHaveRun=dispatched)
    if isinstance(error, (ValueError, TypeError, KeyError)):
        return MCPFailure(502, "mcp_protocol_error", "MCP response does not match its schema", mayHaveRun=dispatched)
    return MCPFailure(502, "mcp_transport_error", "MCP connection failed", mayHaveRun=dispatched)


class Connection:
    def __init__(self, config):
        self.config = config
        self.runner = None
        self.client = None
        self.state = "idle"
        self.diagnostics = {}
        self.tools = None
        self.lock = asyncio.Lock()
        self.list_lock = asyncio.Lock()

    async def get(self):
        async with self.lock:
            if self.runner is not None and self.stop.is_set():
                await self.runner
                self.runner = None
            if self.runner is None or self.runner.done():
                self.stop = asyncio.Event()
                self.ready = asyncio.get_running_loop().create_future()
                self.runner = asyncio.create_task(self.run())
            ready = self.ready
        try:
            await asyncio.shield(ready)
        except asyncio.CancelledError as error:
            if ready.cancelled() and not asyncio.current_task().cancelling():
                raise MCPFailure(409, "mcp_connection_closed", "MCP connection was closed") from error
            raise
        if self.client is None:
            raise MCPFailure(502, "mcp_transport_error", "MCP session closed")
        return self.client

    async def close(self):
        if self.runner is not None:
            self.stop.set()
            if self.state == "connecting":
                self.runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.runner
            self.runner = None
        self.client, self.tools = None, None
        self.state = "idle"

    def invalidate(self, reason):
        if self.runner is not None:
            self.stop.set()
        self.tools = None
        self.state = "offline"
        self.diagnostics["lastError"] = reason

    async def run(self):
        self.state = "connecting"
        self.diagnostics = {}
        try:
            if not sdk_available():
                raise MCPFailure(503, "mcp_sdk_unavailable", f"Install the pinned MCP SDK {SDK_VERSION}")
            async with contextlib.AsyncExitStack() as stack:
                await self.connect(stack)
                await self.stop.wait()
        except asyncio.CancelledError:
            if not self.ready.done():
                self.ready.cancel()
            raise
        except Exception as error:
            failure = public_error(error)
            self.diagnostics = {"lastError": failure.code}
            self.state = "offline"
            if not self.ready.done():
                self.ready.set_exception(failure)
        finally:
            self.client = None
            self.tools = None
            if self.state in {"ready", "connecting"}:
                self.state = "idle"

    async def connect(self, stack):
        from mcp import Client, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.client.streamable_http import streamable_http_client

        config = self.config
        credential = config["credentialRef"]
        secret = os.environ.get(credential["env"]) if credential else None
        if credential and not secret:
            raise MCPFailure(503, "mcp_credential_unavailable", "The credential reference is not set")
        if config["transport"] == "stdio":
            command = config["command"]
            program = shutil.which(command)
            if not program and Path(command).is_file():
                program = command
            if not program:
                raise MCPFailure(503, "mcp_executable_unavailable", "The stdio executable is unavailable")
            env = {credential["target"]: secret} if credential else None
            stream = stdio_client(
                StdioServerParameters(command=program, args=config["args"], cwd=config["cwd"], env=env),
                errlog=stack.enter_context(open(os.devnull, "w", encoding="utf-8")),
            )
        else:
            import httpx2

            headers = {"Authorization": "Bearer " + secret} if secret else {}
            http = await stack.enter_async_context(
                httpx2.AsyncClient(headers=headers, timeout=config["timeoutSeconds"], follow_redirects=False, trust_env=False),
            )
            stream = streamable_http_client(config["url"], http_client=http)
        timeout = config["timeoutSeconds"]
        # A watchdog cancels this owner task during SDK entry. Its cancel scopes
        # must enter and exit in the same task and remain nested across requests.
        actor = asyncio.current_task()
        deadline = asyncio.get_running_loop().call_later(timeout, actor.cancel)
        try:
            client = await stack.enter_async_context(Client(
                stream, cache=None, mode=config["protocolMode"], message_handler=self.notification,
            ))
        except asyncio.CancelledError as error:
            if not self.stop.is_set():
                raise MCPFailure(504, "mcp_timeout", "MCP connection deadline expired") from error
            raise
        finally:
            deadline.cancel()
        caps = client.server_capabilities
        self.client = client
        self.state = "ready"
        self.diagnostics = {
            "protocolVersion": client.protocol_version,
            "capabilities": caps.model_dump(mode="json", by_alias=True, exclude_none=True),
        }
        if client.server_info:
            self.diagnostics["serverInfo"] = client.server_info.model_dump(mode="json", by_alias=True, exclude_none=True)
        self.ready.set_result(None)

    async def notification(self, message):
        root = getattr(message, "root", message)
        if getattr(root, "method", None) == "notifications/tools/list_changed":
            self.tools = None

    async def list(self, refresh=False):
        async with self.list_lock:
            client = await self.get()
            if self.tools is not None and not refresh:
                return self.tools
            if client.server_capabilities.tools is None:
                raise MCPFailure(409, "mcp_tools_unsupported", "The server does not advertise tools")
            methods = {}
            cursor = None
            cursors = set()
            try:
                async with asyncio.timeout(self.config["timeoutSeconds"]):
                    for _page in range(50):
                        response = await client.list_tools(cursor=cursor)
                        for tool in response.tools:
                            if tool.name in methods or len(methods) >= 1000:
                                raise MCPFailure(502, "mcp_protocol_error", "Invalid MCP tool listing")
                            methods[tool.name] = tool.model_dump(mode="json", by_alias=True, exclude_none=True)
                        cursor = response.next_cursor
                        if cursor is None:
                            self.tools = methods
                            return methods
                        if cursor in cursors:
                            break
                        cursors.add(cursor)
            except Exception as error:
                failure = public_error(error)
                if failure.code in {"mcp_transport_error", "mcp_timeout"}:
                    self.invalidate(failure.code)
                if failure is error:
                    raise
                raise failure from error
            raise MCPFailure(502, "mcp_protocol_error", "Invalid MCP tools cursor")
