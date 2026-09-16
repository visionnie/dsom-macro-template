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
  // 打开应用先出菜单，不立即执行。
  // autoStartSeconds 是无人值守的退路：开机自启后没人点菜单，
  // 倒计时结束就自己进常驻调度；人在设备前时任何一次点击都会取消它。
  // 设为 0 表示永不自动进入，开发调试时用。
  launcher: {
    autoStartSeconds: 10
  },
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
