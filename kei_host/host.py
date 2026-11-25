"""Keep installed packages, grants, workers and live page sessions consistent."""
import copy
import json
import secrets
import shutil
import tempfile
import threading
from collections import deque
from pathlib import Path

from . import API_VERSION
from .package import ApiError, FEATURES, identifier, manifest, stage_archive
from .plugin_settings import ConfigError, normalized
from .process import Worker, WorkerFailure

EVENT_LIMIT = 512
PAGE_LIMIT = 256


def write_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as out:
        temporary = Path(out.name)
        try:
            json.dump(value, out, ensure_ascii=True, indent=2, allow_nan=False)
        except Exception:
            out.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)

def child_of(parent, path):
    if path.resolve().parent != parent.resolve() or path.is_symlink():
        raise OSError("Plugin path leaves its configured directory")
    return path


DIAGNOSTICS = {
    "config_unreadable": ("Stored configuration could not be loaded", "save_configuration"),
    "initialize_exception": ("Plugin initialization raised an error", "check_package"),
    "registration_mismatch": ("Registered actions differ from metadata.yaml", "check_manifest"),
    "worker_start_failed": ("Plugin worker could not start", "check_runtime"),
    "worker_unresponsive": ("Plugin worker did not respond", "enable_again"),
    "worker_failed": ("Plugin worker failed", "check_package"),
}



