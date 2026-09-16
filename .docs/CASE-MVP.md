# 已实现的用例格式 - CASE-MVP.md

## 先读这一段：这里有两套用例结构，用 `model` 区分

仓库里同时存在两套「用例」，字段完全不同：

| | 本文档（`nodes` 节点图） | `CASE-SCHEMA.md`（`steps` 三段式） |
|---|---|---|
| `model` | `"nodes"`（缺省值） | `"steps"`（必须显式写） |
| 实现文件 | `src/core/case/case-runner-autojs.js` | `src/core/case/case-schema-autojs.js` |
| 状态 | **已实现，正在跑真实用例** | **只有设计稿和校验器，没有执行器** |
| 谁在用 | `src/tasks/case-*-autojs.js` → 真实 JSON | 没有任何代码 require 它 |

**用例文档的身份是 `(model, schemaVersion)` 这一对，不是单独的 `schemaVersion`。**
两套结构各有独立的版本号空间，都从 `1` 开始、互不干扰。早期两边都只写 `schemaVersion: 1`，
照设计稿写出来的用例喂给执行器只会报一串「缺少 nodes」之类看不出根因的错
（ONBOARDING 第 11 条陷阱）。现在两个校验器都先认结构再校字段，互喂时直接说清
「这是另一套结构，去看哪份文档」。

`model` 缺省按 `"nodes"` 解释，所以此前所有用例 JSON 和录制器产物都不用改；
新写的用例建议显式写上，让文件自带结构标识。

`case-geometry-autojs.js`（归一化坐标换算）**已经在实际调用链上**——
`case-runner` 用它做跨分辨率换算。`case-schema-autojs.js` 目前只被 geometry 引用，
用于取默认的 `scaleStrategy`；它那套 `steps` 校验器仍然没有执行器。

**写新用例、改回放器，一律以本文档为准。**

## 这套格式的由来

来自 `RECORDER-RESEARCH.md`：参考产品把流程组织成**带跳转的节点图**而不是线性步骤链，
每个节点独立配「成功后去哪、失败后去哪」，形成类似 goto 的流程控制。
项目所有者确认长期实际只用三种动作，于是 MVP 边界定死为 `noop` / `tap` / `tapImage`。

## 完整字段

### 顶层

| 字段 | 必填 | 说明 |
|---|---|---|
| `model` | 否 | 缺省 `"nodes"`。写成 `"steps"` 或别的值直接抛错，见本文开头 |
| `schemaVersion` | 是 | `nodes` 模型的版本号，必须是 `1`，不等则抛错 |
| `id` | 是 | 用例标识 |
| `name` | 是 | 人类可读名称 |
| `nodes` | 是 | 非空数组 |
| `baseline` | 否 | `{ width, height }`，**只用于方向断言**，见下方陷阱 |
| `entry` | 否 | 起始节点 id，默认从 `nodes[0]` 开始 |
| `maxNodeVisits` | 否 | 节点访问次数上限，默认 500，超出抛错 |
| `orientationWaitMs` | 否 | 等待屏幕转到 baseline 方向的上限，默认 20000 |
| `orientationPollMs` | 否 | 上述等待的轮询间隔，默认 1000 |
| `requires` | 否 | 前置任务 id 数组。本用例假定它们已经跑过 |
| `assetBase` | 否 | 素材相对谁解析：`assets`（默认，走项目 `assetsRoot`）或 `case`（相对用例文件所在目录） |

**`assetBase: "case"` 是给录制用例用的。** 锚点图是在设备上现框的，而打包后的
`assets/` 在 APK 里是只读的，所以录制用例和它的锚点图一起放在会话目录里。
这种用例由调用方传 `runCase(context, caseData, { caseDir })`，不传直接抛错。
`npm run check` 对它按用例文件所在目录校验素材存在性。

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
| `maxVisits` | 否 | 本节点最多执行几次，用于有界循环 |
| `onExhausted` | 配了 `maxVisits` 就必填 | 次数用尽后转向哪里 |

**`maxVisits` 与 `onExhausted` 必须成对出现**，校验器强制。只给上限不给出口，
等于把死循环换成了硬报错，而循环的意义正是"试够了就往下走"。

用它表达「最多点三次关闭按钮，然后不管了继续」：

