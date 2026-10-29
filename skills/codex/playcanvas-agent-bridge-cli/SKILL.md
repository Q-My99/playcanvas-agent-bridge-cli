---
name: playcanvas-agent-bridge-cli
description: Control an already-open PlayCanvas Editor scene or Launch page and manage the optional custom Editor frontend through the pcbridge CLI and Chrome extension. Use when Codex needs to inspect or modify PlayCanvas Editor targets, debug Launch runtime pages, read logs, run eval snippets, capture viewports, or install and select a published Editor frontend without DevTools, mouse/keyboard automation, MCP, or browser console scripting.
---

# PlayCanvas Agent Bridge CLI

Use `pcbridge` to automate PlayCanvas Editor and PlayCanvas Launch pages through a local daemon and Chrome extension. The CLI is the interface; this skill only tells the agent how to use it safely.

## Quick Start

Check local setup:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

If `doctor` reports `DAEMON_NOT_LISTENING`, tell the user to run this in a separate terminal:

```bash
pcbridge daemon start
```

Do not start a second daemon for `LOOPBACK_ACCESS_DENIED`. That means the current execution
environment cannot access `127.0.0.1`; retry with local-loopback permission instead.

The directory where `pcbridge daemon start` runs is the default workspace root; use
`--workspace <directory>` to select it explicitly. Use `pcbridge daemon restart --workspace
<directory>` to switch roots safely, and `pcbridge daemon stop` to stop the authenticated daemon.
Each connected Editor project is mirrored into `<projectId>-<projectName>/` below that directory.

If no target appears, tell the user to run `pcbridge install-extension`, load the printed directory in `chrome://extensions`, then refresh the PlayCanvas Editor or Launch tab.

For the optional custom Editor frontend, use `pcbridge frontend install latest`, confirm
`pcbridge frontend status`, then use the extension popup to switch between custom and official
frontend modes. Load focused help with `pcbridge help frontend`.
The popup remembers that choice per PlayCanvas project and applies it automatically on later
project-picker and scene Editor navigations; change the remembered mode only through the popup.

## Updating pcbridge

Treat the CLI/daemon, installed agent skill, generated Chrome extension, and custom Editor frontend
as separate components. When the user asks to update pcbridge:

1. Record the current workspace root from `pcbridge daemon status`.
2. Run `bun add --global playcanvas-agent-bridge-cli@latest`, verify `pcbridge version`, and reinstall
   copied skills with `pcbridge install-skill --agent all`.
   For a custom or project-local parent directory, use
   `pcbridge install-skill --agent <one-agent> --path <parent-directory>`; `--path` appends the
   standard artifact name and cannot be combined with `--agent all`.
3. Run `pcbridge install-extension --no-open`. The user must click **Reload** for PlayCanvas Agent
   Bridge in `chrome://extensions` and refresh open Editor/Launch tabs; rewriting the unpacked
   directory is not enough.
4. Run `pcbridge daemon restart --workspace <original-root>` and verify with `pcbridge doctor`.
   When migrating from a daemon version without authenticated shutdown, ask the user to stop that
   old daemon once with Ctrl+C, then start the updated daemon with the same `--workspace` value.
5. Update the independently published Editor build with `pcbridge frontend update`, then verify
   `frontend status`. A frontend-only update does not require daemon restart, but the user must
   refresh the Editor tab and select **Use custom frontend** in the popup when currently in official
   mode.

Do not claim an update is complete until required Chrome reload, page refresh, and daemon restart
steps have been acknowledged or verified.

## Workflow

1. Run `pcbridge targets`. Use `editor:<sceneId>` for Editor writes and `launch:<sceneId>` for
   runtime verification; use `tab:<id>` when either selector is ambiguous.
