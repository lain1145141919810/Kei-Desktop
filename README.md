# Kei Desktop 1.0

Kei Desktop is an unofficial desktop companion. Its Electron shell connects to a local Python host for chat, character performance, plugin administration and optional tools. This branch is the 1.0 **source preview**. Windows release installers and a completed Round 27 acceptance report are still pending.

## Build and run on Windows

Use Node.js with npm and Python 3.11 or newer. The integration was tested with Node 24, Python 3.11 and Electron 44.11.6.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe build.py
npm --prefix frontend ci
npm --prefix frontend/character ci
npm --prefix frontend/character run build
.\Launch-Kei.cmd
```

The normal launcher uses a new profile beneath LocalAppData and starts the bundled host on a random loopback port. A character-less build can open the shell and its admin UI. For development on another platform, set KEI_HOST_ARTIFACT to the absolute path of dist/kei-host.pyz and KEI_HOST_PYTHON to the virtual environment's Python, then run npm --prefix frontend start. Platform-specific window and capture features still need their own validation.

## Chat, models and plugins

- Open 「管理 → モデル → 会話モデル」. Enter an authorized OpenAI-compatible Chat Completions endpoint and model ID. Use an environment variable name for the credential reference, then select 「接続テスト」 and 「保存」. Restart if the host needs to inherit a newly set environment variable. A successful connection probe checks reachability and response format. Multi-turn acceptance is a separate test.
- Turn on 「操作 → ケイの声で読み上げる」 and choose an installed TTS provider under 「管理 → モデル」. Aqua/GPT-SoVITS requires an independently configured local service. The source tree supplies the integration code. Windows SAPI and other model providers are optional plugins.
- Package a trusted plugin with .venv\Scripts\python.exe -m kei_sdk.pack plugins/hastsec kei.hastsec.zip, then install it in the management window and enable only the required scopes. HAST-SEC needs the matching user-local solver checkout. Install requirements-mcp.txt into the host environment before configuring optional MCP connections.
- The local host API is version 1. Its connection descriptor is generated per run and grants access to authenticated local clients. Keep it, chat histories, model settings and credentials in the user profile.

[Plugin author guide](docs/plugin-author.md) · [Host API](docs/host-api.md) · [Plugin management](docs/plugin-admin.md) · [Model providers](docs/model-providers.md) · [MCP](docs/mcp-api.md) · [Task executors](docs/execution-api.md)

## Local artwork and character assets

The source preview has neutral placeholders. To build with a model you have permission to use, set KEI_VRM_MODEL to a self-contained VRM, or set KEI_LIVE2D_MODEL to a local model3.json and KEI_CUBISM_SDK to the local Cubism SDK. Run npm --prefix frontend/character run build again. Optional opening and closing media can be selected in the app. Generated bundles may embed the supplied assets, so keep personalized bundles, voice weights, recordings and profiles local. See [character setup](docs/character-stage.md) and the [distribution profiles](docs/installation-profiles.md).

## Verification status

The R26 Windows integration ran 88 unit tests, three visible cold launches with an actual HAST-SEC/VRM first requested motion, five disable/enable cycles and two Admin reconnect runs on Electron 44.11.6. The speech path was checked with scripted loopback chat, real local Aqua and the application's Windows audio-session output. Simulated timing, scheduled audio start and measured output signal describe different stages. Round 27 still needs independent extended cold starts, a matched real-provider conversation, and rollback and profile-migration validation. The public placeholder artwork is specific to this source snapshot.

**Existing profile migration is a release blocker.** One older Windows trial directory was found to inherit broad full-control permissions. Start 1.0 with a fresh user-private profile. Migration of existing chats, settings and databases requires preserving the originals and validating access controls on the migrated copy. Do not use the older shared workspace directory as the new profile.

Source code is under [MIT](LICENSE). Separately licensed plugin sample data retains its accompanying notices.
