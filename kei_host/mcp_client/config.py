"""Validate operator-owned MCP configuration and credential references."""
import ipaddress
import re
from urllib.parse import urlsplit

from ..package import identifier, ApiError

ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")
TOOL_NAME = re.compile(r"[A-Za-z0-9_.-]{1,128}")
SAFE_ID = re.compile(r"[a-z][a-z0-9_-]{0,59}")


def invalid(message):
    raise ApiError(422, "invalid_mcp_config", message)


def tool_name(value):
    return isinstance(value, str) and TOOL_NAME.fullmatch(value)


def server_id(value):
    return isinstance(value, str) and SAFE_ID.fullmatch(value)


def env_name(value):
    return isinstance(value, str) and ENV_KEY.fullmatch(value)


def tool_names(values):
    if not isinstance(values, list) or len(values) > 100 or not all(map(tool_name, values)):
        invalid("Use a list of up to 100 tool names")
    return list(dict.fromkeys(values))


def local_host(name):
    if name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def validate(config):
    if not isinstance(config, dict):
        invalid("Server config must be an object")
    transport = config.get("transport")
    if transport not in ("stdio", "streamable-http"):
        invalid("Use stdio or streamable-http")
    name, enabled = config.get("name"), config.get("enabled", True)
    timeout = config.get("timeoutSeconds", 15)
    if not isinstance(name, str) or not name.strip() or len(name) > 80 or type(enabled) is not bool:
        invalid("Server name and enabled state are required")
    if type(timeout) is not int or not 1 <= timeout <= 60:
        invalid("timeoutSeconds must be an integer from 1 to 60")
    mode = config.get("protocolMode", "auto")
    if mode not in ("auto", "legacy"):
        invalid("protocolMode must be auto or legacy")
    credential = config.get("credentialRef")
    if credential is not None:
        if not isinstance(credential, dict) or not env_name(credential.get("env")):
            invalid("credentialRef.env must name an environment variable")
        if transport == "stdio":
            if set(credential) != {"env", "target"} or not env_name(credential.get("target")):
                invalid("A stdio credential reference needs env and target variable names")
        elif set(credential) != {"env"}:
            invalid("HTTP credentials use a Bearer token environment variable")
    rights = config.get("pluginAccess", {})
    if not isinstance(rights, dict) or len(rights) > 100 or not all(map(identifier, rights)):
        invalid("pluginAccess maps plugin IDs to tool names")
    result = {
        "name": name, "transport": transport, "enabled": enabled, "timeoutSeconds": timeout,
        "protocolMode": mode, "credentialRef": credential, "readOnlyTools": tool_names(config.get("readOnlyTools", [])),
        "pluginAccess": {key: tool_names(value) for key, value in rights.items()},
    }
    if transport == "stdio":
        command, args, cwd = config.get("command"), config.get("args", []), config.get("cwd")
        if not isinstance(command, str) or not command.strip() or len(command) > 1000:
            invalid("Stdio requires a configured executable")
        if not isinstance(args, list) or len(args) > 40 or not all(isinstance(item, str) and len(item) <= 2000 for item in args):
            invalid("Stdio arguments must be a string array")
        if cwd is not None and (not isinstance(cwd, str) or len(cwd) > 1000):
            invalid("Stdio cwd must be a path string")
        result.update(command=command, args=args, cwd=cwd)
    else:
        url = config.get("url")
        if not isinstance(url, str) or len(url) > 2000:
            invalid("HTTP requires an endpoint URL")
        try:
            address = urlsplit(url)
            if (address.scheme not in ("http", "https") or not address.hostname
                or address.username or address.password or address.query or address.fragment):
                invalid("Specify an HTTP endpoint without credentials, query strings or fragments")
            if credential and address.scheme == "http" and not local_host(address.hostname):
                invalid("Bearer credential references require HTTPS or loopback HTTP")
        except ValueError:
            invalid("Invalid MCP endpoint URL")
        result.update(url=url)
    return result
