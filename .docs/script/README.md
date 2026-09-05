# 仓库维护脚本

这里只存放构建、检查和项目生成脚本，AutoJs6 产品代码统一放在 `src/`。

| 脚本 | 用途 | 调用方式 |
|---|---|---|
| `build-autojs-bundles.js` | 递归打包入口与 CommonJS 依赖 | `npm run build` |
| `check-autojs-project.js` | 检查 JS 语法、配置和任务登记 | `npm run check` |
| `build-autojs-project.js` | 组装 AutoJs6 项目目录，供打包成独立 APK | `npm run project` |
| `package-apk.ps1` | 生成项目、推送、等待手机打包并自动安装 | 见 `.docs/PACKAGING.md` |
| `collect-logs.ps1` | 拉回设备上最近几次运行的日志、结果与截图 | `.\.docs\script\collect-logs.ps1 -Device <地址>` |
| `create-game-project.js` | 创建下一款游戏的干净项目 | 见下方示例 |
| `commit-push.ps1` | 提交全部改动并推送当前分支 | `.\.docs\script\commit-push.ps1 "feat: xxx"` |
| `run-task.ps1` | 在设备上跑默认任务并取回结果 | 见下方说明 |

## 在设备上跑任务（开发调试用）

```powershell
.\.docs\script\run-task.ps1 -Device <设备地址> -ColdStart
```

一条命令完成：检查 -> 构建 -> 推送 -> 强杀游戏 -> 拉起 AutoJs6 -> 自动确认截图授权
-> 等待结束 -> 取回产出 -> 打印步骤摘要。产出落在 `dist/runs/<任务ID>/<运行ID>/`，
`dist/` 已被 `.gitignore` 排除。

脚本、素材与用例会推到设备的 `/sdcard/dsom-macro-<项目ID>/` 下同一目录，
因为配置里 `assetsRoot` 是相对路径 `./assets`，用例也按 `files.path("cases/...")` 加载，
这与打包成 APK 后的形态一致。

常用参数：

| 参数 | 说明 |
|---|---|
| `-Device` | 必填。设备地址，如 `192.168.1.10:5555`。按仓库规则，云机地址禁止写进任何提交文件，因此不设默认值 |
| `-ColdStart` | 先强杀游戏，用于测试冷启动路径 |
| `-PushAssets` | 同时推送 `src/assets` 与 `src/cases`，改过素材或用例 JSON 后必须加 |
| `-SkipBuild` | 跳过检查与构建，直接用现有 `dist/main-autojs.js` |
| `-TimeoutSeconds` | 等待任务结束的上限，默认 300 |
| `-GrantTapX/-GrantTapY` | 截图授权弹窗「立即开始」的坐标，默认 566,844（720x1280 竖屏） |

要换任务，改 `src/config/game-config-autojs.js` 的 `defaultTask` 后重新运行。
任务失败时脚本以退出码 1 结束，并打印失败原因，失败截图随产出一起取回。

**改了 JSON 用例就必须带 `-PushAssets`。** `npm run check` 不校验用例文件，
用例的错误只有在设备上跑到那一步才会暴露，见 `.docs/CASE-MVP.md`。

**这是开发调试路径。** 正式形态是打包成独立 APK 在手机上自己跑，见 `.docs/PACKAGING.md`。

## 创建新游戏项目

```powershell
node .\.docs\script\create-game-project.js `
  --target F:\Git\AI\dsom-macro-new-game `
  --id new-game `
  --name "新游戏" `
  --package com.company.game
```

先用 `--dry-run` 可以只校验参数与目标路径，不创建文件。

生成器只复制白名单中的通用文件，不会复制当前游戏新增的业务任务和素材。
