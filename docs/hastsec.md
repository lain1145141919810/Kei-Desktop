# HAST-SEC optional body motion

Install `kei.hastsec.zip` in Kei Desktop 管理 → プラグイン. The normal shell and character stage run without the plugin. To enable body motion, grant `hastsec.solve`, `hastsec.preview` and `hastsec.settings` as needed.

Prepare the pinned external checkout with Node.js 22 or later and Git.

```powershell
git clone https://github.com/lain1145141919810/HAST-SEC.git
Set-Location HAST-SEC
git checkout --detach f4d5c9aa32f9d04e249585e0b2e6d4c56572ca51
npm ci
```

Open HAST-SEC 動作ライブラリ in the admin window. Save the absolute checkout path, reload the plugin, then refresh the library. When Node.js or Git is outside its standard installation path, set their absolute paths in generic plugin settings. The adapter checks the pinned checkout, required Three.js version and the selected trajectory's byte length and SHA-256. The structured-motion path needs the checked-in trajectory data and has no language model or runtime download.

Load an authorized VRM 1.0 character with the 53 canonical humanoid bones shown in the diagnostics. The adapter reads the normalized rest pose and refuses incomplete rigs. Select a motion in the library and use ステージで試す. The body layer applies only the selected mask. The solver produces 20 Hz motion and rendering interpolates the neighboring solved samples. The VRM update, including any spring bones the avatar provides, runs once per draw. Audio-clock mouth animation and LumenAct expression weights remain independent. Preview Stop, an interrupted playback, a renderer change, disable and uninstall clear the motion lease. An unavailable backend or mismatched model leaves the default pose usable.

The trusted stage API accepts a structured intent, for example `stage.motion.request({ motion: "left-向上抬高", speed: 1, strength: 0.9 })`. `stage` is the instance returned by `KeiCharacterStage.get(document.querySelector("#character-stage"))`. The body-motion job is cancelled when it is superseded. The optional language-model planner in the HAST-SEC demo is separate.

```powershell
python -m kei_sdk.pack plugins/hastsec <output-directory>/kei.hastsec.zip
```

The original Kei avatar and the converted runtime asset are local-only. Build the character bundle with `KEI_VRM_MODEL` pointing to the local VRM when testing a normal launch. Follow the avatar's own terms. [Kei adapter notice](../plugins/hastsec/NOTICE.md)
