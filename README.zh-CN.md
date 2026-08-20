# playcanvas-agent-bridge-cli

这是一个 CLI 优先的本地自动化桥，用来让 Codex、Claude Code、Cursor、Windsurf 等 AI 编程 agent 控制已经打开的 PlayCanvas Editor 场景和 PlayCanvas Launch 页面。

核心接口是 `pcbridge` 命令、本地 daemon 和 Chrome Manifest V3 插件。MCP 不是核心依赖，之后可以作为薄适配层再加。

## 安装

从 npm 安装：

```bash
npm install -g playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

下文命令跟随仓库版 `0.6.1`。npm 安装的是最新稳定版本；测试尚未发布的改动时请使用
GitHub 安装。

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

## 更新 pcbridge 各组件

CLI/daemon、已安装的 Agent 技能、生成的 Chrome 插件和可选的本地 Editor 前端是四个独立的
本地组件，更新其中一个不会自动更新其他组件。

### 更新 CLI、daemon 和 Agent 技能

```bash
npm install -g playcanvas-agent-bridge-cli@latest
pcbridge version
pcbridge install-skill --agent all
pcbridge daemon restart --workspace /原来的/workspace/根目录
```

npm 全局安装会替换 CLI 文件，但已经运行的 daemon 仍然是内存中的旧版本，必须重启才会生效。
`daemon restart` 会先认证当前 pcbridge 服务，优雅关闭并等待端口释放，再在当前终端启动新
daemon。它不会因为某个进程占用了配置端口就直接杀掉该进程。从不支持认证关闭的旧版本升级
时，第一次仍需在旧 daemon 终端按 **Ctrl+C**；完成这次迁移后即可使用 restart 切换和升级。

Codex、Claude、Cursor 和 Windsurf 的技能文件也是安装时复制出去的，因此需要重新执行
`install-skill`；如果当前 Agent 任务已经加载了旧技能，请新建一个任务或会话再使用新技能。

### 更新 Chrome 插件

CLI 更新完成后，重新生成 unpacked 插件目录：

```bash
pcbridge install-extension --no-open
```

然后完成以下 **Chrome 手动操作**：

1. 打开 `chrome://extensions`。
2. 找到 **PlayCanvas Agent Bridge**，点击 **Reload**。如果现有条目已经指向
   `~/.pcbridge/extension`，不需要再次 Load unpacked。
3. 如果插件尚未安装，开启 Developer Mode，点击 **Load unpacked**，选择
   `pcbridge install-extension` 打印的目录。
4. 刷新所有已经打开的 PlayCanvas Editor 和 Launch 页面。
5. daemon 重启后运行 `pcbridge doctor`，确认生成目录中的插件版本、浏览器已连接插件版本和
   CLI 版本一致。

只更新 npm 包不会更新 `~/.pcbridge/extension`；重新写入插件目录后，Chrome 也不会自动 reload
unpacked 插件。

### 更新 PlayCanvas 本地前端

本地前端使用独立的 Release，不会随 CLI 或插件一起更新：

```bash
pcbridge frontend update
pcbridge frontend status
```

`frontend update` 默认会下载、校验并激活最新发布版。如果 daemon 已经运行，它会在每次请求时
读取当前激活版本，因此只更新前端不需要重启 daemon；**用户仍然必须刷新 PlayCanvas Editor
页面**。如果当前项目正在使用官方前端，请打开插件 popup，点击 **Use custom frontend**。
旧的本地前端版本会继续保留，除非显式执行 `frontend remove`。

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

## 使用自构建 Editor 前端

Editor 构建产物不会打进 npm 包。下面的命令会从 `Q-My99/playcanvas-editor` 下载最新
Release，校验发布清单、文件大小和 SHA-256，然后在本地激活：

```bash
pcbridge frontend install latest
pcbridge frontend status
pcbridge daemon start
```

