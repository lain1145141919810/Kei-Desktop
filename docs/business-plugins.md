# Core chat, PDF selection and Bilibili integration

## Core conversation API

Give the host a chat.json in its data directory or pass --chat-config <file>. Configure an HTTPS or loopback HTTP Chat Completions endpoint, model, optional credentialRef environment-variable name, and optional timeoutSeconds. Credential values remain in the host process. Example:

~~~
{
  "endpoint": "https://api.deepseek.com/chat/completions",
  "model": "deepseek-flash",
  "credentialRef": "DEEPSEEK_API_KEY",
  "timeoutSeconds": 25
}
~~~

The trusted renderer bridge uses the authenticated host envelope. POST /v1/chat/ask takes conversationId, requestId, question, optional turnId and optional selection. Selection is an object with text, source and page. Use null for an unknown page. The request returns a new queued turn with 202, or a stored turn with 200 for an exact retry. Changing a request with the same conversationId and requestId yields chat_request_conflict. GET /v1/chat/turns/{turnId} observes queued, running, completed, failed or cancelled. POST /v1/chat/turns/{turnId}/cancel requests cancellation. GET /v1/chat/turns?conversationId=... restores that conversation after restart. The response contains reply on success or error with stable code and message. Turns that were still in progress after unclean shutdown are recorded as failed with chat_host_restarted.

Completed history is kept locally per conversation. The current user's explicitly selected text is added to that one provider turn. This interface implements non-streaming text responses. Live audio, long-term memory and the optional AstrBot connector have separate milestones.

The chat.ask grant lets a plugin action submit a question with context.ask_chat(request_id, question, selection=selection, turn_id=turn_id). The host obtains the conversationId from the trusted POST /v1/pages/call context object, independent of the action's declared arguments. The trusted main/renderer bridge must bind the active conversation and must not let an iframe choose it. A plugin generation's in-flight broker calls are cancelled on teardown. ChatAskError exposes the stable error code.

## PDF plugin

Install kei.pdf.zip and choose pdf.read, pdf.write, pdf.migrate and chat.ask for the required surfaces. The Windows selection adapter follows the earlier UI Automation TextPattern workflow. Register Ctrl+Alt+Q in trusted desktop code, capture user-selected text from the focused external reader before changing focus, then open plugin kei.pdf/selection and forward a source-checked kei:selection message with text, source and page. Keep page null unless the reader provides it. Block whitespace-only selection before sending. The supplied windows-read-selection.ps1 is the frozen baseline reference for the trusted Windows implementation.

The reading extension and settings pages offer plans and progress, notes, migration and selection QA. Display these pages in the existing Japanese reading entry. Legacy import receives the parsed reading-plans.json array through the admin legacy.import action. It preserves IDs, progress and existing notes. Keep the source file as recovery evidence; use bounded chunks for large files and log their migration IDs. The selected page action limit is 2 MiB per request. A repeated exact batch is idempotent. legacy.rollback removes only untouched rows added by that migration, protecting subsequent user changes. The package contains no embedded PDF engine.

Fixture acceptance verified the explicit selected text at the provider, unknown page handling, no provider call for empty text, conversation isolation, stored notes, progress correction, repeat import, rollback, a fully populated 200-note legacy plan and restart recovery. Actual external reader plus global shortcut and the original formal Japanese UI remain to be verified together.

## Bilibili plugin

Install kei.bilibili.zip and configure its server_id to a Kei MCP registry ID. Grant bili.read and mcp.call for read operations, and bili.interact only for authorized interactions. Add allowed names to that server's pluginAccess for kei.bilibili. Operator-designated read-only queries map search to bili_search, detail to bili_video_info and account status to bili_check_credential. Connection settings and credentials remain managed by the core MCP client. Query results preserve upstream content and expose a stable account_required status for expired credentials.

For a side-effecting operation the desktop page calls prepare. Validate the resulting draft belongs to the exact open plugin page and present the server, tool and operation arguments in a trusted confirmation dialog. The iframe uses kei:mcp-confirm with draft and request ID. Only after confirmation may the trusted main process POST /v1/mcp/confirm with the exact prepared arguments and confirmed=true. Return the resulting opaque token to the requesting frame as kei:mcp-confirmation with the original iframe request ID and result. The frame then calls interact with the original operation, unchanged arguments/requestId and token. Reject stale page generations and forged draft or token messages. The broker enforces confirmation for Bilibili writes regardless of the server's read-only labels.

The default interaction map has comment via bili_reply and dynamic via bili_send_dynamic. Optional like and follow mappings require a configured server exposing the corresponding operations. The earlier autonomous schedule and vision preview are separate migration gaps. Read-only search ran against the existing Bilibili MCP installation; write and expired-account scenarios used the recording fixture. A disconnected attempted interaction reports outcome_unknown. Reconnect retains the same request receipt and avoids repeat submission.

Plugin packages can be installed, disabled and removed independently. Disabling either leaves ordinary chat, the other plugin and its separately owned services operational.

See [DeepSeek's documented Chat Completions contract](https://api-docs.deepseek.com/api/create-chat-completion/) for the real provider smoke protocol.
