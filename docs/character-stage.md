# Windows character stage

The character module mounts in the trusted Electron desktop renderer at `#character-stage`. The Japanese shell owns the background, toolbar, plugin sheets and management window. The stage owns one active transparent canvas and one animation callback. It keeps the selected renderer and the CG and compact stage preferences in the Electron profile.

## Build and run

Use Node.js and PowerShell 7 on Windows. Install the shell and build dependencies from the two lockfiles. Build credentials and user private models can stay outside the checkout. The runtime bundle is generated and stays out of Git.

```powershell
Set-Location <checkout>/frontend
npm ci
$env:KEI_VRM_MODEL = '<path to Seed-san.vrm or a self-contained VRM>'
$env:KEI_CUBISM_SDK = '<local Cubism SDK for Web 5-r.5 directory>'
$env:KEI_LIVE2D_MODEL = '<local .model3.json path>'
npm --prefix character ci
npm --prefix character run build
$env:KEI_HOST_ARTIFACT = '<path to the Round 07 kei-host.pyz>'
$env:KEI_HOST_PYTHON = '<path to Python with requirements-mcp.txt installed>'
npm start
```

Set the two Cubism variables together to build with Live2D. A build with only `KEI_VRM_MODEL` activates VRM and reports Live2D unavailable. In the shell, open **操作 → キャラクター** to select a model, set CG or compact layout, or play and stop the two-segment audio preview. Escape leaves compact layout. CG preserves the existing background and hides the canvas while the audio timeline can still display subtitles. The compact layout sizes the stage inside the existing shell window. OS-level click-through and the legacy transparent overlay still require shell integration.

## Trusted renderer contract

| Surface | Contract |
| --- | --- |
| `KeiCharacterStage.mount(stage, controls)` | Returns the single controller for the slot. `get(stage)` returns it to the desktop integration. The generated entry mounts the shipped slot on startup. |
| `resize(width, height)` and `setVisible(visible)` | CSS pixel dimensions and visibility. The module also consumes the existing `kei:stage-resize` and `kei:stage-visibility` DOM events. |
| `select('live2d' or 'vrm', optionalVrmArrayBuffer)` | The current model stays live until the next model initializes and draws. A failing load leaves the current canvas and saved choice intact. A one-off custom model does not replace the bundled startup preference. |
| `dispose()` | Cancels animation and listeners, closes audio, retires the active renderer and settles outstanding model loads. |
| `kei:stage-hit` | Emitted after the active renderer recognizes a click. Detail contains `renderer` and normalized `x` / `y`. |

Render adapters implement `resize`, `draw`, `hit` and `dispose`. Both renderers consume one pose with `dt`, `sway`, `blink`, `lookX`, `lookY`, `smile` and scalar `mouth`. VRM maps to normalized humanoid bones and `aa`, blink and expression channels. It updates the model and spring solver once per draw. Live2D drives native Cubism parameters and evaluates the supplied physics file. The Live2D descriptor lists authored expressions, while this round uses direct parameter controls for the baseline smile, blink, gaze and mouth.

### Playback API

| Method | Inputs and behavior |
| --- | --- |
| `playback.begin(turnId)` | Called from a user-activated audio path. Returns a new `{playbackId, turnId}` lease each time, including repeats of the same turn. |
| `playback.segment(data)` | Supply the lease, unique `segmentId`, encoded audio as `ArrayBuffer`, and optional `subtitle`. Decodes through Web Audio and schedules segments in submission order. |
| `playback.frame(data)` | Supply the lease, `segmentId`, increasing `seq`, segment-relative `positionMs` and normalized `value`. Stale leases, segment or turn mismatches, duplicate sequence numbers and positions behind the current output clock are rejected. PCM provides the envelope when an explicit frame is unavailable. |
| `playback.interrupt(lease)` / `playback.disconnect(lease)` | Stops scheduled audio and clears subtitle and mouth state for the matching lease. |
| `playback.legacy(event, lease)` | Accepts the previous `tts.mouth` envelope when it includes `turn_id`, `payload.segment_id`, `seq`, `position_ms` and `value`. Untimed historic levels leave the decoded PCM envelope in control. |

The playback clock uses Web Audio `getOutputTimestamp()` first, with the running context clock minus reported latency as a fallback. These are software estimates at the output device timeline. The renderer selects the active segment on that timeline and samples its PCM envelope at about 10 ms resolution. A new turn retires in-flight decode work and all scheduled sources for the old lease. The Round 07 host ships a text chat route. This round uses the real Chromium player and known WAV audio. An external TTS stream or the previous Python audio device is not wired to this new shell in this round.

### Acceptance

```powershell
npm test
npm --prefix character test
$env:KEI_EVIDENCE_DIR = '<character evidence folder>'
node tests/acceptance/character.mjs
$env:KEI_ADAPTER_FIXTURE = '<Round 07 external-adapter/fixture.py>'
$env:KEI_MCP_FIXTURE = '<checkout>/tests/backend_acceptance/mcp_fixture.py'
$env:KEI_COUNTER_ZIP = '<Round 05 studio.counter.zip>'
./tests/acceptance/run-visible-win.ps1 -EvidenceRoot '<integration evidence folder>'
```

The character acceptance needs both assets. The Windows regression harness runs temporary copies of the imported test files with Chromium sandbox enabled, verifies the visible native window mode and retains the production test steps. The counter file chooser and MCP native confirmation are answered by their fixture. The underlying IPC, host, MCP SDK transports and adapter lifecycle are exercised against the real process.

## Assets and dependency provenance

- **Seed-san** is a VRM 1.0 example by **VirtualCast, Inc.** under the [VRM Public License 1.0](https://vrm.dev/licenses/1.0/). Its metadata requires credit and permits redistribution. It is a demonstration avatar. [Pinned specification sample](https://github.com/vrm-c/vrm-specification/tree/837f156dbce43ad69183ce1bdab549961ae1c1ee/samples/Seed-san)
- **Kei_Model_Physics** is the existing user-local model. The local Cubism Web 5-r.5 SDK, compiled `.moc3`, physics and texture are inputs to a private workstation build. Keep the generated private bundle and original assets outside transferable packages. The SDK shader stage embeds the official local shader text during build. [Cubism Core](https://docs.live2d.com/cubism-sdk-manual/cubism-core/)
- The private Kei FBX/PMX reference has redistribution restrictions and is kept outside this candidate. No ready-to-use Kei VRM has been verified.
- `three` 0.184.0, `@pixiv/three-vrm` 3.5.4 and `esbuild` 0.28.0 are pinned in the character component lockfile. [VRM loader and disposal API](https://github.com/pixiv/three-vrm/blob/v3.5.4/guides/migration-guide-1.0.md) · [Web Audio output timestamp](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp)
