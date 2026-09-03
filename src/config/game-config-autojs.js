// =====================================================================
// 游戏配置：新项目首先修改本文件，禁止填写账号、口令和设备连接信息
// 坐标与页面阈值应放进具体任务，避免无关任务共享易变配置
// =====================================================================

module.exports = {
  project: {
    id: "template",
    name: "DSOM Macro Template"
  },
  game: {
    packageName: ""
  },
  outputRoot: "/sdcard/Download/dsom-macro-template",
  // 找图素材相对当前脚本的位置。以 . 开头表示相对模式，由运行时用 files.path 解析。
  // 开发时把脚本和 assets 放在设备同一目录下，打包成 APK 后两者也在一起。
  assetsRoot: "./assets",
  screen: {
    width: 0,
    height: 0,
    strict: false
  },
  capture: {
    landscape: false
  },
  runtime: {
    launchTimeoutMs: 15000,
    pollIntervalMs: 250,
    actionWaitMs: 600,
    retryDelayMs: 1000
  },
  defaultTask: "environment-check"
};