2. Run `pcbridge workspace status --target editor:<sceneId>`. Do not write while it reports a conflict or sync error.
3. **Inspect local files first (0 RPC)** to understand the project before calling Editor RPCs:
   - Read `pcbridge.project.json` for `scenes[]` (active/writable vs inactive/read-only), full asset IDs, paths, and lazy binary `meta` (texture dimensions/format, model/audio summaries).
   - Read `scenes/<name>.<sceneId>.scene.json` (DFS-ordered `entities` + `settings`) and search `scenes/` + `assets/` with `rg` to trace entities, script attachments, `<name>.material.json`, `<name>.template.json`, scripts, and shaders across the entire project.
4. Use layered help to load only the command group you need: `pcbridge help`, then `pcbridge help core|workspace|processing|import|frontend|target|entity|asset|material|template|script|scene|store|viewport|launch|logs|eval`.
5. **Choose the right write path** (never mix local file edits and CLI write RPCs on the same target concurrently):
   - **Edit local files** under `assets/` and `scenes/` for scripts, shaders, CSS/HTML/JSON/text, `<name>.material.json` / `<name>.template.json` / other `*.<type>.json` structured assets (including batch edits and creating new `*.<type>.json` files), file renames/moves, and ordinary property or entity edits in the **active** `.scene.json` (`"$pcbridge": { "active": true }`).
   - **Use structured CLI commands** for Editor-specific pipelines: `scene open` (required before editing an inactive read-only scene), `template instantiate`, `template create --entity-id`, `template overrides`, `template apply` / `apply-many` (never hand-edit `template_ent_ids`), `script parse`, `import submit/wait`, `viewport focus/capture`, and `launch` diagnostics/logs.
6. Keep temporary files, manifests, and captures under `tmp/`, which is never synchronized.
7. Use `pcbridge eval` for exploratory Editor/Engine API inspection, Launch runtime debugging (`runtimeApp`), and custom Editor workflows not covered by local projections or structured commands.
8. Return compact JSON from snippets. Never return raw `editor`, `Entity`, `Asset`, `entities.root`, or app objects.

## Workspace

```text
<workspace root>/<projectId>-<projectName>/
  pcbridge.project.json # project metadata, scenes list, and agent-readable asset catalog (with meta summaries)
  scenes/       # active writable .scene.json plus read-only (0o444) mirrors of inactive scenes
  assets/       # collision-safe projection of the PlayCanvas folder tree (text, *.<type>.json, pulled binaries)
  tmp/          # agent files, builds, conflicts, captures, and local/remote deletion trash; never synchronized
  .pcbridge/    # internal sync state, 3-way JSON baselines, and object cache; do not edit
```

Use:

```bash
pcbridge workspace status --target editor:<sceneId>
pcbridge workspace path --target editor:<sceneId>
pcbridge workspace settings [--eager-max-mb <1..10>]
pcbridge workspace sync --target editor:<sceneId>
pcbridge workspace pull --target editor:<sceneId> --asset <assetId>
```

Synchronization is event-driven via WebSocket `workspace:delta` pushes and targeted local `fs.watch` dirty paths (zero idle polling):

