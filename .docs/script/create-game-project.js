// =====================================================================
// 操作场景：为公司新游戏创建一份干净的 AutoJs6 自动化项目
// 当前手动步骤：校验目标目录 -> 复制通用骨架 -> 写入项目与包名配置
// 输入参数：--target、--id、--name、--package；--dry-run 可只做检查
// 失败处理：目标非空、参数非法或目标覆盖当前项目时立即退出
// 输出：一个不包含当前游戏业务任务和设备信息的新项目目录
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const genericPaths = [
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "package.json",
  ".docs/PROJECT.md",
  ".docs/RULES.md",
  ".docs/CASE-SCHEMA.md",
  ".docs/PACKAGING.md",
  ".docs/HANDOFF.md",
  ".docs/archive/HANDOFF-history.md",
  ".docs/script/README.md",
  ".docs/script/build-autojs-bundles.js",
  ".docs/script/build-autojs-project.js",
  ".docs/script/check-autojs-project.js",
  ".docs/script/create-game-project.js",
  ".docs/script/commit-push.ps1",
  ".docs/script/package-apk.ps1",
  ".docs/script/collect-logs.ps1",
  "src/README.md",
  "src/assets/README.md",
  "src/config/game-config-autojs.js",
  "src/core/actions-autojs.js",
  "src/core/case/case-geometry-autojs.js",
  "src/core/case/case-schema-autojs.js",
  "src/core/case/case-runner-autojs.js",
  "src/core/logger-autojs.js",
  "src/core/ocr-autojs.js",
  "src/core/runtime-autojs.js",
  "src/core/screen-autojs.js",
  "src/core/workflow-autojs.js",
  "src/entry/main-autojs.js",
  "src/tasks/_task-template-autojs.js",
  "src/tasks/environment-check-autojs.js",
  "src/tasks/launch-game-check-autojs.js"
];

function getArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error("缺少参数: " + name);
  }
  return process.argv[index + 1];
}

function assertValidProjectId(projectId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new Error("--id 只能包含小写字母、数字和连字符");
  }
}

function assertSafeTarget(targetPath) {
  const relativeFromProject = path.relative(projectRoot, targetPath);
  const relativeToProject = path.relative(targetPath, projectRoot);
  if (
    relativeFromProject === "" ||
    (!relativeFromProject.startsWith("..") && !path.isAbsolute(relativeFromProject)) ||
    (!relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject))
  ) {
    throw new Error("目标目录不能与当前项目互相包含: " + targetPath);
  }
  if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).length > 0) {
    throw new Error("目标目录不是空目录: " + targetPath);
  }
}

function copyGenericFiles(targetPath) {
  for (const relativePath of genericPaths) {
    const sourcePath = path.join(projectRoot, relativePath);
    const destinationPath = path.join(targetPath, relativePath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error("模板文件不存在: " + sourcePath);
    }
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function validateTemplateFiles() {
  for (const relativePath of genericPaths) {
    const sourcePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error("模板文件不存在: " + sourcePath);
    }
  }

  JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const initialTasks = [
    require(path.join(projectRoot, "src/tasks/environment-check-autojs.js")),
    require(path.join(projectRoot, "src/tasks/launch-game-check-autojs.js"))
  ];
  for (const task of initialTasks) {
    if (!task.id || !task.name || typeof task.run !== "function") {
      throw new Error("内置任务结构无效: " + JSON.stringify(task));
    }
  }
}

function renderProjectConfig(content, values) {
  return content
    .replace(/id: "[^"]+"/, "id: " + JSON.stringify(values.projectId))
    .replace(/name: "[^"]+"/, "name: " + JSON.stringify(values.projectName))
    .replace(
      /packageName: "[^"]*"/,
      "packageName: " + JSON.stringify(values.packageName)
    )
    .replace(
      /outputRoot: "[^"]+"/,
      "outputRoot: " + JSON.stringify("/sdcard/Download/dsom-macro-" + values.projectId)
    );
}