daemon 会在 `http://localhost:3487` 提供当前激活的构建。打开
`https://playcanvas.com/editor/...` 页面后，在插件 popup 中点击 **Use custom frontend**。
点击 **Use official frontend** 会删除 `use_local_frontend` 参数，并用官方前端重新加载同一个
Editor URL。

插件会按 PlayCanvas project ID 记住最后一次在 popup 中选择的模式。之后进入
`/editor/project/<projectId>` 场景选择页或 `/editor/scene/<sceneId>` 场景编辑页时，会自动
添加或删除 `use_local_frontend`，并保留 URL 中其他查询参数和 hash。该偏好只会在用户再次
点击 **Use custom frontend** 或 **Use official frontend** 时改变；popup 的 **Project
preference** 会显示当前项目的记忆值。

需要时可以显式管理本地版本：

```bash
pcbridge frontend list
pcbridge frontend update
pcbridge frontend use playcanvas-editor-v2.28.1-r1
pcbridge frontend remove playcanvas-editor-v2.28.1-r1
```

下载的构建保存在 `~/.pcbridge/frontends/`。当前激活的版本不能直接删除，需要先切换到
另一个已安装版本。

## 启动桥接

可以使用当前目录作为 workspace 根目录，也可以显式指定目录：

```bash
cd /path/to/my-playcanvas-workspace
pcbridge daemon start

# 在任意目录执行，效果相同
pcbridge daemon start --workspace /path/to/my-playcanvas-workspace

# 停止当前 daemon 并切换 workspace
pcbridge daemon restart --workspace /path/to/another-workspace

# 优雅停止经过认证的 pcbridge daemon
pcbridge daemon stop
```

`daemon restart` 和 `daemon stop` 都会先校验带 token 的 `/health` 响应。token 不匹配或端口上
不是 pcbridge 服务时，命令会报错且不会终止占用端口的进程。`start` 和 `restart` 都以前台
方式运行，日志仍然直接显示在终端中，也仍然可以使用 **Ctrl+C** 停止。

连接 ready 的 Editor 后，pcbridge 会自动创建 `<projectId>-<projectName>/` 工程目录：

```text
1552681-pcbridge-test/
├── pcbridge.project.json # 项目信息和供 agent 读取的资源目录
├── assets/       # PlayCanvas 文件树的碰撞安全本地投影
├── tmp/          # 构建产物、缓存、冲突、截图和远端删除隔离副本
└── .pcbridge/    # 内部同步状态和内容寻址对象缓存，请勿手动修改
```

查看或手动刷新工作区：

```bash
pcbridge workspace status --target editor:<sceneId>
pcbridge workspace path --target editor:<sceneId>
pcbridge workspace sync --target editor:<sceneId>
pcbridge workspace pull --target editor:<sceneId> --asset <assetId>
```

脚本默认实时同步到本地；图片、模型、音频、字体等二进制资源默认只同步 Asset 元数据，
不会在首次建立镜像时下载文件内容。需要本地文件时使用 `workspace pull`，或由 Tiny Builder
在构建实际依赖时按需拉取。已经存在于 `assets/` 的本地二进制文件会保留并参与双向同步。
刷新只读取完整 Asset 元数据，并用 PlayCanvas MD5 与本地缓存的 size/mtime/MD5 判断变化。
本地修改会自动上传，远端修改会按基线判断并下载；同时修改时不会覆盖任一版本，文本和二进制
冲突副本都写入 `tmp/conflicts/`。

daemon 会监控项目 `assets/` 目录：本地新增文件会上传到对应目录，由 PlayCanvas 自行判断资源
类型并完成导入，然后重新读取远端 Asset 列表；本地目录会自动映射为 PlayCanvas Folder。
本地重命名和移动会保持同一个 Asset ID，并同步远端名称和目录。删除本地文件只视为清理本地
缓存，不会删除 PlayCanvas 远端 Asset；远端删除仍会隔离到 `tmp/trash/remote/`。`tmp/` 下的
构建、缓存和 agent 临时文件完全不参与 workspace 同步。