- **Tier 1 (Eager bidirectional)**: Text assets (`script`, `text`, `json`, `html`, `css`, `shader`) and structured JSON data assets (`material`, `template`, `cubemap`, `sprite`, `animstategraph`, `bundle`, projected as `<name>.<type>.json`) up to the direct-sync limit (**default `2 MB`**, adjustable **`1–10 MB`** via the extension popup **Direct sync limit** slider or `pcbridge workspace settings --eager-max-mb <1..10>`) are downloaded automatically and synced bidirectionally.
- **Scenes (`scenes/<name>.<sceneId>.scene.json`)**: `entities` are ordered in hierarchy DFS pre-order. The open Editor scene has `"$pcbridge": { "id": "...", "kind": "scene", "active": true }` (`0o644` writable); adding/removing entities locally reconciles `parent <-> children` automatically. Inactive scenes have `"$pcbridge": { "id": "...", "kind": "scene", "active": false, "readonly": true }` (`0o444` read-only) — inspect them freely with `rg`, and run `pcbridge scene open --target editor:<currentSceneId> --id <targetSceneId>` before editing one.
- **Property-path 3-way merge**: Structured JSON assets and the active `.scene.json` merge against `.pcbridge/baselines/` at property/entity granularity, so non-overlapping local and Editor edits merge automatically without false whole-file conflicts. True same-path conflicts write `.local`, `.remote`, and `.conflict.json` under `tmp/conflicts/`.
- **Create, rename, and move locally**: Creating files under `assets/` (including new `<name>.material.json` or other `*.<type>.json` files without an ID) creates matching remote folders and Assets and writes back `$pcbridge.id`. Renaming or moving local files preserves the remote Asset ID via `$pcbridge.id`, file inode, or content hash (even when renamed and edited together).
- **Tier 2 (Lazy binary / over-limit files)**: Images, models, audio, fonts, binaries, and files above `eagerMaxMb` record metadata, dimensions, and MD5 in `pcbridge.project.json` without downloading bytes. Run `workspace pull --asset <id>` before modifying a missing binary locally.
- **Deletion semantics (important distinction)**:
  - Deleting a local **Tier 1** eagerly synced file (in-limit text/script/shader or `*.<type>.json`) **backs it up under `tmp/trash/local/` AND deletes the remote PlayCanvas Asset** to keep both sides consistent. Delete Tier 1 files only when remote deletion is intended.
  - Deleting a locally pulled **Tier 2** lazy binary (or over-limit file) only evicts the local cache without deleting the remote Asset; use `pcbridge asset delete --id <id>` to delete a remote Tier 2 Asset.
- **Derived assets**: Binary derivatives (`source_asset_id != null` with a file, such as GLB `container`/`model` outputs and generated font atlases) remain lazy and read-only (`0o444`); local edits are quarantined to `tmp/conflicts/` and restored. Structured JSON assets linked to a source model (such as FBX/GLB-imported `material` files) **are writable (`0o644`)** and sync bidirectionally while keeping `$pcbridge.sourceAssetId` for provenance.

After a local edit, allow ~0.5–1s for the watcher debounce to flush, then check `workspace status` until it reports
`synced`. A brief yellow `local-change` is expected. Do not declare completion or alternate to
remote editing while the same file is pending. If it does not converge, run one explicit
`workspace sync`, inspect `lastError`, `lastWarning`, and `tmp/conflicts/`, and do not overwrite
a conflict automatically.
Read schema-v3 `pcbridge.project.json.assets` to resolve Asset IDs. `folder` is the remote display
path; `projectionPath` is the unique local path. Inspect `origin`, `remoteFile`, and `local` for the
source/derived role, advertised/observed/effective MD5, presence, writability, and current/base MD5.
Only collision paths gain `.__pc_<type>_<assetId>`. The catalog is managed by pcbridge; do not edit it
to request remote asset operations. Confirmed remote deletions are quarantined under
`tmp/trash/remote/`; `tmp/conflicts/` is reserved for divergent local and remote contents.

Selecting a Template Asset exposes **pcbridge Tiny Builder** in the Attributes panel. It collects
dependencies, materializes missing or remote-updated primary files, texture variants, and additional
font maps under `assets/`, then uploads individual S3 objects without a ZIP. `local.resources` in the
schema-v3 manifest identifies managed read-only auxiliary files; `.pcbridge/objects` is only the
internal content cache. Project `.env` overrides workspace-root `.env`; never read or return
credential values. CLI equivalents are
`pcbridge builder start --target editor:<sceneId> --asset <id>` and
`pcbridge builder status --job <jobId>`.

Local file arguments are restricted to the selected project workspace. Never use
`--allow-external-path` unless the user explicitly asks to use a known external file.

## Safe Commands

Prefer reading local `pcbridge.project.json`, `scenes/*.scene.json`, and `assets/` first for static inspection. Use CLI commands when you need live Editor/Launch state, pipeline actions, or single targeted RPC mutations:

