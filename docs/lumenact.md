# LumenAct optional expression plugin

Install `kei.lumenact.zip` in Kei Desktop 管理 → プラグイン. Grant `lumenact.select`, `lumenact.preview` and `lumenact.settings` as needed. Enable the package. The host is the existing SDK v1 host, and the renderer requires the Round 09 character bundle. The plugin is optional in all installation profiles.

1. Open 操作 in the desktop and select VRM. Open LumenAct 表情プレビュー in the administration window.
2. Choose a bundled clip by ID for an offline preview. The desktop VRM plays the original authored samples through its configured expression map. Press 停止 to clear the preview.
3. For real semantic selection, install the optional dependencies into the Python that launches the Kei host. Download the pinned model and resources to a local directory. In リソースと表情マップ, enter the absolute path to the resource root. Select `onnx`, save and reload the plugin. The admin page shows status and supports an optional line of dialogue. The upstream model expects Chinese descriptions.

```powershell
python -m pip install -r requirements-mcp.txt -r requirements-lumenact.txt
python tools/fetch_lumenact_assets.py <local-resource-root>
python -m kei_sdk.pack plugins/lumenact <output-directory>/kei.lumenact.zip
```

`resource_root` contains `models/semantic` and `models/expression`. The worker verifies the five official files with sizes and SHA-256 from the pinned release. The package does not download resources while running. Missing weights, dependencies or mapped targets return a diagnostic and the stage keeps its base face. Explicit fixed selection works without Python inference dependencies. The plugin page saves its scoped settings in the plugin's private data directory. Those values override the generic host configuration when saved from the plugin UI and take effect after reload. Direct host configuration applies when a private settings file has not been created.

## Curves and mapping

Both sample and full banks use the upstream `lumenact.curves.v1` little-endian float32 layout. The player reads each full span at its authored offset, width and sampling rate. The default map chooses a VRM emotion preset family from the selected label and maps relevant source shape channels into that preset. For a custom map, use a JSON object keyed by VRM preset or registered custom expression name. Each value is an array of source names without the `blendShape.` prefix.

```json
{
  "happy": ["mouth_smile_1", "mouth_smile_2"],
  "customBrow": ["eyebrow_up_L"]
}
```

Mapped sources are normalized from 0–100, averaged per target and multiplied by the configured strength. The stage interpolates between frames with a 140 ms edge fade. The role adapter skips missing targets and morphs that overlap the playable mouth, blink or gaze bindings. Emotion weights are composed with the existing base smile in one place. The base stage independently supplies the mouth from the actual playback clock, eyelid motion and gaze. Model expression override flags on composed emotions are neutralized so they cannot suppress those base layers. This is a VRM expression adapter. A channel-complete reconstruction requires a model rig that exposes the intended morph bindings.

## Trusted runtime contract

For VRM presets authored as binary, the role adapter binds a continuous morph-only expression while the clip owns that preset. It retains the native binary material/texture behavior during base idle and pointer expressions. This keeps sub-0.5 animated morphs visible without interpolating discrete texture atlas choices.

Use `KeiCharacterStage.get(stage).expressions.request(intent, text)` on the trusted desktop. Select VRM first. If the request accompanies a speech turn, start its playback lease before submitting the intent. The current release exposes a typed integration point for production dialogue. Acceptance exercises it with the actual playback source and a generated WAV. The dialogue/TTS producer integration remains a separate product item.

The adapter opens the designated `character-settings` entry using the existing scoped page broker. It receives only the owning window's tag and derives no authority from plugin iframe messages. `select`, `select.poll` and `select.cancel` use short worker actions and an asynchronous job. Admin preview delivers one payload from the authorized admin action. Fresh requests replace previous requests. Playback interruption, an explicit `expressions.interrupt()`, renderer switching, host disconnect and plugin page revocation discard old results. Cancelling a running ONNX job withdraws its result while the CPU work may finish in the private worker.

Run `python tests/backend_acceptance/verify_lumenact.py <host.pyz> <plugin.zip> [--resources <local-resource-root>]` for the separate offline and real ONNX cases. On Windows with the Round 08 model build variables set, run `npm --prefix character run build` from `frontend/`, set `KEI_LUMENACT_ZIP`, `KEI_LUMENACT_RESOURCES`, `KEI_HOST_ARTIFACT`, `KEI_HOST_PYTHON`, and `KEI_EVIDENCE_DIR`, then run `node tests/acceptance/lumenact.mjs`. This uses the real Electron windows and a chooser response fixture. The package notice records asset attribution.
