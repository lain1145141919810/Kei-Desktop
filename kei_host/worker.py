"""One process per enabled plugin, with a private stdin/stdout protocol."""
import contextlib
import importlib.util
import json
import sys
from pathlib import Path

from kei_sdk import ChatAskError, Context, MCPCallError

MAX_LINE = 2 * 1024 * 1024 + 65536


def run():
    module = None
    context = None
    root = Path(sys.argv[1])
    private_data = Path(sys.argv[2])
    wire = sys.stdout
    sys.path.insert(0, str(root))
    def host_request(kind, parameters):
        error_type = ChatAskError if kind != "mcp" else MCPCallError
        request = json.dumps({"broker": kind, "parameters": parameters}, ensure_ascii=True, allow_nan=False)
        if len(request) > (800000 if kind == "vision" else 65536):
            raise error_type("request_too_large", "Broker request exceeds its size limit")
        wire.write(request + "\n")
        wire.flush()
        reply = json.loads(sys.stdin.buffer.readline(MAX_LINE))
        if reply.get("ok") is True:
            return reply["data"]
        error = reply["error"]
        raise error_type(error["code"], error["message"], error.get("details"))

    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
            method = request["method"]
            with contextlib.redirect_stdout(sys.stderr):
                if method == "activate":
                    spec = importlib.util.spec_from_file_location("kei_plugin_main", root / "main.py")
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[spec.name] = module
                    spec.loader.exec_module(module)
                    context = Context(private_data, request.get("config"))
                    module.initialize(context)
                    result = sorted(context._handlers)
                elif method == "call":
                    context._events.clear()
                    context._host_request = host_request
                    context.conversation_id = request.get("conversationId")
                    try:
                        result = context._handlers[request["action"]](request["arguments"])
                    finally:
                        context._host_request = None
                        context.conversation_id = None
                elif method == "provide_model":
                    context._events.clear()
                    context.model_credential = request.get("credential")
                    try:
                        result = context._handlers[request["action"]](request["arguments"])
                    finally:
                        context.model_credential = None
                elif method == "shutdown":
                    terminate = getattr(module, "terminate", None)
                    if terminate:
                        terminate(context)
                    return
                else:
                    raise ValueError("Unknown worker method")
            response = json.dumps(
                {"ok": True, "data": result, "events": context._events},
                ensure_ascii=True, allow_nan=False, separators=(",", ":"),
            )
            if len(response) > MAX_LINE:
                raise ValueError("Plugin response is too large")
        except Exception as error:
            response = json.dumps({"ok": False, "error": type(error).__name__})
        wire.write(response + "\n")
        wire.flush()
