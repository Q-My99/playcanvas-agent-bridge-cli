# playcanvas-agent-bridge-cli

Scene management: `scene list`, `scene create --name <name>`, and `scene open --id <id>` use the selected Editor project; opening waits for the matching scene load. `asset upload` infers GLB/FBX/OBJ files as model sources (`scene`).

In the parent PlayCanvas workspace, `bun run pcbridge <command>` defaults to the root `pcbridge-workspace/` directory (created automatically and ignored by Git). `bun run dev` starts the daemon from the current source and stops it on exit. If the daemon port is occupied, run `bun run pcbridge daemon stop` first. The extension popup shows its own version separately from the daemon version, including while offline.

> Requires Bun 1.4.0 or newer. In the parent monorepo, run `bun install --frozen-lockfile` at the workspace root.

CLI-first local automation for controlling already-open PlayCanvas Editor scenes and PlayCanvas Launch pages from AI coding agents such as Codex, Claude Code, Cursor, and Windsurf.

The core interface is the `pcbridge` command plus a local daemon and a Chrome Manifest V3 extension. MCP is intentionally not required.

## Install

From npm:

```bash
bun add --global playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

From this GitHub repository for unreleased changes:

```bash
bun add --global github:Q-My99/playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

The commands documented below track repository version `0.6.2`. bun installs the latest stable
release; use the GitHub install when testing changes that have not been released yet.

One-shot with npx:

```bash
npx playcanvas-agent-bridge-cli doctor
npx playcanvas-agent-bridge-cli install-skill --agent all
```

## Update pcbridge components

The CLI/daemon, installed agent skills, generated Chrome extension, and optional custom Editor
frontend are separate local components. Updating one does not update the others automatically.

### Update the CLI, daemon, and agent skills

```bash
bun add --global playcanvas-agent-bridge-cli@latest
pcbridge version
pcbridge install-skill --agent all
pcbridge daemon restart --workspace /the/workspace/root
```

Installing the npm package replaces the CLI files, but an already-running daemon remains the old
in-memory version until it is restarted. `daemon restart` authenticates the existing pcbridge
listener, shuts it down gracefully, waits for the port to be released, and starts the new daemon in
the current terminal. It never kills an unverified process merely because that process occupies the
configured port. When upgrading from a version that predates authenticated shutdown, stop that old
daemon once with **Ctrl+C**, then use `daemon restart` for later switches and upgrades.

Installed Codex, Claude, Cursor, and Windsurf skills are also copies, so rerun `install-skill`;
start a new agent task/session if the client has already loaded the old skill.

### Update the Chrome extension

After updating the CLI, regenerate the unpacked extension directory:

```bash
pcbridge install-extension --no-open
```

Then complete these **manual Chrome steps**:

1. Open `chrome://extensions`.
2. Find **PlayCanvas Agent Bridge** and click **Reload**. Loading it again is unnecessary when the
   existing entry already points to `~/.pcbridge/extension`.
3. If the extension is not installed, enable Developer Mode, click **Load unpacked**, and select the
   directory printed by `pcbridge install-extension`.
4. Refresh every open PlayCanvas Editor and Launch tab.
5. After restarting the daemon, run `pcbridge doctor` and confirm the generated and connected
   extension versions match the CLI.

Updating npm alone does not refresh `~/.pcbridge/extension`, and rewriting that directory does not
make Chrome reload an unpacked extension automatically.

### Update the custom PlayCanvas Editor frontend

The custom frontend has its own release lifecycle and is not bundled with the CLI or extension:

```bash
pcbridge frontend update
pcbridge frontend status
```

`frontend update` downloads, verifies, and activates the latest published frontend by default. A
running daemon resolves the active release for each request, so a frontend-only update does not
require a daemon restart. The **manual step is to refresh the PlayCanvas Editor tab**. If the project
is currently using the official frontend, open the extension popup and choose **Use custom
frontend**. Previously downloaded frontend releases remain installed until explicitly removed.

