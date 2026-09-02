// =====================================================================
// 任务模板：复制本文件并改名，然后在 task-registry-autojs.js 中登记
// 设计约束：先识别页面状态，再执行动作；状态未知时立即失败并留证
// =====================================================================

module.exports = {
  id: "replace-me",
  name: "待命名任务",
  launchGame: true,
  requiresCapture: true,
  run: function (context) {
    return context.workflow.runSteps(context, [
      {
        name: "确认起始页面",
        retryCount: 1,
        retryDelayMs: 1000,
        run: function (stepContext) {
          stepContext.screen.waitFor(
            "待实现的起始页面",
            function (image) {
              // 在这里使用像素、找图或 OCR 判断页面，禁止直接返回 true 后盲点。
              return false;
            },
            10000,
            500
          );
        }
      }
    ]);
  }
};
