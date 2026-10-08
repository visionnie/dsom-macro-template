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
  ".docs/CASE-MVP.md",
  ".docs/CASE-SCHEMA.md",
  ".docs/RECORDER.md",
  ".docs/RESIDENT.md",
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
  // 版本号那个文件（2026-10-08 回流）。**必须进清单**：game-config 第一行就
  // require 它，漏了的话生成出来的新项目连配置都读不进来。
  // 生成时它会被重置成 0.1.0，见 renderProjectVersion。
  "src/config/version-autojs.js",
  "src/config/schedule-autojs.js",
  "src/core/actions-autojs.js",
  "src/core/capture-session-autojs.js",
  "src/core/device-prefs-autojs.js",
  "src/core/permissions-autojs.js",
  "src/core/case/case-geometry-autojs.js",
  "src/core/case/case-schema-autojs.js",
  "src/core/case/case-runner-autojs.js",
  "src/core/case/recorded-case-autojs.js",
  "src/core/errors-autojs.js",
  "src/core/foreground-autojs.js",
  "src/core/launcher-autojs.js",
  "src/core/logger-autojs.js",
  "src/core/recorded-task-autojs.js",
  "src/core/recorder-autojs.js",
  "src/core/ocr-autojs.js",
  // 2026-09-30 回流带进来的五个通用件。**加了 core 文件就要加进这份清单**——
  // 漏一个的后果是生成出来的新项目跑到那句 require 才炸，
  // 而模板自己一切正常（menu-autojs.js 漏掉那次就是这么发现的）。
  "src/core/ui-thread-autojs.js",
  "src/core/screen-overlays-autojs.js",
  "src/core/tap-marker-autojs.js",
  "src/core/point-picker-autojs.js",
  "src/core/region-picker-autojs.js",
  "src/core/resident-autojs.js",
  "src/core/run-control-autojs.js",
  "src/core/run-lock-autojs.js",
  "src/core/runtime-autojs.js",
  "src/core/schedule-store-autojs.js",
  "src/core/screen-autojs.js",
  "src/core/workflow-autojs.js",
  // 2026-10-08 回流带进来的十个。同上：**加了 core 文件就要加进这份清单**。
  // 这十个当前在模板里没有调用方（它们的调用方是 B 轮才拆得出来的 launcher），
  // 所以不会进 bundle；留在这儿是给 B 轮备的现货，和 point-picker / region-picker
  // 当初一样。
  "src/core/app-version-autojs.js",
  "src/core/overlay-keyboard-autojs.js",
  "src/core/pick-overlay-autojs.js",
  "src/core/run-overlay-autojs.js",
  "src/core/schedule-overlay-autojs.js",
  "src/core/step-overlay-autojs.js",
  "src/core/task-group-autojs.js",
  "src/core/task-group-store-autojs.js",
  "src/core/task-store-autojs.js",
  "src/core/text-input-autojs.js",
  "src/entry/main-autojs.js",
  // 入口拆成 auto + ui 两个文件后漏了这一个，生成出来的新项目会没有菜单界面。
  // 别删：main-autojs.js 只负责分派，菜单在这里。
  "src/entry/menu-autojs.js",
  "src/tasks/_task-template-autojs.js",
  "src/tasks/environment-check-autojs.js",
  "src/tasks/launch-game-check-autojs.js",
  "src/tasks/resident-runner-autojs.js"
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

// 新项目的版本号从 0.1.0 重新数（2026-10-08）。
// 继承模板当前的版本号（比如 0.4.0）只会让人以为这个新游戏已经迭代过四轮；
// 而 package.json 与 version-autojs.js 必须一头一致，否则
// build-autojs-project.js 的版本闸会拒绝生成项目——新项目第一次打包就卡住。
const NEW_PROJECT_VERSION = "0.1.0";

function writeProjectConfig(targetPath, values) {
  const configPath = path.join(targetPath, "src/config/game-config-autojs.js");
  const content = renderProjectConfig(fs.readFileSync(configPath, "utf8"), values);
  fs.writeFileSync(configPath, content, "utf8");

  const versionPath = path.join(targetPath, "src/config/version-autojs.js");
  const versionContent = fs
    .readFileSync(versionPath, "utf8")
    .replace(/name:\s*"[^"]+"/, 'name: "' + NEW_PROJECT_VERSION + '"');
  if (versionContent.indexOf('"' + NEW_PROJECT_VERSION + '"') < 0) {
    throw new Error("版本号重置失败：src/config/version-autojs.js 的写法变了");
  }
  fs.writeFileSync(versionPath, versionContent, "utf8");

  const packagePath = path.join(targetPath, "package.json");
  const packageConfig = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageConfig.name = "dsom-macro-" + values.projectId;
  packageConfig.version = NEW_PROJECT_VERSION;
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
    '  require("./tasks/launch-game-check-autojs.js"),',
    '  require("./tasks/resident-runner-autojs.js")',
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