## Install the Chrome extension

Run:

```bash
pcbridge install-extension
```

The command generates a local unpacked extension directory at:

```text
~/.pcbridge/extension
```

On Windows this path is under your user home directory. The path printed by
`pcbridge install-extension` is the source of truth.

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click Load unpacked.
4. Select the exact directory printed by `pcbridge install-extension`.
5. Open or refresh a PlayCanvas Editor page or a PlayCanvas Launch page.

The generated extension directory contains a local session token in `config.json`, so load that generated directory rather than the raw `extension/` folder from the repo.

## Use the custom Editor frontend

The Editor build is not bundled in the npm package. Download the latest published build from
`Q-My99/playcanvas-editor`, verify its release metadata and SHA-256, then activate it locally:

```bash
pcbridge frontend install latest
pcbridge frontend status
pcbridge daemon start
```

The daemon serves the active build from `http://localhost:3487`. On a
`https://playcanvas.com/editor/...` tab, open the extension popup and choose **Use custom
frontend**. Choose **Use official frontend** to remove `use_local_frontend` and reload the same
Editor URL with the official frontend.

The extension remembers the last popup selection per PlayCanvas project ID. Later visits to either
the `/editor/project/<projectId>` scene picker or an `/editor/scene/<sceneId>` page automatically
add or remove `use_local_frontend` while preserving other query parameters and the URL hash. The
preference changes only when the user clicks **Use custom frontend** or **Use official frontend**
again, and the popup shows the remembered value under **Project preference**.

A remembered custom preference is applied even when the daemon or frontend listener is unavailable,
so the Editor fails visibly instead of silently falling back to the official frontend. The popup
reports whether the daemon is offline, the frontend server is stopped, or no release is installed.
The pcbridge daemon and its frontend listener are started together from the terminal; the extension
does not attempt to start local processes.

Manage installed releases explicitly when needed:

```bash
pcbridge frontend list
pcbridge frontend update
pcbridge frontend use playcanvas-editor-v2.28.1-r1
pcbridge frontend remove playcanvas-editor-v2.28.1-r1
```

Downloaded builds live under `~/.pcbridge/frontends/`. Removing the active release is refused
until another installed release is selected.

## Start the bridge

Use the current directory as the workspace root, or pass it explicitly:

```bash
cd /path/to/my-playcanvas-workspace
pcbridge daemon start

# Equivalent from any directory
pcbridge daemon start --workspace /path/to/my-playcanvas-workspace

# Stop the current daemon and switch workspace roots
pcbridge daemon restart --workspace /path/to/another-workspace

# Gracefully stop the authenticated pcbridge daemon
pcbridge daemon stop
```

`daemon restart` and `daemon stop` first verify the token-protected `/health` response. A token
mismatch or a non-pcbridge listener fails without terminating the process on that port. Both
`start` and `restart` run the daemon in the foreground so logs remain visible and **Ctrl+C** still
works.

When a ready Editor connects, pcbridge creates `<projectId>-<projectName>/` automatically:

```text
1552681-pcbridge-test/
├── pcbridge.project.json # project metadata plus the agent-readable asset catalog
├── scenes/       # active writable .scene.json plus read-only mirrors of inactive scenes
├── assets/       # collision-safe projection of the PlayCanvas folder tree
├── tmp/          # builds, cache, conflicts, captures, and local/remote deletion trash
└── .pcbridge/    # internal sync state, 3-way JSON baselines, and object cache; do not edit
```

Inspect or refresh the workspace with:

```bash
pcbridge workspace status --target editor:<sceneId>
pcbridge workspace path --target editor:<sceneId>
pcbridge workspace settings [--eager-max-mb <1..10>]
pcbridge workspace sync --target editor:<sceneId>
pcbridge workspace pull --target editor:<sceneId> --asset <assetId>
```

