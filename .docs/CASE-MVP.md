# 已实现的用例格式 - CASE-MVP.md

## 先读这一段：这里有两套用例结构，别弄混

仓库里同时存在两套「用例」，字段完全不同，却都写着 `schemaVersion: 1`：

| | 本文档（`nodes` 节点图） | `CASE-SCHEMA.md`（`steps` 三段式） |
|---|---|---|
| 实现文件 | `src/core/case/case-runner-autojs.js` | `src/core/case/case-schema-autojs.js` |
| 状态 | **已实现，正在跑真实用例** | **只有设计稿和校验器，没有执行器** |
| 谁在用 | `src/tasks/case-*-autojs.js` → 真实 JSON | 没有任何代码 require 它 |

`case-schema-autojs.js` 只被 `case-geometry-autojs.js` 引用，而 `case-geometry-autojs.js`
不被任何人引用——这两个文件目前是**死代码**，是先于 MVP 做的设计，保留是因为
里面的归一化换算和锚点分类以后还用得上。

**写新用例、改回放器，一律以本文档为准。** 看到 `CASE-SCHEMA.md` 里的
`steps` / `expect` / `verify` / `anchor` / `swipe`，那些字段喂给 `case-runner` 会直接报错。

两者共用 `schemaVersion: 1` 是个历史遗留问题，等 `steps` 模型真要落地时必须先分开版本号。

## 这套格式的由来

来自 `RECORDER-RESEARCH.md`：参考产品把流程组织成**带跳转的节点图**而不是线性步骤链，
每个节点独立配「成功后去哪、失败后去哪」，形成类似 goto 的流程控制。
项目所有者确认长期实际只用三种动作，于是 MVP 边界定死为 `noop` / `tap` / `tapImage`。

## 完整字段

### 顶层

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 必须是 `1`，不等则抛错 |
| `id` | 是 | 用例标识 |
| `name` | 是 | 人类可读名称 |
| `nodes` | 是 | 非空数组 |
| `baseline` | 否 | `{ width, height }`，**只用于方向断言**，见下方陷阱 |
| `entry` | 否 | 起始节点 id，默认从 `nodes[0]` 开始 |
| `maxNodeVisits` | 否 | 节点访问次数上限，默认 500，超出抛错 |

**陷阱**：真实用例 `boss-feast-layer3.json` 里还写着 `launchGame` / `requiresCapture` /
`captureAfterLaunch`。**`case-runner` 完全不读这三个字段。** 它们的生效位置是任务模块
（`src/tasks/case-*-autojs.js`）的 `module.exports`，因为运行时要在 `run()` 被调用之前
就读到它们来决定前置流程。改 JSON 里的这三个字段不会有任何效果，必须改任务模块。

### 节点通用

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 用例内唯一，重复则抛错 |
| `name` | 是 | 写进日志和步骤结果 |
| `type` | 是 | `noop` / `tap` / `tapImage`，其余值抛错 |
| `onSuccess` | 否 | 默认 `@next` |
| `onFail` | 否 | 默认 `@abort` |

### `noop`

无参数。占位与汇合点，供别的节点跳转过来。

### `tap` — 死坐标点击

| 字段 | 必填 | 说明 |
|---|---|---|
| `rx` / `ry` | 是 | 0 到 1，超出范围抛错 |
| `postWaitMs` | 否 | 点击后等待，交给 `context.actions.tap` |

### `tapImage` — 找图后点击

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `asset` | 是 | - | 相对 `assetsRoot` 的路径，如 `game/btn-xxx.png` |
| `threshold` | 否 | `0.85` | 0 到 1 |
| `region` | 否 | 全屏 | `{ rx, ry, rw, rh }`，`rx+rw` 或 `ry+rh` 超过 1 抛错 |
| `waitMs` | 否 | `15000` | 找图总超时 |
| `pollMs` | 否 | `1500` | 轮询间隔 |
| `click` | 否 | `true` | **填 `false` 表示只等待出现、不点击**，用于纯断言 |
| `preTapMs` | 否 | `400` | 找到后、点击前的停顿 |
| `offset` | 否 | 无 | `{ rx, ry }` 归一化偏移，可为负，从匹配中心挪开再点 |
| `postWaitMs` | 否 | - | 点击后等待 |

