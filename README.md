# playcanvas-agent-bridge-cli

CLI-first local automation for controlling already-open PlayCanvas Editor scenes and PlayCanvas Launch pages from AI coding agents such as Codex, Claude Code, Cursor, and Windsurf.

The core interface is the `pcbridge` command plus a local daemon and a Chrome Manifest V3 extension. MCP is intentionally not required.

## Install

From npm:

```bash
npm install -g playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

From this GitHub repository for unreleased changes:

```bash
npm install -g github:Q-My99/playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

The commands documented below include repository version `0.4.2`. Until that version is published,
the npm `latest` release (`0.3.0` as of 2026-08-04) does not contain every command described here;
use the GitHub install when testing these unreleased changes.

One-shot with npx:

```bash
npx playcanvas-agent-bridge-cli doctor
npx playcanvas-agent-bridge-cli install-skill --agent all
```

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

Change into the directory that should become the local workspace root before starting the daemon:

```bash
cd /path/to/my-playcanvas-workspace
pcbridge daemon start
```

When a ready Editor connects, pcbridge creates `<projectId>-<projectName>/` automatically:

```text
1552681-pcbridge-test/
├── pcbridge.project.json
├── assets/       # PlayCanvas folder mirror with bidirectional script sync
├── tmp/          # task scripts, manifests, captures, and conflict copies
└── .pcbridge/    # internal asset index; do not edit
```

Inspect or refresh the workspace with:

```bash
pcbridge workspace status --target editor:<sceneId>
pcbridge workspace path --target editor:<sceneId>
pcbridge workspace sync --target editor:<sceneId>
pcbridge workspace pull --target editor:<sceneId> --asset <assetId>
```

Script contents synchronize in both directions. Create, move, rename, and delete assets through
structured pcbridge commands. Images, models, audio, and other file assets are indexed and downloaded
lazily with `workspace pull`. Concurrent local and remote script edits are preserved under
`tmp/conflicts/` instead of being overwritten.

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
pnpm install
pnpm build
node dist/cli.js doctor
```

Use `bun` for one-off TypeScript scripts if you add them.

## Publishing to npm (maintainers)

Publishing uses npm Trusted Publishing through `.github/workflows/npm-publish.yml`; the GitHub
repository does not need an `NPM_TOKEN` secret.

1. Update the same stable version in `package.json`, `src/config.ts`, and
   `extension/manifest.json`.
2. Run `pnpm test`, commit the release to `main`, and push `main`.
3. Create and push the matching tag, for example:

```bash
git tag v<version>
git push origin v<version>
```

The workflow rejects tags that do not match the package version or whose commit is not on `main`.
Configure the npm package's Trusted Publisher with GitHub user `Q-My99`, repository
`playcanvas-agent-bridge-cli`, and workflow filename `npm-publish.yml` before pushing the tag.