Synchronization is event-driven over WebSocket deltas (`workspace:delta`) and targeted local
`fs.watch` dirty paths without idle polling. Text assets (`script`, `text`, `json`, `html`, `css`,
`shader`) and structured JSON data assets (`material`, `template`, `cubemap`, `sprite`,
`animstategraph`, `bundle`, projected as `<name>.<type>.json`) up to the direct-sync size limit are
eagerly mirrored and kept bidirectional. Adjust the direct-sync limit from **1 MB to 10 MB**
(default **2 MB**) with the slider in the browser extension popup or `pcbridge workspace settings
--eager-max-mb <1..10>`. The active Editor scene is mirrored bidirectionally at
`scenes/<name>.<sceneId>.scene.json` with DFS-ordered entities, while inactive project scenes are
mirrored as read-only (`0o444`, `$pcbridge.readonly: true`) files for cross-scene inspection
(`pcbridge scene open` activates a scene before editing it).

Structured JSON assets and active scenes use canonical formatting and property-path 3-way merge
against `.pcbridge/baselines/`: non-overlapping local and Editor edits merge automatically, while
conflicting edits to the same leaf property preserve `.local`, `.remote`, and `.conflict.json` under
`tmp/conflicts/`. Images, models, audio, fonts, and files above the direct-sync limit remain lazy:
metadata, dimensions, and MD5 hashes are recorded in `pcbridge.project.json`, and bytes are fetched
on demand via `workspace pull` or Tiny Builder. New local files (including new `*.<type>.json`
structured assets) create matching remote Assets and folders; renames and moves preserve the Asset
ID via embedded `$pcbridge.id`, file inode, or content hash. Deleting an eagerly synced Tier 1 file
locally backs up the file under `tmp/trash/local/` and deletes the remote Asset to keep both sides
consistent, whereas deleting a pulled lazy binary file only evicts the local cache. The `tmp/` tree
is agent-owned and excluded from workspace synchronization.

PlayCanvas may create source and generated Assets with the same display name, for example a source
GLB plus Container/Model outputs or a font plus generated atlas files. The manifest keeps the remote
display `folder` separate from the unique local `projectionPath`. The real `file.filename` is used
for derived files while source/standalone names track `asset.name`; only collisions receive
`.__pc_<type>_<assetId>` before the extension. Source and standalone projections are writable.
Generated binary derivatives are lazy and read-only (`0o444`), while structured JSON assets
linked to a source model (such as FBX/GLB-imported materials) remain writable and bidirectional,
recording `$pcbridge.sourceAssetId` for provenance; local edits or moves on read-only binary
derivatives are quarantined under `tmp/conflicts/` before restoration.

`pcbridge.project.json` schema v3 records `origin` (`source`, `derived`, or `standalone`), advertised
and observed remote file metadata, the effective MD5, and local presence/writability/current/base
hashes. Texture variants, additional font maps, and similar build-only files are listed under
`local.resources`; they are read-only managed files beside the primary Asset projection. Agents may
read this catalog directly; the `assets` object is managed by pcbridge. Existing
schema-v1 and schema-v2 state is migrated automatically; the v1 hidden index is retained as
`.pcbridge/asset-index.v1.json` for rollback.
An empty snapshot received while indexed assets exist is ignored, and a non-empty shrinking
snapshot must repeat before files are moved to `tmp/trash/remote/`.

## Template builds and S3 uploads

Selecting a PlayCanvas Template Asset adds a **pcbridge Tiny Builder** section to the Attributes
panel. **Build and upload to S3** collects recursive Asset references, attached scripts, and child
Templates in the page. The daemon materializes every dependency under `assets/`: an existing local
file is reused when it matches the effective remote MD5, while a missing or remote-updated file is
synchronized from PlayCanvas first. Texture variants and additional font maps are stored beside the
primary Asset as managed read-only resources, not under `tmp/cache/assets/`. The internal
`.pcbridge/objects/` cache avoids repeat downloads, and uploads run concurrently without creating a
ZIP. Attached non-`sds*` scripts are merged, transpiled to ES5 with Babel, and conservatively
compressed with Terser while preserving function and class names. Only generated `tinyapp.json`
and `gamescript.js` files live under `tmp/builds/`.

