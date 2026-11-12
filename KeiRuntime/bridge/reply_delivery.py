"""Coalesce retried final replies without caching failures."""
import asyncio
import functools
import json
import inspect
import time

def deduplicate_final_replies(handler):
    entries = {}

    @functools.wraps(handler)
    async def wrapped(event):
        if event.type != 'assistant.reply' or not event.turn_id:
            return await handler(event)
        key = (event.session_id, event.turn_id, event.text,
               json.dumps(event.payload, ensure_ascii=False, sort_keys=True))
        now = time.monotonic()
        for old_key, (created, task) in list(entries.items()):
            if task.done() and (now - created > 600 or len(entries) > 256):
                entries.pop(old_key, None)
        entry = entries.get(key)
        if entry is None:
            task = asyncio.create_task(handler(event))
            entries[key] = (now, task)
            def remove_failure(done):
                if done.cancelled() or done.exception() is not None:
                    if entries.get(key, (None, None))[1] is done:
                        entries.pop(key, None)
            task.add_done_callback(remove_failure)
        else:
            task = entry[1]
        # A disconnected publisher must not cancel an accepted delivery.
        return await asyncio.shield(task)

    # FastAPI must resolve postponed annotations in the handler's module.
    wrapped.__signature__ = inspect.signature(handler, eval_str=True)
    return wrapped
