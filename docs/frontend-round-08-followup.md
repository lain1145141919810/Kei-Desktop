# Linux Round 08 shell merge and selected capture

The incoming frontend archive has SHA-256 `7800CFBE362E5DB5C12C27E04437216756BC913BBBF076C913BB2A21404C647F`. Applying its patch to Windows candidate `b2540dd57bd0bf9aa371726afd781b01c2458505` reproduced all 51 source hashes. The exact Linux import is `5053b61080999fbed7101cf344f1385f6caf8d5c`. The merge with the independent LumenAct change is `e7bc5122770b78a267dbca25d9c66246bd848b56`.

## Shared file changes

- `frontend/src/renderer/desktop/index.html` retains the Windows character mount, generated script, stylesheet and trusted desktop CSP. The imported capture control and indicator are present. The patch has one integrator.
- Claude's trusted URL, host origin, redirect, `file:` and one-shot `kei-page://` subframe rules are carried forward in the common shell.
- Windows is the single writer for the selected-capture follow-up. It revises `src/main/capture-service.js`, adds `src/main/selected-capture.js` and the minimal renderer under `src/renderer/capture/`, and stops capture when the desktop window closes. The separate capture renderer is sandboxed and has a dedicated session which allows only its own entry document and script.

## Capture interface

Source discovery requests identifiers and names with a zero-sized thumbnail. The trusted chooser shows eight entries per page with forward and backward navigation. It authorizes one identifier. The driver requests a video-only stream with that exact desktop capture ID and fails when the source is unavailable. It never substitutes a display or enumerates candidate pixels. The output frame goes only through the existing scoped host call.

Sessions are bound to the selected source, grant generation and main-owned conversation. A pending chooser is tied to an abortable request. On replacement, cancellation, plugin revocation, relevant page close, desktop close or host loss, the pending request and stream are revoked before a late result can be sent. The active stream closes immediately and the host cancels in-flight work before clearing its observation context. Host configuration and cleanup are serialized so late cleanup cannot overwrite a replacement.

`desktop-<uuid>` remains the temporary conversation ID for a shell without chat. When wiring chat, first update the trusted conversation accessor, then invoke `capture.onConversationChanged()` and await its completion before issuing a new capture authorization. The hook cancels outstanding old work. Plugin pages never supply the conversation or the source authorization.

## Plugin MCP confirmation

The message name is `kei:mcp-confirm`. A sandboxed plugin frame sends `{type: 'kei:mcp-confirm', id, serverId, toolName, arguments}`. Main identifies the plugin through the owned frame record, verifies the grant and tool access, asks for the user's decision and requests the host's one-use token for those exact arguments. The plugin passes the token into its own scoped mutation action. Cancelling the dialog yields no token. Read-only tools use the existing no-prompt path. Tokens are not interchangeable between callers, tools or argument sets.

## Reproduction notes

Run `npm test` in `frontend/` for containment and injected capture lifecycle tests. Use `tests/acceptance/run-visible-win.ps1` for the visible sandbox regressions. The capture scenario explicitly uses isolated byte fixtures and a chooser stub.

`node tests/acceptance/native-observation.mjs` runs the native Windows path. Set `KEI_OBSERVATION_ZIP`, `KEI_HOST_ARTIFACT`, `KEI_HOST_PYTHON` and `KEI_EVIDENCE_DIR`. Its source metadata is filtered to a uniquely titled test window. The test uses the native chooser and OS video capture for that window. An isolated loopback vision fixture checks the frame's markers. Native dialog input uses the owned Windows modal handle. When the operating system allows the isolated instance to register the shortcut, the test sends that accelerator. An occupied shortcut is recorded as skipped and the real desktop switch starts capture.

For a separate real MCP confirmation run, set `KEI_NATIVE_MCP_DIALOG=1` and run `run-visible-win.ps1 -Scenario plugin-mcp -EvidenceRoot <folder>`. It uses the native modal response and a local MCP fixture. The default fixture cases stay available without native dialog input.

Keep the capture boundary in main when continuing the common Linux shell work.
