---
name: playcanvas-agent-bridge-cli
description: Control an already-open PlayCanvas Editor scene or Launch page through pcbridge CLI commands and the bundled Chrome extension. Use for PlayCanvas Editor inspection, entity/asset/script edits, Launch runtime debugging, eval snippets, logs, viewport captures, and optional pcbridge plugin workflows without DevTools or browser automation.
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

The current directory is the default workspace root; `daemon start/restart --workspace <directory>`
selects it explicitly, and `daemon stop` stops the authenticated daemon. Each ready Editor project
is mirrored into `<projectId>-<projectName>/` below it. After choosing an explicit target, run
`pcbridge workspace status --target editor:<sceneId>` and do not write while it reports a conflict
or sync error.

When the user wants a locally served Editor frontend on official `playcanvas.com` (not needed on
self-hosted PlayCanvas), install the official `local-frontend` plugin (`pcbridge plugin add
local-frontend`), run `pcbridge plugin call local-frontend install`, and switch modes from the
Editor toolbar popover or `pcbridge plugin call local-frontend mode --target editor:<sceneId>
--params '{"mode":"local"}'`.

## Updating pcbridge

CLI responses attach `meta.updates` whenever cached checks find a newer `pcbridge` release on npm,
local CLI/daemon/extension version drift, or outdated installed plugins:

1. Run `pcbridge update status --refresh` (or `pcbridge doctor --refresh`) to inspect core and
   plugin update status.
2. Run `pcbridge update` (or `pcbridge update --plugins`) for a one-click update of the global CLI,
   installed agent skills, `~/.pcbridge/extension`, connected Chrome extension + PlayCanvas tabs
   (use `--no-reload-tabs` to skip tab refresh), and in-place daemon restart. Users can also click
   **Update & Reload** in the Chrome extension popup.
3. Official plugins update independently from GitHub (`pcbridge plugin list --refresh`,
   `pcbridge plugin update <id>`, or `pcbridge plugin update --all`) and hot-reload without
   restarting the daemon or refreshing PlayCanvas tabs.
4. When `local-frontend` is installed, update the separately published Editor build via
   `pcbridge plugin call local-frontend update` and refresh the `playcanvas.com` Editor page.

Do not report completion before the required manual browser and daemon steps are confirmed.

Use layered help to load only the command surface you need:

```bash
pcbridge help
pcbridge help core
pcbridge help material
pcbridge help script
pcbridge help store
pcbridge help target
pcbridge help workspace
pcbridge help plugin
pcbridge help processing
pcbridge help import
pcbridge help entity
pcbridge help asset
pcbridge help template
pcbridge help tinyapp
pcbridge help scene
pcbridge help viewport
pcbridge help launch
pcbridge help logs
pcbridge help eval
```

Workspace layout:

```text
<workspace root>/<projectId>-<projectName>/
  pcbridge.project.json # project metadata, scenes list, and agent-readable asset catalog (with meta summaries)
  scenes/       # active writable .scene.json plus read-only (0o444) mirrors of inactive scenes
  assets/       # collision-safe projection of the remote folder tree (text, *.<type>.json, pulled binaries)
  tmp/          # agent files, builds, conflicts, captures, and local/remote deletion trash; never synchronized
  .pcbridge/    # internal sync state, 3-way JSON baselines, and object cache; do not edit
```

Inspect local files first (0 RPC) to understand the project: read `pcbridge.project.json` (which
includes `scenes[]`, full Asset IDs/paths, and lazy binary `meta` such as texture dimensions), read
`scenes/<name>.<sceneId>.scene.json` (DFS-ordered `entities` + `settings`), and search `scenes/` and
`assets/` with `rg` instead of issuing `entity list` / `asset list` / `eval` RPCs for static
inspection.

Synchronization is event-driven via WebSocket `workspace:delta` pushes and targeted local `fs.watch`
dirty paths (zero idle polling):
- **Tier 1 (Eager bidirectional)**: Text assets (`script`, `text`, `json`, `html`, `css`, `shader`)
  and structured JSON data assets (`material`, `template`, `cubemap`, `sprite`, `animstategraph`,
  `bundle`, projected as `<name>.<type>.json`) up to the direct-sync limit (default **2 MB**,
  adjustable **1–10 MB** via the extension popup **Direct sync limit** slider or
  `pcbridge workspace settings --eager-max-mb <1..10>`) sync automatically in both directions.
