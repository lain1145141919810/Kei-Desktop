# Optional AstrBot memory handoff

The independent `kei.astrbot-memory.zip` adapter implements the existing Kei-to-AstrBot completed-transcript handoff direction. Kei starts, stores its conversations and serves its existing APIs without an AstrBot instance.

1. Install the ZIP through Kei administration, then set `bridge_origin` to the existing authorized loopback bridge, for example `http://127.0.0.1:17882`. Set `token_file` to the absolute path to that bridge's local credential file.
2. Enable only the needed `astrbot.memory.read` and `astrbot.memory.handoff` grants. Open **AstrBot 記憶の引き継ぎ** in administration.
3. Paste the selected transcript and confirm that the text can be transferred. The page accepts a UUID under `sessionId` and a `messages` array of `{role, content, timestamp, status?}` objects. Provide timestamp offsets. Assistant messages need `status: "completed"`. Include both user and assistant messages.
4. Read the resulting batch ID and its native import status. Resume is available only for a batch this adapter accepted. The adapter does not automatically read, export, or replay local conversation history.

The adapter sends only to the explicitly configured loopback endpoint. It disallows redirects and proxies, reads the credential from the selected local file, and persists only digests and batch IDs. An identical accepted transcript returns its existing batch. A transport failure after submission is treated as an unknown outcome and is not retried automatically. Inspect the AstrBot importer for the corresponding session before retrying through a fresh operator-approved transfer.

The bridge contract uses POST `/handoff`, GET `/handoff/{batch_id}`, and POST `/handoff/{batch_id}/resume` with the existing `X-Kei-Bridge` header. Installing the Kei package does not start or configure AstrBot. Native processing and its summary provider remain the AstrBot operator's responsibility.

The verification harness uses installed AstrBot and MemoryCompanion in a separate profile, with synthetic records. It distinguishes native batch submission, a paused import without a summary provider and any processing run that uses a local summary model fixture.