```json
{ "id": "close-popup", "name": "关弹窗", "type": "tapImage", "asset": "ui/close.png",
  "waitMs": 3000, "maxVisits": 3, "onSuccess": "close-popup", "onExhausted": "@next",
  "onFail": "@next" }
```

`onSuccess` 指回自己形成环，`maxVisits` 给环划界，`onExhausted` 给出口。

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

## baseline 管两件事：方向断言 + 分辨率换算

`baseline` 首先用于确认「设备横竖屏方向与录制时一致」。方向本身不做换算——
横竖屏对调意味着界面布局完全不同，不是缩放能解决的。

**这个检查是有上限的等待，不是即时判断。** 屏幕方向跟随前台应用而变，而游戏被拉起后
要过若干秒才真正转成横屏。2026-09-10 实测：拿到截图授权、把游戏拉回前台后仅 6 秒就跑用例，
设备仍报 720x1280（竖屏），用例当场失败——失败的是时序，不是用例。
现在改为轮询等待 `orientationWaitMs`（默认 20 秒），超时才抛错（判定为 `broken`）。

方向一致之后，坐标按 `case-geometry` 的 viewport 从 baseline 换算到当前设备：
`fit`（默认，等比缩放居中留边）或 `stretch`（横纵独立拉伸），
由 `baseline.scaleStrategy` 指定。**baseline 与设备同尺寸时是恒等映射**，
所以在录制设备上跑，行为与换算前一致。宽高比差异超过 5% 会记一条告警——
那种情况下任何策略都不完全可信。

换算越界不会静默裁剪，而是直接抛错——盲点比报错更难查。

## 用例 JSON 必须与 main.js 同级

和素材一样，用例是外部数据文件，运行时用 `files.path("cases/xxx.json")` 加载：

- `npm run project` 把 `src/cases/*.json` 拷进 `dist/project/cases/`
- `run-task.ps1 -PushAssets` 同时推 `assets/` 和 `cases/`

写成绝对路径打包后必然找不到。

## `npm run check` 会校验用例

检查脚本对 `src/cases/*.json` 逐个做四件事：

1. **schema 校验**，复用设备侧同一份 `validateCase`，两边判定不会不一致
2. **跳转目标存在性**——运行时刻意放行未知目标（允许向前跳到还没扫到的节点），
   所以拼错一个 id 要跑到那一步才炸；这里静态查掉
3. **素材文件存在性**——素材缺失在设备上是 `broken`，完全可以提前拦住
4. **`requires` 指向已登记任务**——否则常驻调度器到点才发现前置补不上

JSON 带 UTF-8 BOM 也能正常解析：Windows 上保存 JSON 常常带 BOM，
肉眼看不出来，而 `JSON.parse` 会直接抛。加载方和校验器都做了容错。

仍然要实机跑：静态校验查不出阈值不合适、锚点选错、时序不够这些问题。

## 加一条新用例

1. `src/cases/<用例名>.json` 写节点图，`model` 填 `"nodes"`、`schemaVersion` 填 `1`
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

## 执行结果里的三种状态

`runCase` 返回的每一步是 `passed` / `failed` / `exhausted`（次数用尽），
而整条用例在运行时层面取 `passed` / `failed` / `broken`。

`broken` 是环境或前置条件不成立——截图权限没给、游戏起不来、素材缺失、
屏幕方向不对、用例文件没推上去。它不是业务缺陷，必须与 `failed` 分开统计，
否则通过率会失去意义。判定由 `src/core/errors-autojs.js` 的标记决定，不靠猜错误文本。

## 已知缺口

**录制出来的用例进不了任务登记表。** 录制器已能生成并回放用例（见 `RECORDER.md`），
但产物在设备的会话目录里，要进常驻调度，仍需拷回 `src/cases/`、把 `assetBase` 改回
`assets` 并把锚点移进 `src/assets/`，再照下方「加一条新用例」登记。

较小的：

- **跨分辨率只做了坐标换算，没做素材换算。** 模板图是按录制分辨率截的，
  换到别的分辨率后找图仍可能失配。一套素材配一个基线，差异过大时需要另录。
- **`optional` 步骤**：没有"这一步失败了就跳过并记 skipped"的语义，
  只能用 `onFail` 跳转手工表达。
