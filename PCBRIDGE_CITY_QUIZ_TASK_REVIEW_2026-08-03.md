# pcbridge 实战复盘：`citygame-川行` 移动端答题模板

日期：2026-08-03  
使用版本：本地 pcbridge / Chrome 扩展 `0.4.0`  
PlayCanvas 项目：`citygame-川行`（project `1571756`，scene `2558183`）

## 1. 本次任务简述

本次任务是在一个已经打开的 PlayCanvas Editor 项目中，根据 Word 文档和移动端设计图制作五个答题 Template。主要工作包括：

- 从文档整理五个点位的单选、多选和拼接题占位数据。
- 在 2D Screen 下创建并维护五套结构一致、数据不同的答题 Template。
- 实现同一点位多题切换、答错晃动、正确/错误音效和最终 `complete` 事件。
- 使用项目已有的 `sdsAudioPlayer`，保证小程序运行环境兼容。
- 更新字体字符集并执行 PlayCanvas 的 `PROCESS FONT`。
- 根据 474 × 958 的设计图反复调整移动端布局，并验证四选项、六选项和长文本。
- 在 Launch 中运行五个点位的完整流程测试，并将临时预览状态恢复为可交付状态。

本次主要使用了以下 pcbridge 能力：

- `targets`、`workspace status`
- `entity list|get|patch|patch-many`
- `asset list`、`script set-text|parse`
- `template create|instantiate`
- `eval --code|--file`
- `viewport capture`
- `logs get`

最终创建并维护了五个 Template、一个控制器脚本、五个模板源实体，以及一组任务脚本、测试脚本和截图。

## 2. 总体评价

pcbridge 已经足以完成真实 PlayCanvas 项目的复杂编辑任务。它最有价值的部分是：

- 可以直接访问现有登录态中的 Editor 和 Launch 页面。
- 结构化实体、资产和脚本命令覆盖了大部分常见操作。
- `eval --file` 适合一次性安装大批实体或执行复杂 Editor API 流程。
- workspace 镜像、冲突检测、专用 viewport RPC 和日志抓取显著降低了自动化风险。

当前主要问题不是“无法完成”，而是一些关键流程缺少一等命令和可靠的完成语义，导致任务需要反复探测 Editor 内部 API、轮询状态并人工维护预览状态。下面按优先级记录具体痛点。

## 3. P0：Launch 目标的 `ready` 不能代表游戏场景已加载

### 具体表现

Launch 标签页在后台时，`pcbridge targets` 返回：

- `ready: true`
- `hasRuntimeApp: true`
- `hasPc: true`

但实际运行实例仍停在启动画面：

- `document.visibilityState === "hidden"`
- `pc.AppBase.getApplication('application-canvas').root.children` 为空
- 当前 scene 未加载
- 脚本注册表为空
- Launch 日志没有 error

PlayCanvas 的实时连接会等页面变为 visible。由于标签页一直在后台，pcbridge 看起来“已就绪”，但场景没有真正启动。为了继续验证，我最终不得不借助 Chrome 控制能力聚焦 Launch 标签页；聚焦后场景才加载。

### 建议改进

新增明确的 Launch 生命周期状态，并让 `ready` 采用更严格的定义：

```json
{
  "pageReady": true,
  "visibilityState": "hidden",
  "runtimeCreated": true,
  "sceneLoaded": false,
  "scriptsReady": false,
  "splashVisible": true,
  "ready": false
}
```

建议新增：

- `pcbridge target focus --target <launch-tab>`
- `pcbridge launch wait-ready --target <launch-tab> --timeout-ms 30000`
- `pcbridge launch diagnose --target <launch-tab>`
- `pcbridge launch refresh --focus --wait-ready`

`wait-ready` 至少应检查：页面可见、运行 app 存在、root 已有场景子实体、scene 已加载、启动遮罩已隐藏。

### 为什么要改

