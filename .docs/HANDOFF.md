# 迭代交接 - HANDOFF.md

## 下次启动，第一件事

```text
2026-09-30 从 rxfs 回流了「回放与录制内核」，但**界面层还是老的**（见下）。
下一件要么是补完界面层回流（B 轮：launcher / runtime / 三个浮层 / 任务列表），
要么等真要接第二个游戏时再动——那时才知道那个游戏的界面该长什么样。

回流完这一轮之后，模板与 rxfs 的 src/core 还差 8 个文件（见下方清单）。
```

## 2026-09-30 回流自 rxfs：回放与录制内核（A 轮）

rxfs 侧已发版 v0.12.0 并由项目所有者实机验收通过，按规矩才回流。
**只回流了跟游戏无关、且不依赖 launcher 的那部分。**

**进来了**（更新 6 个 + 新增 5 个）：

| 文件 | 带进来什么 |
|---|---|
| `case/case-runner-autojs.js` | 节点类型加 `longTap` / `swipe`，含时长与终点的边界校验 |
| `case/recorded-case-autojs.js` | 手势节点的生成与还原、整道滑动平移、`nextNodeId`、默认名带动作词 |
| `recorder-autojs.js` | 按「按下到抬手」判动作（点击 / 长按 / 滑动）、转发跟着动作走、补录单个动作 `captureOneGesture`、截图按节点 id 取名 |
| `actions-autojs.js` | `longPress` 新增；`drag` 补上与 `tap` 同一道护栏（悬浮层让开、红十字、扣等待） |
| `run-control-autojs.js` | `sleepInterruptibly`（长循环要能被中断） |
| `screen-autojs.js` | 截图前让开已登记的悬浮层 |
| **新增** `ui-thread-autojs.js` | 从工作线程派事给界面线程并等它做完 |
| **新增** `screen-overlays-autojs.js` | 悬浮层登记表：截图/点击前统一让开 |
| **新增** `tap-marker-autojs.js` | 点击红十字（注入的点击在屏幕上看不见） |
| **新增** `point-picker-autojs.js` | 在真实画面上拖十字取一个点 |
| **新增** `region-picker-autojs.js` | 在真实画面上框一块区域 |

`create-game-project.js` 的拷贝清单已同步补上这 5 个新文件，并**实际生成了一个项目
验过 check 与 build**（这份清单漏文件的后果是新项目跑到那句 require 才炸，
而模板自己一切正常——`menu-autojs.js` 那次就是这么发现的）。

**故意没进来**（都强依赖 launcher，没有它们只是死代码）：

```text
launcher-autojs.js       rxfs 已长到 3742 行，游戏语义与通用界面混着，要拆
runtime-autojs.js        前置补跑、截图会话那一套
recorded-task-autojs.js  recorded:<会话 id> 的解析与任务包装
task-store / task-group-store / task-group    任务列表与组合任务
step-overlay / run-overlay / pick-overlay     游戏内编辑层、运行待命层、切任务浮层
app-version-autojs.js    版本可见机制（还要配两个构建脚本）
resident / schedule-store / permissions       只差几行到几十行
```

`point-picker` 与 `region-picker` 进来了但**当前没有调用方**，所以不会进 bundle
（bundler 按 require 走）。它们是给 B 轮的 launcher 准备的现货。

**注意一处行为变化**：新录制器起手是**待命态**（浮出「▶ 开始录制」，人点一下才开始记），
而模板这套老 launcher 的文案可能还按「点了就开始录」写。B 轮一并改。

**验到哪儿**：`npm run check` / `npm run build` 过；生成一个新项目后它自己的
check / build 也过；rxfs 那两个纯数据探针（用例校验、类型互转、插入重排、
识别边界）指向模板这份内核跑，同样全过。**模板侧没有实机验证**——
真机证据全部来自 rxfs v0.12.0。

## 当前状态

**开发分支**：`test`　**稳定分支**：`main`（不直接提交，由 `test` 验证通过后合入）  
**最近一次 release / tag**：`v0.3.0`（2026-09-30，回流 rxfs v0.12.0 的回放与录制内核），已推送到 origin  
（这一行以前写着 `v0.1.0`，而 `main` 上早已是 `v0.2.0` —— 发版时顺手改它，
`package.json` 的 `version` 也跟着走，别再留一个说不清版本的仓库）  
**进行中**：通用模板六轮迭代完成，JSON 用例引擎已回流，打包成独立 APK 的链路已通。
**2026-09-15 回流自 rxfs**：录制器框锚点 / 生成用例 / 回放（`case/recorded-case-autojs.js`、
用例 `assetBase: "case"`），以及切前台修复（`foreground-autojs.js`：UI 模式下
`app.launchPackage` 切回自己会销毁脚本页）。均在 rxfs 实机跑通，见 `RECORDER.md`。

**2026-09-16 回流自 rxfs**（调度增补层与 `recorded:` 解析当天已在 rxfs 上
**开发路径与独立 APK 双双实机验证通过**）：

- **用例结构双轨用 `model` 判别符分开**：`nodes`（已实现）与 `steps`（设计稿）
  各有独立版本号空间，`model` 缺省按 `nodes` 解释，旧用例不用改。
- **设备侧调度增补层**：`core/schedule-store-autojs.js` + `core/recorded-task-autojs.js`。
  调度表 = 代码基表 + `<outputRoot>/schedule/overlay.json`，调度项可写
  `taskId: "recorded:<会话 id>"`，让设备上录的用例不重新打包也能进常驻。见 `RESIDENT.md`。