`click: false` 是这套 MVP 里唯一的断言手段——真实用例中一半节点都是它，
用来确认「面板已打开」「标题已出现」再往下走。

## 跳转语义

`onSuccess` / `onFail` 取四种值：

| 值 | 含义 |
|---|---|
| `@next` | 走 `nodes` 数组里的下一个；已是最后一个则用例正常结束 |
| `@end` | 立即结束，判定成功 |
| `@abort` | 立即结束，判定失败，**原始异常抛给上层运行时** |
| 节点 id | 跳到该节点 |

`@abort` 抛出而不是静默返回，是为了让上层 runtime 走它原有的失败截图与
`result.json` 流程，保留原始错误信息。

**静态校验不检查跳转目标是否存在。** 校验器刻意放行未知字符串（因为允许向前跳到
还没扫到的节点），真正的存在性检查发生在执行到那一步的时候。所以拼错一个节点 id，
要跑到那一步才炸。

## 执行结果

`runCase` 返回步骤数组，每项 `{ id, name, type, status, durationMs, error? }`，
`status` 只有 `passed` / `failed` 两种。

**没有 `skipped`，没有 `optional`，没有 `broken`。** `CASE-SCHEMA.md` 里
把环境问题（`broken`）和业务失败（`failed`）分开统计的设计，在 MVP 里还不存在。

## baseline 的真实作用：只管方向，不做缩放

`baseline` 唯一的用途是断言「设备横竖屏方向与录制时一致」，不一致就抛错。

**归一化坐标是按当前设备算的**：`tap` 用 `node.rx * device.width`，`region` 同理，
过程里根本不参考 `baseline.width / height`。

所以 **MVP 目前不具备「一次录制、多端回放」能力**——只要分辨率或宽高比变了，
死坐标 `tap` 就会偏。现在能跑通是因为始终在同一台 720x1280 云机上。
`case-geometry-autojs.js` 里的 `createViewport` 才是为跨端换算准备的，但还没接进来。

## 用例 JSON 必须与 main.js 同级

和素材一样，用例是外部数据文件，运行时用 `files.path("cases/xxx.json")` 加载：

- `npm run project` 把 `src/cases/*.json` 拷进 `dist/project/cases/`
- `run-task.ps1 -PushAssets` 同时推 `assets/` 和 `cases/`

写成绝对路径打包后必然找不到。

## `npm run check` 不校验用例

检查脚本只看 JS 语法、配置和任务登记，**完全不碰 `src/cases/` 和 `src/assets/`**。
用例 JSON 写错（字段拼错、节点 id 重复、region 越界）只有在设备上跑到那一步才会暴露。

改完用例请直接推到设备跑一次，别指望 `npm run check` 拦住。

## 加一条新用例

1. `src/cases/<用例名>.json` 写节点图，`schemaVersion` 填 `1`
2. `src/assets/game/` 放锚点图，**用户手工框选**，别自动截取
   （`RECORDER-RESEARCH.md` 记录了自动挑锚点的教训：把动态背景框进去就再也匹配不上）
3. `src/tasks/case-<用例名>-autojs.js` 照抄 `case-boss-feast-layer3-autojs.js`，
   只改 `id` / `name` / `CASE_RELATIVE_PATH`，以及 `launchGame` / `requiresCapture` /
   `captureAfterLaunch` 三个前置开关
4. 登记到 `src/task-registry-autojs.js`
5. 改 `src/config/game-config-autojs.js` 的 `defaultTask`
6. `.\.docs\script\run-task.ps1 -Device <地址> -PushAssets` 实机验证

第 3 步里 `require` 之外不要写业务逻辑。`files.path` 只在设备上存在，
所以 `loadCase` 必须放在 `run()` 内部——放到模块顶层会让 `npm run check` 在 Node 下直接崩。

## 已知缺口

按优先级：

1. **跨分辨率回放**：接入 `case-geometry` 的 viewport 换算，让 `baseline` 真正生效
2. **`broken` 与 `failed` 分离**：环境问题和业务失败混在一起，通过率会失去意义
3. **有界循环**：目前只能靠节点跳转手工造环 + `maxNodeVisits` 兜底，没有 `repeat` 语义
4. **静态校验**：把用例 JSON 纳入 `npm run check`，至少查跳转目标存在性
5. **录制器**：目前用例是手写 JSON，录制器还没开始做，设计见 `RECORDER-RESEARCH.md`
