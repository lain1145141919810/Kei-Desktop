# Kei execution API v1

Use the same authenticated loopback client and JSON envelope as the plugin API. The Electron main process submits user-authorized work, supplies attachments already staged below the configured workspace, and invokes computer operations only after confirmation in the desktop UI. The plugin page bridge in v1 does not expose these routes.

| Method and route | Purpose |
| --- | --- |
| GET /v1/executors | List stable adapter IDs, capability flags, availability, and reason codes. The DSH entry also includes available model aliases and child roles. |
| POST /v1/tasks | Create a durable task (202), or return the existing task for an exact repeat (200). A different payload with the same conversationId and requestId returns request_conflict. |
| GET /v1/tasks?conversationId=... | List the recent task snapshots in the conversation. |
| GET /v1/tasks/{id} | Read the current state, input request or terminal result. |
| GET /v1/tasks/{id}/events?after=0 | Read the next ordered event page. Continue from its cursor while hasMore is true. |
| POST /v1/tasks/{id}/cancel | Request cancellation (202, accepted=true, confirmed=false). Await task.cancelled or query the task for confirmation. |
| POST /v1/tasks/{id}/input | Supply an answer to the pending input request. Input includes inputId and value. |
| GET /v1/computer/apps?query=... | List registered Windows apps by display name and opaque ID. |
| POST /v1/computer/apps/open | Open a selected Windows app with {"id":"...","confirmed":true}. A success verifies Windows accepted launch. |

A task request contains executorId, requestId, conversationId and input. Optional fields are workspace, attachments, options and followUpTaskId. Defaults are the configured workspace, no attachments and no options. Paths resolve beneath the configured workspace. Attachment and artifact paths in the adapter request or response are relative to the task workspace. A follow-up is scoped to a succeeded task with the same executor, conversation and workspace. DSH accepts options.model (configured alias) and options.childRoles (explicit work or review roles mapped to aliases).

Statuses are queued, running, waiting_for_input, cancelling, succeeded, failed and cancelled. Events carry a one-based sequence, taskId, timestamp, type and data. Pending or running tasks found after an unclean restart become failed with runtime_restarted, and prior results and events remain queryable. The host does not replay interrupted operations. A started task that fails or is cancelled may have caused side effects. Task errors report a stable code and mayHaveSideEffects. Neither CLI requests nor raw provider errors are streamed into progress.

Example submission:

~~~
{"executorId":"dsh","requestId":"run-42","conversationId":"desktop-42","input":"Summarize notes.txt","attachments":["notes.txt"],"options":{"model":"flash"}}
~~~

## Operator configuration

Pass --executor-config to supply a JSON file. By default the host checks executors.json in its data directory. Typical fields include workspace, timeoutSeconds, dsh_entry, dsh_default, dsh_models and dsh_providers. DSH detects the locally installed CLI and uses its existing credential reference. Credential values stay out of task requests and logs. DSH uses a task-local SDK profile and retains the legacy workspace and permission restrictions.

On Windows, configure Codex using codex_executable, codex_verified_sha256, codex_validated_workspace and optional codex_model. Select a model advertised by the installed binary. The configured executable hash and task workspace must match the operator-approved values. Codex runs with workspace-write, no workspace network access and the pinned MXC policy. It does not inherit enabled MCP servers from the interactive client. The existing CLIs keep provider and authentication configuration. Missing or unapproved CLI availability does not prevent other adapters or the plugin host from starting.

Codex follow-up resumes the native thread when available. The DSH adapter creates a fresh worker for each task and passes the completed prior result as context for follow-up. Neither CLI advertises interactive approval or input. For artifact references, the native adapters accept validated workspace-relative paths returned with a KEI_ARTIFACT marker. Preserve references returned by the API.

## Add an external executor

Provide --executor-dir with a trusted directory of JSON manifests. An adapter declares a stable dotted id, name, integer apiVersion 1, argv array command, and capabilities from progress, cancel, input, attachments, artifacts and followUp. A registered adapter can appear in the desktop's selector without new routing code. Use a configured absolute executable or a program on the host PATH. Choosing this directory authorizes its native programs.

The adapter runs with the task workspace as its working directory. It reads one UTF-8 JSON line from stdin with type start, version, task and previous. It may write progress with a data object, and input with id and prompt if those capabilities were declared. For input it reads back a matching {"type":"input","id":"...","value":"..."}. It finishes by printing one result with text and artifacts and exiting successfully. Nonzero exit or missing result marks the task failed. Standard output is reserved for the protocol. Assign a bounded timeout in host configuration. On Windows the host owns each CLI's process tree. On POSIX it owns the new process group.

See the independently authored fixture and task API smoke evidence supplied alongside this release. Retain the v1 plugin endpoints and page bridge from the previous round.
