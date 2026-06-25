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
2. Prefer structured commands for common tasks: `entity`, `asset`, `script`, and `viewport`.
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

Work with assets and scripts:

```bash
pcbridge asset list --target current --type script --limit 50
pcbridge script set-text --target current --asset-id <id> --file ./controller.js
pcbridge script parse --target current --asset-id <id>
```

Capture the viewport:

```bash
pcbridge viewport capture --target current --out /tmp/playcanvas-viewport.webp
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
