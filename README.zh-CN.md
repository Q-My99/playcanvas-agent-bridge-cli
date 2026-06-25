# playcanvas-agent-bridge-cli

这是一个 CLI 优先的本地自动化桥，用来让 Codex、Claude Code、Cursor、Windsurf 等 AI 编程 agent 控制已经打开的 PlayCanvas Editor 场景。

核心接口是 `pcbridge` 命令、本地 daemon 和 Chrome Manifest V3 插件。MCP 不是核心依赖，之后可以作为薄适配层再加。

## 安装

发布到 npm 后：

```bash
npm install -g playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

在 npm 发布前，也可以直接从这个 GitHub 仓库安装：

```bash
npm install -g github:Q-My99/playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

用 npx 一次性运行：

```bash
npx github:Q-My99/playcanvas-agent-bridge-cli doctor
npx github:Q-My99/playcanvas-agent-bridge-cli install-skill --agent all
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

然后在 Chrome 中操作：

1. 打开 `chrome://extensions`。
2. 开启 Developer Mode。
3. 点击 Load unpacked。
4. 选择 `pcbridge install-extension` 打印出来的那个目录。
5. 打开或刷新 PlayCanvas Editor 页面。

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
```

## 常用命令

```bash
pcbridge entity list --target current --limit 50
pcbridge entity create --target current --json ./entity.json
pcbridge entity patch --target current --id <resource_id> --set position='[0,1,0]'

pcbridge asset list --target current --type script
pcbridge asset get --target current --id <asset_id>

pcbridge script set-text --target current --asset-id <asset_id> --file ./controller.js
pcbridge script parse --target current --asset-id <asset_id>

pcbridge viewport capture --target current --out /tmp/playcanvas-viewport.webp
```

## 目标选择

```bash
pcbridge targets
pcbridge eval --target current --code "return location.href"
pcbridge eval --target tab:123 --code "return location.href"
pcbridge eval --target scene:987654 --code "return location.href"
pcbridge eval --target project:123456 --code "return location.href"
```

`current` 表示最近可用的 PlayCanvas Editor 目标页。

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

这是一个本地可信开发工具，会在你已经打开的 PlayCanvas Editor 页面内执行 JavaScript。

基础防护：

- daemon 只绑定 `127.0.0.1`；
- CLI、daemon、插件共享本地 session token；
- 插件只匹配 PlayCanvas Editor URL；
- CLI 输出统一使用紧凑 JSON envelope；
- 结构化写命令要求明确 ID 或 JSON 文件。

## 开发

```bash
pnpm install
pnpm build
node dist/cli.js doctor
```

如果以后添加一次性 TypeScript 脚本，优先用 `bun` 执行。
