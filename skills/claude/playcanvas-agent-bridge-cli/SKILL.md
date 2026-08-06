---
name: playcanvas-agent-bridge-cli
description: Control an already-open PlayCanvas Editor scene or Launch page and manage the optional custom Editor frontend through pcbridge CLI commands and the bundled Chrome extension. Use for PlayCanvas Editor inspection, entity/asset/script edits, Launch runtime debugging, eval snippets, logs, viewport captures, and published Editor frontend selection without DevTools or browser automation.
---

# PlayCanvas Agent Bridge CLI

Use `pcbridge` as the only interface. Start with:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

If `doctor` reports `DAEMON_NOT_LISTENING`, ask the user to run `pcbridge daemon start` in another
terminal. For `LOOPBACK_ACCESS_DENIED`, retry with local-loopback permission instead of starting a
second daemon. If no PlayCanvas target appears, ask the user to run `pcbridge install-extension`,
load the printed directory in `chrome://extensions`, and refresh the Editor or Launch tab.

The directory where `pcbridge daemon start` runs is the workspace root. Each ready Editor project
is mirrored into `<projectId>-<projectName>/` below it. After choosing an explicit target, run
`pcbridge workspace status --target editor:<sceneId>` and do not write while it reports a conflict
or sync error.

Use `pcbridge frontend install latest` and `pcbridge frontend status` when the user wants the
published custom Editor build. The extension popup switches between custom and official modes.
The popup remembers that choice per PlayCanvas project and applies it automatically on later
project-picker and scene Editor navigations; change the remembered mode only through the popup.

Use layered help to load only the command surface you need:

```bash
pcbridge help
pcbridge help core
pcbridge help material
pcbridge help script
pcbridge help store
pcbridge help target
pcbridge help workspace
pcbridge help frontend
pcbridge help entity
pcbridge help asset
pcbridge help template
pcbridge help scene
pcbridge help viewport
pcbridge help launch
pcbridge help logs
pcbridge help eval
```

Workspace layout:

```text
<workspace root>/<projectId>-<projectName>/
  pcbridge.project.json # project metadata and agent-readable asset catalog
  assets/       # remote folder tree and synchronized asset file contents
  tmp/          # task files, builds, cache, conflicts, captures, and deletion quarantine
  .pcbridge/    # internal state; do not edit
```

Existing script and binary asset contents synchronize in both directions. Use structured commands
for asset create, move, rename, and delete operations. `pcbridge workspace pull --target
editor:<sceneId> --asset <assetId>` explicitly refreshes one file. Local file
arguments must stay inside the selected project workspace. Do not use `--allow-external-path`
unless the user explicitly asks to use a known external file.
Read `pcbridge.project.json.assets` to resolve asset ids to project-relative `assets/...` paths and
compare remote, local, and base MD5 values. Do not edit the managed asset catalog to request remote
operations. Remote deletions are quarantined under `tmp/trash/remote/`, while true content
divergence remains under `tmp/conflicts/`.

Selecting a Template Asset exposes **pcbridge Tiny Builder** in the Attributes panel. It collects
dependencies, fills the workspace cache, and uploads individual S3 objects without a ZIP. Project
`.env` overrides workspace-root `.env`; never expose credential values. CLI equivalents are
`pcbridge builder start --target editor:<sceneId> --asset <id>` and
`pcbridge builder status --job <jobId>`.

Use structured commands for small, known Editor operations:

```bash
pcbridge entity list --target editor:<sceneId> --limit 50
pcbridge entity create --target editor:<sceneId> --json ./entity.json
pcbridge entity create-many --target editor:<sceneId> --json ./entities.json
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

Organize generated assets under `AI Agent Bridge/<task name>/Textures`, `Materials`, and `Scripts`. Use `pcbridge eval` for exploratory API inspection, custom Editor/Engine workflows, and large multi-step scene edits:

```bash
pcbridge eval --target editor:<sceneId> --code "return { href: location.href, entityCount: editor.api.globals.entities.list().length }"
pcbridge eval --target editor:<sceneId> --file ./install.js --args-json ./install-args.json --timeout-ms 120000
pcbridge launch diagnose --target launch:<sceneId>
pcbridge launch wait-ready --target launch:<sceneId> --focus --timeout-ms 30000
pcbridge eval --target launch:<sceneId> --code "return { runtimeCreated: !!runtimeApp, rootChildCount: runtimeApp?.root?.children?.length ?? 0 }"
```

Eval snippets run in an async function with `editor`, `pc`, `pcui`, `runtimeApp`, `window`,
`document`, `command`, and `serialize`. `runtimeApp` uses a compatibility resolver for Engine V1/V2. Return compact
JSON only; bounded `--max-depth`/`--max-items` are available when projection is insufficient. Do
not return raw PlayCanvas Editor or runtime objects. Use `{ history: true }` for Editor mutations
when available, and verify changes with a read-only command.

For Launch runtime debugging, target `launch:<sceneId>` or `tab:<id>` and use `pcbridge eval`, `pcbridge viewport capture`, and `pcbridge logs get`. Editor-only structured entity/asset/script commands require an Editor target.

Use `editor:<sceneId>` for writes and `launch:<sceneId>` for runtime tests. Launch
`lifecycleReady` is a best-effort heuristic based on an owned graphics canvas/context, attached
scene root, a completed frame, and recognized splash state; target `ready` also requires visibility.
These are not Engine lifecycle events, and script type count is diagnostic only. For a hidden tab,
use `launch diagnose` and `launch wait-ready --focus`. Capture records the
current canvas, defaults to `--max-width 1200`, and does not emulate a mobile viewport or DPR. Use `--script-name` for bundle- or
runtime-registered ScriptTypes that have no standalone asset id.

Editor patches are durable. Restore preview-only enabled/visibility changes before Template apply,
then verify overrides. Template `verified` covers the current Editor observer, not reload
persistence. Prefer `script upsert --parse --wait` after script edits; its completion check does not
wait for a later workspace mirror sync.

For large PlayCanvas tasks, choose an explicit target from `pcbridge targets`, confirm `workspace status`, keep task files under the project `tmp/` directory, upload assets with an upload manifest, edit tracked scripts under `assets/`, and capture the viewport under `tmp/captures/` after smoke tests. If the same manual glue repeats across tasks, improve the CLI or this skill instead of continuing the brittle sequence.

Do not pre-place runtime-generated content just to prove a game exists. Keep procedural maps, pickups, enemies, and VFX in the runtime script, with only a small durable Editor root and helper entities when needed. If Editor entities must be created, use structured commands and small `entity create-many` batches with read-back verification; large eval scripts that create many entities in a tight loop can briefly show objects and then lose them from the Editor data model.
