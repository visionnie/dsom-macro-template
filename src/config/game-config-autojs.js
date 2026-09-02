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
  // 找图素材在设备上的根目录。src/assets/ 不进单文件打包，需要单独推送到这里。
  assetsRoot: "/sdcard/dsom-macro-template/assets",
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