```bash
pcbridge scene list --target editor:<sceneId>
pcbridge scene open --target editor:<sceneId> --id <otherSceneId>
pcbridge eval --target editor:<sceneId> --code "return { href: location.href, hasEditor: !!editor, entityCount: editor.api.globals.entities.list().length }"
```

List entities:

```bash
pcbridge entity list --target editor:<sceneId> --limit 50
pcbridge entity list --target editor:<sceneId> --name Player --component render
pcbridge entity list --target editor:<sceneId> --tag enemy
```

Create an entity from JSON:

```bash
pcbridge entity create --target editor:<sceneId> --json ./entity.json
pcbridge entity create-many --target editor:<sceneId> --json ./entities.json
```

Patch an entity:

```bash
pcbridge entity patch --target editor:<sceneId> --id <resource_id> --set name=Player --set position='[0,1,0]'
pcbridge entity patch-many --target editor:<sceneId> --json ./edits.json
pcbridge entity duplicate --target editor:<sceneId> --id <resource_id>
pcbridge entity reparent --target editor:<sceneId> --id <resource_id> --parent <parent_resource_id>
```

Modify components and materials:

```bash
pcbridge entity add-component --target editor:<sceneId> --id <resource_id> --component render --data '{"type":"box"}'
pcbridge entity add-components --target editor:<sceneId> --id <resource_id> --json ./components.json
pcbridge entity set-material --target editor:<sceneId> --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.4}'
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --script-name sdsAudioPlayer --attributes-json ./audio-slots.json
pcbridge entity delete --target editor:<sceneId> --id <resource_id>
```

Use exactly one of `--asset-id` and `--script-name`. The name form is for a ScriptType registered
by a bundle or runtime asset and therefore lacking a standalone script asset id. Verify such a
script in Launch; explicit script reordering is not yet a dedicated command.

Work with asset pipelines, explicit transfers, and script verification. For ordinary script/shader/text or `*.material.json` / `*.template.json` content edits, prefer editing the tracked local file under `assets/` over CLI `patch` / `set-text` or re-uploading:

```bash
pcbridge asset list --target editor:<sceneId> --type script --limit 50
pcbridge asset create --target editor:<sceneId> --json ./assets.json
pcbridge asset folder ensure --target editor:<sceneId> --path "My Task/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./texture.png --name TaskTexture --folder "My Task/Textures"
pcbridge asset upload-many --target editor:<sceneId> --json ./upload-manifest.json
pcbridge asset instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge material create --target editor:<sceneId> --name TaskMaterial --folder "My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge material patch --target editor:<sceneId> --asset-id <material_asset_id> --set diffuse='[1,0,0]'
pcbridge template create --target editor:<sceneId> --entity-id <resource_id> --name TaskTemplate --folder "My Task/Templates"
pcbridge template instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge template overrides --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply-many --target editor:<sceneId> --json ./template-roots.json
pcbridge script upsert --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "My Task/Scripts" --parse --wait
pcbridge script create --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "My Task/Scripts"
pcbridge script set-text --target editor:<sceneId> --asset-id <id> --file ./controller.js --parse --wait
pcbridge script parse --target editor:<sceneId> --asset-id <id>
```

`template-roots.json` may be `{"entityIds":["root-a","root-b"]}` or an array of entity ids/items.
`apply-many` validates every root before writing and processes them serially. When an apply is
needed, completion requires the pipeline callback plus two zero-override observations. `verified`
only covers the current Editor observer; it does not confirm persistence across an Editor reload.

Prefer the completion-checked `--parse --wait` forms after edits. They wait for non-empty stable
file metadata, verify the remote text, parse it, and read back stable script attributes before
returning. They do not wait for the workspace mirror to finish a later sync.

Scene, store, and viewport:

