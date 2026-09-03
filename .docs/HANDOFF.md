# 迭代交接 - HANDOFF.md

## 下次启动，第一件事

```text
先修复 OCR 接口与失败步骤留存；配置 Git 提交者身份后创建首次基线提交。
```

## 当前状态

**活跃分支**：`main`（尚未首次提交）  
**最近一次 release / tag**：尚未发版  
**进行中**：`dsom-macro-template` 通用模板已建立并通过本地检查。

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
