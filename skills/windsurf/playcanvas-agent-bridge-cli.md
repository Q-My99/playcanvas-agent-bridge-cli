# PlayCanvas Agent Bridge CLI

Use `pcbridge` to automate an already-open PlayCanvas Editor tab through the local daemon and Chrome extension.

Start with:

```bash
pcbridge doctor
pcbridge daemon status
pcbridge targets
```

If the daemon is offline, ask the user to run `pcbridge daemon start`. If no target is connected, ask the user to run `pcbridge install-extension`, load the printed unpacked extension path in `chrome://extensions`, and refresh the Editor tab.

Prefer structured commands over eval:

```bash
pcbridge entity list --target current --limit 50
pcbridge entity create --target current --json ./entity.json
pcbridge entity patch --target current --id <resource_id> --set position='[0,1,0]'
pcbridge entity set-material --target current --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.4}'
pcbridge asset list --target current --type script
pcbridge asset folder ensure --target current --path "AI Agent Bridge/My Task/Textures"
pcbridge asset upload --target current --file ./texture.png --name TaskTexture --folder "AI Agent Bridge/My Task/Textures"
pcbridge material create --target current --name TaskMaterial --folder "AI Agent Bridge/My Task/Materials" --diffuse-map <texture_asset_id>
pcbridge script create --target current --filename controller.js --file ./script.js --folder "AI Agent Bridge/My Task/Scripts"
pcbridge script set-text --target current --asset-id <id> --file ./script.js
pcbridge viewport capture --target current --out ./tmp/playcanvas.png
```

Put generated assets under `AI Agent Bridge/<task name>/Textures`, `Materials`, and `Scripts`.

Use `pcbridge eval` only for custom Editor API snippets. Return compact JSON and never return raw PlayCanvas Editor objects. Use history-enabled mutations when available and verify writes with a read-only command.