PlayCanvas 可能生成同名的源 Asset 和派生 Asset，例如源 GLB 与 Container/Model，或字体源文件
与字体图集。manifest 会把网页端显示路径 `folder` 和本地唯一路径 `projectionPath` 分开记录。
本地优先使用真实的 `file.filename`；只有名称碰撞时，才会在扩展名前加入
`.__pc_<type>_<assetId>`。source 和 standalone 投影可写；derived 投影按需下载且只读，内容会
缓存到 `.pcbridge/objects/<assetId>/<md5>/`。修改或移动 derived 投影时，本地副本会隔离到
`tmp/conflicts/`，随后从对象缓存恢复正确内容，不会反向上传到 PlayCanvas。

schema v3 的 `pcbridge.project.json` 会记录 `origin`（`source`、`derived` 或 `standalone`）、
PlayCanvas 声明和实际观察到的文件元数据、最终采用的 MD5，以及本地是否存在、是否可写、当前
和同步基线 MD5。贴图 variant、字体附加图集等仅在构建中使用的文件记录在 `local.resources`
中，并作为主 Asset 同目录下的只读受管文件。agent 可以直接读取这些信息，但 `assets` 对象由
pcbridge 管理。schema v1
和 v2 会自动迁移；v1 隐藏索引仍保留为 `.pcbridge/asset-index.v1.json` 以便回退。已有资源时
收到的空快照会被忽略；
非空但缩小的快照必须连续出现两次，文件才会被移动到 `tmp/trash/remote/`。

## Template 构建与 S3 上传

选中 PlayCanvas Template Asset 后，Attributes 面板会出现 **pcbridge Tiny Builder**。点击
**构建并上传到 S3** 后，网页只负责收集 Template、递归 Asset 引用、挂载脚本和子 Template；
daemon 会把全部依赖物化到 `assets/`：本地文件与有效远端 MD5 一致时直接复用，不存在或远端
已更新时先从 PlayCanvas 同步。贴图 variant 和字体附加图集会作为主 Asset 同目录下的只读
受管资源保存，不再写入 `tmp/cache/assets/`；`.pcbridge/objects/` 仅作为避免重复下载的内部
对象缓存。随后并发上传对象，不生成 ZIP；只有 `tinyapp.json` 和 `gamescript.js` 保存在
`tmp/builds/`。挂载的非 `sds*` 脚本会先合并，再由 Babel 转换为 ES5，并由 Terser 做保守
压缩；函数名和类名会保留，避免破坏脚本注册和运行时反射。

在 daemon 启动目录创建 `.env` 作为工作区默认配置，也可以在单个项目目录创建 `.env`；
项目配置按字段覆盖工作区配置。不要提交含密钥的 `.env`：

```dotenv
PCBRIDGE_S3_ENDPOINT=https://s3.example.com
PCBRIDGE_S3_REGION=us-east-1
PCBRIDGE_S3_BUCKET=my-bucket
PCBRIDGE_S3_ACCESS_KEY_ID=your-access-key
PCBRIDGE_S3_SECRET_ACCESS_KEY=your-secret-key
# PCBRIDGE_S3_SESSION_TOKEN=
PCBRIDGE_S3_PUBLIC_BASE_URL=https://cdn.example.com
PCBRIDGE_S3_PREFIX=assets
PCBRIDGE_S3_FORCE_PATH_STYLE=false
```

以上配置使用 AWS S3 标准客户端，适用于 Amazon S3、阿里云 OSS、腾讯云 COS、Cloudflare
R2 等兼容服务；自定义服务是否需要 path-style URL 由
`PCBRIDGE_S3_FORCE_PATH_STYLE` 决定。若 OSS endpoint 已包含 bucket 前缀，例如
`https://my-bucket.oss-cn-shanghai.aliyuncs.com`，pcbridge 会先规范化 endpoint，避免 SDK 再次
拼接 bucket；上传使用固定 `Content-MD5`，不会发送流式 checksum trailer。也可以从 CLI
发起和查看任务：

```bash
pcbridge builder start --target editor:<sceneId> --asset <templateAssetId> --suffix '-${time}'
pcbridge builder status --job <jobId>
```

