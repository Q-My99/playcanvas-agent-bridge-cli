# playcanvas-agent-bridge-cli

场景管理：`scene list`、`scene create --name <名称>`、`scene open --id <ID>` 使用所选 Editor 的项目；打开操作会等待目标场景加载。`asset upload` 自动将 GLB/FBX/OBJ 识别为模型源资源（`scene`）。

在父级 PlayCanvas 工作区中，`bun run pcbridge <命令>` 默认使用根目录 `pcbridge-workspace/`（自动创建，Git 忽略）。`bun run dev` 会自动启动当前源码的 daemon，退出时一起关闭；若 daemon 端口已被占用，先运行 `bun run pcbridge daemon stop`。插件弹窗显示插件自身版本和 daemon 版本，离线时也能确认插件版本。

> 需要 Bun 1.4.0 或更新版本。在父级 monorepo 中，请于根目录执行 `bun install --frozen-lockfile`。

这是一个 CLI 优先的本地自动化桥，用来让 Codex、Claude Code、Cursor、Windsurf 等 AI 编程 agent 控制已经打开的 PlayCanvas Editor 场景和 PlayCanvas Launch 页面。

核心接口是 `pcbridge` 命令、本地 daemon 和 Chrome Manifest V3 插件。MCP 不是核心依赖，之后可以作为薄适配层再加。

## 安装

从 npm 安装：

```bash
bun add --global playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

下文命令跟随仓库版 `0.8.0`。npm 安装的是最新稳定版本；测试尚未发布的改动时请使用
GitHub 安装。

如果要测试尚未发布的改动，也可以直接从这个 GitHub 仓库安装：

```bash
bun add --global github:Q-My99/playcanvas-agent-bridge-cli
pcbridge install-skill --agent all
```

用 npx 一次性运行：

```bash
npx playcanvas-agent-bridge-cli doctor
npx playcanvas-agent-bridge-cli install-skill --agent all
```

## 更新 pcbridge 各组件

`pcbridge` 会后台定期检查 npm 上的最新 CLI/浏览器扩展版本，以及 GitHub 仓库（`plugins/index.json`）
中独立演进的官方插件版本。检测到可用更新时：

- **浏览器插件徽标与弹窗**：Chrome 工具栏图标会显示 `↑` 角标；打开弹窗即可在顶部点击
  **Update & Reload** 一键更新 `pcbridge` 本体，或在 **Plugins** 标签页点击 **Update** /
  **Update all** 一键热更新官方插件。
- **CLI 与 AI Agent**：命令返回的 JSON 信封会自动挂载结构化 `meta.updates` 字段，交互式终端会在
  `stderr` 打印单行更新提示。

### 一键更新（CLI、daemon、Agent 技能、Chrome 插件与官方插件）

```bash
pcbridge update status --refresh   # 检查 pcbridge 本体与已安装插件的更新状态
pcbridge update                    # 一键升级 CLI、daemon、已安装技能、Chrome 扩展并刷新标签页
pcbridge update --plugins          # 同时一键更新所有有新版本的已安装插件
pcbridge plugin update <id>        # 独立热更新单个插件（无需重启 daemon 或刷新页面）
pcbridge plugin update --all       # 独立热更新全部有新版本的已安装插件
```

`pcbridge update` 会自动升级全局 npm 包，调用新版二进制重写 `~/.pcbridge/extension` 并刷新已安装的
Agent 技能，通知 Chrome 扩展执行 `chrome.runtime.reload()` 自动重载并刷新已打开的 PlayCanvas
Editor / Launch 标签页（可通过 `--no-reload-tabs` 跳过标签页刷新），同时让正在运行的 daemon 在原终端
内原地重启并继承原有的 `--workspace` 目录。

### 手动分步更新命令

```bash
bun add --global playcanvas-agent-bridge-cli@latest
pcbridge version
pcbridge install-skill --agent all
pcbridge install-extension --no-open
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

## 可选官方插件：本地 Editor 前端（`playcanvas.com`）

自托管 PlayCanvas 服务直接托管你自己的 Editor 前端，不需要本地前端切换功能；访问官方
`https://playcanvas.com/editor/...` 且需要切换为本地托管前端时，可在浏览器扩展弹窗 **Plugins**
标签页一键安装，或通过 CLI 安装启用官方插件 `local-frontend`：

```bash
pcbridge plugin add local-frontend
pcbridge plugin call local-frontend install
pcbridge plugin call local-frontend status
```

