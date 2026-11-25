"""Portable MCP tool fixture with pagination and auditable call counts."""
import argparse
import asyncio
import os
from pathlib import Path

from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.shared.exceptions import MCPError


def fixture(label, journal):
    def log(kind, key):
        with journal.open("a", encoding="utf-8") as output:
            output.write(f"{kind} {key}\n")

    async def list_tools(_context, params):
        log("list", params.cursor if params and params.cursor else "first")
        if params and params.cursor == "second":
            return types.ListToolsResult(tools=[
                types.Tool(name="change", description="Fixture mutation", input_schema={"type": "object"}),
            ])
        return types.ListToolsResult(tools=[
            types.Tool(name="echo", description="Echo from " + label, input_schema={"type": "object"}),
        ], next_cursor="second")

    async def call_tool(_context, params):
        arguments = params.arguments or {}
        key = arguments.get("key", "echo")
        mode = arguments.get("mode")
        log("call", key)
        try:
            if mode == "slow":
                await asyncio.sleep(25)
            if mode == "disconnect":
                os._exit(11)
            if mode == "protocol":
                raise MCPError(-32602, "Fixture protocol error")
        except asyncio.CancelledError:
            log("cancel", key)
            raise
        secret = os.environ.get("FIXTURE_STDIO_TOKEN")
        return types.CallToolResult(
            is_error=mode == "tool-error", content=[types.TextContent(type="text", text=label)],
            structured_content={"server": label, "pid": os.getpid(), "credentialPresent": bool(secret)},
        )

    return Server(name=label, version="1.0.0", on_list_tools=list_tools, on_call_tool=call_tool)


async def stdio(server):
    async with stdio_server() as (receive, send):
        await server.run(receive, send, server.create_initialization_options())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("transport", choices=("stdio", "http"))
    parser.add_argument("journal", type=Path)
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    server = fixture(args.transport, args.journal)
    if args.transport == "stdio":
        asyncio.run(stdio(server))
        return
    import uvicorn
    from starlette.responses import Response

    app = server.streamable_http_app(json_response=True)
    expected = os.environ["KEI_FIXTURE_TOKEN"].encode("ascii")

    async def authenticated(scope, receive, send):
        if scope["type"] == "http":
            if dict(scope["headers"]).get(b"authorization") != b"Bearer " + expected:
                await Response(status_code=401)(scope, receive, send)
                return
        await app(scope, receive, send)

    uvicorn.run(authenticated, host="127.0.0.1", port=args.port, log_level="critical",
                timeout_graceful_shutdown=2)


if __name__ == "__main__":
    main()