这是本次最耗时、最容易误判的痛点。当前 `ready: true` 会让调用者把“页面脚本已注入”误认为“游戏已可测试”。Launch 自动化必须区分页面连接、Engine 实例创建和场景真正可运行三个阶段。

## 4. P0：Engine V2 的运行 app 获取方式与现有示例不一致

### 具体表现

技能文档示例使用：

```js
pc.Application.getApplication()
```

本项目启用了 Engine V2。该调用返回的是空 app，实际游戏实例需要通过：

```js
pc.AppBase.getApplication('application-canvas')
```

第一次排查时，空 app 导致 `root.children` 为空，和“Launch 尚未加载”问题叠加，增加了定位难度。

### 建议改进

在 Launch `eval` 中注入一个由 pcbridge 解析好的稳定绑定：

```js
runtimeApp
```

解析顺序可覆盖：

1. `pc.AppBase.getApplication('application-canvas')`
2. `pc.AppBase.getApplication()`
3. `pc.Application.getApplication()`
4. 从 `pc.AppBase._applications` 中选择绑定可见主 canvas、且 root 非空的实例

同时新增：

- `pcbridge launch inspect-runtime`
- 在 `eval` 元信息中返回所选 app、canvas id、Engine 版本和 root 子实体数量

并更新技能文档中的 Launch 示例。

### 为什么要改

调用者不应该自行了解不同 PlayCanvas Engine 版本的全局 app 差异。提供稳定的 `runtimeApp` 能减少大量重复探测代码。

## 5. P0：缺少可靠的 Template apply / apply-many 命令

### 具体表现

五个模板源实体更新后，需要把 overrides 应用回 Template 资产。当前没有结构化命令，只能在 `eval` 中调用内部 API：

```js
editor.call('templates:computeFilteredOverrides', root)
editor.call('templates:apply', root, callback)
```

遇到的问题：

- `templates:apply` 的直接返回值是 `false` 或 `undefined`，但操作可能已经开始。
- callback 的布尔值不能可靠代表最终落盘结果。
- 连续对五个 root 调用时，第一次只有两个模板立即显示 overrides 归零，其余模板稍后才异步完成。
- 直接修改 Template asset 的 `data` 看似成功，但刷新 Editor 后会回退，不能作为持久化方案。
- 必须自己轮询 `computeFilteredOverrides`，并串行等待每个模板变成 0。

### 建议改进

新增结构化命令：

```bash
pcbridge template apply --target <editor> --entity-id <root-id> --wait
pcbridge template apply-many --target <editor> --json ./template-roots.json --wait
pcbridge template overrides --target <editor> --entity-id <root-id>
```

命令内部应：

1. 读取 apply 前 overrides 数量。
2. 调用官方 Editor apply 流程。
3. 串行轮询，等待 overrides 归零。
4. 从 Template 资产读回关键字段，确认已持久化。
5. 返回 `before`、`after`、耗时、模板 id 和错误信息。

`apply-many` 应默认串行处理，避免 Editor 模板更新队列竞争。

### 为什么要改

Template 是 PlayCanvas 项目复用的核心单位。只有 `template create` 和 `instantiate`，没有可靠的 apply，使复杂任务必须依赖不稳定的内部 API。

## 6. P0：临时预览状态容易污染 Template

### 具体表现

为了在 Launch 中只预览第一个答题模板，我临时进行了以下修改：

- 启用模板源父组。
- 只启用第一个模板源 root。
- 禁用其他四个 root。

在这个预览状态下执行 Template apply 后，后四个 Template 的根实体也被保存为 `enabled: false`。恢复场景预览状态后，四个源实体各留下一个 override。最后通过再次 apply 才修正为五个 Template 根实体默认启用、overrides 全部为 0。

### 建议改进

提供可恢复的临时预览事务：

```bash
pcbridge preview begin --target <editor> --snapshot ./tmp/preview-state.json
pcbridge entity patch-many --temporary --json ./preview-on.json
pcbridge preview restore
```

