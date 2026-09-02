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

const sourceFiles = collectJavaScriptFiles(path.join(projectRoot, "src"));
const scriptFiles = collectJavaScriptFiles(path.join(projectRoot, ".docs/script"));
for (const filePath of sourceFiles.concat(scriptFiles)) {
  checkSyntax(filePath);
}
checkConfig();
checkTasks();

console.log("检查通过: " + sourceFiles.length + " 个源码文件");
console.log(
  "已登记任务: " +
    require(path.join(projectRoot, "src/task-registry-autojs.js")).listIds().join(", ")
);
