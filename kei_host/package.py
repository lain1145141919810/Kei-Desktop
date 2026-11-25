"""Read the public v1 package format and safely stage plugin archives."""
import io
import re
import stat
import zipfile
from pathlib import PurePosixPath

import yaml

from . import API_VERSION
from .plugin_settings import ConfigError, schema_at

MAX_ARCHIVE = 8 * 1024 * 1024
MAX_EXPANDED = 32 * 1024 * 1024
CAPABILITIES = ("tts", "asr", "vision", "embedding")
FEATURES = ("attachments-v1", "vision-broker-v1", "chat-broker-v1", "config-schema-v1", "mcp-broker-v1",
            "plugin-pages-v1", "model-providers-v1")
SLOTS = ("extensions", "attachment", "selection", "character-settings", "admin")
IDENTIFIER = re.compile(r"[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){0,7}")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?")
PATH_COMPONENT = re.compile(r"[a-zA-Z0-9_][a-zA-Z0-9_.-]*")
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL"} | {
    f"{prefix}{index}" for prefix in ("COM", "LPT") for index in range(10)
}


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def invalid_manifest(message):
    raise ApiError(422, "invalid_manifest", message)


def identifier(value):
    return isinstance(value, str) and len(value) <= 100 and IDENTIFIER.fullmatch(value)


def archive_path(value):
    if not isinstance(value, str) or not value or len(value) > 200:
        raise ValueError("Invalid package path")
    parts = value.split("/")
    if any(
        not PATH_COMPONENT.fullmatch(part) or part.endswith(".")
        or part.split(".")[0].upper() in WINDOWS_RESERVED
        for part in parts
    ):
        raise ValueError("Invalid package path")
    return PurePosixPath(*parts)


def objects(value, label):
    if not isinstance(value, list) or len(value) > 64 or any(not isinstance(item, dict) for item in value):
        invalid_manifest(f"{label} must be a list of up to 64 objects")
    return value


def identifiers(value, label):
    if not isinstance(value, list) or len(value) > 64 or not all(map(identifier, value)):
        invalid_manifest(f"{label} must be a list of up to 64 identifiers")
    if len(set(value)) != len(value):
        invalid_manifest(f"{label} contains duplicate identifiers")
    return value


def label(value, max_length):
    return isinstance(value, str) and 0 < len(value.strip()) <= max_length