class Host:
    def __init__(self, directory, mcp=None, chat=None, attachments=None):
        self.root = directory
        self.mcp, self.chat, self.attachments = mcp, chat, attachments
        self.packages = child_of(self.root, self.root / "plugins")
        self.data = child_of(self.root, self.root / "plugin-data")
        self.state_file = self.root / "state.json"
        self.guard = threading.RLock()
        self.packages.mkdir(parents=True, exist_ok=True)
        self.data.mkdir(parents=True, exist_ok=True)
        for container in (self.packages, self.data):
            for removed in container.glob(".remove-*"):
                shutil.rmtree(child_of(container, removed), ignore_errors=True)
        self.states = json.loads(self.state_file.read_text("utf-8")) if self.state_file.exists() else {}
        self.recover_upgrades()
        self.manifests = {}
        self.workers = {}
        self.sessions = {}
        self.events = deque(maxlen=EVENT_LIMIT)
        self.cursor = 0
        self.epoch = secrets.token_urlsafe(18)
        self._motion_catalog_cache = None
        for folder in sorted(self.packages.iterdir()):
            if folder.is_dir() and identifier(folder.name):
                metadata = manifest(child_of(self.packages, folder))
                if metadata["id"] != folder.name:
                    raise RuntimeError(f"Package id differs from its folder: {folder.name}")
                self.manifests[folder.name] = metadata
                if folder.name not in self.states:
                    self.states[folder.name] = {"enabled": False, "grants": [], "lastError": None}
        self.states = {key: self.states[key] for key in self.manifests}
        for plugin_id, state in self.states.items():
            if state["enabled"]:
                try:
                    self.activate(plugin_id, state["grants"])
                except ApiError:
                    continue

    def close(self):
        self._motion_catalog_cache = None
        for plugin_id in list(self.workers):
            self.revoke(plugin_id)
        self.sessions.clear()

    def info(self, plugin_id):
        if plugin_id not in self.manifests:
            raise ApiError(404, "plugin_not_found", "Plugin is not installed")
        metadata = self.manifests[plugin_id]
        return {
            **{key: metadata[key] for key in ("id", "name", "version", "apiVersion", "permissions")},
            **self.states[plugin_id],
        }

    def settings_file(self, plugin_id):
        directory = child_of(self.data, self.data / plugin_id)
        return child_of(directory, directory / "kei-settings.json")

    def config(self, plugin_id):
        schema = self.manifests[plugin_id]["configSchema"]
        try:
            path = self.settings_file(plugin_id)
            values = json.loads(path.read_text("utf-8")) if path.exists() else {}
            return normalized(schema, values)
        except (OSError, ValueError, RecursionError) as error:
            raise WorkerFailure("Stored configuration is unreadable", "config_unreadable") from error

    def detail(self, plugin_id):
        basic = self.info(plugin_id)
        metadata = self.manifests[plugin_id]
        worker = self.workers.get(plugin_id)
        reason = basic.get("diagnostic")
        try:
            values = self.config(plugin_id)
        except WorkerFailure as error:
            reason = error.reason
            values = normalized(metadata["configSchema"], {})
        diagnostic = None
        if reason:
            text, action = DIAGNOSTICS.get(reason, DIAGNOSTICS["worker_failed"])
            diagnostic = {"code": reason, "message": text, "action": action}
        return {
            **basic,
            "compatibility": {"compatible": True, "hostApiVersion": API_VERSION, "hostFeatures": list(FEATURES),
                              "requiresFeatures": metadata["requiresFeatures"]},
            "effectiveGrants": basic["grants"] if worker else [],
            "declaredEntries": list(metadata["entries"].values()),
            "activeEntries": [entry for entry in self.entries() if entry["pluginId"] == plugin_id],
            "configuration": {"schema": metadata["configSchema"], "values": values,
                              "pendingReload": bool(worker and worker.config != values)},
            "diagnostics": [diagnostic] if diagnostic else [],
        }

    def configure(self, plugin_id, values):
        self.info(plugin_id)
        schema = self.manifests[plugin_id]["configSchema"]
        try:
            values = normalized(schema, values)
        except ConfigError as error:
            raise ApiError(422, "invalid_plugin_config", str(error)) from error
        path = self.settings_file(plugin_id)
        path.parent.mkdir(exist_ok=True)
        write_json(path, values)
        self.event("plugin.configured", plugin_id)
        return self.detail(plugin_id)

    def save_state(self, plugin_id, **state):
        updated = {**self.states, plugin_id: {**self.states.get(plugin_id, {}), **state}}
        write_json(self.state_file, updated)
        self.states = updated

    def event(self, kind, plugin_id, payload=None):
        self.cursor += 1
        self.events.append({
            "sequence": self.cursor, "type": kind, "pluginId": plugin_id, "data": payload or {},
        })
        if kind in {
            "plugin.enabled", "plugin.disabled", "plugin.reloaded",
            "plugin.configured", "plugin.upgraded", "plugin.uninstalled",
        }:
            self._motion_catalog_cache = None

    def invalidate_motion_catalog(self):
        with self.guard:
            self._motion_catalog_cache = None

    def motion_catalog(self):
        with self.guard:
            if self._motion_catalog_cache is not None:
                return copy.deepcopy(self._motion_catalog_cache)
            targets = []
            generation = self.cursor
            for plugin_id, worker in sorted(self.workers.items()):
                descriptor = self.manifests[plugin_id].get("motionProvider")
                if descriptor and descriptor["scope"] in self.states[plugin_id]["grants"]:
                    targets.append((plugin_id, worker, descriptor["catalogAction"]))
        if not targets:
            return {"providers": [], "motions": []}
        providers = []
        motions = []
        seen_ids = set()
        complete = True
        for plugin_id, worker, action in targets:
            try:
                result, _events = worker.request("call", action=action, arguments={})
            except WorkerFailure:
                complete = False
                continue
            if not isinstance(result, dict) or result.get("state") != "ready":
                complete = False
                continue
            raw_motions = result.get("motions")
            if not isinstance(raw_motions, list):
                continue
            plugin_motions = []
            for item in raw_motions[:64]:
                if not isinstance(item, dict):
                    continue
                mid = item.get("id")
                raw_title = item.get("title")
                mask = item.get("mask")
                title = raw_title.strip() if isinstance(raw_title, str) and raw_title.strip() else mid
                if (isinstance(mid, str) and 0 < len(mid) <= 100 and mid not in seen_ids
                        and isinstance(title, str) and 0 < len(title) <= 200
                        and isinstance(mask, list) and mask and all(isinstance(b, str) and len(b) <= 64 for b in mask)):
                    seen_ids.add(mid)
                    entry = {"id": mid, "title": title, "mask": list(mask), "pluginId": plugin_id}
                    category = item.get("category")
                    if isinstance(category, str) and 0 < len(category.strip()) <= 48:
                        entry["category"] = category.strip()
                    if isinstance(item.get("ownsHead"), bool):
                        entry["ownsHead"] = item["ownsHead"]
                    handedness = item.get("handedness")
                    if isinstance(handedness, list) and all(isinstance(h, str) and len(h) <= 16 for h in handedness[:4]):
                        entry["handedness"] = list(handedness[:4])
                    variants = item.get("variants")
                    if isinstance(variants, list):
                        v_ids = [
                            v["id"] for v in variants[:12]
                            if isinstance(v, dict) and isinstance(v.get("id"), str) and 0 < len(v["id"]) <= 48
                        ]
                        if v_ids:
                            entry["variants"] = v_ids
                    plugin_motions.append(entry)
                    motions.append(entry)
            if plugin_motions:
                providers.append({"pluginId": plugin_id, "count": len(plugin_motions)})
        catalog = {"providers": providers, "motions": motions}
        with self.guard:
            # Only cache if workers are still active (avoid caching across concurrent disable)
            if self.cursor != generation or not all(self.workers.get(pid) is w for pid, w, _ in targets):
                return {"providers": [], "motions": []}
            if complete:
                self._motion_catalog_cache = catalog
        return copy.deepcopy(catalog)

    def read_events(self, after, plugin_id=None):
        oldest = self.events[0]["sequence"] if self.events else self.cursor + 1
        events = [
            event for event in self.events if event["sequence"] > after and (
                (plugin_id is None and event["type"] != "plugin.message")
                or (plugin_id is not None and event["pluginId"] == plugin_id and event["type"] == "plugin.message")
            )
        ]
        return {
            "epoch": self.epoch, "cursor": self.cursor, "reset": after < oldest - 1 or after > self.cursor,
            "events": events,
        }

    def install(self, archive):
        with tempfile.TemporaryDirectory(prefix=".new-", dir=self.packages) as temporary:
            staging = Path(temporary) / "contents"
            staging.mkdir()
            metadata = stage_archive(archive, staging)
            plugin_id = metadata["id"]
            dest = child_of(self.packages, self.packages / plugin_id)
            if dest.exists():
                raise ApiError(409, "plugin_exists", "Plugin is already installed")
            staging.rename(dest)
        try:
            self.save_state(plugin_id, enabled=False, grants=[], lastError=None)
        except OSError:
            shutil.rmtree(dest)
            raise
        self.manifests[plugin_id] = metadata
        self.event("plugin.installed", plugin_id)
        return self.info(plugin_id)

    def recover_upgrades(self):
        for path in self.packages.glob(".upgrade-*"):
            scratch = child_of(self.packages, path)
            journal = scratch / "plan.json"
            backup = scratch / "old"
            if backup.exists() and journal.exists() and not (scratch / "committed").exists():
                transaction = json.loads(journal.read_text("utf-8"))
                plugin_id = transaction["pluginId"]
                if not identifier(plugin_id):
                    raise ValueError("Invalid plugin upgrade journal")
                dest = child_of(self.packages, self.packages / plugin_id)
                if dest.exists():
                    dest.rename(child_of(scratch, scratch / "abandoned"))
                child_of(scratch, backup).rename(dest)
                self.states[plugin_id] = transaction["state"]
                write_json(self.state_file, self.states)
            if not backup.exists() or (scratch / "committed").exists():
                shutil.rmtree(scratch)

    def upgrade(self, plugin_id, archive):
        info = self.info(plugin_id)
        previous = self.manifests[plugin_id]
        existing = self.config(plugin_id)
        scratch = child_of(self.packages, Path(tempfile.mkdtemp(prefix=".upgrade-", dir=self.packages)))
        staging, backup = scratch / "new", scratch / "old"
        completed = False
        try:
            staging.mkdir()
            metadata = stage_archive(archive, staging)
            if metadata["id"] != plugin_id or metadata["version"] == info["version"]:
                raise ApiError(409, "plugin_upgrade_conflict", "Choose a distinct version of the installed plugin")
            if set(info["grants"]) - set(metadata["permissions"]):
                raise ApiError(409, "plugin_upgrade_grants_conflict", "Existing grants are incompatible with this package")
            try:
                normalized(metadata["configSchema"], existing)
            except ConfigError as error:
                raise ApiError(409, "plugin_upgrade_config_conflict", str(error)) from error
            destination = child_of(self.packages, self.packages / plugin_id)
            write_json(scratch / "plan.json", {"pluginId": plugin_id, "state": self.states[plugin_id]})
            if info["enabled"]:
                self.revoke(plugin_id)
            try:
                destination.rename(backup)
                staging.rename(destination)
                self.manifests[plugin_id] = metadata
                if info["enabled"]:
                    self.activate(plugin_id, info["grants"])
                (scratch / "committed").touch()
                completed = True
            except (ApiError, OSError) as error:
                if plugin_id in self.workers:
                    self.revoke(plugin_id)
                if backup.exists():
                    if destination.exists():
                        destination.rename(staging)
                    backup.rename(destination)
                self.manifests[plugin_id] = previous
                if info["enabled"]:
                    try:
                        self.activate(plugin_id, info["grants"])
                    except ApiError:
                        self.event("plugin.upgrade_recovery_failed", plugin_id)
                        raise ApiError(409, "plugin_upgrade_recovery_failed", "Previous package restored but activation failed") from error
                raise ApiError(409, "plugin_upgrade_failed", "Previous package has been restored") from error
        finally:
            if completed or not backup.exists():
                shutil.rmtree(scratch)
        self.event("plugin.upgraded", plugin_id, {"version": metadata["version"]})
        return self.detail(plugin_id)

    def activate(self, plugin_id, grants):
        metadata = self.manifests[plugin_id]
        if (
            not isinstance(grants, list) or len(grants) > 64 or not all(map(identifier, grants))
            or len(set(grants)) != len(grants) or not set(grants).issubset(metadata["permissions"])
        ):
            raise ApiError(422, "invalid_grants", "Grants must be unique permissions declared by this plugin")
        worker = None
        try:
            private_data = child_of(self.data, self.data / plugin_id)
            private_data.mkdir(exist_ok=True)
            config = self.config(plugin_id)
            owner = secrets.token_urlsafe(18)
            broker = None
            uses_mcp = self.mcp is not None and "mcp.call" in grants
            uses_chat = self.chat is not None and any(grant in grants for grant in ("chat.ask", "vision.describe"))
            if uses_mcp or uses_chat or "attachments.read" in grants:
                def broker(kind, parameters, context):
                    return self.plugin_broker(kind, plugin_id, owner, grants, parameters, context)
            worker = Worker(self.packages / plugin_id, private_data, broker)
            worker.mcp_owner = owner if uses_mcp else None
            worker.chat_owner = owner if uses_chat else None
            worker.config = config
            actions, _events = worker.request("activate", config=config)
            if actions != sorted(metadata["actions"]):
                raise WorkerFailure("Registered actions differ from the plugin manifest", "registration_mismatch")
        except (OSError, WorkerFailure) as error:
            reason = error.reason if isinstance(error, WorkerFailure) else "worker_start_failed"
            if worker is not None:
                worker.close()
            self.save_state(plugin_id, enabled=False, grants=grants, lastError="activation_failed", diagnostic=reason)
            self.event("plugin.activation_failed", plugin_id, {"diagnostic": reason})
            raise ApiError(422, "activation_failed", DIAGNOSTICS.get(reason, DIAGNOSTICS["worker_failed"])[0]) from error
        try:
            self.save_state(plugin_id, enabled=True, grants=grants, lastError=None, diagnostic=None)
        except OSError:
            worker.close()
            raise
        self.workers[plugin_id] = worker
        self.event("plugin.enabled", plugin_id)
        return self.info(plugin_id)

    def plugin_broker(self, kind, plugin_id, owner, grants, parameters, context):
        try:
            if not isinstance(parameters, dict):
                raise ApiError(422, "invalid_broker_request", "Broker parameters must be an object")
            if kind == "mcp" and "mcp.call" in grants and self.mcp is not None:
                from .mcp_client.config import server_id

                ident = parameters.get("serverId")
                if not server_id(ident):
                    raise ApiError(422, "invalid_mcp_call", "A valid MCP serverId is required")
                result = self.mcp.sync(self.mcp.call(ident, parameters, plugin_id, owner))
            elif kind == "chat" and "chat.ask" in grants and self.chat is not None:
                conversation = context.get("conversationId") if context else None
                if conversation is None:
                    raise ApiError(403, "chat_context_required", "The trusted client must bind a current conversation")
                result = self.chat.ask(conversation, parameters, owner)
            elif kind == "vision" and "vision.describe" in grants and self.chat is not None:
                capture = context.get("capture") if context else None
                image = parameters.get("image")
                if (not isinstance(capture, dict) or capture.get("authorized") is not True
                    or not isinstance(image, dict) or not isinstance(capture.get("sourceId"), str)
                    or capture.get("sourceId") != image.get("sourceId") or capture.get("kind") != image.get("kind")):
                    raise ApiError(403, "vision_scope_denied", "Trusted capture permission is required")
                result = self.chat.describe(image, owner)
            elif kind == "attachment" and "attachments.read" in grants and self.attachments is not None:
                conversation = context.get("conversationId") if context else None
                result = self.attachments.prefix(conversation, parameters.get("id"))
            else:
                raise ApiError(403, kind + "_scope_denied", "Plugin has no grant for this service")
            return {"ok": True, "data": result}
        except ApiError as error:
            return {"ok": False, "error": {
                "code": error.code, "message": error.message, "details": getattr(error, "details", {}),
            }}
        except (ValueError, OSError, TypeError):
            return {"ok": False, "error": {"code": kind + "_broker_error", "message": "Host service failed"}}

    def enable(self, plugin_id, grants):
        info = self.info(plugin_id)
        if plugin_id in self.workers:
            if info["grants"] != grants:
                raise ApiError(409, "plugin_enabled", "Disable the plugin before changing its grants")
            return info
        return self.activate(plugin_id, grants)

    def revoke(self, plugin_id):
        self._motion_catalog_cache = None
        self.sessions = {
            key: session for key, session in self.sessions.items() if session["pluginId"] != plugin_id
        }
        worker = self.workers.pop(plugin_id, None)
        if worker is not None:
            if worker.mcp_owner:
                self.mcp.sync(self.mcp.release(worker.mcp_owner, plugin_id))
            if worker.chat_owner:
                self.chat.release(worker.chat_owner)
            try:
                worker.close()
            finally:
                if worker.chat_owner:
                    self.chat.forget(worker.chat_owner)
                if worker.mcp_owner:
                    self.mcp.sync(self.mcp.forget_generation(worker.mcp_owner))

    def disable(self, plugin_id):
        info = self.info(plugin_id)
        if plugin_id in self.workers:
            self.save_state(plugin_id, enabled=False)
            self.revoke(plugin_id)
            self.event("plugin.disabled", plugin_id)
        return info | self.states[plugin_id]

    def reload(self, plugin_id):
        info = self.info(plugin_id)
        if plugin_id not in self.workers:
            raise ApiError(409, "plugin_disabled", "Enable the plugin before reloading it")
        self.disable(plugin_id)
        result = self.activate(plugin_id, info["grants"])
        self.event("plugin.reloaded", plugin_id)
        return result

    def uninstall(self, plugin_id, retain_data):
        self.info(plugin_id)
        if type(retain_data) is not bool:
            raise ApiError(422, "invalid_request", "retainData must be a boolean")
        self.disable(plugin_id)
        package = child_of(self.packages, self.packages / plugin_id)
        private_data = child_of(self.data, self.data / plugin_id)
        staged = []
        try:
            if private_data.exists() and not retain_data:
                removed_data = child_of(self.data, self.data / (".remove-" + secrets.token_hex(12)))
                private_data.rename(removed_data)
                staged.append((private_data, removed_data))
            removed_package = child_of(self.packages, self.packages / (".remove-" + secrets.token_hex(12)))
            package.rename(removed_package)
            staged.append((package, removed_package))
            updated = {key: value for key, value in self.states.items() if key != plugin_id}
            write_json(self.state_file, updated)
        except OSError:
            for original, removed in reversed(staged):
                removed.rename(original)
            raise
        self.states = updated
        del self.manifests[plugin_id]
        for _original, removed in staged:
            shutil.rmtree(child_of(_original.parent, removed), ignore_errors=True)
        self.event("plugin.uninstalled", plugin_id)
        return {"id": plugin_id, "retainData": retain_data}

    def entries(self):
        entries = [
            entry for key in self.workers for entry in self.manifests[key]["entries"].values()
        ]
        return sorted(entries, key=lambda entry: (entry["slot"], entry["order"], entry["pluginId"], entry["id"]))

    def open_page(self, plugin_id, entry_id):
        if not identifier(plugin_id) or not identifier(entry_id):
            raise ApiError(422, "invalid_request", "pluginId and entryId must be identifiers")
        self.info(plugin_id)
        if plugin_id not in self.workers:
            raise ApiError(409, "plugin_disabled", "Plugin is disabled")
        metadata = self.manifests[plugin_id]
        entry = metadata["entries"].get(entry_id)
        if entry is None:
            raise ApiError(404, "entry_not_found", "Plugin page does not exist")
        if len(self.sessions) >= PAGE_LIMIT:
            raise ApiError(429, "page_limit", "Close a plugin page before opening another")
        session_id = secrets.token_urlsafe(24)
        html = (self.packages / plugin_id / entry["page"]).read_text("utf-8")
        self.sessions[session_id] = {**entry, "openedCursor": self.cursor}
        return {"sessionId": session_id, "entry": copy.copy(entry), "html": html, "cursor": self.cursor}

    def session(self, session_id):
        session = self.sessions.get(session_id) if isinstance(session_id, str) else None
        if session is None:
            raise ApiError(410, "page_closed", "Plugin page was closed or revoked")
        return session

    def close_page(self, session_id):
        self.session(session_id)
        del self.sessions[session_id]
        return {"closed": True}

    def cancel_capture(self, session_id):
        entry = self.session(session_id)
        scopes = self.manifests[entry["pluginId"]]["actions"]
        worker = self.workers[entry["pluginId"]]
        if self.chat is None or not worker.chat_owner or not any(scopes[action] == "vision.describe" for action in entry["actions"]):
            raise ApiError(403, "vision_scope_denied", "This page does not own a capture")
        return self.chat.cancel_capture(worker.chat_owner)

    def call_page(self, session_id, action, arguments, context=None):
        with self.guard:
            entry = self.session(session_id)
            plugin_id = entry["pluginId"]
            scope = self.manifests[plugin_id]["actions"].get(action) if isinstance(action, str) else None
            if action not in entry["actions"] or scope not in self.states[plugin_id]["grants"]:
                raise ApiError(403, "scope_denied", "This page does not have permission to call the action")
            if not isinstance(arguments, dict):
                raise ApiError(422, "invalid_request", "Action arguments must be an object")
            worker = self.workers[plugin_id]
        try:
            if context is not None and not isinstance(context, dict):
                raise ApiError(422, "invalid_request", "Trusted page context must be an object")
            result, events = worker.request("call", action=action, arguments=arguments, broker_context=context)
        except WorkerFailure as error:
            with self.guard:
                self.session(session_id)
                if worker.broken and self.workers.get(plugin_id) is worker:
                    self.disable(plugin_id)
            raise ApiError(502, "action_failed", "Plugin could not complete the action") from error
        with self.guard:
            self.session(session_id)
            for item in events:
                self.event("plugin.message", plugin_id, item)
        return {"result": result}
