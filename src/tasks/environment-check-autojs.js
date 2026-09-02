// =====================================================================
// 验证任务：确认 AutoJs6 能读取设备信息、申请截图权限并保存截图
// 安全边界：不启动游戏、不点击、不滑动，可在配置包名前先运行
// =====================================================================

module.exports = {
  id: "environment-check",
  name: "AutoJs6 环境检查",
  launchGame: false,
  requiresCapture: true,
  run: function (context) {
    return context.workflow.runSteps(context, [
      {
        name: "记录设备环境",
        run: function (stepContext) {
          stepContext.logger.info(
            "设备 " +
              device.brand +
              " " +
              device.model +
              "，Android SDK " +
              device.sdkInt +
              "，屏幕 " +
              device.width +
              "x" +
              device.height
          );
        }
      },
      {
        name: "保存环境截图",
        run: function (stepContext) {
          return stepContext.screen.saveStage("environment-check");
        }
      }
    ]);
  }
};