Create `.env` in the directory where the daemon starts for workspace defaults, or in a project
directory for per-project values. Project values override workspace values field by field. Do not
commit credential-bearing `.env` files:

```dotenv
PCBRIDGE_S3_ENDPOINT=https://s3.example.com
PCBRIDGE_S3_REGION=us-east-1
PCBRIDGE_S3_BUCKET=my-bucket
PCBRIDGE_S3_ACCESS_KEY_ID=your-access-key
PCBRIDGE_S3_SECRET_ACCESS_KEY=your-secret-key
# PCBRIDGE_S3_SESSION_TOKEN=
PCBRIDGE_S3_PUBLIC_BASE_URL=https://cdn.example.com
PCBRIDGE_S3_PREFIX=assets
PCBRIDGE_S3_FORCE_PATH_STYLE=false
```

The implementation uses the standard AWS S3 client and supports Amazon S3, Alibaba OSS, Tencent
COS, Cloudflare R2, and other compatible providers. Set `PCBRIDGE_S3_FORCE_PATH_STYLE` when the
provider requires path-style addressing. Bucket-prefixed OSS endpoints such as
`https://my-bucket.oss-cn-shanghai.aliyuncs.com` are normalized before the SDK applies the bucket,
and uploads use a fixed `Content-MD5` instead of streaming checksum trailers. Builds can also be
started and inspected from the CLI:

```bash
pcbridge builder start --target editor:<sceneId> --asset <templateAssetId> --suffix '-${time}'
pcbridge builder status --job <jobId>
```

Script, JSON, upload, and capture paths are restricted to the selected project workspace by default.
Use `--allow-external-path` only for an intentional external file.

In another terminal:

```bash
pcbridge doctor
pcbridge targets
pcbridge eval --target editor:<sceneId> --code "return { href: location.href, hasEditor: !!editor }"
pcbridge launch diagnose --target launch:<sceneId>
```

`doctor` distinguishes a missing listener (`DAEMON_NOT_LISTENING`) from a sandbox that blocks
localhost (`LOOPBACK_ACCESS_DENIED`); only the former means another daemon should be started.

## Progressive help

The CLI exposes layered help so agents can load only the command surface they need:

```bash
pcbridge help
pcbridge help core
pcbridge help workspace
pcbridge help processing
pcbridge help import
pcbridge help builder
pcbridge help frontend
pcbridge help target
pcbridge help entity
pcbridge help asset
pcbridge help material
pcbridge help template
pcbridge help script
pcbridge help scene
pcbridge help store
pcbridge help viewport
pcbridge help launch
pcbridge help logs
pcbridge help eval
```

Use structured commands for small, known operations that map cleanly to one Editor action. Use
`pcbridge eval` for exploratory work, custom Editor/Engine API workflows, Launch debugging, and
large multi-step scene edits where one script is clearer and faster than many CLI calls.

## Common commands

