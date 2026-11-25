# Kei MCP client API v1

Kei uses the official MCP Python SDK pinned at 2.2.0. Install requirements-mcp.txt in the Python environment that runs kei-host.pyz. The dependency is optional for the core and plugin host. A host with an empty MCP registry can start without the SDK. The registry reports sdkAvailable.

The SDK negotiates protocol versions per server. The verified fixtures used stdio with 2026-07-28 discovery and Streamable HTTP with the 2025-11-25 initialization handshake. Use protocolMode auto (default) for negotiation and legacy for a service that expects the older handshake. The supported application surface is tool discovery and invocation. Each result identifies its configured server and tool.

## Management

Use the existing local authenticated API envelope. The Electron main process owns the connection credentials. The following routes require the local Bearer descriptor.

| Route | Request and behavior |
| --- | --- |
| GET /v1/mcp/servers | SDK version/availability, per-server configuration and state, sanitized diagnostic code and negotiated capabilities when connected. |
| PUT /v1/mcp/servers/{id} | Replace the server definition. A change retires its old connection and requests. |
| POST /v1/mcp/servers/{id}/enabled | {"enabled":true} enables on-demand connection, false disconnects and cancels work for this server. |
| DELETE /v1/mcp/servers/{id} | Remove the server and release it. Existing call receipts remain available after the same ID is reconfigured. |
| GET /v1/mcp/servers/{id}/tools | Connect on demand and list all tool pages, including input/output schemas when returned. |
| POST /v1/mcp/servers/{id}/refresh | Bypass the discovery cache. |
| POST /v1/mcp/servers/{id}/reconnect | Retire the previous transport and refresh discovery through a new connection. |
| POST /v1/mcp/servers/{id}/call | Invoke a specific tool. Required requestId and toolName, optional arguments object and confirmed boolean. |
| POST /v1/mcp/cancel | {"requestId":"..."} requests cancellation of a desktop call. Observe its terminal reply for the result and uncertainty. |
| POST /v1/mcp/confirm | Generate one-use confirmation for a scoped plugin call. The trusted UI supplies pluginId, serverId, toolName, arguments and confirmed=true after the user confirms. |

Server definitions use the transport string stdio or streamable-http, plus name, optional enabled, timeoutSeconds (1–60), protocolMode, readOnlyTools, pluginAccess and credentialRef. Stdio takes command, args and optional cwd. Streamable HTTP takes the exact url. The credentials are loaded from the host process environment at connection time. Use {"env":"MY_SERVICE_TOKEN"} for an HTTP Bearer token, or {"env":"MY_SERVICE_TOKEN","target":"EXTERNAL_TOOL_TOKEN"} for stdio. URLs with Bearer credentials require HTTPS or loopback HTTP. Do not put secrets in the command arguments or URL. Management responses show configured reference names. Command arguments stay in the local operator configuration and are omitted from responses.

Example stdio config:

~~~
{
  "name": "Local fixture",
  "transport": "stdio",
  "command": "python",
  "args": ["mcp_fixture.py", "stdio", "fixture.log"],
  "cwd": "/path/to/fixture",
  "readOnlyTools": ["echo"],
  "pluginAccess": {"studio.example": ["echo", "change"]}
}
~~~

Status values are idle, connecting, ready, offline and disabled. Tool listing and reconnect use independent transports for each server ID. Unknown/offline credentials and missing executables return a sanitized reason code. A failed transport reconnects on the next eligible explicit operation.

## Calls and confirmation

Use the pair (serverId, toolName), even for uniquely named tools. Read-only classification comes from the operator's readOnlyTools list. Other calls require explicit confirmation. An exact repeated requestId for the same owner and arguments returns its stored receipt. A conflict returns request_conflict. A request that was pending when the host stopped yields mcp_outcome_unknown and mayHaveRun=true. Reconnect or UI timeout must never issue another request ID automatically.

A delivered result contains content, structuredContent and isError as supplied by the protocol. isError=true is a tool-level result. MCP protocol errors use mcp_protocol_error and protocolCode when available. Transport errors and timeout/cancellation have distinct codes. mayHaveRun=true means the remote operation might have started. Cancellation is cooperative with the remote service. Host call receipts are deployment data under the chosen data directory.

## Plugin broker

A plugin declares and receives the mcp.call grant along with its page action scope. An operator lists eligible tool names under pluginAccess for each server. From an action, the plugin uses:

~~~
context.call_mcp(server_id, tool_name, arguments, request_id, confirmation=token)
~~~

The confirmation is unnecessary for an operator-designated read-only tool. For other tools the desktop confirmation route returns a token bound to that exact plugin, server, tool and arguments for one use within 60 seconds. The page bridge passes it through the approved action. Catch kei_sdk.MCPCallError for stable code and details. Python plugins remain trusted native code. Only the host broker can use its configured credential references. When a plugin is disabled or reloaded, that generation's pending calls and page subscriptions are revoked. Unrelated consumers retain the transport.

## Run with the pinned SDK

~~~
python -m venv .venv-mcp
# Use that environment's python for the following commands.
python -m pip install -r requirements-mcp.txt
python kei-host.pyz --data-dir ./kei-test-data --port 0
python verify_mcp.py kei-host.pyz
~~~

The verifier launches both portable MCP fixture transports on loopback. It authenticates the fixtures with synthetic environment values and tests scope, two-page tool discovery, structured results, transport isolation, uncertainty after disconnect/restart, and cleanup. Sources for the wire behavior are the [official SDK releases](https://github.com/modelcontextprotocol/python-sdk/releases) and [transport documentation](https://py.sdk.modelcontextprotocol.io/client/transports/).