- **Scenes (`scenes/<name>.<sceneId>.scene.json`)**: The active Editor scene carries
  `"$pcbridge": { "id": "...", "kind": "scene", "active": true }` (`0o644` writable, automatic
  `parent <-> children` reconciliation). Inactive scenes carry
  `"$pcbridge": { "id": "...", "kind": "scene", "active": false, "readonly": true }` (`0o444`
  read-only); run `pcbridge scene open --target editor:<currentSceneId> --id <targetSceneId>` before
  editing an inactive scene.
- **Property-path 3-way merge**: Structured JSON assets and the active `.scene.json` merge against
  `.pcbridge/baselines/` at property/entity granularity so non-overlapping local and Editor edits
  merge cleanly; same-path conflicts write `.local`, `.remote`, and `.conflict.json` under
  `tmp/conflicts/`.
- **Create, rename, and delete semantics**: Creating files under `assets/` (including new
  `*.<type>.json` structured assets) creates matching remote folders/Assets and writes back
  `$pcbridge.id`. Renaming or moving local files preserves the Asset ID via `$pcbridge.id`, file
  inode, or content hash. **Deleting a local Tier 1 eagerly synced file backs it up to
  `tmp/trash/local/` AND deletes the remote PlayCanvas Asset**; delete Tier 1 files only when remote
  deletion is intended. Deleting a pulled Tier 2 lazy binary (images, models, audio, fonts, or
  over-limit files; pull missing ones with `pcbridge workspace pull --target editor:<sceneId>
  --asset <assetId>`) only evicts the local cache (`pcbridge asset delete --id <id>` deletes remote
  Tier 2 assets).
- **Derived assets**: Binary derivatives (`container`, `model`, generated font atlases) remain lazy
  and read-only (`0o444`), whereas structured JSON assets linked to a source model (such as
  FBX/GLB-imported `material` files) are writable (`0o644`) and sync bidirectionally while keeping
  `$pcbridge.sourceAssetId` for provenance.

After local writes, allow ~0.5–1s for the watcher debounce and poll `workspace status` until
`synced` (do not mix local file saves and CLI write RPCs on the same asset/scene simultaneously). A
brief `local-change` is normal. If it does not converge, run one `workspace sync`, inspect status and
`tmp/conflicts/`, and never overwrite a conflict automatically. Local file
arguments must stay inside the selected project workspace. Do not use `--allow-external-path`
unless the user explicitly asks to use a known external file.
Read schema-v3 `pcbridge.project.json.assets`: `folder` is the remote display path and
`projectionPath` is the unique local path. Inspect `origin`, `remoteFile`, and `local` for role,
advertised/observed/effective MD5, presence, writability, and current/base MD5. Only collisions gain
`.__pc_<type>_<assetId>`. Do not edit the managed catalog to request remote operations. Remote
deletions are quarantined under `tmp/trash/remote/`, while true content
divergence remains under `tmp/conflicts/`.

Optional features ship as plugins that each user adds and enables. Run `pcbridge plugin list` to
see installed plugins, their actions, and the official plugins available to add; call an action with
`pcbridge plugin call <id> <action> --target editor:<sceneId> --params '<json>'`. The extension
popup **Plugins** tab manages the same list. To create or change a plugin, use the
`pcbridge-plugin-authoring` skill.

## TinyApp Architecture, Packaging, and Runtime Constraints

A **TinyApp** is a hot-loadable PlayCanvas 3D module built from a **Template Asset** (`tinyapp.json` +
ES5 `gamescript.js` + referenced asset/variant/font files under `<prefix>/<buildSlug>/`) and loaded
at runtime by `tiny-runtime` (`TinyLuncher` / `TinyLoader` / `TinyRoot` / `sdsTinyRootHandler`).
`TinyLoader` resolves `baseUrl` two `/` levels above `tinyapp.json` and disposes assets by
`tinyRoot.assetTag` reference count. Builtin `sds*` scripts are provided by `tiny-runtime` and
excluded from `gamescript.js` while keeping entity `attributes`; nested `sdsTinyRootHandler`
(`type: "testTemplate"`, `testTemplate: <childAssetId>`) entries are rewritten to `type: "TinyAPP"`
with their published `tinyAppUrl`.

- **Self-hosted backend packaging (preferred on self-hosted servers — no local S3 keys, server-side
  ES5 build + direct OSS/COS upload, nested child content-hash reuse, version history & S3 cleanup)**:
  The backend publishes to `<projectId>/<templateAssetId>-<templateName>-v<version>/tinyapp.json`.
  ```bash
  pcbridge tinyapp status --target editor:<sceneId>
  pcbridge tinyapp inspect --target editor:<sceneId> --template <template_asset_id>
  pcbridge tinyapp build --target editor:<sceneId> --template <template_asset_id> --label "v1" --wait
  pcbridge tinyapp list --target editor:<sceneId> [--template <template_asset_id>]
  pcbridge tinyapp get --target editor:<sceneId> --build <build_id>
  pcbridge tinyapp delete --target editor:<sceneId> --build <build_id> [--force]
  ```
  Also callable in `eval` via `editor.api.globals.tinyapps` (`status`, `inspect`, `buildAndWait`,
  `list`, `get`, `delete`, `downloadTemplateArchive`).
