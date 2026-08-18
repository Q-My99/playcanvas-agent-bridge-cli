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

The directory where `pcbridge daemon start` runs is the workspace root. Choose it intentionally;
each connected Editor project is mirrored into `<projectId>-<projectName>/` below that directory.

If no target appears, tell the user to run `pcbridge install-extension`, load the printed directory in `chrome://extensions`, then refresh the PlayCanvas Editor or Launch tab.

For the optional custom Editor frontend, use `pcbridge frontend install latest`, confirm
`pcbridge frontend status`, then use the extension popup to switch between custom and official
frontend modes. Load focused help with `pcbridge help frontend`.
The popup remembers that choice per PlayCanvas project and applies it automatically on later
project-picker and scene Editor navigations; change the remembered mode only through the popup.

## Workflow

1. Run `pcbridge targets`. Use `editor:<sceneId>` for Editor writes and `launch:<sceneId>` for
   runtime verification; use `tab:<id>` when either selector is ambiguous.
2. Run `pcbridge workspace status --target editor:<sceneId>`. Do not write while it reports a conflict or sync error.
3. Use layered help to load only the command group you need: `pcbridge help`, then `pcbridge help core|workspace|frontend|target|entity|asset|material|template|script|scene|store|viewport|launch|logs|eval`.
4. Edit asset file contents locally under the selected project's `assets/` tree and let the daemon synchronize them. Keep temporary files, manifests, and captures under `tmp/`, which is not synchronized.
5. Use structured commands for scene structure and non-file Asset operations that map cleanly to one Editor action.
6. Use `pcbridge eval` for exploratory API inspection, custom Editor/Engine workflows, Launch runtime debugging, and large multi-step scene edits where one script is clearer than many CLI calls.
7. Return compact JSON from snippets. Never return raw `editor`, `Entity`, `Asset`, `entities.root`, or app objects.
8. Use PlayCanvas history options for writes when available and verify writes with a read-only command.

## Workspace

```text
<workspace root>/<projectId>-<projectName>/
  pcbridge.project.json # project metadata and agent-readable asset catalog
  assets/       # PlayCanvas folder tree; scripts eager, binary file contents lazy
  tmp/          # agent files, builds, cache, conflicts, captures, and deletion quarantine; never synchronized
  .pcbridge/    # internal sync state; do not edit
```

Use:

```bash
pcbridge workspace status --target editor:<sceneId>
pcbridge workspace path --target editor:<sceneId>
pcbridge workspace sync --target editor:<sceneId>
pcbridge workspace pull --target editor:<sceneId> --asset <assetId>
```

Prefer local file operations for file-backed Assets:

- Edit existing scripts directly under `assets/`; the watcher uploads them to PlayCanvas.
- Create files and folders under `assets/` to upload them into the matching remote folder. Let PlayCanvas infer and process the Asset type.
- Rename or move a local file to rename or move the same remote Asset ID.
- Deleting a local file only removes the local lazy cache. It does not delete the remote Asset; use `pcbridge asset delete --id <id>` only when remote deletion is explicitly intended.
- Scripts are downloaded eagerly. Binary files are lazy; run `workspace pull --asset <id>` before modifying a remote binary that is not present locally.
- PlayCanvas-generated derivatives such as GLB Model/Container/material outputs are catalog-only. Edit the source GLB, not a derivative.

After a local edit, allow the watcher to react, then poll `workspace status` until it reports
`synced`. A brief yellow `local-change` is expected. Do not declare completion or alternate to
remote editing while the same file is pending. If it does not converge, run one explicit
`workspace sync`, inspect `lastError`, `lastWarning`, and `tmp/conflicts/`, and do not overwrite
a conflict automatically.
Read `pcbridge.project.json.assets` to resolve asset ids to project-relative `assets/...` paths and
compare remote, local, and base MD5 values. The catalog is managed by pcbridge; do not edit it to
request remote asset operations. Confirmed remote deletions are quarantined under
`tmp/trash/remote/`; `tmp/conflicts/` is reserved for divergent local and remote contents.

