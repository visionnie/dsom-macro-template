// =====================================================================
// 项目入口：选择任务并交给通用运行时执行
// 输入参数：AutoJs6 execArgv.task；未提供时使用配置中的 defaultTask
// =====================================================================

"auto";

var config = require("../config/game-config-autojs.js");
var taskRegistry = require("../task-registry-autojs.js");
var runtime = require("../core/runtime-autojs.js");

function getSelectedTaskId() {
  try {
    var executionArguments = engines.myEngine().execArgv;
    if (executionArguments && executionArguments.task) {
      return String(executionArguments.task);
    }
  } catch (error) {
    console.log("未读取到任务参数，使用默认任务: " + error);
  }
  return config.defaultTask;
}

var selectedTaskId = getSelectedTaskId();
var selectedTask = taskRegistry.get(selectedTaskId);
runtime.run(config, selectedTask);