或者为 `entity patch|patch-many` 增加：

- `--snapshot-out`
- `--restore-from`
- `--temporary`（只修改 Launch/runtime，不写入 Editor 持久化模型）

Template apply 也可增加警告：如果 root 的 `enabled` 状态刚由 preview transaction 改动，则要求显式 `--include-preview-state`。

### 为什么要改

预览开关属于测试状态，不应悄悄进入生产 Template。复杂场景中这种污染很难通过视觉发现，只有逐个检查 Template 数据或 overrides 才能发现。

## 7. P1：`script set-text` 与 `script parse` 缺少原子完成语义

### 具体表现

每次修改控制器都需要：

```bash
pcbridge script set-text ...
pcbridge script parse ...
```

期间出现过：

- `set-text` 返回的脚本 attributes 仍是旧数据。
- 更新后返回的 asset `file` 短暂为 `null`，随后 `parse` 又能读到正确文件和 hash。
- 删除 `correctAudioUrl`、`wrongAudioUrl` 属性后，必须等第二次 parse 才能确认 attributesOrder 已更新。

### 建议改进

为 `script set-text` 增加：

```bash
pcbridge script set-text ... --parse --wait
```

完成条件应包括：

- 文件 hash 已更新且稳定。
- asset file 非空。
- 脚本解析任务完成。
- 返回最新 `attributesOrder`、`attributesInvalid` 和 parse diagnostics。
- workspace 镜像已同步到相同 hash。

也可以提供统一的幂等命令：

```bash
pcbridge script upsert ... --parse --wait
```

### 为什么要改

脚本内容已提交但属性元数据仍旧，会产生短暂而危险的不一致。调用者需要一个明确的“脚本已可安全挂载和运行”信号。

## 8. P1：字体 PROCESS FONT 没有结构化命令

### 具体表现

任务要求把所有题目字符写入字体并执行 PROCESS FONT。pcbridge 没有相应命令，我只能检查自定义 Editor frontend 的实现，再在 `eval` 中复现内部流程：

```js
target.set('meta.chars', chars)
editor.call('realtime:send', 'pipeline', {
  name: 'convert',
  data: { source, target, chars, invert }
})
```

之后还需要自行轮询字体 task、字符数量和 `missingCharacters`。

### 建议改进

新增：

```bash
pcbridge font inspect --asset-id <font-asset>
pcbridge font process \
  --source-asset-id <ttf-id> \
  --target-asset-id <font-id> \
  --chars-file ./chars.txt \
  --wait
```

返回：

- 处理前后字符数。
- task 状态和耗时。
- missing characters。
- source/target asset id。
- 是否实际触发了重新处理。

### 为什么要改

中文 UI 项目经常依赖字体子集。PROCESS FONT 是正式交付的一部分，不应要求调用者逆向 Editor 内部 pipeline。

## 9. P1：动态注册 ScriptType 无法通过结构化命令挂载

### 具体表现

`sdsAudioPlayer` 由 `tiny-runtime.umd.js` 动态注册，不是独立的 PlayCanvas script asset。`entity add-script` 需要 asset id，因此无法直接添加该 ScriptType。

我只能在 `eval` 中手动写入：

```js
root.set('components.script.order', ['sdsAudioPlayer', 'cityQuizController'])
root.set('components.script.scripts.sdsAudioPlayer', {
  enabled: true,
  attributes: { slots: [...] }
})
```

### 建议改进

新增按 ScriptType 名称操作的命令：

```bash
pcbridge entity script add \
  --id <entity-id> \
  --name sdsAudioPlayer \
  --attributes-json ./audio-slots.json

pcbridge entity script patch --id <entity-id> --name sdsAudioPlayer ...
pcbridge entity script reorder --id <entity-id> --order sdsAudioPlayer,cityQuizController
```

命令应验证 Editor 当前是否认识该 ScriptType，并在未知时返回清晰错误。