Selecting a Template Asset exposes **pcbridge Tiny Builder** in the Attributes panel. It collects
dependencies, fills the workspace cache, and uploads individual S3 objects without a ZIP. Project
`.env` overrides workspace-root `.env`; never read or return credential values. CLI equivalents are
`pcbridge builder start --target editor:<sceneId> --asset <id>` and
`pcbridge builder status --job <jobId>`.

Local file arguments are restricted to the selected project workspace. Never use
`--allow-external-path` unless the user explicitly asks to use a known external file.

## Safe Commands

Inspect a scene:

```bash
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

Work with asset metadata, explicit transfers, and script verification. For ordinary file-content
edits, prefer editing the tracked local file under `assets/` over `script set-text` or re-uploading it:

```bash
pcbridge asset list --target editor:<sceneId> --type script --limit 50
pcbridge asset create --target editor:<sceneId> --json ./assets.json
pcbridge asset folder ensure --target editor:<sceneId> --path "AI Agent Bridge/My Task/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./texture.png --name TaskTexture --folder "AI Agent Bridge/My Task/Textures"
pcbridge asset upload-many --target editor:<sceneId> --json ./upload-manifest.json
pcbridge asset instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge material create --target editor:<sceneId> --name TaskMaterial --folder "AI Agent Bridge/My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge material patch --target editor:<sceneId> --asset-id <material_asset_id> --set diffuse='[1,0,0]'
pcbridge template create --target editor:<sceneId> --entity-id <resource_id> --name TaskTemplate --folder "AI Agent Bridge/My Task/Templates"
pcbridge template instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge template overrides --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply-many --target editor:<sceneId> --json ./template-roots.json
pcbridge script upsert --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "AI Agent Bridge/My Task/Scripts" --parse --wait
pcbridge script create --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "AI Agent Bridge/My Task/Scripts"
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

Create synchronized files directly under a task-scoped path in the project `assets/` tree. Keep
intermediate or disposable generation files under `tmp/` so the watcher does not upload them:

```text
assets/AI Agent Bridge/<task name>/Textures
assets/AI Agent Bridge/<task name>/Models
assets/AI Agent Bridge/<task name>/Scripts
```

Use stable names that describe the asset purpose. Avoid dumping generated files at the project root.

## Large Task Workflow

For multi-asset or game-sized tasks:

1. Choose an explicit target from `pcbridge targets`, preferably `editor:<sceneId>` for writes or
   `launch:<sceneId>` for tests; use `tab:<id>` to resolve ambiguity.
2. Confirm `workspace status` is `synced`. Put disposable generation inputs under `<project>/tmp/<task name>/`.
3. Put final scripts, textures, models, audio, and other file-backed Assets under `<project>/assets/AI Agent Bridge/<task name>/...`; create or edit them locally and wait for synchronization.
4. Use `asset upload-many` only when explicit upload settings or a non-watched source path is required. Do not upload a file again when it is already tracked under `assets/`.
5. For an existing script, edit its local file. Use `script parse` after synchronization when parse verification is needed; reserve `script upsert --parse --wait` for recovery or workflows that intentionally bypass the mirror.
6. Use `pcbridge eval --target editor:<sceneId> --file ./install.js --args-json ./args.json --timeout-ms 120000` for large scene installation scripts. The JSON object is available as `command.args`; increase `--timeout-ms` instead of splitting a coherent install script just to avoid the default 15s timeout.
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
pcbridge asset folder ensure --target editor:<sceneId> --path "AI Agent Bridge/Texture Box/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./image.png --name TextureBoxImage --folder "AI Agent Bridge/Texture Box/Textures"
pcbridge material create --target editor:<sceneId> --name TextureBoxMaterial --folder "AI Agent Bridge/Texture Box/Materials" --diffuse-map <texture_asset_id>
pcbridge script create --target editor:<sceneId> --filename jumpingBox.js --file ./jumpingBox.js --folder "AI Agent Bridge/Texture Box/Scripts"
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
