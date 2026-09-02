# 仓库维护脚本

这里只存放构建、检查和项目生成脚本，AutoJs6 产品代码统一放在 `src/`。

| 脚本 | 用途 | 调用方式 |
|---|---|---|
| `build-autojs-bundles.js` | 递归打包入口与 CommonJS 依赖 | `npm run build` |
| `check-autojs-project.js` | 检查 JS 语法、配置和任务登记 | `npm run check` |
| `create-game-project.js` | 创建下一款游戏的干净项目 | 见下方示例 |
| `commit-push.ps1` | 提交全部改动并推送当前分支 | `.\.docs\script\commit-push.ps1 "feat: xxx"` |

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
