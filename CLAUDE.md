# AI 协作 - CLAUDE.md

本文件与 `AGENTS.md` 保持同一项目约定。

这是公司 Android 游戏 AutoJs6 自动化项目模板。生成的游戏项目把产品代码放在 `src/`，通用运行时与游戏任务严格分层；核心流程不依赖 ADB。

开发前阅读 `AGENTS.md`，按需查阅：

- `.docs/PROJECT.md`：项目定位与复用方式
- `.docs/RULES.md`：代码和任务边界
- `.docs/CASE-SCHEMA.md`：可回放用例的数据结构契约
- `.docs/PACKAGING.md`：打包成独立 APK 的流程与实测结论
- `.docs/HANDOFF.md`：当前进度与下一步
- `src/README.md`：AutoJs6 接入步骤

常用命令：

```powershell
npm run check
npm run build
```

会话结束更新 `.docs/HANDOFF.md` 的 next action。
