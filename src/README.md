# AutoJs6 项目代码

本目录分为通用能力与游戏实现两层：

```text
src/
├─ config/                 游戏级配置
├─ core/                   通用运行时，禁止写具体游戏页面逻辑
├─ entry/                  AutoJs6 执行入口
├─ tasks/                  当前游戏的独立业务任务
├─ assets/                 找图模板及素材说明
└─ task-registry-autojs.js 任务登记表
```

## 首次接入

1. 修改 `config/game-config-autojs.js` 的项目名、游戏包名和屏幕配置。
2. 执行 `node .\.docs\script\build-autojs-bundles.js`。
3. 在 AutoJs6 中运行 `dist/main-autojs.js`，默认执行安全的环境检查。
4. 将 `defaultTask` 改为 `launch-game-check`，验证游戏可以启动并截图。
5. 复制 `tasks/_task-template-autojs.js` 开发首个业务任务，并登记到任务表。

## 任务约束

- 每个任务只负责一条完整业务流程，不向已有任务叠加无关功能。
- 页面状态未知时立即失败，不尝试盲点返回或连续点击。
- 坐标、颜色阈值和模板路径放在具体任务中。
- 三个以上任务稳定复用的能力才抽取到 `core/`。
- 任务失败由运行时统一保存日志、结果和截图。
