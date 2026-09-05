# 用例结构 - CASE-SCHEMA.md

> **状态：设计稿，未实现。写用例请看 `CASE-MVP.md`。**
>
> 本文档描述的 `steps` + `expect` / `action` / `verify` 三段式结构，只有校验器
> （`case-schema-autojs.js`）和坐标换算（`case-geometry-autojs.js`），**没有执行器**，
> 也没有任何代码引用这两个文件。
>
> 实际跑着的是另一套 `nodes` 节点图结构，由 `case-runner-autojs.js` 实现，
> 契约写在 `CASE-MVP.md`。两者字段完全不同却共用 `schemaVersion: 1`，
> 这是历史遗留问题——本文档的结构真要落地时，必须先把版本号分开。
>
> 保留本文档是因为其中三条设计决定（归一化坐标 + 基线分辨率、锚点优先坐标兜底、
> `broken` 与 `failed` 分离）仍然是 MVP 要补的方向，见 `CASE-MVP.md` 的「已知缺口」。

## 定位

用例（case）是一段可序列化、可回放的操作序列，是录制器、回放器和报告三方唯一的契约。任何一方改动字段都必须先改本文档并递增 `schemaVersion`。

实现在 `src/core/case/`：

- `case-schema-autojs.js`：版本号、上限、默认值、`validate` / `assertValid` / `createSkeleton`。
- `case-geometry-autojs.js`：归一化坐标与设备像素互转。

两个文件都不引用 `device`、`images` 等 AutoJs6 全局对象，所以 PC 侧录制器（Node）和设备侧回放器（AutoJs6）可以共用同一份校验，不会出现两边判定不一致。

## 三条设计决定

**1. 坐标一律归一化，用例自带基线分辨率。**
所有点和区域用 `rx` / `ry` / `rw` / `rh`（0 到 1）存储，`baseline` 记录录制时的像素分辨率。回放时 `createViewport(baseline, device.width, device.height)` 换算成当前设备像素。这是"一次录制、多端回放"的前提；直接存绝对坐标的用例只能在同分辨率同机型上跑。

`scaleStrategy` 两种：

- `fit`（默认）：等比缩放并居中，内容区之外留边。宽高比不同的端用它最稳。
- `stretch`：横纵独立拉伸。仅在确认游戏画面本身会被拉伸时使用。

宽高比差异超过 5% 时 `needsAspectReview(viewport)` 返回 true，回放器应当记录告警——此时任何换算策略都不完全可信。

**2. 锚点优先，坐标兜底。**
每一步优先用画面特征定位（找图 / OCR / 像素），坐标只作为没有可用特征时的退路。`validate` 会对"纯坐标点击且没有 `expect` 锚点"发出警告，不拦截，但录制器和报告应当把它显示出来——这类步骤是跨端失败的主要来源。

**3. 每一步是 `expect` → `action` → `verify` 三段式。**
动作前确认进入状态，动作后确认目标状态。这把 `RULES.md` 里"动作前识别页面、动作后验证状态"从约定变成了结构约束：没有 `verify` 的步骤失败时，无法区分是这一步没生效还是后面某一步的问题。

## 示例

