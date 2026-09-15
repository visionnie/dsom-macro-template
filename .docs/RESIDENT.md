# 常驻调度 - RESIDENT.md

## 要解决的问题

截图授权（MediaProjection）在 Android 10 无法记住，**每次启动脚本都要人工确认一次**。
前台服务、打包成 APK 都解决不了。

但授权是**按会话**的：只要脚本进程不退出、MediaProjection 会话不释放，就一直有效。
所以方向不是"想办法免授权"，而是**别反复拉起脚本**：

```text
现在：每跑一条用例 = 拉起脚本 -> 授权一次 -> 跑完退出      ← 每次都要人点
目标：开机自启 -> 授权一次 -> 常驻循环 -> 到点自己跑用例    ← 只在开机后点一次
```

`resident-runner` 就是那个不退出的进程。**开机自启这一半 2026-09-16 已真机验证通过**。

## 入口：带倒计时的菜单

打开应用**先出菜单，不立即执行**——点图标直接开跑的话，想换任务、想看上次结果、
想录新用例，都得回 PC 改配置重新打包。

但菜单和无人值守是打架的：开机自启后没人点菜单，常驻就永远起不来。
解法是**倒计时**：菜单显示出来，`config.launcher.autoStartSeconds` 秒无人操作
就自动进入 `autoStartTask`（默认 `resident-runner`）；人在设备前时任何一次点击都取消它。
设为 `0` 表示永不自动进入，开发调试时用。倒计时**只在第一次显示菜单时**触发，
任务跑完回到菜单不会再倒计时。

菜单四项：开始常驻调度 / 任务列表 / 录制用例 / 运行记录。
实现在 `src/core/launcher-autojs.js`。入口拆成两个：`src/entry/main-autojs.js` 是 `"auto"` 模式，
只负责分派（有 `task.txt` 直接跑任务，否则在主线程拉起菜单）；菜单是 `src/entry/menu-autojs.js`（`"ui"`）。
**别把入口改回 `"ui"`**——那样开机自启会静默失败，原因见 `main-autojs.js` 文件头。

**开发路径不走菜单。** `run-task.ps1 -Task <id>` 会在脚本同级写一个 `task.txt`，
入口见到它就无界面直接跑那个任务并产出 `result.json`，不弹菜单挡在中间。
打包成 APK 后包内没有这个文件，于是正常进菜单——两种形态共用同一份入口。

```powershell
.\.docs\script\run-task.ps1 -Device <设备地址> -Task resident-runner
```

打包时配合 `package-apk.ps1 -RunOnBoot`，开机自启 → 菜单倒计时 → 常驻，
中间只需要人点一次截图授权。

## 分工

| 文件 | 职责 |
|---|---|
| `src/entry/main-autojs.js` | 无界面入口，分派到任务或菜单 |
| `src/core/launcher-autojs.js` | 菜单界面与倒计时。**不含任何游戏语义** |
| `src/core/resident-autojs.js` | 循环、判定、结果累积。**不含任何游戏语义** |
| `src/config/schedule-autojs.js` | 跑什么、什么时候跑。游戏相关的编排都在这里 |
| `src/tasks/resident-runner-autojs.js` | 薄入口，把上面两个接起来 |

界面上的任务必须跑在工作线程（`threads.start`）：任务里全是 `sleep` 和阻塞轮询，
放在 UI 线程会直接卡死界面，连"正在运行"几个字都刷不出来。
工作线程要更新界面得回到 `ui.run()` 里。

## 调度表字段

```js
module.exports = {
  tickIntervalMs: 60000,                  // 每隔多久检查一次
  maxDurationMs: 12 * 60 * 60 * 1000,     // 常驻最长跑多久
  maxIterations: 2000,                    // 最多检查多少轮
  maxConsecutiveFailures: 5,              // 连续失败多少次就退出

  entries: [
    {
      id: "boss-feast-layer3",            // 调度项标识，用于结果汇总分组
      taskId: "case-boss-feast-layer3",   // 要执行的任务，必须已登记
      window: { from: "12:00", to: "24:00" },  // 可选，支持跨零点
      maxRunsPerDay: 2,                   // 可选，默认 1
      minIntervalMs: 3600000,             // 可选，两次运行的最小间隔
      requires: ["login-rxfs"]            // 可选，前置任务
    }
  ]
};
```

三个上限是硬要求，不是建议。`RULES.md` 要求所有业务循环有明确上限——
一个整夜空转、还不停乱点的脚本比不跑更糟。

## 前置依赖：为什么是「失败后才补跑」

直觉做法是每次先跑登录再跑业务。**这是错的。**

以 rxfs 为例，`login-rxfs` 的第一步是「确认盒子首页」。游戏已经在主城时跑它必然失败——
它期望的起点根本不在那儿。每次先跑登录，等于在一切正常时主动制造一次失败。

所以策略是：

1. 直接跑业务任务
2. 失败了，才按 `requires` 补跑前置
3. 补完**只重试一次**

这样「会话掉了」能自愈，「一切正常」不会白跑。重试有界，不会连环重试。

## 结果累积

单次 `result.json` 回答不了"今天日常刷没刷、昨天是否正常"。
常驻按天写一份汇总：

```text
<outputRoot>/resident/YYYY-MM-DD.json
```

```json
{
  "date": "2026-09-11",
  "entries": {
    "boss-feast-layer3": {
      "runs": 2, "passed": 1, "failed": 0, "broken": 1,
      "lastRunAt": 1789055832047,
      "history": [
        { "startedAt": "...", "status": "passed", "durationMs": 47440 },
        { "startedAt": "...", "status": "broken", "error": "截图权限未授予" }
      ]
    }
  }
}
```

进程重启后会读回同一天的文件继续累加，所以「今天跑了几次」不会因为重启而丢。
汇总文件损坏时会重建一份并在 `recoveredFrom` 里留下原因，而不是让循环崩掉。

`passed` / `failed` / `broken` 三者分开计数：`broken` 是环境问题（权限没给、
游戏起不来、素材缺失、屏幕方向不对），不是业务缺陷。混在一起统计通过率就没意义了。

## 退出条件

四个，任一满足就退出：

| 条件 | 含义 |
|---|---|
| `maxDurationMs` | 跑够时长，主动退出 |
| `maxIterations` | 检查够轮次 |
| `maxConsecutiveFailures` | 连续失败到上限——环境已经坏了，继续跑只是乱点 |
| 进程被系统杀死 | 见下方未解决 |

## 尚未解决

- **开机后仍要人点一次截图授权**。Android 10 平台限制，常驻已把它压到每次开机一次。
  授权申请失败会重试 `runtime.capturePermissionAttempts` 次，人晚点也来得及。
- **游戏被系统回收后无法自愈到已知状态**。当前唯一可靠的入口是从盒子首页冷启动，
  而脚本自己没有强杀游戏的能力。前置补跑只能覆盖「游戏还活着但界面跑偏」的情况。
- **脚本自身崩溃后不会自恢复**。进程被杀后会被无障碍服务拉回，但脚本不会跟着起来；
  目前只能靠重启设备走开机自启。