```bash
pcbridge entity list --target editor:<sceneId> --limit 50
pcbridge entity list --target editor:<sceneId> --tag enemy --component render
pcbridge entity create --target editor:<sceneId> --json ./entity.json
pcbridge entity create-many --target editor:<sceneId> --json ./entities.json
pcbridge entity patch --target editor:<sceneId> --id <resource_id> --set position='[0,1,0]'
pcbridge entity patch-many --target editor:<sceneId> --json ./edits.json
pcbridge entity duplicate --target editor:<sceneId> --id <resource_id>
pcbridge entity reparent --target editor:<sceneId> --id <resource_id> --parent <parent_resource_id>
pcbridge entity set-material --target editor:<sceneId> --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.5}'
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --script-name sdsAudioPlayer --attributes-json ./audio-slots.json
pcbridge entity delete --target editor:<sceneId> --id <resource_id>

pcbridge asset list --target editor:<sceneId> --type script
pcbridge asset list --target editor:<sceneId> --tag generated
pcbridge asset get --target editor:<sceneId> --id <asset_id>
pcbridge asset create --target editor:<sceneId> --json ./assets.json
pcbridge asset folder ensure --target editor:<sceneId> --path "AI Agent Bridge/Demo/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./texture.png --name DemoTexture --folder "AI Agent Bridge/Demo/Textures"
pcbridge asset upload-many --target editor:<sceneId> --json ./upload-manifest.json
pcbridge asset instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge asset delete --target editor:<sceneId> --id <asset_id>

pcbridge material create --target editor:<sceneId> --name DemoMaterial --folder "AI Agent Bridge/Demo/Materials" --diffuse-map <texture_asset_id>
pcbridge material patch --target editor:<sceneId> --asset-id <asset_id> --set diffuse='[1,0,0]'

pcbridge template create --target editor:<sceneId> --entity-id <resource_id> --name DemoTemplate --folder "AI Agent Bridge/Demo/Templates"
pcbridge template instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge template overrides --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply-many --target editor:<sceneId> --json ./template-roots.json

pcbridge script create --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "AI Agent Bridge/Demo/Scripts"
pcbridge script upsert --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "AI Agent Bridge/Demo/Scripts" --parse --wait
pcbridge script set-text --target editor:<sceneId> --asset-id <asset_id> --file ./controller.js --parse --wait
pcbridge script parse --target editor:<sceneId> --asset-id <asset_id>

pcbridge scene settings get --target editor:<sceneId>
pcbridge scene settings patch --target editor:<sceneId> --set physics.gravity='[0,-9.8,0]'

pcbridge store search --target editor:<sceneId> --search vehicle --limit 20
pcbridge store get --target editor:<sceneId> --id <store_asset_id>
pcbridge store download --target editor:<sceneId> --id <store_asset_id> --name Vehicle --license-json ./license.json

pcbridge viewport capture --target editor:<sceneId> --out ./tmp/playcanvas-viewport.png
pcbridge viewport focus --target editor:<sceneId> --id <resource_id> --view perspective

pcbridge logs get --target editor:<sceneId> --limit 100
pcbridge logs get --target launch:<sceneId> --level error
pcbridge logs clear --target editor:<sceneId>
```

Use `--script-name` for ScriptTypes registered by a bundle or runtime asset and therefore lacking a
standalone script asset id. Script update commands with `--parse --wait` verify the uploaded text,
stable file metadata, and parsed attributes before returning. This completion check covers the
remote asset and current Editor observer, not a later workspace mirror sync.

Template apply commands invoke the Editor's existing `templates:apply` action. When overrides exist,
completion requires its pipeline callback plus two zero-override observations. A returned `verified`
value only confirms the current Editor observer; it does not confirm persistence across an Editor
reload. Editor entity patches are durable: restore preview-only enabled/visibility changes before
applying a Template. `apply-many` accepts
`{"entityIds":["root-a","root-b"]}` (or an array of ids or `{ "entityId": "..." }` items), validates
its manifest first, and applies roots serially.

For task-sized installs, keep upload manifests next to the generated files. Relative `file` paths are resolved from the manifest location:

```json
{
  "assets": [
    {
      "key": "player",
      "file": "final/player.png",
      "name": "DemoPlayer",
      "folder": "AI Agent Bridge/Demo/Textures"
    }
  ]
}
```

Use `eval --args-json` when a large Editor script needs local configuration without embedding JSON into source:

```bash
pcbridge eval --target editor:<sceneId> --file ./install-scene.js --args-json ./install-args.json
```

## Texture + material + script workflow