启用 `local-frontend` 且 daemon 运行时，插件会在 `http://127.0.0.1:3487` 提供当前激活的构建，并
仅在官方 `playcanvas.com` 的 Editor 页面左侧工具栏注入 **Local Frontend** 按钮（访问自托管站点时
不做任何注入或跳转）。可通过工具栏面板或 CLI 切换项目的本地/官方前端模式并更新前端版本：

```bash
pcbridge plugin call local-frontend update
pcbridge plugin call local-frontend list
pcbridge plugin call local-frontend use --params '{"release":"playcanvas-editor-v2.28.1-r4"}'
pcbridge plugin call local-frontend remove --params '{"release":"playcanvas-editor-v2.28.1-r1"}'
pcbridge plugin call local-frontend mode --target editor:<sceneId> --params '{"mode":"local"}'
pcbridge plugin disable local-frontend
```

下载的前端构建保存在 `~/.pcbridge/frontends/`。禁用或移除 `local-frontend` 插件会立即释放
`localhost:3487` 端口并移除页面工具栏按钮。

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
├── scenes/       # 当前激活场景的可写 .scene.json 与未激活场景的只读镜像
├── assets/       # PlayCanvas 文件树的碰撞安全本地投影
├── tmp/          # 构建产物、缓存、冲突、截图以及本地/远端删除回收站
└── .pcbridge/    # 内部同步状态、JSON 三方合并基线和内容寻址对象缓存，请勿手动修改
```

查看或手动刷新工作区：

```bash
pcbridge workspace status --target editor:<sceneId>
pcbridge workspace path --target editor:<sceneId>
pcbridge workspace settings [--eager-max-mb <1..10>]
pcbridge workspace sync --target editor:<sceneId>
pcbridge workspace pull --target editor:<sceneId> --asset <assetId>
```

同步采用 WebSocket 增量事件流（`workspace:delta`）与本地脏路径精确监控，空闲时零轮询。
未超过直接同步体积上限的文本类资源（`script`、`text`、`json`、`html`、`css`、`shader`）和结构化
JSON 资源（`material`、`template`、`cubemap`、`sprite`、`animstategraph`、`bundle`，投影为
`<name>.<type>.json`）默认直接落盘并双向实时同步。可在浏览器插件弹窗中使用 **Direct sync limit**
滑动条或执行 `pcbridge workspace settings --eager-max-mb <1..10>` 在 **1 MB–10 MB**（默认 **2 MB**）
范围内调整直接同步上限。当前打开的激活场景同步到 `scenes/<name>.<sceneId>.scene.json`（按场景树
DFS 排序，支持双向增量同步）；未打开的其他场景落盘为只读（`0o444`，且 `$pcbridge.readonly: true`）`.scene.json` 供跨场景检索，
编辑前先通过 `pcbridge scene open` 切换为激活场景。

结构化 JSON 资源与激活场景基于 `.pcbridge/baselines/` 做规范化与属性路径级三方合并：两端修改不同
实体或不同属性时自动无冲突合并并结构化 Patch 回写 Editor；仅当同一叶子属性被同时改成不同值时，
才将 `.local`、`.remote` 与 `.conflict.json` 隔离到 `tmp/conflicts/`。图片、模型、音频、字体及超过
直接同步上限的大文件保持懒同步：在 `pcbridge.project.json` 中记录元数据、尺寸规格与 MD5，按需通过
`workspace pull` 或 Tiny Builder 插件拉取。本地新增文件（包括新建 `*.<type>.json` 结构化资源）会在对应
目录自动创建远端 Asset；本地重命名和移动通过内嵌 `$pcbridge.id`、文件 inode 或内容哈希保持原 Asset ID。
删除本地直接同步（Tier 1）文件会先备份到 `tmp/trash/local/` 并同步删除远端 Asset 以避免状态歧义；
删除已拉取的懒同步（Tier 2）二进制文件则仅清理本地缓存，远端删除仍隔离到 `tmp/trash/remote/`。
`tmp/` 下的构建、缓存和 agent 临时文件完全不参与 workspace 同步。

PlayCanvas 可能生成同名的源 Asset 和派生 Asset，例如源 GLB 与 Container/Model，或字体源文件
与字体图集。manifest 会把网页端显示路径 `folder` 和本地唯一路径 `projectionPath` 分开记录。
派生二进制使用 `file.filename`，源资源和独立资源跟随 `asset.name`；只有名称碰撞时，才会在扩展名前加入
`.__pc_<type>_<assetId>`。派生二进制按需下载且只读（`0o444`），而关联源模型的结构化 JSON 资源
（如 FBX/GLB 导入生成的材质）保持可写并参与双向同步，仅在 `$pcbridge.sourceAssetId` 保留来源标记；
修改或移动只读派生二进制投影时，本地副本会隔离到
`tmp/conflicts/`，随后从对象缓存恢复正确内容，不会反向上传到 PlayCanvas。

schema v3 的 `pcbridge.project.json` 会记录 `origin`（`source`、`derived` 或 `standalone`）、
PlayCanvas 声明和实际观察到的文件元数据、最终采用的 MD5，以及本地是否存在、是否可写、当前
和同步基线 MD5。贴图 variant、字体附加图集等仅在构建中使用的文件记录在 `local.resources`
中，并作为主 Asset 同目录下的只读受管文件。agent 可以直接读取这些信息，但 `assets` 对象由
pcbridge 管理。schema v1
和 v2 会自动迁移；v1 隐藏索引仍保留为 `.pcbridge/asset-index.v1.json` 以便回退。已有资源时
收到的空快照会被忽略；
非空但缩小的快照必须连续出现两次，文件才会被移动到 `tmp/trash/remote/`。

## 插件

可选功能以 pcbridge 插件的形式提供。pcbridge 插件不等于 Chrome 浏览器插件：浏览器插件是
pcbridge 固定的组成部分，而 pcbridge 插件是每个用户按需添加、开启、关闭和删除的功能包。
一个插件可以包含两类代码：

| 运行环境 | 运行位置 | 典型用途 |
| --- | --- | --- |
| `node` | 本地 daemon | 文件、网络、密钥、连接 Blender 等本地程序 |
| `page.editor` / `page.launch` | PlayCanvas Editor 或 Launch 页面 | 编辑器 UI、Editor API 读写、运行时检查 |

浏览器插件本身不能被 pcbridge 插件扩展，它只负责在两端之间转发消息并提供管理面板。可以在
浏览器插件弹窗的 **Plugins** 标签页或通过 CLI 管理插件：

```bash
pcbridge plugin list                       # 已安装插件、各自的 action，以及可添加的官方插件
pcbridge plugin add tinyapp-builder        # 随 pcbridge 发布的官方插件
pcbridge plugin add github:<owner>/<repo>[/<subdir>][#<ref>]
pcbridge plugin add ./my-plugin [--link]   # --link 直接使用该目录，便于开发调试
pcbridge plugin enable|disable|remove|update <id>
pcbridge plugin reload <id>                # 修改插件文件后重新加载
pcbridge plugin call <id> <action> --target editor:<sceneId> --params '<json>'
```

插件保存在 `~/.pcbridge/plugins/`。带 npm 依赖的插件会在添加或更新时通过
`bun install --production` 安装依赖。开启、关闭和重新加载会立即作用于 daemon 以及已打开的
Editor / Launch 页面，无需刷新页面。`plugin update` 会从添加时记录的来源重新拉取。插件拥有
完整的本地和页面权限，请只添加可信来源的插件。

开发插件时，先安装 Agent 技能（`pcbridge install-skill --agent all`），再使用
`pcbridge-plugin-authoring` 技能；它定义了清单文件（`pcbridge-plugin.json`）、两端运行时 API
和编写规则。本仓库的 `plugins/tinyapp-builder/` 是参考实现。

## Tiny Builder 插件：Template 构建与 S3 上传

在已配置 `TINYAPP_S3_*` 的自托管 PlayCanvas 编辑器服务端上，无需本地携带密钥即可直接通过
`pcbridge tinyapp` 调用后端进行 ES5 编译、直传 OSS/COS CDN、子模板增量复用与历史版本管理：

```bash
pcbridge tinyapp status --target editor:<sceneId>
pcbridge tinyapp inspect --target editor:<sceneId> --template <templateAssetId>
pcbridge tinyapp build --target editor:<sceneId> --template <templateAssetId> --label "正式版" --wait
pcbridge tinyapp list --target editor:<sceneId> --template <templateAssetId>
pcbridge tinyapp delete --target editor:<sceneId> --build <buildId>
```

在官方 `playcanvas.com` 或希望自行管理对象存储密钥与桶时，仍可使用本地插件方案：
Tiny Builder 是官方插件 `tinyapp-builder`，执行一次 `pcbridge plugin add tinyapp-builder`
或在弹窗 **Plugins** 标签页点击 **Install** 即可添加。

插件开启后，选中 PlayCanvas Template Asset，Attributes 面板会出现 **pcbridge Tiny Builder**。点击
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
pcbridge plugin call tinyapp-builder start --target editor:<sceneId> --params '{"templateAssetId":"<templateAssetId>","suffix":"-${time}"}'
pcbridge plugin call tinyapp-builder status --params '{"jobId":"<jobId>"}'
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
pcbridge help processing
pcbridge help import
pcbridge help plugin
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

插件 popup 会展示 daemon、当前 tab、项目、scene、branch、工作区路径、同步统计、冲突数、
站点授权以及 **Plugins** 插件管理面板。红色表示断联或冲突，黄色表示初始化、同步中或本地待处理状态，
绿色表示 ready / synced。

## 安全模型

这是一个本地可信开发工具，会在你已经打开的 PlayCanvas Editor 和 Launch 页面内执行 JavaScript。

基础防护：

- daemon 只绑定 `127.0.0.1`；
- 启用可选的 `local-frontend` 插件时，其静态服务只绑定 `127.0.0.1`，校验 Host，且只提供当前已校验 Release 目录内的文件；
- CLI、daemon、插件共享本地 session token；
- 插件只匹配 PlayCanvas Editor 和 Launch URL；
- CLI 输出统一使用紧凑 JSON envelope；
- 结构化写命令要求明确 ID 或 JSON 文件。

## 开发

```bash
bun install
bun run build
bun dist/cli.js doctor
```

如果以后添加一次性 TypeScript 脚本，优先用 `bun` 执行。

## 发布到 npm（维护者）

发布流程通过 `.github/workflows/npm-publish.yml` 使用 npm Trusted Publishing，GitHub
仓库不需要保存 `NPM_TOKEN`。

1. 在 `package.json`、`src/config.ts` 和 `extension/manifest.json` 中同步更新同一个稳定版本号。
2. 运行 `bun run test`，把发布提交合并并推送到 `main`。
3. 创建并推送匹配的 tag，例如：

```bash
git tag v<version>
git push origin v<version>
```

如果 tag 与包版本不一致，或者 tag 对应的提交不属于 `main`，workflow 会拒绝发布。
推送 tag 前，需要在 npm 包设置中把 GitHub 用户设为 `Q-My99`、仓库设为
`playcanvas-agent-bridge-cli`、workflow 文件名设为 `npm-publish.yml`。

## 自托管站点与本地资源处理

插件自动识别官方站点、`pc-editor.sightp.com`、`pc-launch.sightp.com` 及任意端口的 localhost / 127.0.0.1 Editor、Launch 页面。其他域名在 popup 点击 **Enable on this site**，经 Chrome 授权后刷新；Editor 与 Launch 域名分别授权。禁用或撤回权限会关闭现有连接。

本地计算仅限自托管，默认关闭。安装可信发布者提供的版本化工具 manifest 和预编译包（当前实测 macOS arm64，尚未发布公开工具 release）：

```sh
pcbridge processing install /path/to/release.json
pcbridge processing enable --memory-mb 1024 --timeout-ms 600000
pcbridge processing status --target editor:<sceneId>
pcbridge import submit --asset <id> --kind model --json options.json --target editor:<sceneId>
pcbridge import list --target editor:<sceneId>
pcbridge import wait --job <id> --sync-workspace --target editor:<sceneId>
pcbridge import status --job <id> --target editor:<sceneId>
pcbridge import cancel --job <id> --target editor:<sceneId>
pcbridge import retry --job <id> --target editor:<sceneId>
pcbridge processing disable
```

贴图改用 `--kind texture`，options 如 `{"formats":["dxt","etc2"],"mipmaps":true}`。已有上传命令和 Editor UI 使用同一种服务器任务。身份、租约和对象存储 URL 仅由浏览器持有，不传给 CLI。`complete` 表示服务器正式发布；`--sync-workspace` 额外等待工作区元数据同步，二进制继续按需下载。工具缺失、关闭或繁忙时回退服务器 worker。

固定转换子进程单并发，转换预算 1 GiB，顺序分块 256 KiB，临时文件在项目 `tmp/processing/`。转换超时 10 分钟，失联传输 90 秒回收；这不是 OS 级硬内存沙箱。工具/配方/平台兼容性独立于桥接连接报告。可复用可信服务端缓存，但客户端结果不写入服务端转换缓存；首版不提供本地持久结果缓存。

更新后执行 `pcbridge install-extension --no-open`，在 Chrome 重新加载 unpacked 扩展，再刷新 Editor/Launch；旧 daemon 需使用原工作区路径重启。官方与自托管需分开工作区并明确选择目标，不提供跨站点 projectId 命名空间。自托管新数据集使用资源 MD5，不提供旧 SHA-256 资源迁移。