```json
{
  "schemaVersion": 1,
  "id": "rxfs-daily-signin",
  "name": "每日签到",
  "tags": ["smoke", "daily"],
  "baseline": { "width": 1080, "height": 2400, "orientation": "portrait", "scaleStrategy": "fit" },
  "recording": {
    "recordedAt": "2026-09-02T02:00:00.000Z",
    "recorderVersion": "0.1.0",
    "device": { "brand": "Xiaomi", "model": "M2102K1C", "sdkInt": 33 },
    "appVersion": "1.2.3"
  },
  "requirements": {
    "packageName": "com.company.rxfs",
    "launchGame": true,
    "requiresCapture": true,
    "maxDurationMs": 300000
  },
  "steps": [
    {
      "id": "wait-home",
      "name": "等待主界面",
      "expect": {
        "anchor": {
          "type": "all",
          "anchors": [
            { "type": "template", "asset": "home/home-marker.png", "threshold": 0.85,
              "region": { "rx": 0, "ry": 0.8, "rw": 1, "rh": 0.2 } },
            { "type": "text", "text": "主城", "mode": "contains",
              "region": { "rx": 0, "ry": 0.8, "rw": 1, "rh": 0.2 } }
          ]
        },
        "timeoutMs": 20000,
        "pollIntervalMs": 500
      },
      "action": { "type": "check" },
      "retryCount": 1
    },
    {
      "id": "tap-signin",
      "name": "点击签到按钮",
      "expect": {
        "anchor": { "type": "template", "asset": "signin/entry-button.png", "threshold": 0.88 },
        "timeoutMs": 10000
      },
      "action": { "type": "tap", "target": "anchor", "offset": { "rx": 0, "ry": 0.02 }, "waitMs": 800 },
      "verify": {
        "anchor": { "type": "text", "text": "签到成功",
          "region": { "rx": 0.1, "ry": 0.4, "rw": 0.8, "rh": 0.2 } },
        "timeoutMs": 8000
      },
      "retryCount": 1,
      "retryDelayMs": 1000
    }
  ]
}
```

## 字段

**顶层**：`schemaVersion` `id`（小写字母数字连字符）`name` `tags?` `baseline` `recording?` `requirements` `steps`。

`requirements.maxDurationMs` 必填且有上限，用例必须能被强制中止；`launchGame` 不为 `false` 时 `packageName` 必填。

**步骤**：`id` `name` `expect?` `action` `verify?` `retryCount?` `retryDelayMs?` `optional?`。
`optional: true` 表示这一步失败记 `skipped` 并继续，用于奖励弹窗一类不稳定出现的界面。

**锚点** `anchor.type`：

| 类型 | 关键字段 |
|---|---|
| `template` | `asset`（相对 `src/assets` 的路径）、`threshold`、`region?` |
| `text` | `text`、`mode`（`contains` / `equals`）、`language?`、`region?` |
| `pixel` | `point`、`rgb`（三元数组）、`tolerance?` |
| `all` / `any` | `anchors`（最多 8 个，最多嵌套 2 层） |

`region` 限定搜索范围，能明显提升找图和 OCR 的稳定性与速度，建议尽量填。

**动作** `action.type`：

| 类型 | 关键字段 |
|---|---|
| `tap` | `target`（`anchor` / `point`）、`point`（target 为 point 时必填）、`offset?` |
| `swipe` | `from`、`to`、`durationMs` |
| `wait` | `durationMs` |
| `key` | `name`（`back` / `home`） |
| `check` | 无，仅用 `expect` 做断言 |

`offset` 允许负值，用于从锚点位置向左或向上取实际点击点。

## 回放判定

步骤取 `passed` / `failed` / `skipped`；用例取 `passed` / `failed` / `broken`。

`broken` 表示环境或前置问题（截图权限没给、游戏起不来、宽高比不匹配、模板素材缺失），不是业务缺陷。报告必须把 `broken` 和 `failed` 分开统计——混在一起会让通过率失去意义，也会让人不再相信这份报告。

## 校验

```js
var schema = require("./core/case/case-schema-autojs.js");

var result = schema.validate(caseDocument);  // { valid, errors, warnings }
schema.assertValid(caseDocument);            // 非法时抛出，含全部错误
```

`validate` 一次返回全部问题而不是遇到第一个就停，便于录制器一次性提示人工修正。`LIMITS` 里的上限（最多 300 步、单次等待 60 秒、用例总时长 30 分钟、重试 5 次）由通用层强制，避免自动执行的用例让设备空转或反复误点。

## v1 未覆盖

以下留到后续版本，避免 v1 结构过度设计：

- 步骤间的分支和循环（当前只有顺序执行 + `optional` 跳过）。
- 用例之间的引用与复用（如公共前置登录流程）。
- 数据驱动（同一用例跑多组参数）。
- 模板素材的多分辨率变体；当前一套素材配一个基线，跨端差异过大时需要另录一份用例。
- 素材分发：`build-autojs-bundles.js` 只打包 JS，`src/assets/` 下的 PNG 需要另行推送到设备，回放器要能在素材缺失时判定 `broken` 而不是 `failed`。