### 为什么要改

许多项目通过 bundle 或 runtime 注册 ScriptType。仅支持 asset-id 形式会迫使调用者直接修改内部数据模型。

## 10. P1：缺少移动端浏览器视口控制

### 具体表现

设计验收要求 474 × 958 手机视口。`viewport capture` 可以截图，但 pcbridge 本身不能：

- 聚焦 Launch 标签页。
- 设置浏览器 viewport 尺寸。
- 设置或查询 DPR。
- 在完成后恢复原 viewport。

因此本次必须借助另一套 Chrome 控制能力设置 474 × 958，再回到 pcbridge 截图。

### 建议改进

新增：

```bash
pcbridge target focus --target <tab-id>
pcbridge viewport size get --target <tab-id>
pcbridge viewport size set --target <tab-id> --width 474 --height 958 --dpr 1
pcbridge viewport size reset --target <tab-id>
```

`viewport capture` 返回值中同时记录：

- CSS viewport。
- canvas backing size。
- DPR。
- 输出图片尺寸。
- 是否发生缩放或裁切。

### 为什么要改

PlayCanvas 移动端项目需要在固定 viewport 下做可重复视觉测试。如果 viewport 设置不属于 pcbridge，一个完整验证流程就无法只依赖 CLI 完成。

## 11. P1：通用序列化的 `[MaxDepth Object]` 过多

### 具体表现

读取以下数据时频繁得到 `[MaxDepth Object]`：

- `components.script.scripts`
- `sdsAudioPlayer.attributes.slots`
- Template asset 的 entity 数据
- 脚本 parse attributes

为了拿到实际字段，只能反复写 `eval`，手动 map 成扁平对象。有些实体查询还会返回大量无关 component 字段，导致输出被截断。

### 建议改进

增加字段投影和序列化控制：

```bash
pcbridge entity get --id <id> --select name,enabled,components.script
pcbridge asset get --id <id> --select data.entities --max-depth 8
pcbridge eval ... --max-depth 8 --max-items 500
```

也可以增加专用 inspect 命令：

- `entity script list|get`
- `template inspect`
- `font inspect`

### 为什么要改

当前默认深度适合防止返回巨大对象，但缺少调用者可控的精确投影，结果是不得不用更多 `eval`，反而增加复杂度和风险。

## 12. P1：2D Element 的位置、尺寸和 margin 需要手工保持一致

### 具体表现

调整中心锚点 UI 元素时，不能只改 `position`、`width`、`height`。为了保证 Editor 数据和运行时一致，还要同步计算：

```js
[left, bottom, right, top]
```

本次为卡片、题目、选项、选中条和按钮编写了自定义 `setElementBox`，重复维护 `position`、尺寸和 margin。五个模板、29 个实体会放大任何计算错误。

### 建议改进

新增 2D UI 专用命令：

```bash
pcbridge ui set-box --id <id> --x 0 --y 345 --width 900 --height 200
pcbridge ui inspect-layout --id <screen-or-root> --screen-corners
pcbridge ui validate --id <root> --check-overlap --check-viewport
```

`set-box` 应根据 anchor/pivot 自动维护 margin。`validate` 可返回元素屏幕边界、越界和重叠列表。

### 为什么要改

大部分移动端 PlayCanvas UI 都依赖 Element 的 anchor/pivot/margin 组合。把这部分封装为结构化能力，会显著减少 eval 脚本和视觉回归次数。

## 13. P1：workspace 中新建脚本的本地文件名不稳定

### 具体表现

远端脚本资产名称为 `cityQuizController.js`，但镜像中一度出现：

```text
assets/New Asset~300991959
```

实际可编辑源仍放在任务 `tmp` 中，再通过 `script set-text` 上传。调用者难以从 asset id 快速找到规范的本地镜像路径。

### 建议改进

- 当远端 asset 完成 rename 或 file metadata 更新时，自动把本地镜像重命名到最终路径。
- 新增：

