"""Explicit operator smoke tests; does not run on application startup."""
import asyncio
import json
import sys
import time
from bridge.executors import CONFIG, RpcWorker


async def main():
    config = json.loads(CONFIG.read_text(encoding='utf-8'))
    for backend in sys.argv[1:] or ['dsh', 'codex']:
        worker = RpcWorker(backend, config)
        start = time.perf_counter()
        try:
            await worker.start()
            print(json.dumps({'backend': backend, 'handshake': 'ok', 'pid': worker.proc.pid,
                              'elapsed_s': round(time.perf_counter() - start, 3)}), flush=True)
        except Exception as exc:
            print(json.dumps({'backend': backend, 'handshake': 'failed', 'type': type(exc).__name__,
                              'error': str(exc)}), flush=True)
        finally:
            await worker.close()
            print(json.dumps({'backend': backend, 'exited': worker.proc is None or worker.proc.returncode is not None}), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
