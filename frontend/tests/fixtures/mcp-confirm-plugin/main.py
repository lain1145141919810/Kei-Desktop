"""Test plugin (Round 08 decision 1): forwards one MCP call with an optional confirmation token.
Same shape as the maintained tests/backend_acceptance/verify_mcp.py plugin."""
from kei_sdk import MCPCallError


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
