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

Updates are component-specific. For an explicit update request, record the workspace root from
`pcbridge daemon status`. Run
`bun add --global playcanvas-agent-bridge-cli@latest`, verify `pcbridge version`, then rerun
`pcbridge install-skill --agent all`. For a custom or project-local parent directory, use
`pcbridge install-skill --agent <one-agent> --path <parent-directory>`; it appends the standard
artifact name and cannot be combined with `--agent all`. Regenerate the extension with
`pcbridge install-extension --no-open`; the user must manually click **Reload** in
`chrome://extensions` and refresh Editor/Launch tabs. Run `pcbridge daemon restart --workspace
<original-root>` and verify `pcbridge doctor`. A daemon version without authenticated shutdown must
be stopped once with Ctrl+C before starting the updated daemon. Update the independently published Editor build with
`pcbridge frontend update` and `frontend status`; a frontend-only update needs no daemon restart,
but the Editor tab must be refreshed and custom mode selected in the popup when necessary. Do not
claim completion before these manual steps are confirmed.

The current directory is the default workspace root; `daemon start/restart --workspace <directory>`
selects it explicitly, and `daemon stop` stops the authenticated daemon. After selecting a target, run
`pcbridge workspace status --target editor:<sceneId>` and stop if it reports a conflict or sync
error. Each project is mirrored under `<projectId>-<projectName>/{pcbridge.project.json,scenes,assets,tmp}`.
Inspect local files first (0 RPC) to understand the project: read `pcbridge.project.json` (scenes list,
full asset catalog, and lazy binary `meta` such as texture dimensions), read `scenes/<name>.<sceneId>.scene.json`
(DFS-ordered `entities` + `settings`), and search `scenes/` + `assets/` with `rg` before calling RPCs.

Sync is event-driven via WebSocket `workspace:delta` and targeted `fs.watch` dirty paths (zero idle polling):
- Tier 1 eager bidirectional: text assets (`script`, `text`, `json`, `html`, `css`, `shader`) and structured
  JSON data assets (`material`, `template`, `cubemap`, `sprite`, `animstategraph`, `bundle`, projected as
  `<name>.<type>.json`) up to the direct-sync limit (default 2 MB, adjustable 1–10 MB via the extension popup
  slider or `pcbridge workspace settings --eager-max-mb <1..10>`).
- Scenes: the active open scene has `"$pcbridge": { "active": true }` (`0o644` writable, auto-reconciling
  `parent <-> children`); inactive scenes have `"$pcbridge": { "active": false, "readonly": true }` (`0o444`
  read-only — run `pcbridge scene open --target editor:<currentSceneId> --id <targetSceneId>` before editing).
- Structured JSON assets and the active `.scene.json` use property-path 3-way merge against `.pcbridge/baselines/`
  so non-overlapping local and Editor edits merge automatically; same-path conflicts write `.local`, `.remote`,
  and `.conflict.json` under `tmp/conflicts/`.
- Create files under `assets/` (including new `*.<type>.json` assets) to create remote folders/Assets; rename or
  move locally to preserve the Asset ID via `$pcbridge.id`, inode, or MD5. **Deleting a local Tier 1 eagerly
  synced file backs it up to `tmp/trash/local/` AND deletes the remote Asset** (delete Tier 1 files only when
  remote deletion is intended). Images, models, audio, fonts, and over-limit files are Tier 2 lazy (use
  `workspace pull --asset <id>` before modifying missing bytes; deleting a pulled Tier 2 file only evicts local cache).
- Binary derivatives (`container`, `model`, font atlases) remain lazy and read-only (`0o444`), whereas structured
  JSON assets linked to a source model (such as FBX/GLB-imported `material` files) are writable (`0o644`) and
  keep `$pcbridge.sourceAssetId` for provenance. `tmp/` is never synchronized.
After local writes, allow ~0.5–1s for debounce and poll `workspace status` until `synced` (do not mix local saves
and CLI write RPCs on the same asset/scene concurrently). If it does not converge, run one `workspace sync` and
inspect status plus `tmp/conflicts/`.
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

Use layered help to load only the command surface you need: `pcbridge help`, then `pcbridge help core|target|workspace|processing|import|frontend|entity|asset|material|template|script|scene|store|viewport|launch|logs|eval`.

Prefer local file edits for scripts, shaders, text, `*.material.json` / `*.template.json` data, and multi-property
edits in the active `.scene.json`. Use structured commands for Editor pipelines (`scene open`,
`template instantiate/create/overrides/apply`, `script parse`, `import`), explicit transfers, and live verification:

```bash
pcbridge workspace settings --eager-max-mb 2
pcbridge scene list --target editor:<sceneId>
pcbridge scene open --target editor:<sceneId> --id <otherSceneId>
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
pcbridge asset folder ensure --target editor:<sceneId> --path "My Task/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./texture.png --name TaskTexture --folder "My Task/Textures"
pcbridge asset upload-many --target editor:<sceneId> --json ./upload-manifest.json
pcbridge material create --target editor:<sceneId> --name TaskMaterial --folder "My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge template create --target editor:<sceneId> --entity-id <resource_id> --name TaskTemplate --folder "My Task/Templates"
pcbridge template instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge template overrides --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply-many --target editor:<sceneId> --json ./template-roots.json
pcbridge scene settings get --target editor:<sceneId>
pcbridge viewport focus --target editor:<sceneId> --id <resource_id> --view perspective
pcbridge script upsert --target editor:<sceneId> --filename controller.js --file ./script.js --folder "My Task/Scripts" --parse --wait
pcbridge script create --target editor:<sceneId> --filename controller.js --file ./script.js --folder "My Task/Scripts"
pcbridge script set-text --target editor:<sceneId> --asset-id <id> --file ./script.js --parse --wait
pcbridge viewport capture --target editor:<sceneId> --out ./tmp/playcanvas.png
pcbridge logs get --target launch:<sceneId> --limit 100
pcbridge logs get --target launch:<sceneId> --level error
```

Before creating asset folders, inspect the project's existing directory tree and comparable
resources. Prefer reusing suitable folders and follow the project's naming language, casing,
separators, hierarchy, and resource grouping when new folders are needed. Organize related assets
by task or feature within that structure; if the project groups by resource type first, preserve
that layout rather than imposing a task-first hierarchy. Do not create an `AI Agent Bridge` folder
by default. If no convention exists, use a descriptive task folder with resource subfolders as needed.

Keep final file-backed assets in the project `assets/` tree and intermediate or disposable files
under `tmp/<task name>/` so the watcher does not upload them. Paths in command examples are
illustrative; adapt them to the project's existing conventions before creating folders.

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


## Self-hosted local processing

Use `pcbridge help processing` and `pcbridge help import` for self-hosted conversion. Diagnose with `processing status --target editor:<sceneId>`; tools require explicit installation and `processing enable`. Do not enable local conversion on official targets. Use `import submit --asset <id> --kind model|texture --json options.json`, then `import wait --job <id> --sync-workspace`. Server `complete` means published; workspace synchronization is separate and keeps binary lazy loading. On a wait timeout query the same job before repeating a write. Browser authentication, leases and signed URLs must never be copied into CLI arguments. Extension source upgrades require regenerating the unpacked extension, reloading it in Chrome and refreshing target pages. Custom host permissions are granted by the user through the popup.
