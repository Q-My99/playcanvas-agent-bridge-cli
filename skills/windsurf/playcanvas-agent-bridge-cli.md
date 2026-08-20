# PlayCanvas Agent Bridge CLI

Use `pcbridge` to automate an already-open PlayCanvas Editor tab or debug a PlayCanvas Launch tab through the local daemon and Chrome extension.

Start with:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

Run `pcbridge daemon start` only for `DAEMON_NOT_LISTENING`; for `LOOPBACK_ACCESS_DENIED`, retry
with local-loopback permission. If no target is connected, install/reload the unpacked extension.

Updates are component-specific. For an explicit update request, have the user stop the foreground
daemon with Ctrl+C and remember its workspace-root directory; there is no `daemon stop`. Run
`npm install -g playcanvas-agent-bridge-cli@latest`, verify `pcbridge version`, then rerun
`pcbridge install-skill --agent all`. Regenerate the extension with
`pcbridge install-extension --no-open`; the user must manually click **Reload** in
`chrome://extensions` and refresh Editor/Launch tabs. Restart the daemon from the original workspace
root and verify `pcbridge doctor`. Update the independently published Editor build with
`pcbridge frontend update` and `frontend status`; a frontend-only update needs no daemon restart,
but the Editor tab must be refreshed and custom mode selected in the popup when necessary. Do not
claim completion before these manual steps are confirmed.

The daemon start directory is the workspace root. After selecting an explicit target, run
`pcbridge workspace status --target editor:<sceneId>` and stop if it reports a conflict or sync
error. Each project is mirrored under `<projectId>-<projectName>/{assets,tmp}`. Prefer local
operations for file-backed Assets: edit scripts under `assets/`; create files/folders there to
upload through PlayCanvas processing; rename or move locally to preserve the remote Asset ID.
Deleting locally only clears the cache, never the remote Asset. Scripts are eager and binaries are
lazy; use `workspace pull` before editing a missing binary. Generated GLB Model/Container/material
Assets and font atlases are lazy, read-only projections: edit the source Asset. Derivative edits or
moves are quarantined, restored from `.pcbridge/objects`, and never uploaded. `tmp/` is never
synchronized. After local writes, poll
`workspace status` until `synced`; a brief `local-change` is expected. If it does not converge,
run one `workspace sync` and inspect status plus `tmp/conflicts/`.
Read schema-v3 `pcbridge.project.json.assets`: `folder` is the remote display path,
`projectionPath` is the unique local path, and `origin`/`remoteFile`/`local` describe role,
effective metadata, presence, writability, and hashes. Only collisions gain
`.__pc_<type>_<assetId>`. Treat that asset catalog as pcbridge-managed. Confirmed remote
deletions are quarantined under `tmp/trash/remote/`; `tmp/conflicts/` contains content divergence.
Template selection exposes pcbridge Tiny Builder for direct S3 object uploads; project `.env`
overrides workspace-root `.env`. A build materializes every primary dependency plus texture
variants and additional font maps under the Asset's remote folder in `assets/`, then uploads only
those projected files. Schema-v3 `local.resources` records the managed read-only auxiliary files;
`.pcbridge/objects` is only an internal content cache. New builds do not use `tmp/cache/assets/`,
and compatible files left there by older versions are migrated into `assets/` when needed.

For the optional published Editor build, use `pcbridge frontend install latest`, verify it with
`pcbridge frontend status`, and switch custom/official mode from the extension popup.
The popup remembers that choice per project and reapplies it on later project-picker and scene
Editor navigations; change the remembered choice only through the popup.

Use layered help to load only the command surface you need: `pcbridge help`, then `pcbridge help target|workspace|frontend|entity|asset|material|template|script|scene|store|viewport|launch|logs|eval`.

Use structured commands for scene structure, Asset metadata, explicit transfers, and verification.
For normal file-content changes, prefer editing the tracked local file under `assets/`:

