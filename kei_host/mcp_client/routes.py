"""Authenticated operator and core MCP endpoints."""
import re

from ..package import ApiError

SERVER_ROUTE = re.compile(r"/v1/mcp/servers/([a-z][a-z0-9_-]{0,59})(?:/(enabled|tools|refresh|reconnect|call))?")


def mcp_route(service, method, path, body):
    if path == "/v1/mcp/servers" and method == "GET":
        return 200, service.sync(service.list_servers())
    if path == "/v1/mcp/confirm" and method == "POST":
        return 200, service.sync(service.authorize(body))
    if path == "/v1/mcp/cancel" and method == "POST":
        request_id = body.get("requestId")
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 100:
            raise ApiError(422, "invalid_mcp_call", "Provide a stable requestId")
        return 200, service.sync(service.cancel(request_id))
    if match := SERVER_ROUTE.fullmatch(path):
        ident, action = match.groups()
        if action is None and method == "PUT":
            return 200, service.sync(service.put(ident, body))
        if action is None and method == "DELETE":
            return 200, service.sync(service.delete(ident))
        if action == "tools" and method == "GET":
            return 200, service.sync(service.tools(ident))
        if method == "POST":
            if action == "enabled":
                return 200, service.sync(service.set_enabled(ident, body.get("enabled")))
            if action == "refresh":
                return 200, service.sync(service.tools(ident, True))
            if action == "reconnect":
                return 200, service.sync(service.reconnect(ident))
            if action == "call":
                return 200, service.sync(service.call(ident, body))
    raise ApiError(404, "route_not_found", "Unknown MCP operation")