```bash
pcbridge asset folder ensure --target editor:<sceneId> --path "AI Agent Bridge/Texture Box/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./cat.png --name CatTexture --folder "AI Agent Bridge/Texture Box/Textures"

pcbridge material create --target editor:<sceneId> --name CatMaterial --folder "AI Agent Bridge/Texture Box/Materials" --diffuse-map <texture_asset_id>

pcbridge script create --target editor:<sceneId> --filename jumpingBox.js --file ./jumpingBox.js --folder "AI Agent Bridge/Texture Box/Scripts"

pcbridge entity create --target editor:<sceneId> --json ./box.json
pcbridge entity set-material --target editor:<sceneId> --id <box_resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target editor:<sceneId> --id <box_resource_id> --asset-id <script_asset_id> --attributes '{"height":0.5,"speed":2.4}'
```

## Target selection

```bash
pcbridge targets
pcbridge eval --target current --code "return location.href"
pcbridge eval --target tab:123 --code "return location.href"
pcbridge eval --target scene:987654 --code "return location.href"
pcbridge eval --target project:123456 --code "return location.href"
pcbridge launch diagnose --target launch:987654
pcbridge launch wait-ready --target launch:987654 --focus --timeout-ms 30000
pcbridge eval --target launch:987654 --code "return { runtimeCreated: !!runtimeApp, rootChildCount: runtimeApp?.root?.children?.length ?? 0 }"
pcbridge viewport capture --target launch:987654 --out ./tmp/launch.png
pcbridge logs get --target launch:987654 --limit 100
```

`current` means the most recently seen ready PlayCanvas target. If both the Editor and Launch page
are open for the same scene, use `tab:<id>`, `editor:<sceneId>`, or `launch:<sceneId>` to avoid
ambiguity. Editor-only structured commands require an Editor target; `eval`, `viewport capture`,
and `logs` also work on Launch targets.

Launch readiness is a best-effort heuristic, not an Engine lifecycle event. `lifecycleReady`
requires a runtime app with its own graphics canvas/context, an attached scene root, and at least
one completed frame, with no recognized splash. Target `ready` additionally requires the tab to be
visible, so use `launch wait-ready --focus` for a hidden Launch tab. `scriptTypeCount` is diagnostic
only and does not prove every ScriptType has registered. Eval receives a compatibility-resolved
`runtimeApp` binding for Engine V1 and V2.

`viewport capture` records the current canvas; it does not resize Chrome or emulate a mobile DPR.
PNG can preserve transparency; the default `--max-width 1200` can downscale output. Eval output is bounded; use a
leaf projection first, then bounded `--max-depth`, `--max-items`, or `--max-keys` if needed.

## Agent skills

Install rules/skills for common agents:

```bash
pcbridge install-skill --agent codex
pcbridge install-skill --agent claude
pcbridge install-skill --agent cursor
pcbridge install-skill --agent windsurf
pcbridge install-skill --agent all
```

Use `--path` to install one agent's skill or rule under a custom parent directory. Relative paths
are resolved from the current working directory, and pcbridge appends the standard directory or
filename so the parent itself is never cleared:

```bash
pcbridge install-skill --agent codex --path "D:\AgentConfig\skills"
pcbridge install-skill --agent cursor --path ./.cursor/rules
```

