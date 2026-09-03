# 迭代交接 - HANDOFF.md

## 下次启动，第一件事

```text
先修复 OCR 接口与失败步骤留存；配置 Git 提交者身份后创建首次基线提交。
```

## 当前状态

**活跃分支**：`main`（尚未首次提交）  
**最近一次 release / tag**：尚未发版  
**进行中**：`dsom-macro-template` 通用模板已建立并通过本地检查。

## Iteration 1 - 通用项目模板

**日期**：2026-07-25  
**状态**：完成

完成内容：

- 建立配置、运行时、截图、找图、OCR、动作、流程、任务和入口分层。
- 增加环境检查、游戏启动检查和业务任务模板。
- 增加递归单文件打包、静态检查和新游戏项目生成脚本。
- 生成器只复制通用白名单，不复制模板仓库后续可能出现的业务任务。

已知遗留：

- 尚未从模板生成并实机验证第一个真实游戏项目。

## Iteration 2 - 可回放用例结构

**日期**：2026-09-02
**状态**：草案待实机验证

完成内容：

- 新增 `src/core/case/case-schema-autojs.js`：用例结构定义、上限、默认值和不依赖运行环境的校验。
- 新增 `src/core/case/case-geometry-autojs.js`：归一化坐标与设备像素互转，支持 fit / stretch 两种策略。
- 新增 `.docs/CASE-SCHEMA.md` 作为录制器、回放器和报告三方的唯一契约。
- 已在 Node 侧验证校验与换算：4 组分辨率换算正确，异宽高比正确触发人工确认，越界坐标被拦截。

已知遗留：

- 尚无录制器和回放器，用例结构还没有经过真实用例的检验。
- `src/assets/` 的 PNG 不进单文件打包，素材分发方式待定。

## Iteration 3 - 首轮实机验证暴露的通用层问题

**日期**：2026-09-02
**状态**：两处已修，一处待设计

在 rxfs（神龙云机，Android 10，游戏强制横屏）上首次实机运行，通用层被打出三个问题：

- **已修** `screen-autojs.js`：原来无条件 `requestScreenCapture(!!landscape)`。在强制横屏设备上传 `true`
  会拿到 720x1280 竖屏画布，把横屏画面等比压成 720x405 的黑边窄带，与点击坐标空间不一致，
  且失配是静默的。改为默认不传参，并在首次截图时断言截图尺寸与 `device` 一致，不一致立即抛错。
- **已修** `runtime-autojs.js`：`getErrorDetail` 优先取 `error.stack`，但 Rhino 的 stack 不含消息，
  导致报告里只剩一串行号、失败原因丢失。改为消息与堆栈一起保留。
- **待设计** `actions-autojs.js` 的 `launchPackageAndWait` 依赖 `currentPackage()`。
  云机 ROM 会屏蔽该查询（恒返回 `com.android.systemui`，`currentActivity()` 返回权限拒绝记录），
  等待前台的能力在这类设备上完全失效。需要给"等待目标应用前台"提供画面锚点兜底，
  与 CASE-SCHEMA 的 anchor 优先设计对齐。

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

## Next Action
- 解决无人值守的最后一环：截图授权每次都要确认，需要常驻脚本在进程内循环而非反复拉起。
