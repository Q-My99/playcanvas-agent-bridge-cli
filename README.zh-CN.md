# playcanvas-agent-bridge-cli

这是一个 CLI 优先的本地自动化桥，用来让 Codex、Claude Code、Cursor、Windsurf 等 AI 编程 agent 控制已经打开的 PlayCanvas Editor 场景和 PlayCanvas Launch 页面。

核心接口是 `pcbridge` 命令、本地 daemon 和 Chrome Manifest V3 插件。MCP 不是核心依赖，之后可以作为薄适配层再加。

## 安装

从 npm 安装：

```bash
npm install -g playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

如果要测试尚未发布的改动，也可以直接从这个 GitHub 仓库安装：

```bash
npm install -g github:Q-My99/playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

用 npx 一次性运行：

```bash
npx playcanvas-agent-bridge-cli doctor
npx playcanvas-agent-bridge-cli install-skill --agent all
```

## 安装 Chrome 插件

运行：

```bash
pcbridge install-extension
```

这个命令会生成一个本地可加载插件目录：

```text
~/.pcbridge/extension
```

在 Windows 上，这个目录会位于你的用户主目录下。请以
`pcbridge install-extension` 实际打印出来的路径为准。

然后在 Chrome 中操作：

1. 打开 `chrome://extensions`。
2. 开启 Developer Mode。
3. 点击 Load unpacked。
4. 选择 `pcbridge install-extension` 打印出来的那个目录。
5. 打开或刷新 PlayCanvas Editor 页面或 PlayCanvas Launch 页面。

注意：生成目录里的 `config.json` 包含本地 session token。请加载 `~/.pcbridge/extension`，不要直接加载仓库里的原始 `extension/` 目录。

## 启动桥接

```bash
pcbridge daemon start
```

另开一个终端检查：

```bash
pcbridge doctor
pcbridge targets
pcbridge eval --target current --code "return { href: location.href, hasEditor: !!editor }"
pcbridge eval --target launch:<sceneId> --code "return { href: location.href, hasPc: !!pc }"
```

## 渐进式 help

CLI 提供分层 help，方便 agent 只加载当前需要的命令面：

```bash
pcbridge help
pcbridge help entity
pcbridge help asset
pcbridge help material
pcbridge help template
pcbridge help script
pcbridge help scene
pcbridge help store
pcbridge help viewport
pcbridge help logs
pcbridge help eval
```

小而明确、能对应到单个 Editor 操作的任务优先用结构化命令。探索 API、自定义
Editor/Engine 工作流、Launch 调试、大量多步骤场景修改，则优先用 `pcbridge eval`，一段脚本通常更清楚也更快。

## 常用命令

```bash
pcbridge entity list --target current --limit 50
pcbridge entity list --target current --tag enemy --component render
pcbridge entity create --target current --json ./entity.json
pcbridge entity create-many --target current --json ./entities.json
pcbridge entity patch --target current --id <resource_id> --set position='[0,1,0]'
pcbridge entity patch-many --target current --json ./edits.json
pcbridge entity duplicate --target current --id <resource_id>
pcbridge entity reparent --target current --id <resource_id> --parent <parent_resource_id>
pcbridge entity set-material --target current --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.5}'
pcbridge entity delete --target current --id <resource_id>

pcbridge asset list --target current --type script
pcbridge asset list --target current --tag generated
pcbridge asset get --target current --id <asset_id>
pcbridge asset create --target current --json ./assets.json
pcbridge asset folder ensure --target current --path "AI Agent Bridge/Demo/Textures"
pcbridge asset upload --target current --file ./texture.png --name DemoTexture --folder "AI Agent Bridge/Demo/Textures"
pcbridge asset upload-many --target current --json ./upload-manifest.json
pcbridge asset instantiate --target current --id <template_asset_id>
pcbridge asset delete --target current --id <asset_id>

pcbridge material create --target current --name DemoMaterial --folder "AI Agent Bridge/Demo/Materials" --diffuse-map <texture_asset_id>
pcbridge material patch --target current --asset-id <asset_id> --set diffuse='[1,0,0]'

pcbridge template create --target current --entity-id <resource_id> --name DemoTemplate --folder "AI Agent Bridge/Demo/Templates"
pcbridge template instantiate --target current --id <template_asset_id>

pcbridge script create --target current --filename controller.js --file ./controller.js --folder "AI Agent Bridge/Demo/Scripts"
pcbridge script upsert --target current --filename controller.js --file ./controller.js --folder "AI Agent Bridge/Demo/Scripts" --parse
pcbridge script set-text --target current --asset-id <asset_id> --file ./controller.js
pcbridge script parse --target current --asset-id <asset_id>

pcbridge scene settings get --target current
pcbridge scene settings patch --target current --set physics.gravity='[0,-9.8,0]'

pcbridge store search --target current --search vehicle --limit 20
pcbridge store get --target current --id <store_asset_id>
pcbridge store download --target current --id <store_asset_id> --name Vehicle --license-json ./license.json

pcbridge viewport capture --target current --out ./tmp/playcanvas-viewport.png
pcbridge viewport focus --target current --id <resource_id> --view perspective

pcbridge logs get --target current --limit 100
pcbridge logs get --target launch:<sceneId> --level error
pcbridge logs clear --target current
```