```bash
pcbridge scene settings get --target editor:<sceneId>
pcbridge scene settings patch --target editor:<sceneId> --json ./scene-settings.json
pcbridge store search --target editor:<sceneId> --search vehicle --limit 20
pcbridge store get --target editor:<sceneId> --id <store_asset_id>
pcbridge viewport focus --target editor:<sceneId> --id <resource_id> --view perspective
```

Capture the viewport:

```bash
pcbridge viewport capture --target editor:<sceneId> --out ./tmp/playcanvas-viewport.png
```

Launch runtime debugging:

```bash
pcbridge launch diagnose --target launch:<sceneId>
pcbridge launch wait-ready --target launch:<sceneId> --focus --timeout-ms 30000
pcbridge eval --target launch:<sceneId> --code "return { href: location.href, runtimeCreated: !!runtimeApp, rootChildCount: runtimeApp?.root?.children?.length ?? 0 }"
pcbridge viewport capture --target launch:<sceneId> --out ./tmp/launch.png
pcbridge logs get --target launch:<sceneId> --limit 100
pcbridge logs get --target launch:<sceneId> --level error
```

For Launch, `lifecycleReady` is a best-effort heuristic requiring a runtime app with its own
graphics canvas/context, an attached scene root, at least one completed frame, and no recognized
startup splash. Target `ready` additionally requires a visible tab, so use `target focus` or
`launch wait-ready --focus` for a hidden Launch. These are diagnostic signals, not Engine lifecycle
events; custom splash screens may be missed. `scriptTypeCount` is diagnostic only. Use the resolved
`runtimeApp` eval binding instead of calling `Application.getApplication()` yourself.

`viewport capture` records the current canvas. It does not emulate a phone viewport or DPR. PNG
may preserve transparency, and the default `--max-width 1200` may downscale the output; use returned dimensions as
authoritative.

## Asset Organization

Before creating asset folders, inspect the project's existing directory tree and comparable
resources. Prefer reusing suitable folders and follow the project's naming language, casing,
separators, hierarchy, and resource grouping when new folders are needed. Organize related assets
by task or feature within that structure; if the project groups by resource type first, preserve
that layout rather than imposing a task-first hierarchy. Do not create an `AI Agent Bridge` folder
by default. If no convention exists, use a descriptive task folder with resource subfolders as needed.

Keep final file-backed assets in the project `assets/` tree and intermediate or disposable files
under `tmp/<task name>/` so the watcher does not upload them. Paths in command examples are
illustrative; adapt them to the project's existing conventions before creating folders.

## Large Task Workflow

For multi-asset or game-sized tasks:

1. Choose an explicit target from `pcbridge targets`, preferably `editor:<sceneId>` for writes or
   `launch:<sceneId>` for tests; use `tab:<id>` to resolve ambiguity.
2. Confirm `workspace status` is `synced`. Inspect `pcbridge.project.json`, `scenes/*.scene.json`, and `assets/` locally with `rg` to understand existing hierarchy, conventions, and asset IDs without extra RPC traffic. Put disposable generation inputs under `<project>/tmp/<task name>/`.
3. Follow existing folder naming and hierarchy. Group new resources within that convention, reuse suitable folders, and create or edit scripts, shaders, `*.material.json` files, and assets locally under `<project>/assets/`; wait for `workspace status` to reach `synced`.
4. Use `asset upload-many` only when explicit upload settings or a non-watched source path is required. Do not upload a file again when it is already tracked under `assets/`.
5. For an existing script, edit its local file. Use `script parse` after synchronization when parse verification is needed; reserve `script upsert --parse --wait` for recovery or workflows that intentionally bypass the mirror.
6. For active scene edits, either edit `scenes/<name>.<sceneId>.scene.json` directly (ideal for multi-entity/property tuning with 3-way merge) or use structured `entity` / `template` commands (or `pcbridge eval --target editor:<sceneId> --file ./install.js --args-json ./args.json --timeout-ms 120000` for procedural Editor setup). Do not edit `.scene.json` and run scene-mutating RPCs at the exact same instant.
7. Wait for `workspace status` to become `synced`, then verify with read-only commands, a small smoke-test eval, and a capture under `<project>/tmp/captures/`.

