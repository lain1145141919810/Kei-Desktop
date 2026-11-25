"""Durable task protocol with a bounded queue and ordered, restartable queries."""
import asyncio
import hashlib
import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from queue import Empty, Queue
from uuid import uuid4

from ..package import ApiError
from .adapters import TaskCancelled, TaskFailure, registry, run_cancellable

TERMINAL = {"succeeded", "failed", "cancelled"}
ACTIVE = {"queued", "running", "waiting_for_input", "cancelling"}


def invalid(message):
    raise ApiError(422, "invalid_task", message)


def text(value, max_length):
    return isinstance(value, str) and 0 < len(value.strip()) <= max_length


def within(root, value, *, file=False):
    if not isinstance(value, str) or len(value) > 1000:
        invalid("Workspace reference is invalid")
    try:
        path = (root / value).resolve(strict=True)
    except (OSError, ValueError, RuntimeError):
        invalid("Workspace reference does not exist")
    if not path.is_relative_to(root) or not (path.is_file() if file else path.is_dir()):
        invalid("Workspace reference is outside the configured directory or has the wrong type")
    return path


class TaskContext:
    def __init__(self, service, task_id, request, private):
        self.service, self.id, self.request, self.private = service, task_id, request, private
        self.cancelled = threading.Event()
        self.stop_wait = threading.Event()
        self.answers = Queue(maxsize=1)
        self.started = False

    def progress(self, payload):
        payload_json = json.dumps(payload, allow_nan=False)
        if len(payload_json) > 8192:
            raise TaskFailure("progress_too_large")
        with self.service.guard, self.service.db:
            task = self.service.get(self.id)
            if task["status"] == "running" and task["sequence"] < 2048:
                self.service.transition(task, "task.progress", payload)

    def wait_for_input(self, input_id, prompt):
        if not text(input_id, 80) or not text(prompt, 2048):
            raise TaskFailure("adapter_protocol_error")
        with self.service.guard, self.service.db:
            if self.cancelled.is_set() or self.stop_wait.is_set():
                raise TaskCancelled()
            task = self.service.get(self.id)
            self.service.transition(task, "task.input_requested", {
                "inputId": input_id, "prompt": prompt,
            }, status="waiting_for_input", inputRequest={"id": input_id, "prompt": prompt})
        while not self.cancelled.is_set() and not self.stop_wait.is_set():
            try:
                return self.answers.get(timeout=.1)
            except Empty:
                continue
        raise TaskCancelled()