CLI 的脚本、JSON、上传文件和截图路径默认必须位于对应项目工作区内。只有明确需要使用
外部文件时才使用 `--allow-external-path`。

另开一个终端检查：

```bash
pcbridge doctor
pcbridge targets
pcbridge eval --target editor:<sceneId> --code "return { href: location.href, hasEditor: !!editor }"
pcbridge launch diagnose --target launch:<sceneId>
```

`doctor` 会区分 daemon 未监听（`DAEMON_NOT_LISTENING`）和受限环境禁止 localhost
（`LOOPBACK_ACCESS_DENIED`）；只有前一种情况才应该再启动 daemon。

## 渐进式 help

CLI 提供分层 help，方便 agent 只加载当前需要的命令面：

```bash
pcbridge help
pcbridge help core
pcbridge help workspace
pcbridge help builder
pcbridge help frontend
pcbridge help target
pcbridge help entity
pcbridge help asset
pcbridge help material
pcbridge help template
pcbridge help script
pcbridge help scene
pcbridge help store
pcbridge help viewport
pcbridge help launch
pcbridge help logs
pcbridge help eval
```

小而明确、能对应到单个 Editor 操作的任务优先用结构化命令。探索 API、自定义
Editor/Engine 工作流、Launch 调试、大量多步骤场景修改，则优先用 `pcbridge eval`，一段脚本通常更清楚也更快。

## 常用命令

```bash
pcbridge entity list --target editor:<sceneId> --limit 50
pcbridge entity list --target editor:<sceneId> --tag enemy --component render
pcbridge entity create --target editor:<sceneId> --json ./entity.json
pcbridge entity create-many --target editor:<sceneId> --json ./entities.json
pcbridge entity patch --target editor:<sceneId> --id <resource_id> --set position='[0,1,0]'
pcbridge entity patch-many --target editor:<sceneId> --json ./edits.json
pcbridge entity duplicate --target editor:<sceneId> --id <resource_id>
pcbridge entity reparent --target editor:<sceneId> --id <resource_id> --parent <parent_resource_id>
pcbridge entity set-material --target editor:<sceneId> --id <resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --asset-id <script_asset_id> --attributes '{"speed":2.5}'
pcbridge entity add-script --target editor:<sceneId> --id <resource_id> --script-name sdsAudioPlayer --attributes-json ./audio-slots.json
pcbridge entity delete --target editor:<sceneId> --id <resource_id>

pcbridge asset list --target editor:<sceneId> --type script
pcbridge asset list --target editor:<sceneId> --tag generated
pcbridge asset get --target editor:<sceneId> --id <asset_id>
pcbridge asset create --target editor:<sceneId> --json ./assets.json
pcbridge asset folder ensure --target editor:<sceneId> --path "AI Agent Bridge/Demo/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./texture.png --name DemoTexture --folder "AI Agent Bridge/Demo/Textures"
pcbridge asset upload-many --target editor:<sceneId> --json ./upload-manifest.json
pcbridge asset instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge asset delete --target editor:<sceneId> --id <asset_id>

pcbridge material create --target editor:<sceneId> --name DemoMaterial --folder "AI Agent Bridge/Demo/Materials" --diffuse-map <texture_asset_id>
pcbridge material patch --target editor:<sceneId> --asset-id <asset_id> --set diffuse='[1,0,0]'

pcbridge template create --target editor:<sceneId> --entity-id <resource_id> --name DemoTemplate --folder "AI Agent Bridge/Demo/Templates"
pcbridge template instantiate --target editor:<sceneId> --id <template_asset_id>
pcbridge template overrides --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply --target editor:<sceneId> --entity-id <resource_id>
pcbridge template apply-many --target editor:<sceneId> --json ./template-roots.json

pcbridge script create --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "AI Agent Bridge/Demo/Scripts"
pcbridge script upsert --target editor:<sceneId> --filename controller.js --file ./controller.js --folder "AI Agent Bridge/Demo/Scripts" --parse --wait
pcbridge script set-text --target editor:<sceneId> --asset-id <asset_id> --file ./controller.js --parse --wait
pcbridge script parse --target editor:<sceneId> --asset-id <asset_id>

pcbridge scene settings get --target editor:<sceneId>
pcbridge scene settings patch --target editor:<sceneId> --set physics.gravity='[0,-9.8,0]'

pcbridge store search --target editor:<sceneId> --search vehicle --limit 20
pcbridge store get --target editor:<sceneId> --id <store_asset_id>
pcbridge store download --target editor:<sceneId> --id <store_asset_id> --name Vehicle --license-json ./license.json

pcbridge viewport capture --target editor:<sceneId> --out ./tmp/playcanvas-viewport.png
pcbridge viewport focus --target editor:<sceneId> --id <resource_id> --view perspective

pcbridge logs get --target editor:<sceneId> --limit 100
pcbridge logs get --target launch:<sceneId> --level error
pcbridge logs clear --target editor:<sceneId>
```

