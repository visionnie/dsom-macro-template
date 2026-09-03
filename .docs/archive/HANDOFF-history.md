# 迭代历史

本文件保存已从 HANDOFF.md 移出的历史迭代，按时间正序。

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
