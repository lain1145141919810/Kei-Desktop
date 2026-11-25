# Round 16 and 17 integration

Round 16 integrates Windows drive-letter normalization and the Kei PMX eyelid and sparse normal converter. Windows URL normalization applies only to the drive letter. Path components, exact document identity, the protocol, the hostname and query checks, and realpath containment retain their existing checks.

The converter requires the owner-local Kei PMX mesh, with its two closed 24-vertex eye boundary loops. Its thresholds are specific to that mesh. The compactor accepts dense float VEC3 views it can safely read and retains views still referenced by other attributes or images.

Run the following from the backend directory, using the existing frontend dependencies and optional local art files.

```powershell
node kei-desktop/tools/round16/convert-kei-pmx.mjs
node kei-desktop/tools/round17/render-pmx-vrm-cg-compare.mjs
node kei-desktop/tools/round17/verify-semantic-optin.mjs --fixture
node kei-desktop/tools/round17/verify-semantic-optin.mjs --live
```

The converter reads the original PMX geometry, FBX, textures and skeleton profile under the sibling `round-10`. It writes to `round-16-17-integration/private-kei` by default. Set `KEI_ROUND16_OUTPUT` to override that path. Set `KEI_VRM_MODEL` to the rebuilt model when bundling the renderer or running the comparison. The comparison also reads the owner-local speech sample at `round-15/private-kei/same-line.wav`.

The semantic runner defaults to this repository. Provide `--app` for an isolated checkout or `--out` for a report path. Live requests require explicit `--live` and an authorized `KEI_LIVE_CHAT_CONFIG` or the documented endpoint and model environment pair. Live acceptance requires usable plans for all four stages and a stale-plan check. Fixture results always identify themselves as fixture results.
