"""Bounded subprocess transport for plugin workers."""
import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

from .worker import MAX_LINE

TIMEOUT = 4.0
MODEL_TIMEOUT = 20.0


class WorkerFailure(Exception):
    def __init__(self, message, reason="worker_failed"):
        super().__init__(message)
        self.reason = reason


def runtime_path():
    if getattr(sys.modules["__main__"].__loader__, "archive", None):
        return sys.modules["__main__"].__loader__.archive
    return str(Path(__file__).resolve().parents[1])


class Worker:
    def __init__(self, plugin, data, broker=None):
        self.broker = broker
        self.closed = False
        self.gate = threading.Lock()
        self.close_guard = threading.Lock()
        env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        entry = "import sys; sys.path.insert(0,sys.argv.pop(1)); from kei_host.worker import run; run()"
        self.child = subprocess.Popen(
            [sys.executable, "-I", "-B", "-u", "-c", entry, runtime_path(), str(plugin), str(data)],
            cwd=plugin, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.broken = False
        self.answers = queue.Queue(maxsize=2)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        stream = self.child.stdout
        try:
            while True:
                line = stream.readline(MAX_LINE + 2)
                if not line or len(line) > MAX_LINE + 1:
                    break
                self.answers.put_nowait(json.loads(line))
        except (OSError, ValueError, queue.Full):
            pass
        finally:
            try:
                self.answers.put_nowait(None)
            except queue.Full:
                pass

    def _send(self, data):
        try:
            self.child.stdin.write(data)
            self.child.stdin.flush()
        except OSError:
            try:
                self.answers.put_nowait(None)
            except queue.Full:
                pass

    def exchange(self, message, timeout=TIMEOUT):
        if self.closed or self.broken:
            raise WorkerFailure("Plugin worker is unavailable")
        data = json.dumps(message, ensure_ascii=True, allow_nan=False) + "\n"
        sender = threading.Thread(target=self._send, args=(data.encode("ascii"),), daemon=True)
        sender.start()
        try:
            response = self.answers.get(timeout=timeout)
        except queue.Empty:
            self.broken = True
            raise WorkerFailure("Plugin worker did not respond", "worker_unresponsive") from None
        if not isinstance(response, dict):
            self.broken = True
            raise WorkerFailure("Plugin worker exited unexpectedly", "worker_failed")
        sender.join(timeout=1)
        return response

    def request(self, method, *, broker_context=None, timeout=TIMEOUT, **arguments):
        with self.gate:
            if self.closed:
                raise WorkerFailure("Plugin worker was closed")
            message = {"method": method, **arguments}
            if method == "call" and isinstance(broker_context, dict):
                message["conversationId"] = broker_context.get("conversationId")
            response = self.exchange(message, timeout=timeout)
            for _request in range(16):
                kind = response.get("broker")
                if kind not in ("mcp", "chat", "vision", "attachment"):
                    if response.get("ok") is not True:
                        raise WorkerFailure("Plugin rejected the operation", "initialize_exception" if method == "activate" else "action_exception")
                    return response["data"], response["events"]
                if method != "call" or self.broker is None:
                    message = {"ok": False, "error": {"code": kind + "_scope_denied", "message": "Plugin has no grant for this service"}}
                else:
                    message = self.broker(kind, response.get("parameters"), broker_context)
                response = self.exchange(message, timeout=timeout)
            self.broken = True
            raise WorkerFailure("Plugin exceeded its broker call limit")

    def close(self):
        with self.close_guard:
            if self.closed:
                return
            self.closed = True
            acquired = self.gate.acquire(blocking=False)
            try:
                if not acquired:
                    # A broker callback can need the host lock held by revoke.
                    # Kill and reap the worker without waiting on its request lock.
                    self.broken = True
                self.stop()
            finally:
                if acquired:
                    self.gate.release()

    def stop(self):
        try:
            if self.child.poll() is None and not self.broken:
                threading.Thread(target=self._send, args=(b'{"method":"shutdown"}\n',), daemon=True).start()
                self.child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        finally:
            if self.child.poll() is None:
                self.child.kill()
                self.child.wait(timeout=2)
            self.child.stdin.close()
            self.reader.join(timeout=1)
            self.child.stdout.close()
