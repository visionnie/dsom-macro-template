# AI 协作 - AGENTS.md

> 启动时只读本文件，其他文档按需查阅。

## 项目

这是公司 Android 游戏 AutoJs6 自动化项目模板。每个游戏从本模板创建独立仓库，共享同一套项目骨架和通用运行时。

目标：通过截图、找图、OCR、坐标和手势完成可重复测试；失败时保留步骤、日志、截图和耗时。真机、模拟器、云机都要考虑，核心能力不能依赖 ADB。

## 行为风格

- 任务明确时直接执行，改动前先说明改什么、为什么。
- 注释统一中文，先保结构再填实现。
- 同类仓库维护操作重复 3 次以上，固化到 `.docs/script/`。
- 页面状态未知时立即失败，禁止盲点。

## 硬性规则

- AutoJs6 产品代码放在 `src/`，仓库维护脚本放在 `.docs/script/`。
- `src/core/` 禁止包含具体游戏页面、坐标和业务逻辑。
- 每个业务流程放进独立任务并登记到任务表。
- 坐标、颜色阈值、模板路径属于任务配置，禁止写入通用层。
- 禁止硬编码密钥、账号、设备口令和云机地址。
- 业务定时器写在程序内部，除非用户明确要求，禁止创建 Codex 定时任务。
- HANDOFF / RULES / PROJECT 任一超过 4000 字符时精简或归档。

## 当前阶段

通用 AutoJs6 模板已建立；下一步用生成器创建第一个游戏项目并做设备验证。

## 常用命令

```powershell
npm run check
npm run build
node .\.docs\script\create-game-project.js --target F:\Git\AI\dsom-macro-new-game --id new-game --name "新游戏" --package com.company.game
```

## 会话末尾

更新 `.docs/HANDOFF.md` 的 next action（一句话）。
