"""Public author API for Kei plugin SDK v1."""
import json
from collections.abc import Callable
from typing import Any
from types import MappingProxyType

API_VERSION = 1
Handler = Callable[[dict[str, Any]], Any]


class MCPCallError(RuntimeError):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


class ChatAskError(MCPCallError):
    pass


class Context:
    """Kei supplies a fresh context to each plugin worker at initialization."""

    def __init__(self, data_dir, config=None):
        self.data_dir = data_dir
        self._handlers = {}
        self._events = []
        self.config = MappingProxyType(config or {})
        self._host_request = None
        self.conversation_id = None
        self.model_credential: str | None = None

    def register(self, action: str, handler: Handler) -> None:
        """Register a handler for an action declared in metadata.yaml."""
        if action in self._handlers or not callable(handler):
            raise ValueError("Action handler must be unique and callable")
        self._handlers[action] = handler

    def emit(self, topic: str, data: Any) -> None:
        """Publish an event to the current generation's page subscriptions."""
        if not isinstance(topic, str) or not 1 <= len(topic) <= 100:
            raise ValueError("Event topic must be a nonempty string of at most 100 characters")
        if len(self._events) >= 64:
            raise ValueError("Too many events in one operation")
        event = {"topic": topic, "data": data}
        if len(json.dumps(event, ensure_ascii=True, allow_nan=False)) > 8192:
            raise ValueError("Event exceeds 8 KiB")
        self._events.append(event)

    def call_mcp(self, server_id, tool_name, arguments, request_id, *, confirmation=None, require_confirmation=False):
        """Invoke an operator-authorized MCP tool during an action handler."""
        if self._host_request is None:
            raise MCPCallError("mcp_scope_denied", "MCP is unavailable outside a running action")
        return self._host_request("mcp", {
            "serverId": server_id, "toolName": tool_name, "arguments": arguments,
            "requestId": request_id, "confirmation": confirmation, "forceConfirmation": require_confirmation,
        })

    def ask_chat(self, request_id, question, *, selection=None, turn_id=None):
        """Submit a question to the trusted page's current conversation."""
        if self._host_request is None:
            raise ChatAskError("chat_scope_denied", "Chat is unavailable outside a running action")
        return self._host_request("chat", {"requestId": request_id, "question": question,
                                           "selection": selection, "turnId": turn_id})


    def describe_capture(self, image):
        """Describe one explicitly authorized desktop frame without preserving the image."""
        if self._host_request is None:
            raise ChatAskError("vision_scope_denied", "Vision is unavailable outside an action")
        return self._host_request("vision", {"image": image})

    def read_attachment(self, attachment_id):
        """Read a bounded prefix of an authorized attachment in the current conversation."""
        if self._host_request is None:
            raise ChatAskError("attachment_scope_denied", "Attachments are unavailable outside an action")
        return self._host_request("attachment", {"id": attachment_id})
