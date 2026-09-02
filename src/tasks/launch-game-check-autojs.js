// =====================================================================
// 验证任务：启动已配置的游戏并确认包名进入前台
// 安全边界：只启动应用和截图，不执行游戏内点击
// =====================================================================

module.exports = {
  id: "launch-game-check",
  name: "游戏启动检查",
  launchGame: true,
  requiresCapture: true,
  run: function (context) {
    return context.workflow.runSteps(context, [
      {
        name: "确认游戏位于前台",
        run: function (stepContext) {
          var actualPackage = currentPackage();
          var expectedPackage = stepContext.config.game.packageName;
          if (actualPackage !== expectedPackage) {
            throw new Error(
              "前台包名不匹配，期望 " + expectedPackage + "，实际 " + actualPackage
            );
          }
        }
      },
      {
        name: "保存游戏启动截图",
        run: function (stepContext) {
          return stepContext.screen.saveStage("game-launched");
        }
      }
    ]);
  }
};