- **Local plugin packaging (`tinyapp-builder`)**: For official `playcanvas.com` or user-managed
  `.env` S3 buckets (never expose credentials): `pcbridge plugin add tinyapp-builder`, then
  `pcbridge plugin call tinyapp-builder start --target editor:<sceneId> --params '{"templateAssetId":"<id>"}'`
  and `pcbridge plugin call tinyapp-builder status --params '{"jobId":"<jobId>"}'`.
- **Mini-Program vs Web runtime constraints**:
  - **Mini-Program (`wx` / `my` / Taobao / Douyin)**: Runs on **Engine v1.77.0 + WebGL 1.0**
    (`preferWebGl2: false`, `antialias: false`; test in Launch with `?version=1.77.0&device=webgl1`).
    Hot-update scripts execute inside **`eval5`** (`pc.e`), which **only supports ES5**: Babel
    transpiles classic `pc.createScript` ES6+ syntax, **but never use ESM `import`/`export`,
    `async`/`await`, or `function*` generators** (`eval5` breaks `_regenerator` `await` results;
    use `.then()`/callbacks). **Never use DOM/browser APIs** (`window`, `document`, HTML/CSS DOM,
    `localStorage`, `XMLHttpRequest`, `fetch`, `Image`, `Audio`, `Worker`); only `pc`, `console`,
    `wx`, `my`, timers, typed arrays, `$TinyLoader`, `$TinyLuncher`, and `$GetTinyRoot` exist in
    scope (use `this.app`, PlayCanvas `Element` UI, `sds*` scripts, and `pc.http`/`wx.request`).
    Keep `pc.createScript` names unique across coexisting TinyApps.
  - **Web**: Runs via `new Function(...)` in a real browser with few restrictions, but any TinyApp
    targeting Mini-Programs must obey the Mini-Program subset above.

Prefer local file edits for scripts, shaders, text, `*.material.json` / `*.template.json` data, and
multi-property edits in the active `.scene.json`. Use structured commands for Editor pipelines
(`scene open`, `template instantiate/create/overrides/apply`, `script parse`, `import`), explicit
transfers, and live viewport/Launch verification:

```bash
pcbridge workspace settings --eager-max-mb 2
pcbridge scene list --target editor:<sceneId>
pcbridge scene open --target editor:<sceneId> --id <otherSceneId>
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
illustrative; adapt them to the project's existing conventions before creating folders. Use `pcbridge eval` for exploratory API inspection,
custom Editor/Engine workflows, and large multi-step scene edits:

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
persistence. For an existing script, edit the local file, wait for workspace sync, then use
`script parse` when parse verification is needed. Reserve `script upsert --parse --wait` for
recovery or workflows that intentionally bypass the mirror.

For large PlayCanvas tasks, choose an explicit target from `pcbridge targets`, confirm
`workspace status` is `synced`, keep disposable task files under `tmp/`, and put final scripts,
textures, models, and audio directly under `assets/`. Wait for workspace sync before structured
scene edits or runtime verification. Use upload manifests only when explicit import settings or a
non-watched source path is required, then capture under `tmp/captures/` after smoke tests.

Do not pre-place runtime-generated content just to prove a game exists. Keep procedural maps, pickups, enemies, and VFX in the runtime script, with only a small durable Editor root and helper entities when needed. If Editor entities must be created, use structured commands and small `entity create-many` batches with read-back verification; large eval scripts that create many entities in a tight loop can briefly show objects and then lose them from the Editor data model.


## Self-hosted local processing

Use `pcbridge help processing` and `pcbridge help import` for self-hosted conversion. Diagnose with `processing status --target editor:<sceneId>`; tools require explicit installation and `processing enable`. Do not enable local conversion on official targets. Use `import submit --asset <id> --kind model|texture --json options.json`, then `import wait --job <id> --sync-workspace`. Server `complete` means published; workspace synchronization is separate and keeps binary lazy loading. On a wait timeout query the same job before repeating a write. Browser authentication, leases and signed URLs must never be copied into CLI arguments. Extension source upgrades require regenerating the unpacked extension, reloading it in Chrome and refreshing target pages. Custom host permissions are granted by the user through the popup.