These create `D:\AgentConfig\skills\playcanvas-agent-bridge-cli\` and
`.cursor/rules/playcanvas-agent-bridge-cli.mdc`. Quote Windows paths that contain spaces.
`--agent all --path ...` is rejected because the supported agents use different artifact layouts;
run one command per agent for custom locations.

Installed locations:

- Codex: `~/.codex/skills/playcanvas-agent-bridge-cli`
- Claude: `~/.claude/skills/playcanvas-agent-bridge-cli`
- Cursor: `~/.cursor/rules/playcanvas-agent-bridge-cli.mdc`
- Windsurf: `~/.windsurf/rules/playcanvas-agent-bridge-cli.md`

The extension popup shows daemon and current-tab connectivity, project/scene/branch identity,
workspace path and sync counts, conflicts, and custom Editor frontend state. Red means disconnected
or conflicted, yellow means initializing/syncing/local attention, and green means ready/synced.

## Security model

This is a local trusted developer tool. It executes JavaScript inside PlayCanvas Editor and Launch pages that you already have open.

Safeguards:

- daemon binds only to `127.0.0.1`;
- the frontend server binds only to `127.0.0.1`, validates the Host header, and serves only files
  under the active verified release;
- CLI, daemon, and extension share a local session token;
- extension matches only PlayCanvas Editor and Launch URLs;
- CLI output uses compact JSON envelopes;
- structured write commands require explicit IDs or JSON files.

## Development

```bash
bun install
bun run build
bun dist/cli.js doctor
```

Use `bun` for one-off TypeScript scripts if you add them.

## Publishing to npm (maintainers)

Publishing uses npm Trusted Publishing through `.github/workflows/npm-publish.yml`; the GitHub
repository does not need an `NPM_TOKEN` secret.

1. Update the same stable version in `package.json`, `src/config.ts`, and
   `extension/manifest.json`.
2. Run `bun run test`, commit the release to `main`, and push `main`.
3. Create and push the matching tag, for example:

```bash
git tag v<version>
git push origin v<version>
```

The workflow rejects tags that do not match the package version or whose commit is not on `main`.
Configure the npm package's Trusted Publisher with GitHub user `Q-My99`, repository
`playcanvas-agent-bridge-cli`, and workflow filename `npm-publish.yml` before pushing the tag.

## Self-hosted sites and local asset processing

The extension automatically recognizes official PlayCanvas, localhost and 127.0.0.1 Editor/Launch pages on any port. For another hostname, use **Enable on this site** in the popup, grant Chrome permission, then refresh. Editor and Launch hosts need separate grants. Disabling or revoking a site closes existing connections. Self-hosted pages never inherit the official frontend-switch preference.

Local conversion is opt-in and self-hosted only. Install a **trusted** versioned asset-tools manifest and its precompiled archive (macOS arm64 validated; no public release published yet):

```sh
pcbridge processing install /path/to/release.json
pcbridge processing enable --memory-mb 1024 --timeout-ms 600000
pcbridge processing status --target editor:<sceneId>
pcbridge import submit --asset <id> --kind model --json options.json --target editor:<sceneId>
pcbridge import list --target editor:<sceneId>
pcbridge import wait --job <id> --sync-workspace --target editor:<sceneId>
pcbridge import status --job <id> --target editor:<sceneId>
pcbridge import cancel --job <id> --target editor:<sceneId>
pcbridge import retry --job <id> --target editor:<sceneId>
pcbridge processing disable
```

For textures use `--kind texture` with options such as `{"formats":["dxt","etc2"],"mipmaps":true}`. Existing asset uploads and Editor UI use the same server jobs. Browser-owned authentication, leases and object-store URLs never reach the CLI. `complete` means server publication; `--sync-workspace` separately waits for metadata synchronization, retaining lazy binary downloads. Missing/disabled/busy tools fall back to the server worker.

Processing uses one fixed subprocess, a 1 GiB conversion budget, 256 KiB sequential chunks and project `tmp/processing/` scratch files. A ten-minute conversion timeout and ninety-second abandoned-transfer timeout bound execution. This is not an OS memory sandbox. Tool/recipe/platform checks are independent of bridge connectivity. Server caches remain trusted; client output does not populate the server converter cache. Persistent local result caching is not implemented.

After upgrading extension sources, regenerate with `pcbridge install-extension --no-open`, reload the unpacked extension in Chrome, refresh Editor/Launch and restart an older daemon while retaining its workspace path. Official and self-hosted projects must use separate workspaces and explicit targets; project IDs are not namespaced across sites. Fresh self-hosted resource datasets use MD5; no legacy SHA-256 resource migration is provided.
