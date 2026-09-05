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
- 在 `test` 分支开发；合并到 `main` 必须由项目所有者明确要求，AI 不得自行发起。

## 当前阶段

通用运行时已被真实用例实机打磨六轮，打包成独立 APK 的链路已打通。
JSON 用例引擎（`case-runner`）MVP 可用，已随 rxfs 的 BOSS 用例验证并回流。

下一步是「常驻脚本 + 进程内定时循环」，解决截图授权每次要人工点的问题——
这是无人值守的最后一环。详见 `.docs/HANDOFF.md`。

## 上手必读

| 文档 | 什么时候看 |
|---|---|
| `.docs/CASE-MVP.md` | **写或改 JSON 用例前必读**，这是唯一实现了的用例格式 |
| `.docs/CASE-SCHEMA.md` | 设计稿，**未实现**，别照着写用例 |
| `.docs/PACKAGING.md` | 打包成 APK，含实测踩过的坑 |
| `.docs/RECORDER-RESEARCH.md` | 录制器的设计来源与 MVP 边界 |
| `.docs/RULES.md` | 代码、用例、分支的硬边界 |
| `.docs/HANDOFF.md` | 当前进度与下一步 |

## 常用命令

```powershell
npm run check
npm run build
node .\.docs\script\create-game-project.js --target F:\Git\AI\dsom-macro-new-game --id new-game --name "新游戏" --package com.company.game
```

## 会话末尾

更新 `.docs/HANDOFF.md` 的 next action（一句话）。