```bash
pcbridge entity list --target editor:<sceneId> --limit 50
pcbridge entity create --target editor:<sceneId> --json ./entity.json
pcbridge entity patch --target editor:<sceneId> --id <resource_id> --set position='[0,1,0]'
pcbridge entity duplicate --target editor:<sceneId> --id <resource_id>
pcbridge entity reparent --target editor:<sceneId> --id <resource_id> --parent <parent_resource_id>
pcbridge entity set-material --target editor:<sceneId> --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.4}'
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --script-name sdsAudioPlayer --attributes-json ./audio-slots.json
pcbridge asset list --target editor:<sceneId> --type script
pcbridge asset create --target editor:<sceneId> --json ./assets.json
pcbridge asset folder ensure --target editor:<sceneId> --path "AI Agent Bridge/My Task/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./texture.png --name TaskTexture --folder "AI Agent Bridge/My Task/Textures"
pcbridge asset upload-many --target editor:<sceneId> --json ./upload-manifest.json
pcbridge material create --target editor:<sceneId> --name TaskMaterial --folder "AI Agent Bridge/My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge template create --target editor:<sceneId> --entity-id <resource_id> --name TaskTemplate --folder "AI Agent Bridge/My Task/Templates"
pcbridge template instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge template overrides --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply-many --target editor:<sceneId> --json ./template-roots.json
pcbridge scene settings get --target editor:<sceneId>
pcbridge viewport focus --target editor:<sceneId> --id <resource_id> --view perspective
pcbridge script upsert --target editor:<sceneId> --filename controller.js --file ./script.js --folder "AI Agent Bridge/My Task/Scripts" --parse --wait
pcbridge script create --target editor:<sceneId> --filename controller.js --file ./script.js --folder "AI Agent Bridge/My Task/Scripts"
pcbridge script set-text --target editor:<sceneId> --asset-id <id> --file ./script.js --parse --wait
pcbridge viewport capture --target editor:<sceneId> --out ./tmp/playcanvas.png
pcbridge logs get --target launch:<sceneId> --limit 100
pcbridge logs get --target launch:<sceneId> --level error
```

Put final file-backed assets under `assets/AI Agent Bridge/<task name>/...`; keep disposable
generation files under `tmp/<task name>/`.

Use `pcbridge launch diagnose` and `pcbridge launch wait-ready --focus` before runtime assertions.
Launch `lifecycleReady` is a best-effort heuristic based on an owned graphics canvas/context,
attached scene root, a completed frame, and known splash selectors; target `ready` also requires a
visible tab. These are not Engine lifecycle events, and script type count is diagnostic only. Eval
includes compatibility-resolved `runtimeApp` for Engine V1/V2 plus the existing Editor bindings. Return compact
JSON; use bounded `--max-depth`/`--max-items` only when a leaf projection is insufficient.

For Launch runtime debugging, target `launch:<sceneId>` or `tab:<id>` and use `pcbridge eval`, `pcbridge viewport capture`, and `pcbridge logs get`. Editor-only structured entity/asset/script commands require an Editor target.

Use `editor:<sceneId>` for writes and `--script-name` for bundle-registered ScriptTypes. Editor
patches are durable, so restore preview-only enabled/visibility changes before Template apply.
Template `verified` covers current Editor overrides, not persistence across a reload. Script
`--parse --wait` completion checks do not wait for the workspace mirror's later sync.
Capture records the current canvas, defaults to `--max-width 1200`, and does not emulate a mobile viewport or DPR.

For large eval installs, use `pcbridge eval --target editor:<sceneId> --file ./install.js --args-json ./install-args.json --timeout-ms 120000`.

For large tasks, choose an explicit target, confirm the workspace is `synced`, keep disposable files
and captures under `tmp/`, and put final scripts, textures, models, and audio directly under
`assets/`. Wait for sync before scene writes or runtime tests. Use `asset upload-many` only when
explicit import settings or a non-watched path is required. Local file arguments must remain inside
the workspace; never use `--allow-external-path` without explicit user approval.

Do not pre-place runtime-generated content just to prove a game exists. Keep procedural maps, pickups, enemies, and VFX in the runtime script, with only a small durable Editor root and helper entities when needed. If Editor entities must be created, use structured commands and small `entity create-many` batches with read-back verification; large eval scripts that create many entities in a tight loop can briefly show objects and then lose them from the Editor data model.
