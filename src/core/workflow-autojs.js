// =====================================================================
// 通用能力：按配置顺序执行步骤，并提供有限重试和步骤级失败留证
// 设计约束：任务只描述步骤，流程控制不绑定任何界面或具体游戏
// =====================================================================

function runSteps(context, steps) {
  var results = [];

  for (var index = 0; index < steps.length; index++) {
    var step = steps[index];
    var retryCount = step.retryCount || 0;
    var attempt = 0;
    var completed = false;

    while (!completed && attempt <= retryCount) {
      attempt++;
      context.logger.info(
        "开始步骤 " + (index + 1) + "/" + steps.length + ": " + step.name +
          "，尝试 " + attempt + "/" + (retryCount + 1)
      );

      try {
        var value = step.run(context);
        results.push({
          name: step.name,
          status: "passed",
          attempts: attempt,
          value: value === undefined ? null : value
        });
        context.logger.info("步骤完成: " + step.name);
        completed = true;
      } catch (error) {
        context.logger.warn("步骤失败: " + step.name + "，原因: " + error);
        if (attempt > retryCount) {
          if (context.screen.hasPermission()) {
            try {
              context.screen.saveStage("step-failed-" + (index + 1));
            } catch (captureError) {
              context.logger.warn("步骤失败截图保存失败: " + captureError);
            }
          }
          throw error;
        }
        sleep(step.retryDelayMs || context.config.runtime.retryDelayMs || 1000);
      }
    }
  }

  return results;
}

module.exports = {
  runSteps: runSteps
};
