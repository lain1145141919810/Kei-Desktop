# Portable Windows candidate build and rollback

Build with the pinned Windows Electron package installed under `frontend/node_modules` and a built `dist/kei-host.pyz`. The candidate includes Electron and its license files. The host uses an installed Python interpreter. Default production profiles can optionally install the separate Minimal/Full backend bundles and model plugins. The private user avatar, generated character bundle and legacy lifecycle media stay in the local development profile.

```powershell
python build.py
python tools/windows_candidate.py build D:/Kei-Release/Kei-Windows-Candidate.zip dist/kei-host.pyz
python tools/windows_candidate.py install D:/Kei-Release/Kei-Windows-Candidate.zip D:/Kei-Candidate
```

Start **Launch-Kei.cmd** or **Kei Desktop.exe** inside the installed directory. Set `KEI_HOST_PYTHON` if a suitable Python is not on PATH. The program directory and data directories must be distinct. Choose a new named installation directory for evaluation.

Before an upgrade, close the desktop and any host using that data directory. Snapshot the plugin code and grant registry in a sibling directory. The installer validates all files before moving the installed program. It retains the previous program beside the new one.

```powershell
python tools/windows_candidate.py snapshot-plugins D:/Kei-Test/host D:/Kei-Test/previous-registry
python tools/windows_candidate.py install D:/Kei-Release/Kei-Windows-Candidate.zip D:/Kei-Candidate
```

For rollback, close the application and restore the prior program and prior plugin registry before reopening it. Preserve the withdrawn registry in a new sibling directory. This matters when the newer version installed a plugin requiring a feature the prior host does not implement.

```powershell
python tools/windows_candidate.py rollback D:/Kei-Candidate
New-Item -ItemType Directory D:/Kei-Test/withdrawn-registry
python tools/windows_candidate.py restore-plugins D:/Kei-Test/host D:/Kei-Test/previous-registry D:/Kei-Test/withdrawn-registry
```

The rollback snapshot covers installed plugin binaries and registration/grants. The application profile, conversations and plugin private data are left where they are. For a deployment involving a new data schema, take a separate data backup before migration. The candidate verification uses two real installed executables, an invalid manifest case, a new-feature plugin, a persisted conversation and a persisted mute setting. A separate backend test exercises interrupted plugin migration recovery.
