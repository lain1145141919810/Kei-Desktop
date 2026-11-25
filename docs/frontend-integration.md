# Round 08 shared Electron integration

## One source baseline

- Common ancestor `076d94d1b2d20cdcfa966f4ec900ebdd0fa9bb99`. All 23 frontend files were imported byte for byte. Initial handoff SHA-256 `4B8E2E2ABE244C720E4D2579FB308AE42AF642220DB1E235AFD24D977D35AA95`.
- Claude Round 07 handoff SHA-256 `EA83648740BA06D2089FF99A906B81C9E64A8AEA6B823488DABD145CA2404958`. All 30 source files were validated and imported at `db23f76400380043306f1371475bfe782d5840cf`.
- Windows character work starts at `7e6e21a`. The two lines were merged at `f15ab86d8f95d62887554647116b923f58e7e6f7`. Use the resulting candidate revision and both parents to reconcile future Linux changes.

## Decisions recorded by the coordinator

1. The trusted Electron main process owns MCP mutation confirmation. The admin tool uses a native confirmation dialog. Plugin writes will reuse the trusted dialog and obtain the host's request-bound, one-use confirmation token. A page-supplied boolean grants no authority.
2. Keep environment-variable credential references in the current host protocol. Treat a future Windows credential-store backend as an optional provider.
3. Management tasks may use a distinct management conversation. Chat-originated tasks use the trusted current conversation ID and reuse the request ID for retries of a single logical request.
4. Keep the `kei-page://` route. The Linux shell owner will constrain bearer connections to HTTP loopback with redirects disabled, associate one-shot pages with the issuing window and subframe, restrict trusted `file:` resources, reject malformed action metadata, and tighten the trusted URL and iframe origin checks before release.
5. The Linux shell owner integrates trusted screen capture on explicit enablement, range selection or Ctrl+Alt+S. Main binds capture to the current conversation, trusted source and grant. Plugin pages cannot mint that context. Stop and disable cancel outstanding work, clear the capture and verify rejection across the configured scope and conversation. This record approves the contract. Production wiring remains with the shell owner.

## Ownership and shared-file changes

| Area | Owner and change |
| --- | --- |
| Common Electron main and preload | Claude's Round 07 import adds `executor-service.js`, `mcp-service.js`, `service-validation.js`, IPC registration in `main.js` and `bridge.js`, and host launcher arguments in `host-client.js`. |
| Admin and common renderer | Claude adds executor and MCP controls in admin HTML/CSS and two new admin scripts. `plugin-frames.js` adds localized errors. |
| Desktop mount | Windows adds character controls, stylesheet and the generated bundle reference in `frontend/src/renderer/desktop/index.html`. The same trusted desktop CSP permits WebAssembly for the locally supplied Cubism SDK and `blob:` for embedded model textures. The plugin document CSP and iframe sandbox remain in the Claude baseline. |
| Character dependencies | Windows owns `frontend/character/package-lock.json` as a separate lock. The shell lockfile retains its imported bytes. |
| Cross-platform acceptance | Windows provides the visible harness and tests native rendering. The inherited executor acceptance now exercises explicitly missing fixture adapters so a Windows installation of DSH does not turn the absence check into a live task. |
| MCP fixture maintenance | Windows adds `tests/backend_acceptance` with deterministic immediate interruption and bounded normal shutdown. The frozen host artifacts remain usable with the maintained scripts. |

Future shared entry changes need one integrator. Keep user-local model data and generated private bundles out of the shared source tree.