```bash
pcbridge workspace resolve --asset-id 300991959
pcbridge workspace repair-paths --dry-run
```

- `script create|upsert` 完成后直接返回稳定的本地绝对路径。

### 为什么要改

workspace 的价值之一是让脚本可以像普通项目文件一样编辑。临时名称泄漏到最终镜像会降低可发现性，也容易产生重复源文件。

## 14. P2：截图需要透明通道与背景处理选项

### 具体表现

`viewport capture` 成功输出 474 × 958 PNG，但图片包含 alpha。部分视觉查看工具会根据透明内容自动裁切显示，导致长图看起来只剩上半部分。为了稳定对照，我额外使用 ffmpeg 把截图铺到固定背景。

### 建议改进

增加：

```bash
pcbridge viewport capture ... --flatten '#808080'
pcbridge viewport capture ... --preserve-alpha
```

返回元信息中增加 `hasAlpha`、有效内容边界和 canvas clear color。

### 为什么要改

视觉 QA 需要稳定、可比较的输出。透明 PNG 在不同查看器中的呈现不一致，会造成“截图被裁切”的假象。

## 15. P2：daemon 不可达错误应区分“未启动”和“环境禁止访问 localhost”

### 具体表现

daemon 已经运行，但最初在受限执行环境中调用 pcbridge 时仍报告不可达。切换到允许访问本机 loopback 的执行权限后，命令正常工作。

这不是 pcbridge 本身的连接故障，但错误表现与 daemon 未启动几乎一致。

### 建议改进

`doctor` 或连接错误中区分：

- `ECONNREFUSED`：端口没有监听。
- `EACCES/EPERM`：环境策略阻止访问。
- DNS / URL 配置错误。
- daemon token 或版本不匹配。

给 agent-friendly 的建议，例如：

```text
Daemon may be running, but this process cannot access 127.0.0.1:17329.
Retry from an execution context with local-loopback permission.
```

### 为什么要改

明确错误类型可以避免重复启动 daemon，也能减少用户被要求执行无效操作。

## 16. 推荐实施顺序

### 第一阶段：可靠性

1. Launch `ready` 分阶段状态、focus、wait-ready、diagnose。
2. 稳定的 `runtimeApp` 绑定，覆盖 Engine V2。
3. `template apply|apply-many --wait`。
4. `script set-text --parse --wait`。

### 第二阶段：覆盖常见制作流程

5. `font process --wait`。
6. 按 ScriptType 名称管理动态脚本。
7. 移动端 viewport set/reset 和截图元信息。
8. 2D UI `set-box` 与布局验证。

### 第三阶段：可用性

9. `--select`、`--max-depth` 和专用 inspect 命令。
10. preview snapshot/restore 或 temporary patch。
11. workspace asset path 修复和 resolve。
12. PNG flatten/alpha 选项。

## 17. 建议的最小验收场景

建议把本次任务提炼为 pcbridge 的端到端回归测试：

1. 在 Editor 中创建一个包含 2D Screen、题目、六个选项和按钮的源实体。
2. 挂载一个普通 script asset 和一个动态注册 ScriptType。
3. 创建两个 Template，并修改源实体后执行 `template apply-many --wait`。
4. 更新字体字符集并等待 PROCESS FONT 完成。
5. 临时启用一个模板进行预览，保证恢复后 Template 根状态不被污染。
6. 聚焦 Launch、设置 474 × 958 viewport、等待 runtime ready。
7. 在 Engine V2 下通过稳定的 `runtimeApp` 执行交互测试。
8. 捕获非透明 PNG，返回 CSS viewport、DPR 和 backing size。
9. 恢复 viewport、场景预览状态，并确认所有 Template overrides 为 0。

如果上述流程能够只使用 pcbridge CLI 完成，不需要额外浏览器控制或内部 Editor API 探测，pcbridge 就能更稳定地承担真实移动端 PlayCanvas UI 制作任务。
