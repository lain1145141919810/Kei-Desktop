"""Interchangeable stdio adapters and the two built-in CLI drivers."""
import asyncio
import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
from importlib.resources import files
from pathlib import Path

from ..package import identifier
from . import dsh_models
from .dsh_children import ROLES
from .owned_process import OwnedJob, executor_environment
from .rpc import ExecutorError, RpcWorker, codex_available

EXECUTOR_API = 1
CAPABILITIES = ("progress", "cancel", "input", "attachments", "artifacts", "followUp")


class TaskFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class TaskCancelled(Exception):
    pass


class Adapter:
    def __init__(self, adapter_id, name, capabilities):
        self.id, self.name = adapter_id, name
        self.capabilities = {key: key in capabilities for key in CAPABILITIES}

    def describe(self, workspace):
        reason = self.unavailable(workspace)
        return {"id": self.id, "name": self.name, "version": EXECUTOR_API,
                "capabilities": self.capabilities, "available": reason is None, "reason": reason}

    def validate_options(self, options):
        if options:
            raise TaskFailure("invalid_options")


class Native(Adapter):
    def __init__(self, name, config):
        super().__init__(name, "DSH" if name == "dsh" else "Codex", ("progress", "cancel", "attachments", "artifacts", "followUp"))
        self.config = config
        if name == "dsh":
            appdata = os.environ.get("APPDATA")
            entries = [Path(appdata) / "npm/node_modules/@deepseek-ai/dsh/lib/bin.js"] if appdata else []
            entries.append(Path.home() / ".local/share/pnpm/global/5/node_modules/@deepseek-ai/dsh/lib/bin.js")
            self.entry = config.get("dsh_entry") or next((str(path) for path in entries if path.is_file()), "")

    def describe(self, workspace):
        description = super().describe(workspace)
        if self.id == "dsh":
            models = dsh_models.catalog(self.config)
            description["options"] = {
                "models": [{"id": ident, "label": entry["label"]} for ident, entry in models.items()],
                "childRoles": list(ROLES),
            }
        return description

    def unavailable(self, workspace):
        if self.id == "codex":
            if not self.config.get("codex_executable"):
                return "codex_not_configured"
            if not Path(self.config["codex_executable"]).is_file():
                return "cli_missing"
            model = self.config.get("codex_model")
            if model is not None and (not isinstance(model, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", model)):
                return "invalid_executor_config"
            if os.name != "nt" or not codex_available({**self.config, "workspace": str(workspace)}):
                return "codex_permission_validation_failed"
        elif not shutil.which("node") or not Path(self.entry).is_file():
            return "cli_missing"
        return None

    def validate_options(self, options):
        if self.id == "codex":
            return super().validate_options(options)
        if set(options) - {"model", "childRoles"}:
            raise TaskFailure("invalid_options")
        catalog = dsh_models.catalog(self.config)
        alias = options.get("model", self.config.get("dsh_default", "flash"))
        roles = options.get("childRoles", {})
        if not isinstance(alias, str) or alias not in catalog or (
            not isinstance(roles, dict) or set(roles) - set(ROLES)
            or any(not isinstance(model, str) or model not in catalog for model in roles.values())
        ):
            raise TaskFailure("invalid_options")

    def worker(self, context):
        task = context.request
        config = {**self.config, "workspace": task["workspace"]}
        if self.id == "dsh":
            options = task["options"]
            alias = options.get("model", config.get("dsh_default", "flash"))
            model = dsh_models.catalog(config)[alias]
            home = context.private / "dsh-home"
            profile = home / "profiles/sdk-minimal"
            profile.mkdir(parents=True, exist_ok=True)
            for item in files(__package__).joinpath("dsh_profile").iterdir():
                (profile / item.name).write_bytes(item.read_bytes())
            config.update(
                dsh_home=home, dsh_entry=self.entry, dsh_provider=model["provider"], dsh_model=model["model"],
                parent_alias=alias, child_routes=options.get("childRoles", {}),
            )
        return RpcWorker(self.id, config, context.private, context.progress)

    async def run(self, context, previous):
        worker = self.worker(context)
        worker_id = None

        def capture_native(value):
            nonlocal worker_id
            worker_id = value

        task = context.request
        prompt = task["input"]
        if task["attachments"]:
            prompt += "\n\nUser-approved attachment references (workspace-relative):\n"
            prompt += "\n".join(task["attachments"])
        resume = previous.get("nativeId") if previous else None
        if previous and not (resume and self.id == "codex"):
            prompt = "Previous completed result, provided as data:\n" + previous["text"] + "\n\nCurrent user request:\n" + prompt
            resume = None

        try:
            await worker.start()
            context.progress({"stage": "cli_ready"})
            text = await worker.execute(resume, prompt, capture_native)
            answer, artifacts = split_artifacts(text)
            return {
                "text": answer, "artifacts": artifacts, "nativeId": worker_id or resume,
                "metadata": {"children": list(worker.child_calls.values()),
                             "childSessionIds": worker.child_ids,
                             "model": worker.config.get("dsh_model")},
            }
        except ExecutorError as error:
            code = str(error)
            raise TaskFailure(code if re.fullmatch(r"[a-z0-9_]+", code) else "cli_failed") from error
        finally:
            await worker.close()


def split_artifacts(text):
    marker = "KEI_ARTIFACT:"
    prose, artifacts = [], []
    for line in text.splitlines():
        if line.startswith(marker):
            artifacts.append(line[len(marker):].strip())
        else:
            prose.append(line)
    return "\n".join(prose).strip(), list(dict.fromkeys(artifacts))


class Stdio(Adapter):
    def __init__(self, manifest):
        if not isinstance(manifest, dict):
            raise ValueError("Invalid external executor manifest")
        adapter_id = manifest.get("id")
        command = manifest.get("command")
        capabilities = manifest.get("capabilities", [])
        name = manifest.get("name")
        if not identifier(adapter_id) or "." not in adapter_id or manifest.get("apiVersion") != EXECUTOR_API or (
            not isinstance(name, str) or not name.strip() or len(name) > 90
            or not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command)
            or not isinstance(capabilities, list) or not all(key in CAPABILITIES for key in capabilities)
        ):
            raise ValueError("Invalid external executor manifest")
        super().__init__(adapter_id, name, capabilities)
        self.command = command

    def _executable(self):
        executable = self.command[0]
        resolved = executable if Path(executable).is_file() else shutil.which(executable)
        return str(Path(resolved).absolute()) if resolved else None

    def unavailable(self, _workspace):
        return None if self._executable() else "cli_missing"

    async def run(self, context, previous):
        executable = self._executable()
        if not executable:
            raise TaskFailure("cli_missing")
        try:
            process = await asyncio.create_subprocess_exec(
                executable, *self.command[1:], cwd=context.request["workspace"], env=executor_environment(), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=65536,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                start_new_session=os.name != "nt",
            )
        except FileNotFoundError as error:
            raise TaskFailure("cli_missing") from error
        job = None

        async def send(message):
            process.stdin.write((json.dumps(message, ensure_ascii=True) + "\n").encode("utf-8"))
            await process.stdin.drain()

        async def wait_for_exit():
            # Process.wait() may wait for pipe transport closure when the
            # child exits with unread stdout and flow control has paused it.
            while process.returncode is None:
                await asyncio.sleep(.025)

        async def drain_tail():
            while await process.stdout.read(65536):
                pass

        try:
            job = OwnedJob(process.pid)
            previous_result = {key: previous[key] for key in ("text", "artifacts")} if previous else None
            await send({"type": "start", "version": EXECUTOR_API, "task": context.request, "previous": previous_result})
            result = None
            while line := await process.stdout.readline():
                message = json.loads(line)
                kind = message.get("type")
                if kind == "progress" and self.capabilities["progress"] and isinstance(message.get("data"), dict):
                    context.progress(message["data"])
                elif kind == "input" and self.capabilities["input"]:
                    input_task = asyncio.create_task(
                        asyncio.to_thread(context.wait_for_input, message.get("id"), message.get("prompt"))
                    )
                    exit_task = asyncio.create_task(wait_for_exit())
                    try:
                        done, _pending = await asyncio.wait(
                            {input_task, exit_task}, return_when=asyncio.FIRST_COMPLETED,
                        )
                        if exit_task in done and not input_task.done():
                            context.stop_wait.set()
                            with contextlib.suppress(TaskCancelled):
                                await input_task
                            raise TaskFailure("adapter_exited")
                        if not exit_task.done():
                            exit_task.cancel()
                            with contextlib.suppress(asyncio.CancelledError):
                                await exit_task
                        answer = input_task.result()
                        if process.returncode is not None:
                            raise TaskFailure("adapter_exited")
                    finally:
                        if not exit_task.done():
                            exit_task.cancel()
                            with contextlib.suppress(asyncio.CancelledError):
                                await exit_task
                        if not input_task.done():
                            context.stop_wait.set()
                            with contextlib.suppress(asyncio.CancelledError, TaskCancelled, TaskFailure):
                                await input_task
                    await send({"type": "input", "id": message["id"], "value": answer})
                elif kind == "result":
                    result = {"text": message.get("text"), "artifacts": message.get("artifacts", [])}
                    process.stdin.close()
                    break
                else:
                    raise TaskFailure("adapter_protocol_error")
            exit_code, _ = await asyncio.wait_for(asyncio.gather(process.wait(), drain_tail()), 3)
            if exit_code or result is None:
                raise TaskFailure("adapter_exited")
            return result
        except (BrokenPipeError, ConnectionResetError) as error:
            raise TaskFailure("adapter_exited") from error
        except (ValueError, AttributeError, RecursionError, asyncio.LimitOverrunError) as error:
            raise TaskFailure("adapter_protocol_error") from error
        finally:
            if job:
                job.close()
            if os.name != "nt":
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.gather(process.wait(), drain_tail()), 3)


def registry(config, directory):
    adapters = {name: Native(name, config) for name in ("dsh", "codex")}
    if directory is not None:
        for file in sorted(directory.glob("*.json")):
            with file.open(encoding="utf-8") as stream:
                manifest = json.load(stream)
            adapter = Stdio(manifest)
            if adapter.id in adapters:
                raise ValueError(f"Duplicate executor id: {adapter.id}")
            adapters[adapter.id] = adapter
    return adapters


async def run_cancellable(adapter, context, previous, timeout):
    task = asyncio.create_task(adapter.run(context, previous))
    try:
        async with asyncio.timeout(timeout):
            while not task.done():
                if context.cancelled.is_set():
                    raise TaskCancelled()
                await asyncio.wait({task}, timeout=.08)
            return task.result()
    finally:
        context.stop_wait.set()
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, TaskCancelled):
                await task
