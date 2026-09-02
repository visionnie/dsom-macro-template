// =====================================================================
// 通用能力：建立任务上下文，统一处理启动、权限、结果、日志和失败截图
// 设计约束：运行时不包含任何具体游戏页面判断
// =====================================================================

var loggerModule = require("./logger-autojs.js");
var screenModule = require("./screen-autojs.js");
var actionsModule = require("./actions-autojs.js");
var ocrModule = require("./ocr-autojs.js");
var workflow = require("./workflow-autojs.js");

function validateConfig(config) {
  if (!config.project || !config.project.id || !config.project.name) {
    throw new Error("项目配置缺少 project.id 或 project.name");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.project.id)) {
    throw new Error("project.id 只能包含小写字母、数字和连字符");
  }
  if (!config.outputRoot) {
    throw new Error("项目配置缺少 outputRoot");
  }
}

function getErrorDetail(error) {
  if (!error) {
    return "未知错误";
  }
  return error.stack ? String(error.stack) : String(error);
}

function run(config, task) {
  validateConfig(config);

  var startedAt = new Date();
  var runId = startedAt.getTime();
  var outputDir = config.outputRoot + "/" + task.id + "/" + runId;
  var logger = loggerModule.create({ outputDir: outputDir });
  var screen = screenModule.create({
    logger: logger,
    outputDir: outputDir,
    capture: config.capture
  });
  var actions = actionsModule.create({
    logger: logger,
    runtime: config.runtime
  });
  var ocr = ocrModule.create({ logger: logger });
  var context = {
    config: config,
    logger: logger,
    screen: screen,
    actions: actions,
    ocr: ocr,
    workflow: workflow,
    outputDir: outputDir
  };
  var result = {
    projectId: config.project.id,
    taskId: task.id,
    taskName: task.name,
    status: "running",
    startedAt: startedAt.toISOString(),
    device: {
      width: device.width,
      height: device.height,
      sdkInt: device.sdkInt,
      brand: device.brand,
      model: device.model
    }
  };

  try {
    logger.info("开始任务: " + task.name + " [" + task.id + "]");

    if (config.screen && config.screen.strict) {
      if (
        device.width !== config.screen.width ||
        device.height !== config.screen.height
      ) {
        throw new Error(
          "屏幕尺寸不匹配，期望 " +
            config.screen.width +
            "x" +
            config.screen.height +
            "，实际 " +
            device.width +
            "x" +
            device.height
        );
      }
    }

    if (task.requiresCapture !== false) {
      screen.requestPermission();
    }
    if (task.launchGame !== false) {
      if (!config.game || !config.game.packageName) {
        throw new Error("当前任务需要启动游戏，请先配置 game.packageName");
      }
      actions.launchPackageAndWait(
        config.game.packageName,
        config.runtime.launchTimeoutMs
      );
    }

    result.steps = task.run(context) || [];
    result.status = "passed";
    logger.info("任务完成: " + task.name);
  } catch (error) {
    result.status = "failed";
    result.error = getErrorDetail(error);
    logger.error("任务失败: " + result.error);
    if (screen.hasPermission()) {
      try {
        result.failureScreenshot = screen.saveStage("task-failed");
      } catch (captureError) {
        logger.warn("任务失败截图保存失败: " + captureError);
      }
    }
    throw error;
  } finally {
    var finishedAt = new Date();
    result.finishedAt = finishedAt.toISOString();
    result.durationMs = finishedAt.getTime() - startedAt.getTime();
    logger.saveJson("result.json", result);
    logger.flush("latest.log");
  }
}

module.exports = {
  run: run
};