通过 bundle 或 runtime asset 注册、没有独立 script asset id 的 ScriptType，请使用
`--script-name`。脚本更新配合 `--parse --wait` 时，会在返回前校验远端文本、稳定的文件元数据
以及最新的解析属性。这个完成检查覆盖远端 asset 和当前 Editor observer，不等待之后一次
workspace mirror sync。

Template apply 命令会调用 Editor 现有的 `templates:apply` action。存在 overrides 时，完成条件
是 pipeline callback 已到达，且连续两次观察到 overrides 为 0。返回的 `verified` 只确认当前
Editor observer 状态，不代表刷新 Editor 后仍然持久。
Editor entity patch 是持久修改；apply 前必须先恢复只用于预览的 enabled/visibility 状态。
`apply-many` 会先校验清单，再串行处理每个 root。清单可以写成
`{"entityIds":["root-a","root-b"]}`，也可直接使用 entity id 或 `{ "entityId": "..." }` 条目数组。

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
pcbridge eval --target editor:<sceneId> --file ./install-scene.js --args-json ./install-args.json
```

## 贴图 + 材质 + 脚本工作流

```bash
pcbridge asset folder ensure --target editor:<sceneId> --path "AI Agent Bridge/Texture Box/Textures"
pcbridge asset upload --target editor:<sceneId> --file ./cat.png --name CatTexture --folder "AI Agent Bridge/Texture Box/Textures"

pcbridge material create --target editor:<sceneId> --name CatMaterial --folder "AI Agent Bridge/Texture Box/Materials" --diffuse-map <texture_asset_id>

pcbridge script create --target editor:<sceneId> --filename jumpingBox.js --file ./jumpingBox.js --folder "AI Agent Bridge/Texture Box/Scripts"