If repeated manual glue is needed across tasks, improve the CLI or this skill rather than continuing to hand-roll brittle shell/script sequences.

## Editor Entity Persistence Notes

Do not pre-place runtime-generated content just to prove a game exists. For roguelike maps, procedural levels, particles, pickups, and enemies that are generated at launch, keep the durable Editor surface small: a root entity, script component, camera/light helpers when useful, and persistent assets/scripts.

When Editor entities do need to be created or replaced, prefer structured commands such as `entity create`, `entity create-many`, `entity add-script`, `entity set-material`, and `entity patch-many`. In current PlayCanvas Editor builds, a large `eval` script that creates many entities in a tight loop can briefly show objects in the viewport and then lose them from the Editor data model. For large static previews, create in small batches, pause between batches when needed, then immediately verify with `entity list` by name/tag before capturing the viewport.

Editor entity patches are durable scene edits, not runtime-only preview state. Never apply a
Template while preview-only `enabled` or visibility changes remain on its source root. Restore and
read back the original preview values first, then run `template overrides` and `template apply`.
Prefer Launch eval for temporary runtime test state. `template apply` warns when the override set
contains an `enabled` change and waits until overrides are stably zero.
That verification is limited to the current Editor observer and does not prove reload persistence.

## Texture Box Pattern

For a textured scripted box, compose structured commands instead of writing one large eval:

```bash
pcbridge asset folder ensure --target editor:<sceneId> --path "Texture Box/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./image.png --name TextureBoxImage --folder "Texture Box/Textures"
pcbridge material create --target editor:<sceneId> --name TextureBoxMaterial --folder "Texture Box/Materials" --diffuse-map <texture_asset_id>
pcbridge script create --target editor:<sceneId> --filename jumpingBox.js --file ./jumpingBox.js --folder "Texture Box/Scripts"
pcbridge entity create --target editor:<sceneId> --json ./box.json
pcbridge entity set-material --target editor:<sceneId> --id <box_resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target editor:<sceneId> --id <box_resource_id> --asset-id <script_asset_id> --attributes '{"height":0.5,"speed":2.4}'
```

## Eval Snippet Rules

The snippet runs inside an async function with these bindings:

```js
editor;
pc;
pcui;
runtimeApp;
window;
document;
command;
serialize;
```

The final bridge serialization is bounded even when `--full` is used. Return only required leaf
fields. If a compact projection still contains `[MaxDepth ...]`, use bounded eval options such as
`--max-depth 8 --max-items 500`; do not return raw Editor or runtime objects.

Prefer:

```js
const globals = editor.api.globals;
const entities = globals.entities;
const assets = globals.assets;
```

Use compact return values:

```js
const entities = editor.api.globals.entities.list();
return entities.slice(0, 20).map((entity) => ({
  resource_id: entity.get("resource_id"),
  name: entity.get("name"),
  components: Object.keys(entity.get("components") || {})
}));
```

Avoid destructive operations unless the user clearly asked for them. When deleting or overwriting, require explicit stable IDs and report affected counts.


## Self-hosted local processing

Use `pcbridge help processing` and `pcbridge help import` for self-hosted conversion. Diagnose with `processing status --target editor:<sceneId>`; tools require explicit installation and `processing enable`. Do not enable local conversion on official targets. Use `import submit --asset <id> --kind model|texture --json options.json`, then `import wait --job <id> --sync-workspace`. Server `complete` means published; workspace synchronization is separate and keeps binary lazy loading. On a wait timeout query the same job before repeating a write. Browser authentication, leases and signed URLs must never be copied into CLI arguments. Extension source upgrades require regenerating the unpacked extension, reloading it in Chrome and refreshing target pages. Custom host permissions are granted by the user through the popup.
