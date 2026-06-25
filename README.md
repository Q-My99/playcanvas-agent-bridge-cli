# playcanvas-agent-bridge-cli

CLI-first local automation for controlling an already-open PlayCanvas Editor scene from AI coding agents such as Codex, Claude Code, Cursor, and Windsurf.

The core interface is the `pcbridge` command plus a local daemon and a Chrome Manifest V3 extension. MCP is intentionally not required.

## Install

When published to npm:

```bash
npm install -g playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

From this GitHub repository before npm publishing:

```bash
npm install -g github:Q-My99/playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

One-shot with npx:

```bash
npx github:Q-My99/playcanvas-agent-bridge-cli doctor
npx github:Q-My99/playcanvas-agent-bridge-cli install-skill --agent all
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
5. Open or refresh a PlayCanvas Editor page.

The generated extension directory contains a local session token in `config.json`, so load that generated directory rather than the raw `extension/` folder from the repo.

## Start the bridge

```bash
pcbridge daemon start
```

In another terminal:

```bash
pcbridge doctor
pcbridge targets
pcbridge eval --target current --code "return { href: location.href, hasEditor: !!editor }"
```

## Common commands

```bash
pcbridge entity list --target current --limit 50
pcbridge entity create --target current --json ./entity.json
pcbridge entity patch --target current --id <resource_id> --set position='[0,1,0]'
pcbridge entity set-material --target current --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.5}'
pcbridge entity delete --target current --id <resource_id>

pcbridge asset list --target current --type script
pcbridge asset get --target current --id <asset_id>
pcbridge asset folder ensure --target current --path "AI Agent Bridge/Demo/Textures"
pcbridge asset upload --target current --file ./texture.png --name DemoTexture --folder "AI Agent Bridge/Demo/Textures"
pcbridge asset delete --target current --id <asset_id>

pcbridge material create --target current --name DemoMaterial --folder "AI Agent Bridge/Demo/Materials" --diffuse-map <texture_asset_id>

pcbridge script create --target current --filename controller.js --file ./controller.js --folder "AI Agent Bridge/Demo/Scripts"
pcbridge script set-text --target current --asset-id <asset_id> --file ./controller.js
pcbridge script parse --target current --asset-id <asset_id>

pcbridge viewport capture --target current --out ./tmp/playcanvas-viewport.png
```

## Texture + material + script workflow

```bash
pcbridge asset folder ensure --target current --path "AI Agent Bridge/Texture Box/Textures"
pcbridge asset upload --target current --file ./cat.png --name CatTexture --folder "AI Agent Bridge/Texture Box/Textures"

pcbridge material create --target current --name CatMaterial --folder "AI Agent Bridge/Texture Box/Materials" --diffuse-map <texture_asset_id>

pcbridge script create --target current --filename jumpingBox.js --file ./jumpingBox.js --folder "AI Agent Bridge/Texture Box/Scripts"

pcbridge entity create --target current --json ./box.json
pcbridge entity set-material --target current --id <box_resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <box_resource_id> --asset-id <script_asset_id> --attributes '{"height":0.5,"speed":2.4}'
```

## Target selection

```bash
pcbridge targets
pcbridge eval --target current --code "return location.href"
pcbridge eval --target tab:123 --code "return location.href"
pcbridge eval --target scene:987654 --code "return location.href"
pcbridge eval --target project:123456 --code "return location.href"
```

`current` means the most recently seen ready PlayCanvas Editor target.

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

## Security model

This is a local trusted developer tool. It executes JavaScript inside PlayCanvas Editor pages that you already have open.

Safeguards:

- daemon binds only to `127.0.0.1`;
- CLI, daemon, and extension share a local session token;
- extension matches only PlayCanvas Editor URLs;
- CLI output uses compact JSON envelopes;
- structured write commands require explicit IDs or JSON files.

## Development

```bash
pnpm install
pnpm build
node dist/cli.js doctor
```

Use `bun` for one-off TypeScript scripts if you add them.
