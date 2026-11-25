# Kei backend distribution profiles

Both profiles ship the same host executable archive. Minimal contains the reusable core and no business packages. Full includes the PDF, Bilibili, screen observation, focus timer and attachment extraction ZIPs. LumenAct and HAST-SEC are independent add-ons.

Start the candidate in a fresh data directory and apply the chosen profile from the extracted archive:

~~~
python kei-host.pyz --data-dir ./kei-data --port 0
python install_profile.py profile.json kei-data/connection.json
~~~

Use Python 3.11 or later. When using MCP with Full, install requirements-mcp.txt into the host's environment. The installer checks every ZIP digest before sending packages to the local host. It stages new packages disabled. Enable only the desired features through a trusted client. Screen capture still requires a new explicit selection of the display or window at each activation.

Apply Full to a Minimal data directory to add packages. Reapplying the same profile keeps existing versions, configuration, grants and data. The optional --upgrade applies newer included versions by API and preserves plugin-local data and state. The upgrade route revokes stale sessions, checks settings and grants, and restarts previously enabled plugins. It restores the previous package on activation failure and keeps a recovery journal until commit. Native packages own their data migrations inside plugin-private storage.

Use a copy of old data when migrating. Import reading plans through the PDF admin interface. Import the previous kei-pomodoro localStorage record into the focus plugin and preserve the original backup. The old local desktop conversation and executor formats remain a separate migration task. Choosing Minimal for an existing full installation does not delete plugins.

## Frontend integration

### Screen observation

The trusted Electron main process handles the capture request, chooses a display or window with the user's approval, and starts the capture loop only on a successful scoped configure action. Route the original Ctrl+Alt+S entry to this flow. Pass sourceId, kind and generation to capture. On POST /v1/pages/call, set context.conversationId and context.capture={authorized:true,sourceId,kind} from the trusted active source. Forward bounded JPEG or PNG bytes as image={mime,base64}. A normal plugin iframe cannot set this trusted context.

Configure the vision section of chat.json with an OpenAI-style image-capable Chat Completions endpoint, model and optional credentialRef. The host never stores input frames. The plugin retains only its most recent short description for the consented conversation and configured TTL. It rejects stale, wrong-source and throttled frames, and exposes the transient description through observation.context for an explicitly relevant chat turn.

Stop the trusted capture loop immediately on user stop, page disposal, disable, reload or unsubscribe. For an active provider request, POST /v1/pages/capture/cancel with the active sessionId, then send configure disabled to clear the transient context. Any new activation begins capture stopped. The old compact window previously enabled observation; restore this only when the user grants the same trusted capture permission. Computer control stays in core.

### Focus timer

Mount kei.focus/timer from the original timer entry. Keep the legacy presets 25/5/15, 50/10/20 and 15/3/10, including a long break after the fourth focus block. Tick the active timer through the trusted bridge even if the visible panel is closed. Use claim with the notice ID before delivering the native notification. The persisted claim prevents duplicate notifications. A phase overdue by more than one minute after sleep or a closed app advances silently and pauses, as in the old timer. Import the previous kei-pomodoro object through legacy.import in the admin entry. Standalone natural-language reminders are a different feature and were not imported into this timer.

### Attachments

Keep normal file drag/drop and task inputs in the trusted client. The legacy behavior stages up to five files of at most 20 MiB into the configured executor workspace and stored references work independently of the extraction package. Register a staged relative path and current conversation with POST /v1/attachments. The result has id, name, path and size. Use path for the core task attachment reference and id for the plugin. On attach extraction, the trusted page context supplies the current conversation, and the plugin receives a bounded authorized prefix. UTF-8 and UTF-8 BOM text are supported. Binary remains available as an ordinary path reference. Extraction exposes start, status and cancel; disabling stops jobs and leaves staged files available to core.

### Bilibili compatibility

Bilibili 0.2 adds user-enabled scheduled read-only search and explicit video preview. Its default fixture-compatible schedule is 09:00–10:00 Asia/Tokyo, disabled until configured. The trusted UI ticks the configured schedule while active. Each day's attempt is recorded before request dispatch and remains nonrepeatable after restart. A tool identified as read-only in the registry is required for scheduled calls. Creating and publishing a user-authorized interaction still uses the scoped single-use confirmation.

Select the preview tool in plugin settings. The stock upstream info tool supplies text metadata. For video evidence, configure a server tool which returns structuredContent.evidence entries with bounded PNG/JPEG data. Verified media fixtures exercise failure and recovery. Actual deployment-specific video frame extraction, longitudinal vision review and older autonomous writing remain separate integration gaps.
