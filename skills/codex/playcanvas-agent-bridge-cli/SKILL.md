---
name: playcanvas-agent-bridge-cli
description: Control an already-open PlayCanvas Editor scene or Launch page through the pcbridge CLI and Chrome extension. Use when Codex needs to inspect or modify PlayCanvas Editor targets, debug Launch runtime pages, read logs, run eval snippets, or capture viewports without DevTools, mouse/keyboard automation, MCP, or browser console scripting.
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

If the daemon is offline, tell the user to run this in a separate terminal:

```bash
pcbridge daemon start
```

If no target appears, tell the user to run `pcbridge install-extension`, load the printed directory in `chrome://extensions`, then refresh the PlayCanvas Editor or Launch tab.

## Workflow

1. Run `pcbridge targets` and choose an explicit target when possible.
2. Use layered help to load only the command group you need: `pcbridge help`, then `pcbridge help entity|asset|material|template|script|scene|store|viewport|launch|logs|eval`.
3. Use structured commands for small, known operations that map cleanly to one Editor action.
4. Use `pcbridge eval` for exploratory API inspection, custom Editor/Engine workflows, Launch runtime debugging, and large multi-step scene edits where one script is clearer than many CLI calls.
5. Return compact JSON from snippets. Never return raw `editor`, `Entity`, `Asset`, `entities.root`, or app objects.
6. Use PlayCanvas history options for writes when available.
7. Verify writes with a read-only command after mutation.

## Safe Commands

Inspect a scene:

```bash
pcbridge eval --target current --code "return { href: location.href, hasEditor: !!editor, entityCount: editor.api.globals.entities.list().length }"
```

List entities:

```bash
pcbridge entity list --target current --limit 50
pcbridge entity list --target scene:<sceneId> --name Player --component render
pcbridge entity list --target current --tag enemy
```

Create an entity from JSON:

```bash
pcbridge entity create --target current --json ./entity.json
pcbridge entity create-many --target current --json ./entities.json
```

Patch an entity:

```bash
pcbridge entity patch --target current --id <resource_id> --set name=Player --set position='[0,1,0]'
pcbridge entity patch-many --target current --json ./edits.json
pcbridge entity duplicate --target current --id <resource_id>
pcbridge entity reparent --target current --id <resource_id> --parent <parent_resource_id>
```

Modify components and materials:

```bash
pcbridge entity add-component --target current --id <resource_id> --component render --data '{"type":"box"}'
pcbridge entity add-components --target current --id <resource_id> --json ./components.json
pcbridge entity set-material --target current --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.4}'
pcbridge entity delete --target current --id <resource_id>
```

Work with assets and scripts:

```bash
pcbridge asset list --target current --type script --limit 50
pcbridge asset create --target current --json ./assets.json
pcbridge asset folder ensure --target current --path "AI Agent Bridge/My Task/Textures"
pcbridge asset upload --target current --file ./texture.png --name TaskTexture --folder "AI Agent Bridge/My Task/Textures"
pcbridge asset upload-many --target current --json ./upload-manifest.json
pcbridge asset instantiate --target current --id <template_asset_id>
pcbridge material create --target current --name TaskMaterial --folder "AI Agent Bridge/My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge material patch --target current --asset-id <material_asset_id> --set diffuse='[1,0,0]'
pcbridge template create --target current --entity-id <resource_id> --name TaskTemplate --folder "AI Agent Bridge/My Task/Templates"
pcbridge template instantiate --target current --id <template_asset_id>
pcbridge script upsert --target current --filename controller.js --file ./controller.js --folder "AI Agent Bridge/My Task/Scripts" --parse
pcbridge script create --target current --filename controller.js --file ./controller.js --folder "AI Agent Bridge/My Task/Scripts"
pcbridge script set-text --target current --asset-id <id> --file ./controller.js
pcbridge script parse --target current --asset-id <id>
```

Scene, store, and viewport:

```bash
pcbridge scene settings get --target current
pcbridge scene settings patch --target current --json ./scene-settings.json
pcbridge store search --target current --search vehicle --limit 20
pcbridge store get --target current --id <store_asset_id>
pcbridge viewport focus --target current --id <resource_id> --view perspective
```

