# dsom-macro-template

公司 Android 游戏 AutoJs6 自动化项目模板。

每款游戏通过生成器创建独立项目，共享截图、找图、OCR、动作、步骤编排、日志、失败留证和单文件打包能力，不复制其他游戏的业务任务与素材。

## 创建游戏项目

```powershell
node .\.docs\script\create-game-project.js `
  --target F:\Git\AI\dsom-macro-new-game `
  --id new-game `
  --name "新游戏" `
  --package com.company.game
```

进入生成的项目后执行：

```powershell
npm run check
npm run build
```

接入步骤见 [src/README.md](./src/README.md)，模板边界见 [.docs/PROJECT.md](./.docs/PROJECT.md)。
