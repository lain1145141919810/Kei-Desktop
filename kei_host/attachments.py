"""Trusted desktop attachment references, independent of optional extraction."""
import base64
import json
import sqlite3
import threading
from uuid import uuid4

from .execution.tasks import within
from .package import ApiError

MAX_FILE = 20 * 1024 * 1024
MAX_EXCERPT = 256 * 1024


def check_conversation(value):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= 100


class Attachments:
    def __init__(self, root, workspace):
        self.workspace = workspace
        self.guard = threading.RLock()
        self.db = sqlite3.connect(root / "attachments-v1.sqlite3", check_same_thread=False)
        self.db.execute("""CREATE TABLE IF NOT EXISTS attachment_refs (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, document TEXT NOT NULL)""")
        self.db.commit()

    def close(self):
        self.db.close()

    def register(self, body):
        conversation = body.get("conversationId")
        if not check_conversation(conversation):
            raise ApiError(422, "invalid_attachment", "Provide a valid conversationId")
        path = within(self.workspace, body.get("path"), file=True)
        length = path.stat().st_size
        if length > MAX_FILE:
            raise ApiError(413, "attachment_too_large", "Attachment exceeds 20 MiB")
        ident = uuid4().hex
        record = {"id": ident, "name": path.name, "path": path.relative_to(self.workspace).as_posix(), "size": length}
        with self.guard, self.db:
            self.db.execute("INSERT INTO attachment_refs VALUES(?,?,?)", (ident, conversation, json.dumps(record)))
        return record

    def prefix(self, conversation, ident):
        if not check_conversation(conversation) or not isinstance(ident, str) or len(ident) > 100:
            raise ApiError(403, "attachment_scope_denied", "Attachment needs the current conversation")
        with self.guard:
            row = self.db.execute("SELECT document FROM attachment_refs WHERE conversation=? AND id=?",
                                  (conversation, ident)).fetchone()
        if row is None:
            raise ApiError(403, "attachment_scope_denied", "Attachment is outside the current conversation")
        record = json.loads(row[0])
        try:
            target = within(self.workspace, record["path"], file=True)
            with target.open("rb") as file:
                data = file.read(MAX_EXCERPT + 1)
        except (OSError, ApiError) as error:
            raise ApiError(404, "attachment_unavailable", "The staged attachment is unavailable") from error
        return {"name": record["name"], "data": base64.b64encode(data[:MAX_EXCERPT]).decode("ascii"),
                "truncated": len(data) > MAX_EXCERPT}
