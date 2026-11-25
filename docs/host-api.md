# Kei host API v1

The trusted Electron main process launches dist/kei-host.pyz with an explicit --data-dir and reads connection.json. Requests use Authorization: Bearer <token>. Browser-origin requests are rejected. Install uses application/zip and JSON mutations use application/json. The response is {"apiVersion":1,"data":...} or {"apiVersion":1,"error":{"code":"...","message":"..."}}. Persist your desktop selection by pluginId and entry ID, not by an ephemeral session ID.

| Method and path | Input and success | Common errors |
| --- | --- | --- |
| GET /v1/status | ready state, epoch and installed count | unauthorized |
| GET /v1/plugins | Plugin ID, name, version, apiVersion, permissions, enabled, grants, lastError | unauthorized |
| POST /v1/plugins/install | Raw ZIP, returns disabled plugin (201) | invalid_archive, invalid_manifest, unsupported_api, plugin_exists |
| POST /v1/plugins/{id}/enable | {"grants":["greeting.read"]}, returns enabled plugin | plugin_not_found, invalid_grants, activation_failed |
| POST /v1/plugins/{id}/disable | {}, returns disabled plugin | plugin_not_found |
| POST /v1/plugins/{id}/reload | {}, creates fresh worker and requires pages to reopen | plugin_disabled, activation_failed |
| DELETE /v1/plugins/{id} | {"retainData":true}, returns ID and retention flag | plugin_not_found |
| GET /v1/entries | Active entries sorted by slot, order, plugin ID and entry ID | unauthorized |
| POST /v1/pages/open | {"pluginId":"example.hello","entryId":"desktop"}, returns sessionId, entry, html, cursor (201) | plugin_disabled, entry_not_found, page_limit |
| POST /v1/pages/call | {"sessionId":"...","action":"greet","arguments":{"name":"ケイ"}}, returns {"result":...} | page_closed, scope_denied, action_failed |
| GET /v1/pages/events?sessionId=...&after=0 | Plugin messages for an open session. Returns epoch, cursor, reset and events. | page_closed |
| POST /v1/pages/close | {"sessionId":"..."}, returns {"closed":true} | page_closed |
| GET /v1/events?after=0 | Host lifecycle events. Returns epoch, cursor, reset and events. | invalid_request |

Event sequences are shared across the process. Lifecycle types are plugin.installed, plugin.enabled, plugin.disabled, plugin.reloaded, plugin.activation_failed and plugin.uninstalled. A plugin message uses type plugin.message and a data object containing topic and data. Scope page event calls to the applicable page session and advance cursors separately. On epoch change or reset=true, refresh registry data and close stale sessions. Bounded retention is 512 events. Stop polling closed sessions. A stalled worker is revoked and its pages close. Reload invalidates every former session even when the package remains enabled.

## Electron integration

Use trusted renderer/main IPC for management and page operations. Verify the sender in main. Keep connection details and page session IDs in main or in the privileged renderer bridge. A plugin document gets a separate sandboxed iframe without allow-same-origin. Allow scripts and start its srcdoc with a host-controlled CSP before the packaged HTML. Start from default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'. Deny frame navigations, popups, network requests and downloads in Electron main and never expose Electron preload APIs to the child frame. Preview iframe content uses inline scripts and styles.

Tag a page and keep its session associated with its exact frame. Accept only structured messages arriving from that frame's contentWindow. Validate message ID, action, arguments, size and frequency. Map the frame to its existing session. Do not let a child provide another session ID, a host URL or management actions. Treat a child navigation as a closed page. Reply only to that frame with the matching request ID. The same page may be installed in multiple slots.

| Direction | Example |
| --- | --- |
| Page to frame host | {"type":"kei:call","id":"greet","action":"greet","arguments":{"name":"ケイ"}} |
| Frame host to page | {"type":"kei:result","id":"greet","ok":true,"result":{"message":"ケイさん、こんにちは。"}} |
| Frame host to page | {"type":"kei:result","id":"greet","ok":false,"error":{"code":"scope_denied","message":"..."}} |
| Frame host to page | {"type":"kei:event","topic":"greeting.completed","data":{"name":"ケイ"}} |

For every disable, reload, uninstall, host disconnect or page_closed response, immediately remove the corresponding frames and stop their polling. Refresh entries after lifecycle changes. Localize errors using the stable error codes. Finalize the live Electron slot and accessibility validation with an installed external package and a clean data directory.
