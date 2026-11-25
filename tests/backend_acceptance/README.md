# Maintained host MCP acceptance

These scripts use the frozen host archive as a subprocess and local stdio and Streamable HTTP MCP fixtures. Install the repository's `requirements-mcp.txt` into an isolated Python environment.

```text
python tests/backend_acceptance/verify_mcp.py <kei-host.pyz>
python tests/backend_acceptance/host_smoke.py <kei-host.pyz> <studio.counter.zip>
```

Use `verify_mcp.py` alone for the seven MCP groups. Linux disconnect and hard-restart tests kill the owned process intentionally while a confirmed mutation is in flight. Other teardown requests graceful termination before reaping with a bounded fallback. The Uvicorn fixture uses a two-second graceful-shutdown deadline. This allows the suite to verify transport failure and replay safety on the same host artifact.