def manifest(root):
    try:
        with (root / "metadata.yaml").open("rb") as source:
            raw = source.read(32769)
        if len(raw) > 32768:
            invalid_manifest("metadata.yaml is too large")
        metadata = yaml.safe_load(raw)
    except (OSError, yaml.YAMLError, ValueError, RecursionError):
        invalid_manifest("metadata.yaml must contain a valid YAML mapping")

    if not isinstance(metadata, dict):
        invalid_manifest("metadata.yaml must contain a mapping")
    if type(metadata.get("apiVersion")) is not int or metadata["apiVersion"] != API_VERSION:
        raise ApiError(422, "unsupported_api", f"This host supports plugin API {API_VERSION}")
    if type(metadata.get("schemaVersion")) is not int or metadata["schemaVersion"] != 1:
        invalid_manifest("schemaVersion must be 1")
    plugin_id = metadata.get("id")
    if not identifier(plugin_id) or "." not in plugin_id or any(
        part.upper() in WINDOWS_RESERVED for part in plugin_id.split(".")
    ):
        invalid_manifest("id must be a namespaced identifier with portable path components")
    name, version = metadata.get("name"), metadata.get("version")
    if not label(name, 90) or not label(version, 40) or not VERSION.fullmatch(version):
        invalid_manifest("name and semantic version are required")
    if not (root / "main.py").is_file():
        invalid_manifest("main.py is required")

    requires = identifiers(metadata.get("requiresFeatures", []), "requiresFeatures")
    if set(requires) - set(FEATURES):
        raise ApiError(422, "unsupported_feature", "The host does not provide a required plugin feature")
    try:
        schema = schema_at(root)
    except (OSError, ConfigError, OverflowError) as error:
        message = str(error) if isinstance(error, ConfigError) else "Invalid plugin configuration schema"
        raise ApiError(422, "invalid_config_schema", message) from error
    scopes = identifiers(metadata.get("permissions", []), "permissions")
    actions = {}
    for action in objects(metadata.get("actions", []), "actions"):
        action_id, scope = action.get("id"), action.get("scope")
        if not identifier(action_id) or action_id in actions or scope not in scopes:
            invalid_manifest("Each action must have a unique id and a declared permission")
        actions[action_id] = scope

    providers = {}
    provider_actions = set()
    for provider in objects(metadata.get("modelProviders", []), "modelProviders"):
        capability, action, models = (provider.get(key) for key in ("capability", "action", "models"))
        if (provider.keys() - {"capability", "action", "models", "requiresCredential"} or capability not in CAPABILITIES
                or capability in providers or not identifier(action) or action in provider_actions
                or actions.get(action) != f"model.provide.{capability}" or not isinstance(models, list)
                or not 1 <= len(models) <= 32 or not all(isinstance(model, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,100}", model) for model in models)
                or len(set(models)) != len(models) or type(provider.get("requiresCredential", False)) is not bool):
            invalid_manifest("Each model provider needs a unique capability, its dedicated action and model IDs")
        providers[capability] = {"models": models, "action": action, "requiresCredential": provider.get("requiresCredential", False)}
        provider_actions.add(action)
    if providers and "model-providers-v1" not in requires:
        invalid_manifest("modelProviders requires model-providers-v1")

    entries = {}
    for entry in objects(metadata.get("entries", []), "entries"):
        entry_id, title, slot = entry.get("id"), entry.get("title"), entry.get("slot")
        if identifier(entry_id) and entry_id in entries:
            raise ApiError(422, "duplicate_entry", "Entry ID must be unique within its plugin")
        if not identifier(entry_id) or not label(title, 90) or slot not in SLOTS:
            invalid_manifest("Each entry must have a unique id, title and supported slot")
        try:
            page = archive_path(entry.get("page"))
        except ValueError:
            invalid_manifest("Each entry must reference a portable page path")
        page_file = root / page
        if page.suffix != ".html" or not page_file.is_file() or page_file.stat().st_size > 262144:
            invalid_manifest("Each entry must reference a bundled UTF-8 HTML file of at most 256 KiB")
        try:
            page_file.read_text(encoding="utf-8")
        except UnicodeError:
            invalid_manifest("Page must be UTF-8")
        entry_actions = identifiers(entry.get("actions", []), "entry actions")
        if provider_actions.intersection(entry_actions):
            invalid_manifest("Model provider actions are callable only through the host registry")
        if not all(action in actions for action in entry_actions):
            invalid_manifest("Entry actions must be declared in actions")
        icon = entry.get("icon")
        if icon is not None and not label(icon, 16):
            invalid_manifest("Entry icon must be a short text glyph")
        order = entry.get("order", 100)
        if type(order) is not int or not 0 <= order <= 65535:
            invalid_manifest("Entry order must be an integer between 0 and 65535")
        entries[entry_id] = {
            "pluginId": plugin_id, "id": entry_id, "title": title, "slot": slot,
            "page": page.as_posix(), "order": order, "actions": entry_actions, "icon": icon,
        }
    motion_provider = None
    raw_motion = metadata.get("motionProvider")
    if raw_motion is not None:
        if (not isinstance(raw_motion, dict)
                or set(raw_motion) - {"entryId", "catalogAction"}
                or not identifier(raw_motion.get("entryId"))
                or not identifier(raw_motion.get("catalogAction"))
                or raw_motion["entryId"] not in entries
                or raw_motion["catalogAction"] not in actions):
            invalid_manifest("motionProvider must name a declared entryId and catalogAction")
        motion_provider = {
            "entryId": raw_motion["entryId"],
            "catalogAction": raw_motion["catalogAction"],
            "scope": actions[raw_motion["catalogAction"]],
        }
    return {
        "id": plugin_id, "name": name, "version": version, "apiVersion": API_VERSION,
        "permissions": scopes, "actions": actions, "entries": entries,
        "requiresFeatures": requires, "configSchema": schema,
        "modelProviders": providers, "motionProvider": motion_provider,
    }


def stage_archive(data, root):
    if len(data) > MAX_ARCHIVE:
        raise ApiError(413, "archive_too_large", "Plugin ZIP exceeds 8 MiB")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = [file for file in archive.infolist() if not file.is_dir()]
            if len(members) > 256 or sum(member.file_size for member in members) > MAX_EXPANDED:
                raise ValueError("Package exceeds expanded size or file count limit")
            names = set()
            for member in members:
                relative = archive_path(member.filename)
                key = relative.as_posix().casefold()
                mode = stat.S_IFMT(member.external_attr >> 16)
                if key in names or mode not in (0, stat.S_IFREG):
                    raise ValueError("Package has a duplicate or non-regular file")
                names.add(key)
                output = root / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, output.open("xb") as target:
                    payload = source.read(member.file_size + 1)
                    if len(payload) != member.file_size:
                        raise ValueError("Package member size mismatch")
                    target.write(payload)
    except (OSError, ValueError, RuntimeError, NotImplementedError, zipfile.BadZipFile) as error:
        raise ApiError(422, "invalid_archive", "Invalid plugin ZIP") from error
    return manifest(root)
