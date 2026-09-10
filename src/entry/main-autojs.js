// =====================================================================
// 项目入口：选择任务并交给通用运行时执行
// 输入参数：AutoJs6 execArgv.task；未提供时使用配置中的 defaultTask
// =====================================================================

"auto";

var config = require("../config/game-config-autojs.js");
var taskRegistry = require("../task-registry-autojs.js");
var runtime = require("../core/runtime-autojs.js");

// 任务来源优先级：execArgv.task > 脚本同级的 task.txt > 配置里的 defaultTask。
//
// task.txt 是开发路径用的：run-task.ps1 的 -Task 会写它，省掉「改 defaultTask
// 跑一次再改回来」的来回。它必须与 main.js 同级，用 files.path 解析——
// 打包成 APK 后包内不存在这个文件，于是自动退回 defaultTask，
// 不会出现"开发时选的任务被打进正式包"这种事。
function getSelectedTaskId() {
  try {
    var executionArguments = engines.myEngine().execArgv;
    if (executionArguments && executionArguments.task) {
      return String(executionArguments.task);
    }
  } catch (error) {
    console.log("未读取到任务参数: " + error);
  }

  try {
    var overridePath = files.path("task.txt");
    if (files.exists(overridePath)) {
      var overrideId = String(files.read(overridePath)).replace(/^﻿/, "").trim();
      if (overrideId) {
        console.log("使用 task.txt 指定的任务: " + overrideId);
        return overrideId;
      }
    }
  } catch (error) {
    console.log("读取 task.txt 失败，使用默认任务: " + error);
  }

  return config.defaultTask;
}

var selectedTaskId = getSelectedTaskId();
var selectedTask = taskRegistry.get(selectedTaskId);
runtime.run(config, selectedTask);
