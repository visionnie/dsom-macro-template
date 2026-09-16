// =====================================================================
// 操作场景：提交前检查 AutoJs6 源码、项目脚本、配置和任务登记
// 当前手动步骤：递归找 JS -> Node 语法检查 -> 校验配置 -> 校验任务 ID
// 输入参数：无
// 失败处理：任一检查失败立即退出 1
// 输出：控制台检查结果
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const projectRoot = path.resolve(__dirname, "..", "..");

function collectJavaScriptFiles(directoryPath) {
  const files = [];
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

function checkSyntax(filePath) {
  const result = childProcess.spawnSync(process.execPath, ["--check", filePath], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      "语法检查失败: " + path.relative(projectRoot, filePath) + "\n" + result.stderr
    );
  }
}

function checkConfig() {
  const configPath = path.join(projectRoot, "src/config/game-config-autojs.js");
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  if (!config.project || !/^[a-z0-9][a-z0-9-]*$/.test(config.project.id)) {
    throw new Error("项目配置中的 project.id 无效");
  }
  if (!config.game.packageName) {
    console.warn("警告: 尚未填写 game.packageName，游戏启动检查暂不可用");
  }
}

function checkTasks() {
  const config = require(path.join(projectRoot, "src/config/game-config-autojs.js"));
  const registryPath = path.join(projectRoot, "src/task-registry-autojs.js");
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  const taskIds = registry.listIds();
  const uniqueTaskIds = new Set(taskIds);
  if (uniqueTaskIds.size !== taskIds.length) {
    throw new Error("任务登记存在重复 ID: " + taskIds.join(", "));
  }
  if (taskIds.length === 0) {
    throw new Error("至少需要登记一个任务");
  }
  for (const taskId of taskIds) {
    const task = registry.get(taskId);
    if (!task.name || typeof task.run !== "function") {
      throw new Error("任务缺少 name 或 run: " + taskId);
    }
  }
  registry.get(config.defaultTask);
}

// 调度表此前完全不进检查。它是无人值守链路的输入：taskId 拼错、时间窗写错，
// 要等开机自启、常驻起来才暴露，而那时没人在设备前——最坏情况是整夜什么都没跑。
// 校验规则复用设备侧同一份 validateSchedule，两边判定不会不一致。
function checkSchedule() {
  const schedulePath = path.join(projectRoot, "src/config/schedule-autojs.js");
  if (!fs.existsSync(schedulePath)) {
    return 0;
  }
  delete require.cache[require.resolve(schedulePath)];
  const schedule = require(schedulePath);
  const resident = require(path.join(projectRoot, "src/core/resident-autojs.js"));
  resident.validateSchedule(schedule);

  const recordedTask = require(path.join(projectRoot, "src/core/recorded-task-autojs.js"));
  const registry = require(path.join(projectRoot, "src/task-registry-autojs.js"));
  const knownTaskIds = new Set(registry.listIds());

  for (const entry of schedule.entries) {
    for (const taskId of [entry.taskId].concat(entry.requires || [])) {
      // recorded:<会话 id> 指向设备上的录制目录，PC 上查不了它存不存在。
      // 它本该由设备侧增补层提供，出现在仓库代码里多半是抄错了。
      if (recordedTask.isRecordedTaskId(taskId)) {
        console.warn(
          "警告: 调度项 [" + entry.id + "] 引用了录制任务 " + taskId +
            "，它只在设备上存在，PC 侧无法校验"
        );
        continue;
      }
      if (!knownTaskIds.has(taskId)) {
        throw new Error(
          "调度项 [" + entry.id + "] 引用了未登记的任务: " + taskId
        );
      }
    }
  }
  return schedule.entries.length;
}

