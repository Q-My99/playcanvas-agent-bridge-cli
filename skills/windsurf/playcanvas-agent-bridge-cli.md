# PlayCanvas Agent Bridge CLI

Use `pcbridge` to automate an already-open PlayCanvas Editor tab or debug a PlayCanvas Launch tab through the local daemon and Chrome extension.

Start with:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

If the daemon is offline, ask the user to run `pcbridge daemon start`. If no target is connected, ask the user to run `pcbridge install-extension`, load the printed unpacked extension path in `chrome://extensions`, and refresh the Editor or Launch tab.

Use layered help to load only the command surface you need: `pcbridge help`, then `pcbridge help entity|asset|material|template|script|scene|store|viewport|logs|eval`.

Use structured commands for small, known Editor operations:

```bash
pcbridge entity list --target current --limit 50
pcbridge entity create --target current --json ./entity.json
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

Put generated assets under `AI Agent Bridge/<task name>/Textures`, `Materials`, and `Scripts`.

Use `pcbridge eval` for exploratory API inspection, custom Editor/Engine workflows, Launch runtime debugging, and large multi-step scene edits. Use `pcbridge eval --file ./install.js --args-json ./args.json --timeout-ms 120000` when local configuration is too large to embed in code or the install can exceed the default 15s timeout. Return compact JSON and never return raw PlayCanvas Editor objects. Use history-enabled mutations when available and verify writes with a read-only command.

For Launch runtime debugging, target `launch:<sceneId>` or `tab:<id>` and use `pcbridge eval`, `pcbridge viewport capture`, and `pcbridge logs get`. Editor-only structured entity/asset/script commands require an Editor target.

For large tasks, choose an explicit target from `pcbridge targets`, keep generated files and captures in a local task folder, upload batches with `asset upload-many`, update scripts with `script upsert`, and capture the viewport after smoke tests. If repeated manual glue appears, improve the CLI or this rule.

Do not pre-place runtime-generated content just to prove a game exists. Keep procedural maps, pickups, enemies, and VFX in the runtime script, with only a small durable Editor root and helper entities when needed. If Editor entities must be created, use structured commands and small `entity create-many` batches with read-back verification; large eval scripts that create many entities in a tight loop can briefly show objects and then lose them from the Editor data model.
