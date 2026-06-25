---
name: playcanvas-agent-bridge-cli
description: Control an already-open PlayCanvas Editor scene through the pcbridge CLI and Chrome extension. Use when Codex needs to inspect or modify PlayCanvas Editor targets, entities, assets, scripts, scene data, or viewport captures without DevTools, mouse/keyboard automation, MCP, or browser console scripting.
---

# PlayCanvas Agent Bridge CLI

Use `pcbridge` to automate PlayCanvas Editor through a local daemon and Chrome extension. The CLI is the interface; this skill only tells the agent how to use it safely.

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

If no target appears, tell the user to run `pcbridge install-extension`, load the printed directory in `chrome://extensions`, then refresh the PlayCanvas Editor tab.

## Workflow

1. Run `pcbridge targets` and choose an explicit target when possible.
2. Prefer structured commands for common tasks: `entity`, `asset`, `material`, `script`, and `viewport`.
3. Use `pcbridge eval` only for custom Editor API work.
4. Return compact JSON from snippets. Never return raw `editor`, `Entity`, `Asset`, `entities.root`, or app objects.
5. Use PlayCanvas history options for writes when available.
6. Verify writes with a read-only command after mutation.

## Safe Commands

Inspect a scene:

```bash
pcbridge eval --target current --code "return { href: location.href, hasEditor: !!editor, entityCount: editor.api.globals.entities.list().length }"
```

List entities:

```bash
pcbridge entity list --target current --limit 50
pcbridge entity list --target scene:<sceneId> --name Player --component render
```

Create an entity from JSON:

```bash
pcbridge entity create --target current --json ./entity.json
```

Patch an entity:

```bash
pcbridge entity patch --target current --id <resource_id> --set name=Player --set position='[0,1,0]'
```

Modify components and materials:

```bash
pcbridge entity add-component --target current --id <resource_id> --component render --data '{"type":"box"}'
pcbridge entity set-material --target current --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.4}'
pcbridge entity delete --target current --id <resource_id>
```

Work with assets and scripts:

```bash
pcbridge asset list --target current --type script --limit 50
pcbridge asset folder ensure --target current --path "AI Agent Bridge/My Task/Textures"
pcbridge asset upload --target current --file ./texture.png --name TaskTexture --folder "AI Agent Bridge/My Task/Textures"
pcbridge material create --target current --name TaskMaterial --folder "AI Agent Bridge/My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge script create --target current --filename controller.js --file ./controller.js --folder "AI Agent Bridge/My Task/Scripts"
pcbridge script set-text --target current --asset-id <id> --file ./controller.js
pcbridge script parse --target current --asset-id <id>
```

Capture the viewport:

```bash
pcbridge viewport capture --target current --out ./tmp/playcanvas-viewport.png
```

## Asset Organization

Create task-scoped folders before uploading generated assets:

```text
AI Agent Bridge/<task name>/Textures
AI Agent Bridge/<task name>/Materials
AI Agent Bridge/<task name>/Scripts
```

Use stable names that describe the asset purpose. Avoid dumping generated files at the project root.

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