Capture the viewport:

```bash
pcbridge viewport capture --target current --out ./tmp/playcanvas-viewport.png
```

Launch runtime debugging:

```bash
pcbridge eval --target launch:<sceneId> --code "return { href: location.href, hasPc: !!pc, canvasCount: document.querySelectorAll('canvas').length }"
pcbridge viewport capture --target launch:<sceneId> --out ./tmp/launch.png
pcbridge logs get --target launch:<sceneId> --limit 100
pcbridge logs get --target launch:<sceneId> --level error
```

## Asset Organization

Create task-scoped folders before uploading generated assets:

```text
AI Agent Bridge/<task name>/Textures
AI Agent Bridge/<task name>/Materials
AI Agent Bridge/<task name>/Scripts
```

Use stable names that describe the asset purpose. Avoid dumping generated files at the project root.

## Large Task Workflow

For multi-asset or game-sized tasks:

1. Choose an explicit target from `pcbridge targets`, preferably `scene:<sceneId>` or `tab:<id>`.
2. Create a project-local task folder for generated scripts, manifests, captures, and temporary assets.
3. Put PlayCanvas assets under `AI Agent Bridge/<task name>/{Textures,Materials,Scripts,Templates}`.
4. Use `pcbridge asset upload-many --json ./upload-manifest.json` for batches. In the manifest, each item needs `file` and may include `key`, `name`, `filename`, `type`, `mime`, `folder`, `folderId`, and `preload`. Relative `file` paths resolve from the manifest file; `key` is returned for later argument mapping but is not sent to PlayCanvas.
5. Use `pcbridge script upsert --filename <name>.js --file ./script.js --folder "AI Agent Bridge/<task name>/Scripts" --parse` for repeatable script creation or update.
6. Use `pcbridge eval --file ./install.js --args-json ./args.json --timeout-ms 120000` for large scene installation scripts. The JSON object is available as `command.args`; increase `--timeout-ms` instead of splitting a coherent install script just to avoid the default 15s timeout.
7. Verify with read-only commands, a small smoke-test eval, and `pcbridge viewport capture --out ./task/captures/preview.png`.

If repeated manual glue is needed across tasks, improve the CLI or this skill rather than continuing to hand-roll brittle shell/script sequences.

## Editor Entity Persistence Notes

Do not pre-place runtime-generated content just to prove a game exists. For roguelike maps, procedural levels, particles, pickups, and enemies that are generated at launch, keep the durable Editor surface small: a root entity, script component, camera/light helpers when useful, and persistent assets/scripts.

When Editor entities do need to be created or replaced, prefer structured commands such as `entity create`, `entity create-many`, `entity add-script`, `entity set-material`, and `entity patch-many`. In current PlayCanvas Editor builds, a large `eval` script that creates many entities in a tight loop can briefly show objects in the viewport and then lose them from the Editor data model. For large static previews, create in small batches, pause between batches when needed, then immediately verify with `entity list` by name/tag before capturing the viewport.

## Texture Box Pattern

For a textured scripted box, compose structured commands instead of writing one large eval:

```bash
pcbridge asset folder ensure --target current --path "AI Agent Bridge/Texture Box/Textures"
pcbridge asset upload --target current --file ./image.png --name TextureBoxImage --folder "AI Agent Bridge/Texture Box/Textures"
pcbridge material create --target current --name TextureBoxMaterial --folder "AI Agent Bridge/Texture Box/Materials" --diffuse-map <texture_asset_id>
pcbridge script create --target current --filename jumpingBox.js --file ./jumpingBox.js --folder "AI Agent Bridge/Texture Box/Scripts"
pcbridge entity create --target current --json ./box.json
pcbridge entity set-material --target current --id <box_resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <box_resource_id> --asset-id <script_asset_id> --attributes '{"height":0.5,"speed":2.4}'
```

## Eval Snippet Rules

The snippet runs inside an async function with these bindings:

```js
editor;
pc;
pcui;
window;
document;
command;
serialize;
```

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