- `resident` 取不到任务时区分「没登记」（抛）与 `broken`（跳过并警告）。
- `runtime` 清洗任务 id 里不能做目录名的字符——冒号在 Windows 上建不了文件，
  `adb pull` 会静默取不回结果。
- `npm run check` 新增调度表静态校验。
- **`create-game-project.js` 的拷贝清单补上 `src/entry/menu-autojs.js`**：入口拆成
  auto + ui 时漏了，此前生成出来的新项目会没有菜单界面、`npm run build` 直接失败。
  已实际生成一个项目验证 check / build 均通过。

注意：本文件下方的「下次启动」与 Next Action 已过期，以工作区 `.docs/HANDOFF.md` 为准。

## Iteration 4 - 第一条真实用例逼出的五处通用层修复

**日期**：2026-09-02
**状态**：已修，随 rxfs 登录用例全流程实机通过

在 rxfs 上手写并跑通第一条完整用例（9 步登录，53 秒全绿）的过程中，通用层被打出五个问题：

- **`screen.findTemplate` 只返回匹配区域左上角。** 直接拿去点击会落在按钮边缘，
  相邻控件靠得近时会点中隔壁（rxfs 角色选择页「删除人物」就在「开始」正下方 85 像素）。
  改为同时返回宽高与中心点。
- **小模板在默认金字塔匹配下必定失效。** AutoJs6 默认用图像金字塔加速，小模板在粗层被
  weakThreshold 剪枝，表现为任何阈值都匹配不到——连从截图自身裁下的图块都找不回来
  （70x70 必现，300x100 正常）。现在模板短边小于 120 像素时自动降为 `level: 1`。
- **`click()` 的点击会丢。** 手势时长极短，H5 与自绘界面约一半收不到，现象是
  "坐标正确、日志显示已点击、界面无反应"。改用 `press()` 并可配置 `tapDurationMs`。
- **权限申请与应用启动的顺序需要可配置。** 有的应用在启动那一刻检测录屏，发现就自行退出
  （囧游村盒子实测：冷启动时开着录屏必死于约 10 秒后；已在运行的则完全不受影响）。
  新增 `task.captureAfterLaunch` 与 `runtime.launchSettleMs`，支持先启动、后授权。
- **`launchPackageAndWait` 让不可靠的包名判断抢先返回。** 屏蔽包名查询的 ROM 会给出假阳性
  （应用没起来就报已在前台）。改为：任务提供了 `confirmForeground` 时以画面判断为准。

## Iteration 5 - 打包成独立 APK

**日期**：2026-09-03
**状态**：全链路实测通过

目标形态确认为：脚本作为独立 APK 跑在手机上，不依赖 AutoJs6 也不依赖 PC，
PC 只用于开发调试。为此新增：

- `src/core/runtime` 增加 `context.assetPath`，素材路径支持相对模式。
  配置统一改为 `assetsRoot: "./assets"`，开发时脚本与素材同目录，打包后同样同级，
  两种形态用同一份配置。绝对路径在打包后必然找不到素材。
- 新增 `.docs/script/build-autojs-project.js` 与 `npm run project`，
  生成 `dist/project/`（main.js + assets/ + project.json）。
- 新增 `.docs/PACKAGING.md` 记录实测得到的 `project.json` 真实字段。
  重点：支持库由 `libs` 控制且**必须含 OpenCV**，否则找图静默失效；
  VSCode 插件模板里的 `optimization.removeOpenCv` 并非真实字段。

实测结果：生成的项目被 AutoJs6 识别为项目，打包界面自动读取全部配置并预勾 OpenCV
与 arm64-v8a，产出 41.9 MB 的 APK，安装后独立运行登录用例，9 步全绿。

## Iteration 6 - 独立 APK 的截图授权时序

**日期**：2026-09-03
**状态**：已修并实测通过

打包成 APK 后点图标启动会失败于 `Start activity to request screen capture timeout (5000ms)`。
原因是脚本启动后立刻拉起目标应用，目标应用抢到前台、自身退到后台，
而 Android 不允许后台应用拉起权限窗口；弹窗常在超时之后才显示，看着像卡死。

运行时现在会在申请前把自身切回前台（`context.getPackageName()` + `app.launchPackage`），
等 `runtime.foregroundSettleMs` 后再申请，失败重试 `runtime.capturePermissionAttempts` 次，
授权后把目标应用拉回前台（进程还在，不会重新触发其启动期检测）。

实测 `foregroundSettleMs` 需要 6 秒，3 秒不够——拉起权限窗口的耗时正好卡在
AutoJs6 内部 5 秒硬超时的边缘。修正后点图标启动，9 步全绿，66 秒。

同时新增 `collect-logs.ps1`：一条命令拉回设备上最近几次运行的日志、结果与截图。

## Next Action

**做「常驻脚本 + 进程内定时循环」。** 这是无人值守的最后一环。

截图授权在 Android 10 无法记住，但它是**按会话**的：只要脚本进程不退出、
MediaProjection 会话不释放就一直有效。所以方向不是免授权，而是不再反复拉起脚本——
开机自启后授权一次，然后常驻循环、到点自己触发用例。

需要设计：常驻入口（循环须有明确上限）、进程内调度、跨运行的结果累积、
以及 `launchConfig.runOnBoot` 在云机重启后权限是否保留的实测验证。

这件事与「日常任务/定时活动是否刷新」是同一个问题：都需要按时间触发并跨天对比。