function writeProjectConfig(targetPath, values) {
  const configPath = path.join(targetPath, "src/config/game-config-autojs.js");
  const content = renderProjectConfig(fs.readFileSync(configPath, "utf8"), values);
  fs.writeFileSync(configPath, content, "utf8");

  const packagePath = path.join(targetPath, "package.json");
  const packageConfig = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageConfig.name = "dsom-macro-" + values.projectId;
  fs.writeFileSync(packagePath, JSON.stringify(packageConfig, null, 2) + "\n", "utf8");

  const readmePath = path.join(targetPath, "README.md");
  const readmeContent = fs
    .readFileSync(readmePath, "utf8")
    .replace(/^#[^\n]*/m, "# " + values.projectName + " AutoJs6 游戏自动化");
  fs.writeFileSync(readmePath, readmeContent, "utf8");
}

function getCleanTaskRegistryContent() {
  return [
    "// 新游戏初始任务登记表；新增业务任务后在这里显式登记。",
    "var tasks = [",
    '  require("./tasks/environment-check-autojs.js"),',
    '  require("./tasks/launch-game-check-autojs.js")',
    "];",
    "",
    "function listIds() {",
    "  var ids = [];",
    "  for (var index = 0; index < tasks.length; index++) {",
    "    ids.push(tasks[index].id);",
    "  }",
    "  return ids;",
    "}",
    "",
    "function get(taskId) {",
    "  for (var index = 0; index < tasks.length; index++) {",
    "    if (tasks[index].id === taskId) {",
    "      return tasks[index];",
    "    }",
    "  }",
    '  throw new Error("未登记任务: " + taskId + "，可用任务: " + listIds().join(", "));',
    "}",
    "",
    "module.exports = { get: get, listIds: listIds };",
    ""
  ].join("\n");
}

function writeCleanTaskRegistry(targetPath) {
  const registryPath = path.join(targetPath, "src/task-registry-autojs.js");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, getCleanTaskRegistryContent(), "utf8");
}

function writeHandoff(targetPath, projectName) {
  const handoffPath = path.join(targetPath, ".docs/HANDOFF.md");
  const content = [
    "# 迭代交接 - HANDOFF.md",
    "",
    "## 下次启动，第一件事",
    "",
    "```",
    "在 AutoJs6 运行环境检查，并填写真实游戏包名。",
    "```",
    "",
    "## 当前状态",
    "",
    "**活跃分支**：尚未初始化 Git",
    "**最近一次 release / tag**：尚未发版",
    "**进行中**：" + projectName + " 已从通用模板创建，等待设备环境验证。",
    "",
    "## 最近迭代",
    "",
    "- 建立通用 AutoJs6 项目骨架。",
    "- 尚未加入具体游戏业务任务。",
    ""
  ].join("\n");
  fs.writeFileSync(handoffPath, content, "utf8");
}

const values = {
  targetPath: path.resolve(getArgument("--target")),
  projectId: getArgument("--id"),
  projectName: getArgument("--name"),
  packageName: getArgument("--package")
};
assertValidProjectId(values.projectId);
assertSafeTarget(values.targetPath);
validateTemplateFiles();

if (process.argv.includes("--dry-run")) {
  const sourceConfig = fs.readFileSync(
    path.join(projectRoot, "src/config/game-config-autojs.js"),
    "utf8"
  );
  const renderedConfig = renderProjectConfig(sourceConfig, values);
  if (
    renderedConfig.indexOf(values.packageName) < 0 ||
    renderedConfig.indexOf(values.projectId) < 0
  ) {
    throw new Error("项目配置生成结果校验失败");
  }
  new Function("module", "exports", "require", getCleanTaskRegistryContent());
  console.log("参数与模板完整性检查通过，目标目录: " + values.targetPath);
  process.exit(0);
}

fs.mkdirSync(values.targetPath, { recursive: true });
copyGenericFiles(values.targetPath);
writeCleanTaskRegistry(values.targetPath);
writeProjectConfig(values.targetPath, values);
writeHandoff(values.targetPath, values.projectName);

console.log("已创建 AutoJs6 游戏项目: " + values.targetPath);
console.log("下一步: 修改 src/config/game-config-autojs.js 后执行 npm run build");