大型任务可以把上传清单放在生成文件旁边。`file` 的相对路径会按清单文件所在目录解析：

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

当较大的 Editor 脚本需要本地配置时，用 `eval --args-json`，避免把 JSON 直接拼进代码里：

```bash
pcbridge eval --target current --file ./install-scene.js --args-json ./install-args.json
```

## 贴图 + 材质 + 脚本工作流

```bash
pcbridge asset folder ensure --target current --path "AI Agent Bridge/Texture Box/Textures"
pcbridge asset upload --target current --file ./cat.png --name CatTexture --folder "AI Agent Bridge/Texture Box/Textures"

pcbridge material create --target current --name CatMaterial --folder "AI Agent Bridge/Texture Box/Materials" --diffuse-map <texture_asset_id>

pcbridge script create --target current --filename jumpingBox.js --file ./jumpingBox.js --folder "AI Agent Bridge/Texture Box/Scripts"

pcbridge entity create --target current --json ./box.json
pcbridge entity set-material --target current --id <box_resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target current --id <box_resource_id> --asset-id <script_asset_id> --attributes '{"height":0.5,"speed":2.4}'
```

## 目标选择

```bash
pcbridge targets
pcbridge eval --target current --code "return location.href"
pcbridge eval --target tab:123 --code "return location.href"
pcbridge eval --target scene:987654 --code "return location.href"
pcbridge eval --target project:123456 --code "return location.href"
pcbridge eval --target launch:987654 --code "return { href: location.href, hasPc: !!pc }"
pcbridge viewport capture --target launch:987654 --out ./tmp/launch.png
pcbridge logs get --target launch:987654 --limit 100
```

`current` 表示最近可用的 PlayCanvas 目标页。如果同一个 scene 同时打开了 Editor 和 Launch
页面，请使用 `tab:<id>`、`editor:<sceneId>` 或 `launch:<sceneId>` 避免歧义。结构化编辑命令需要
Editor 目标；`eval`、`viewport capture` 和 `logs` 也可以用于 Launch 目标。

## Agent skill / rules

安装各家 agent 的使用说明：

```bash
pcbridge install-skill --agent codex
pcbridge install-skill --agent claude
pcbridge install-skill --agent cursor
pcbridge install-skill --agent windsurf
pcbridge install-skill --agent all
```

安装位置：

- Codex: `~/.codex/skills/playcanvas-agent-bridge-cli`
- Claude: `~/.claude/skills/playcanvas-agent-bridge-cli`
- Cursor: `~/.cursor/rules/playcanvas-agent-bridge-cli.mdc`
- Windsurf: `~/.windsurf/rules/playcanvas-agent-bridge-cli.md`

## 安全模型

这是一个本地可信开发工具，会在你已经打开的 PlayCanvas Editor 和 Launch 页面内执行 JavaScript。

基础防护：

- daemon 只绑定 `127.0.0.1`；
- CLI、daemon、插件共享本地 session token；
- 插件只匹配 PlayCanvas Editor 和 Launch URL；
- CLI 输出统一使用紧凑 JSON envelope；
- 结构化写命令要求明确 ID 或 JSON 文件。

## 开发

```bash
pnpm install
pnpm build
node dist/cli.js doctor
```

如果以后添加一次性 TypeScript 脚本，优先用 `bun` 执行。