class TaskService:
    def __init__(self, root, directory, config):
        self.root = root
        self.guard = threading.RLock()
        workspace = Path(config.get("workspace", root / "workspace"))
        workspace.mkdir(parents=True, exist_ok=True)
        self.workspace = workspace.resolve()
        self.private = root / "task-private"
        self.private.mkdir(exist_ok=True)
        if type(config.get("timeoutSeconds", 120)) is not int or not 1 <= config.get("timeoutSeconds", 120) <= 3600:
            raise ValueError("timeoutSeconds must be an integer between 1 and 3600")
        self.timeout = config.get("timeoutSeconds", 120)
        self.adapters = registry(config, directory)
        self.db = sqlite3.connect(root / "tasks-v1.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, conversation TEXT NOT NULL, request_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL, status TEXT NOT NULL, updated REAL NOT NULL,
                document TEXT NOT NULL, UNIQUE(conversation, request_id)
            );
            CREATE TABLE IF NOT EXISTS task_events (
                task_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL,
                PRIMARY KEY(task_id, sequence)
            );
        """)
        with self.db:
            for (document,) in self.db.execute(
                "SELECT document FROM tasks WHERE status IN ('queued','running','waiting_for_input','cancelling')",
            ).fetchall():
                task = json.loads(document)
                self.fail(task, "failed", "runtime_restarted", task["status"] != "queued")

        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="kei-task")
        self.active = {}
        self.closing = False

    def close(self):
        with self.guard:
            self.closing = True
            for context in self.active.values():
                context.cancelled.set()
        self.pool.shutdown(wait=True)
        self.db.close()

    def transition(self, task, event, data, **changes):
        timestamp = time.time()
        task.update(changes, sequence=task["sequence"] + 1, updatedAt=timestamp)
        message = {"sequence": task["sequence"], "type": event, "taskId": task["id"],
                   "timestamp": timestamp, "data": data}
        self.db.execute("UPDATE tasks SET status=?, updated=?, document=? WHERE id=?",
                        (task["status"], timestamp, json.dumps(task), task["id"]))
        self.db.execute("INSERT INTO task_events VALUES(?,?,?)", (task["id"], task["sequence"], json.dumps(message)))

    def get(self, task_id):
        with self.guard:
            row = self.db.execute("SELECT document FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise ApiError(404, "task_not_found", "Task was not found")
        return json.loads(row[0])

    def list(self, conversation):
        where, params = (" WHERE conversation=?", (conversation,)) if conversation else ("", ())
        with self.guard:
            rows = self.db.execute(
                "SELECT document FROM tasks" + where + " ORDER BY updated DESC LIMIT 100", params,
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def events(self, task_id, after):
        with self.guard:
            task = self.get(task_id)
            rows = self.db.execute("SELECT document FROM task_events WHERE task_id=? AND sequence>? "
                                   "ORDER BY sequence LIMIT 200", (task_id, after)).fetchall()
        events = [json.loads(row[0]) for row in rows]
        cursor = events[-1]["sequence"] if events else min(after, task["sequence"])
        return {"cursor": cursor, "hasMore": task["sequence"] > cursor, "events": events}

    def normalize(self, body):
        adapter = self.adapters.get(body.get("executorId")) if isinstance(body.get("executorId"), str) else None
        if adapter is None:
            raise ApiError(404, "executor_not_found", "Executor is not registered")
        for field, limit in (("requestId", 100), ("conversationId", 100), ("input", 16000)):
            if not text(body.get(field), limit):
                invalid(f"{field} must be a nonempty string of at most {limit} characters")
        workspace_ref = body.get("workspace", ".")
        if not isinstance(workspace_ref, str) or len(workspace_ref) > 1000:
            invalid("Workspace reference is invalid")
        attachments = body.get("attachments", [])
        if not isinstance(attachments, list) or len(attachments) > 16 or not all(text(item, 1000) for item in attachments):
            invalid("attachments must be a list of up to 16 paths")
        options = body.get("options", {})
        if not isinstance(options, dict):
            invalid("options must be an object")
        follow_up = body.get("followUpTaskId")
        if follow_up is not None and not text(follow_up, 100):
            invalid("followUpTaskId must be a task ID")
        return adapter, {
            "requestId": body["requestId"], "conversationId": body["conversationId"], "executorId": adapter.id,
            "input": body["input"], "workspace": workspace_ref, "attachments": attachments, "options": options,
            "followUpTaskId": follow_up,
        }

    def submit(self, body):
        adapter, request = self.normalize(body)
        fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
        key = (request["conversationId"], request["requestId"])
        with self.guard:
            row = self.db.execute("SELECT fingerprint, document FROM tasks WHERE conversation=? AND request_id=?", key).fetchone()
            if row:
                if row[0] != fingerprint:
                    raise ApiError(409, "request_conflict", "This request ID already belongs to a different task")
                return 200, json.loads(row[1])
            if self.closing:
                raise ApiError(503, "executor_unavailable", "Task service is shutting down")
            if len(self.active) >= 64:
                raise ApiError(429, "task_queue_full", "Task queue is full")

            workspace = within(self.workspace, request["workspace"])
            request["workspace"] = str(workspace)
            attachments = request["attachments"]
            if attachments and not adapter.capabilities["attachments"]:
                raise ApiError(409, "unsupported_capability", "This executor does not accept attachments")
            for index, item in enumerate(attachments):
                attachments[index] = within(workspace, item, file=True).relative_to(workspace).as_posix()
            try:
                adapter.validate_options(request["options"])
            except (TaskFailure, ValueError) as error:
                raise ApiError(422, "invalid_options", "Executor options are invalid") from error
            if reason := adapter.unavailable(workspace):
                raise ApiError(503, reason, "Executor is unavailable for this workspace")
            previous = self.previous(adapter, request)
            ident, timestamp = uuid4().hex, time.time()
            task = {
                "id": ident, "requestId": key[1], "conversationId": key[0], "executorId": adapter.id,
                "workspace": str(workspace), "status": "queued", "sequence": 0, "createdAt": timestamp,
                "updatedAt": timestamp, "inputRequest": None, "result": None, "error": None,
            }
            private = self.private / ident
            private.mkdir()
            with self.db:
                self.db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)",
                                (ident, *key, fingerprint, "queued", timestamp, json.dumps(task)))
                self.transition(task, "task.queued", {})
            context = TaskContext(self, ident, request, private)
            self.active[ident] = context
            self.pool.submit(self.run, adapter, context, previous)
            return 202, task

    def previous(self, adapter, request):
        ident = request["followUpTaskId"]
        if ident is None:
            return None
        if not adapter.capabilities["followUp"]:
            raise ApiError(409, "unsupported_capability", "This executor does not support follow-up")
        prior = self.get(ident)
        if (prior["status"] != "succeeded" or prior["executorId"] != adapter.id
            or prior["conversationId"] != request["conversationId"] or prior["workspace"] != request["workspace"]):
            raise ApiError(409, "invalid_follow_up", "Follow-up requires a completed task in this conversation and workspace")
        return prior["result"]

    def fail(self, task, status, code, may_have_side_effects):
        error = {"code": code, "mayHaveSideEffects": may_have_side_effects}
        self.transition(task, "task." + status, error, status=status, inputRequest=None, error=error)

    def validate_result(self, adapter, context, result):
        if not isinstance(result, dict) or not text(result.get("text"), 12000):
            raise TaskFailure("invalid_result")
        artifacts = result.get("artifacts", [])
        if not isinstance(artifacts, list) or len(artifacts) > 32 or (artifacts and not adapter.capabilities["artifacts"]):
            raise TaskFailure("invalid_artifacts")
        workspace = Path(context.request["workspace"])
        try:
            refs = [within(workspace, path, file=True).relative_to(workspace).as_posix() for path in artifacts]
        except ApiError as error:
            raise TaskFailure("invalid_artifacts") from error
        return {**result, "artifacts": refs}

    def run(self, adapter, context, previous):
        try:
            with self.guard, self.db:
                task = self.get(context.id)
                if context.cancelled.is_set():
                    raise TaskCancelled()
                context.started = True
                self.transition(task, "task.started", {}, status="running")
            result = asyncio.run(run_cancellable(adapter, context, previous, self.timeout))
            result = self.validate_result(adapter, context, result)
            with self.guard, self.db:
                task = self.get(context.id)
                if context.cancelled.is_set():
                    raise TaskCancelled()
                self.transition(task, "task.succeeded", result, status="succeeded", result=result)
        except Exception as error:
            with self.guard, self.db:
                task = self.get(context.id)
                if context.cancelled.is_set() or isinstance(error, TaskCancelled):
                    self.fail(task, "cancelled", "cancelled", context.started)
                else:
                    code = error.code if isinstance(error, TaskFailure) else (
                        "task_timed_out" if isinstance(error, TimeoutError) else "executor_failed"
                    )
                    self.fail(task, "failed", code, context.started)
        finally:
            with self.guard:
                self.active.pop(context.id, None)

    def cancel(self, ident):
        with self.guard, self.db:
            task = self.get(ident)
            if task["status"] in TERMINAL:
                return {"accepted": False, "confirmed": task["status"] == "cancelled", "task": task}
            if not self.adapters[task["executorId"]].capabilities["cancel"]:
                raise ApiError(409, "unsupported_capability", "This executor does not support cancellation")
            if task["status"] != "cancelling":
                self.transition(task, "task.cancel_requested", {}, status="cancelling", inputRequest=None)
                self.active[ident].cancelled.set()
            return {"accepted": True, "confirmed": False, "task": task}

    def input(self, ident, body):
        with self.guard, self.db:
            task = self.get(ident)
            active = task.get("inputRequest")
            if task["status"] != "waiting_for_input" or not active or body.get("inputId") != active["id"]:
                raise ApiError(409, "input_not_pending", "Task is not waiting for that input")
            value = body.get("value")
            if not text(value, 4000):
                invalid("Input value must be a nonempty string of at most 4000 characters")
            self.transition(task, "task.input_received", {"inputId": active["id"]}, status="running", inputRequest=None)
            self.active[ident].answers.put_nowait(value)
            return task