// 用例 JSON 此前完全不进检查：写错字段、节点 id 重复、跳转目标拼错、素材文件名写错，
// 都要等推到设备上跑到那一步才暴露，一次往返好几分钟。这里在 PC 上一次性查掉。
// case-runner 的顶层只有 require 和函数定义，不碰 files / device，可以在 Node 里直接用。
function checkCases() {
  const casesDir = path.join(projectRoot, "src/cases");
  if (!fs.existsSync(casesDir)) {
    return 0;
  }
  const runnerPath = path.join(projectRoot, "src/core/case/case-runner-autojs.js");
  if (!fs.existsSync(runnerPath)) {
    throw new Error("存在 src/cases/ 但缺少 case-runner，无法校验用例");
  }
  const runner = require(runnerPath);
  const registry = require(path.join(projectRoot, "src/task-registry-autojs.js"));
  const knownTaskIds = new Set(registry.listIds());

  const caseFiles = fs
    .readdirSync(casesDir)
    .filter((name) => name.toLowerCase().endsWith(".json"));

  for (const fileName of caseFiles) {
    const casePath = path.join(casesDir, fileName);
    const relative = path.relative(projectRoot, casePath);
    let data;
    try {
      // Windows 编辑器常写入 UTF-8 BOM，肉眼看不出来但 JSON.parse 直接抛。
      // 设备侧 case-runner 也做同样的容错。
      data = JSON.parse(fs.readFileSync(casePath, "utf8").replace(/^﻿/, ""));
    } catch (parseError) {
      throw new Error("用例 JSON 解析失败: " + relative + "\n" + parseError.message);
    }

    try {
      runner.validateCase(data);
    } catch (validationError) {
      throw new Error("用例校验失败: " + relative + "\n" + validationError.message);
    }

    // 以下三项运行时查不了或故意放过，只能静态查：
    const nodeIds = new Set(data.nodes.map((node) => node.id));
    const terminals = new Set(["@next", "@end", "@abort"]);

    // 1. 跳转目标存在性。validateCase 刻意放行未知字符串（允许向前跳），
    //    于是拼错一个 id 要跑到那一步才炸。
    for (const node of data.nodes) {
      for (const field of ["onSuccess", "onFail", "onExhausted"]) {
        const target = node[field];
        if (target == null || terminals.has(target)) continue;
        if (!nodeIds.has(target)) {
          throw new Error(
            "用例跳转目标不存在: " + relative +
              " 节点 [" + node.id + "] 的 " + field + " -> " + target
          );
        }
      }
    }
    if (data.entry && !nodeIds.has(data.entry)) {
      throw new Error("用例 entry 不存在: " + relative + " -> " + data.entry);
    }

    // 2. 素材文件存在性。素材缺失在设备上是 broken，但完全可以在这里拦住。
    //    assetBase 为 case 时素材相对用例文件所在目录，与设备侧 case-runner 的解析规则一致。
    const assetRoot = data.assetBase === "case"
      ? path.dirname(casePath)
      : path.join(projectRoot, "src/assets");
    for (const node of data.nodes) {
      if (node.type !== "tapImage" || !node.asset) continue;
      const assetPath = path.join(assetRoot, node.asset);
      if (!fs.existsSync(assetPath)) {
        throw new Error(
          "用例引用的素材不存在: " + relative +
            " 节点 [" + node.id + "] -> " + path.relative(projectRoot, assetPath)
        );
      }
    }

    // 3. 前置依赖必须是已登记的任务，否则常驻调度器到点才发现补不上。
    for (const required of data.requires || []) {
      if (!knownTaskIds.has(required)) {
        throw new Error(
          "用例 requires 指向未登记的任务: " + relative + " -> " + required
        );
      }
    }
  }
  return caseFiles.length;
}

const sourceFiles = collectJavaScriptFiles(path.join(projectRoot, "src"));
const scriptFiles = collectJavaScriptFiles(path.join(projectRoot, ".docs/script"));
for (const filePath of sourceFiles.concat(scriptFiles)) {
  checkSyntax(filePath);
}
checkConfig();
checkTasks();
const scheduleCount = checkSchedule();
const caseCount = checkCases();

console.log(
  "检查通过: " + sourceFiles.length + " 个源码文件" +
    (caseCount > 0 ? "，" + caseCount + " 个用例" : "") +
    (scheduleCount > 0 ? "，" + scheduleCount + " 条调度项" : "")
);
console.log(
  "已登记任务: " +
    require(path.join(projectRoot, "src/task-registry-autojs.js")).listIds().join(", ")
);
