# PlayCanvas Agent Bridge CLI

Use `pcbridge` to automate an already-open PlayCanvas Editor tab or debug a PlayCanvas Launch tab through the local daemon and Chrome extension.

Start with:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

Run `pcbridge daemon start` only for `DAEMON_NOT_LISTENING`; for `LOOPBACK_ACCESS_DENIED`, retry
with local-loopback permission. If no target is connected, install/reload the unpacked extension.

The daemon start directory is the workspace root. After selecting an explicit target, run
`pcbridge workspace status --target editor:<sceneId>` and stop if it reports a conflict or sync
error. Each project is mirrored under `<projectId>-<projectName>/{assets,tmp}`. Script content syncs
both ways; other asset files are lazy until explicitly pulled.

For the optional published Editor build, use `pcbridge frontend install latest`, verify it with
`pcbridge frontend status`, and switch custom/official mode from the extension popup.
The popup remembers that choice per project and reapplies it on later project-picker and scene
Editor navigations; change the remembered choice only through the popup.

Use layered help to load only the command surface you need: `pcbridge help`, then `pcbridge help target|workspace|frontend|entity|asset|material|template|script|scene|store|viewport|launch|logs|eval`.

Use structured commands for small, known Editor operations:

```bash
pcbridge entity list --target editor:<sceneId> --limit 50
pcbridge entity create --target editor:<sceneId> --json ./entity.json
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

Put generated assets under `AI Agent Bridge/<task name>/Textures`, `Materials`, and `Scripts`.

Use `pcbridge launch diagnose` and `pcbridge launch wait-ready --focus` before runtime assertions.
Launch `lifecycleReady` is a best-effort heuristic based on an owned graphics canvas/context,
attached scene root, a completed frame, and known splash selectors; target `ready` also requires a
visible tab. These are not Engine lifecycle events, and script type count is diagnostic only. Eval
includes compatibility-resolved `runtimeApp` for Engine V1/V2 plus the existing Editor bindings. Return compact
JSON; use bounded `--max-depth`/`--max-items` only when a leaf projection is insufficient.

For Launch runtime debugging, target `launch:<sceneId>` or `tab:<id>` and use `pcbridge eval`, `pcbridge viewport capture`, and `pcbridge logs get`. Editor-only structured entity/asset/script commands require an Editor target.

Use `editor:<sceneId>` for writes and `--script-name` for bundle-registered ScriptTypes. Editor
patches are durable, so restore preview-only enabled/visibility changes before Template apply.
Template `verified` covers current Editor overrides, not persistence across a reload. Script
`--parse --wait` completion checks do not wait for the workspace mirror's later sync.
Capture records the current canvas, defaults to `--max-width 1200`, and does not emulate a mobile viewport or DPR.

For large eval installs, use `pcbridge eval --target editor:<sceneId> --file ./install.js --args-json ./install-args.json --timeout-ms 120000`.

For large tasks, choose an explicit target from `pcbridge targets`, keep generated files and captures under the project `tmp/` directory, upload batches with `asset upload-many`, edit tracked scripts under `assets/`, and capture the viewport after smoke tests. Local file arguments must remain inside the workspace; never use `--allow-external-path` without explicit user approval. If repeated manual glue appears, improve the CLI or this rule.

Do not pre-place runtime-generated content just to prove a game exists. Keep procedural maps, pickups, enemies, and VFX in the runtime script, with only a small durable Editor root and helper entities when needed. If Editor entities must be created, use structured commands and small `entity create-many` batches with read-back verification; large eval scripts that create many entities in a tight loop can briefly show objects and then lose them from the Editor data model.
