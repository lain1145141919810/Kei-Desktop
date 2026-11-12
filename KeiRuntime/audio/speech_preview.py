"""Private first-sentence synthesis; playback is only allowed by the normal caller."""
import asyncio


class SpeechPreview:
    def __init__(self, source):
        self.source = source
        self.text = None
        self.task = None
        self.queue = None
        self.validated = False

    def clear(self):
        if self.task and not self.task.done():
            self.task.cancel()
        self.task = self.queue = self.text = None
        self.validated = False

    def start(self, text):
        self.clear()
        if not text or len(text) > 120:
            return
        self.text = text
        print(f'[Kei Preview] start chars={len(text)}', flush=True)
        queue = self.queue = asyncio.Queue(maxsize=32)
        async def produce():
            size = 0
            try:
                async for chunk in self.source(text):
                    size += len(chunk)
                    if size > 2_000_000:
                        raise ValueError('Preview exceeds audio budget')
                    await queue.put(chunk)
                await queue.put(None)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await queue.put(exc)
        self.task = asyncio.create_task(produce())

    def validate(self, text):
        if text != self.text:
            self.clear()
        else:
            self.validated = True

    def take(self, text):
        if not self.validated or self.text != text or not self.queue:
            return None
        queue, task = self.queue, self.task
        self.queue = self.task = self.text = None
        print('[Kei Preview] validated audio reused', flush=True)
        async def consume():
            try:
                while True:
                    chunk = await asyncio.wait_for(queue.get(), 30)
                    if chunk is None:
                        break
                    if isinstance(chunk, Exception):
                        raise chunk
                    yield chunk
            finally:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        return consume()
