---
name: playcanvas-agent-bridge-cli
description: Control an already-open PlayCanvas Editor scene or Launch page through pcbridge CLI commands and the bundled Chrome extension. Use for PlayCanvas Editor inspection, entity/asset/script edits, Launch runtime debugging, eval snippets, logs, and viewport captures without DevTools or browser automation.
---

# PlayCanvas Agent Bridge CLI

Use `pcbridge` as the only interface. Start with:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

If the daemon is offline, ask the user to run `pcbridge daemon start` in another terminal. If no PlayCanvas target appears, ask the user to run `pcbridge install-extension`, load the printed directory in `chrome://extensions`, and refresh the Editor or Launch tab.

Use layered help to load only the command surface you need:

```bash
pcbridge help
pcbridge help entity
pcbridge help asset
pcbridge help template
pcbridge help scene
pcbridge help viewport
pcbridge help launch
pcbridge help logs
pcbridge help eval
```

Use structured commands for small, known Editor operations:

```bash
pcbridge entity list --target current --limit 50
pcbridge entity create --target current --json ./entity.json
pcbridge entity create-many --target current --json ./entities.json
pcbridge entity patch --target current --id <resource_id> --set position='[0,1,0]'
pcbridge entity duplicate --target current --id <resource_id>
pcbridge entity reparent --target current --id <resource_id> --parent <parent_resource_id>
pcbridge entity set-material --target current --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.4}'
pcbridge asset list --target current --type script
pcbridge asset create --target current --json ./assets.json
pcbridge asset folder ensure --target current --path "AI Agent Bridge/My Task/Textures"
pcbridge asset upload --target current --file ./texture.png --name TaskTexture --folder "AI Agent Bridge/My Task/Textures"
pcbridge asset upload-many --target current --json ./upload-manifest.json
pcbridge material create --target current --name TaskMaterial --folder "AI Agent Bridge/My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge template create --target current --entity-id <resource_id> --name TaskTemplate --folder "AI Agent Bridge/My Task/Templates"
pcbridge template instantiate --target current --id <template_asset_id>
pcbridge scene settings get --target current
pcbridge viewport focus --target current --id <resource_id> --view perspective
pcbridge script upsert --target current --filename controller.js --file ./script.js --folder "AI Agent Bridge/My Task/Scripts" --parse
pcbridge script create --target current --filename controller.js --file ./script.js --folder "AI Agent Bridge/My Task/Scripts"
pcbridge script set-text --target current --asset-id <id> --file ./script.js
pcbridge viewport capture --target current --out ./tmp/playcanvas.png
pcbridge logs get --target launch:<sceneId> --limit 100
pcbridge logs get --target launch:<sceneId> --level error
```

Organize generated assets under `AI Agent Bridge/<task name>/Textures`, `Materials`, and `Scripts`. Use `pcbridge eval` for exploratory API inspection, custom Editor/Engine workflows, and large multi-step scene edits:

```bash
pcbridge eval --target current --code "return { href: location.href, entityCount: editor.api.globals.entities.list().length }"
pcbridge eval --target current --file ./install.js --args-json ./install-args.json --timeout-ms 120000
pcbridge eval --target launch:<sceneId> --code "return { href: location.href, hasPc: !!pc, canvasCount: document.querySelectorAll('canvas').length }"
```

Eval snippets run in an async function with `editor`, `pc`, `pcui`, `window`, `document`, `command`, and `serialize`. Return compact JSON only. Do not return raw PlayCanvas Editor objects. Use `{ history: true }` for Editor mutations when available, and verify changes with a read-only command.

For Launch runtime debugging, target `launch:<sceneId>` or `tab:<id>` and use `pcbridge eval`, `pcbridge viewport capture`, and `pcbridge logs get`. Editor-only structured entity/asset/script commands require an Editor target.

For large PlayCanvas tasks, choose an explicit target from `pcbridge targets`, keep task files in a local folder, upload assets with an upload manifest, use `script upsert` for repeatable script updates, and capture the viewport after smoke tests. If the same manual glue repeats across tasks, improve the CLI or this skill instead of continuing the brittle sequence.

Do not pre-place runtime-generated content just to prove a game exists. Keep procedural maps, pickups, enemies, and VFX in the runtime script, with only a small durable Editor root and helper entities when needed. If Editor entities must be created, use structured commands and small `entity create-many` batches with read-back verification; large eval scripts that create many entities in a tight loop can briefly show objects and then lose them from the Editor data model.