pcbridge entity create --target editor:<sceneId> --json ./box.json
pcbridge entity set-material --target editor:<sceneId> --id <box_resource_id> --material-id <material_asset_id>
pcbridge entity add-script --target editor:<sceneId> --id <box_resource_id> --asset-id <script_asset_id> --attributes '{"height":0.5,"speed":2.4}'
```

## 目标选择

```bash
pcbridge targets
pcbridge eval --target current --code "return location.href"
pcbridge eval --target tab:123 --code "return location.href"
pcbridge eval --target scene:987654 --code "return location.href"
pcbridge eval --target project:123456 --code "return location.href"
pcbridge launch diagnose --target launch:987654
pcbridge launch wait-ready --target launch:987654 --focus --timeout-ms 30000
pcbridge eval --target launch:987654 --code "return { runtimeCreated: !!runtimeApp, rootChildCount: runtimeApp?.root?.children?.length ?? 0 }"
pcbridge viewport capture --target launch:987654 --out ./tmp/launch.png
pcbridge logs get --target launch:987654 --limit 100
```

`current` 表示最近可用的 PlayCanvas 目标页。如果同一个 scene 同时打开了 Editor 和 Launch
页面，请使用 `tab:<id>`、`editor:<sceneId>` 或 `launch:<sceneId>` 避免歧义。结构化编辑命令需要
Editor 目标；`eval`、`viewport capture` 和 `logs` 也可以用于 Launch 目标。

Launch ready 是尽力而为的启发式判断，不是 Engine 生命周期事件。`lifecycleReady` 要求找到
拥有自身 graphics canvas/context 的 runtime app、scene root 已挂载、至少完成一帧，并且没有
识别到启动遮罩；target `ready` 还要求 tab 可见。因此后台 Launch 应使用
`launch wait-ready --focus`。`scriptTypeCount` 只用于诊断，不能证明所有 ScriptType 已注册。
eval 提供通过兼容 resolver 选择的 Engine V1/V2 `runtimeApp`。

`viewport capture` 只截取当前 canvas，不会调整 Chrome 尺寸或模拟手机 DPR。PNG 可能保留
透明通道；默认的 `--max-width 1200` 可能缩放输出。eval 输出有边界；优先返回叶子字段，必要时再使用有
上限的 `--max-depth`、`--max-items` 或 `--max-keys`。

## Agent skill / rules

安装各家 agent 的使用说明：

```bash
pcbridge install-skill --agent codex
pcbridge install-skill --agent claude
pcbridge install-skill --agent cursor
pcbridge install-skill --agent windsurf
pcbridge install-skill --agent all
```

使用 `--path` 可以把单个 Agent 的 skill 或 rule 安装到自定义父目录。相对路径从当前工作目录
解析；pcbridge 会自动追加标准目录名或文件名，因此不会清空用户传入的父目录：

```bash
pcbridge install-skill --agent codex --path "D:\AgentConfig\skills"
pcbridge install-skill --agent cursor --path ./.cursor/rules
```

以上命令分别生成 `D:\AgentConfig\skills\playcanvas-agent-bridge-cli\` 和
`.cursor/rules/playcanvas-agent-bridge-cli.mdc`。Windows 路径包含空格时必须使用引号。
由于不同 Agent 的产物布局不同，`--agent all --path ...` 会被拒绝；自定义位置时请逐个安装。

安装位置：

- Codex: `~/.codex/skills/playcanvas-agent-bridge-cli`
- Claude: `~/.claude/skills/playcanvas-agent-bridge-cli`
- Cursor: `~/.cursor/rules/playcanvas-agent-bridge-cli.mdc`
- Windsurf: `~/.windsurf/rules/playcanvas-agent-bridge-cli.md`

插件 popup 会展示 daemon、当前 tab、项目、scene、branch、工作区路径、同步统计、冲突数
以及自定义 Editor frontend 状态。红色表示断联或冲突，黄色表示初始化、同步中或本地待处理
状态，绿色表示 ready / synced。

## 安全模型

这是一个本地可信开发工具，会在你已经打开的 PlayCanvas Editor 和 Launch 页面内执行 JavaScript。

基础防护：

- daemon 只绑定 `127.0.0.1`；
- frontend 服务只绑定 `127.0.0.1`，会校验 Host，并且只提供当前已校验 Release 目录内的文件；
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

## 发布到 npm（维护者）

发布流程通过 `.github/workflows/npm-publish.yml` 使用 npm Trusted Publishing，GitHub
仓库不需要保存 `NPM_TOKEN`。

1. 在 `package.json`、`src/config.ts` 和 `extension/manifest.json` 中同步更新同一个稳定版本号。
2. 运行 `pnpm test`，把发布提交合并并推送到 `main`。
3. 创建并推送匹配的 tag，例如：

```bash
git tag v<version>
git push origin v<version>
```

如果 tag 与包版本不一致，或者 tag 对应的提交不属于 `main`，workflow 会拒绝发布。
推送 tag 前，需要在 npm 包设置中把 GitHub 用户设为 `Q-My99`、仓库设为
`playcanvas-agent-bridge-cli`、workflow 文件名设为 `npm-publish.yml`。
