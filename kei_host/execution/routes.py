"""Versioned task and explicit computer operation endpoints."""
import os
import re
import subprocess

from ..package import ApiError
from . import desktop_apps
from .tasks import text

TASK_ROUTE = re.compile(r"/v1/tasks/([0-9a-f]{32})(?:/(events|cancel|input))?")


def task_route(tasks, method, path, query, body, event_cursor):
    if method == "GET" and path == "/v1/executors":
        return 200, {"workspace": str(tasks.workspace), "executors": [
            adapter.describe(tasks.workspace) for adapter in tasks.adapters.values()
        ]}
    if path == "/v1/tasks":
        if method == "POST":
            return tasks.submit(body)
        if method == "GET":
            conversation = query.get("conversationId", [None])[0]
            if conversation is not None and not text(conversation, 100):
                raise ApiError(422, "invalid_task", "Invalid conversation ID")
            return 200, tasks.list(conversation)
    if match := TASK_ROUTE.fullmatch(path):
        ident, action = match.groups()
        if method == "GET":
            if action is None:
                return 200, tasks.get(ident)
            if action == "events":
                return 200, tasks.events(ident, event_cursor(query))
        if method == "POST":
            if action == "cancel":
                result = tasks.cancel(ident)
                return (202 if result["accepted"] else 200), result
            if action == "input":
                return 200, tasks.input(ident, body)
    if (method, path) in (("GET", "/v1/computer/apps"), ("POST", "/v1/computer/apps/open")):
        return 200, operate_computer(method, query, body)
    raise ApiError(404, "route_not_found", "Unknown host operation")


def operate_computer(method, query, body):
    if os.name != "nt":
        raise ApiError(409, "unsupported_platform", "Computer app catalog requires Windows")
    if method == "GET":
        app = query.get("query", [""])[0]
        if len(app) > 200:
            raise ApiError(422, "invalid_app_request", "App query is too long")
        action = "list"
    else:
        app = body.get("id")
        if body.get("confirmed") is not True:
            raise ApiError(403, "confirmation_required", "Opening an app requires the user's confirmation")
        if not isinstance(app, str) or not re.fullmatch(r"[0-9a-f]{16}", app):
            raise ApiError(422, "invalid_app_request", "Select a registered app ID")
        action = "open"
    try:
        result = desktop_apps.operate(action, app)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        raise ApiError(503, "app_catalog_unavailable", "Windows app operation is unavailable") from error
    if result["status"] in {"rejected", "needs_exact_app"}:
        raise ApiError(404, "app_not_found", "App ID is no longer present in the registered catalog")
    return result
