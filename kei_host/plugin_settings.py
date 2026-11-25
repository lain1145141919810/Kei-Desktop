"""Validate the public plugin configuration schema and values."""
import copy
import json
import math
import re

FIELD_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,99}")
DEFAULTS = {
    "string": "", "text": "", "int": 0, "float": 0.0, "bool": False,
    "list": [], "dict": {}, "object": {}, "credential_ref": None,
}


class ConfigError(ValueError):
    pass


def within_type(kind, value):
    if kind == "float":
        return type(value) is int or type(value) is float and math.isfinite(value)
    if kind == "credential_ref":
        return value is None or isinstance(value, str) and bool(ENV_NAME.fullmatch(value))
    return type(value) is type(DEFAULTS[kind])


def field_value(key, field, value):
    if not within_type(field["type"], value):
        raise ConfigError(f"Invalid type for {key}")
    if "options" in field and value not in field["options"]:
        raise ConfigError(f"Select an allowed option for {key}")
    if "minimum" in field and value < field["minimum"] or "maximum" in field and value > field["maximum"]:
        raise ConfigError(f"Value is outside the configured range for {key}")
    return value


def schema_at(root):
    path = root / "_conf_schema.json"
    if not path.is_file():
        return {}
    with path.open("rb") as stream:
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ConfigError("_conf_schema.json exceeds 64 KiB")
    try:
        schema = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise ConfigError("Invalid plugin configuration schema JSON") from error
    if not isinstance(schema, dict) or len(schema) > 64:
        raise ConfigError("The configuration schema must contain up to 64 fields")
    result = {}
    for key, field in schema.items():
        if not FIELD_NAME.fullmatch(key) or not isinstance(field, dict):
            raise ConfigError("Invalid configuration field")
        kind = field.get("type")
        if not isinstance(kind, str) or kind not in DEFAULTS:
            raise ConfigError(f"Unsupported configuration type for {key}")
        if set(field) - {"type", "description", "hint", "default", "options", "minimum", "maximum"}:
            raise ConfigError(f"Unknown configuration schema field for {key}")
        for label in ("description", "hint"):
            if label in field and (not isinstance(field[label], str) or len(field[label]) > 250):
                raise ConfigError(f"Invalid field text for {key}")
        if "options" in field:
            options = field["options"]
            if not isinstance(options, list) or not 1 <= len(options) <= 64 or not all(
                within_type(kind, value) for value in options
            ):
                raise ConfigError(f"Invalid options for {key}")
        for bound in ("minimum", "maximum"):
            if bound in field and (kind not in ("int", "float") or not within_type(kind, field[bound])):
                raise ConfigError(f"Invalid numeric bound for {key}")
        if "minimum" in field and "maximum" in field and field["minimum"] > field["maximum"]:
            raise ConfigError(f"Minimum exceeds maximum for {key}")
        default = field.get("default", copy.deepcopy(DEFAULTS[kind]))
        result[key] = {**field, "default": field_value(key, field, default)}
    try:
        json.dumps(result, allow_nan=False)
    except (ValueError, RecursionError) as error:
        raise ConfigError("Defaults must be finite JSON values") from error
    return result


def normalized(schema, values):
    if not isinstance(values, dict) or set(values) - set(schema):
        raise ConfigError("Configuration includes an unknown field")
    result = {key: field_value(key, field, values.get(key, copy.deepcopy(field["default"])))
              for key, field in schema.items()}
    try:
        if len(json.dumps(result, allow_nan=False)) > 65536:
            raise ConfigError("Configuration exceeds 64 KiB")
    except (ValueError, RecursionError) as error:
        if isinstance(error, ConfigError):
            raise
        raise ConfigError("Configuration must be finite JSON values") from error
    return result
