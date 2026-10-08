// =====================================================================
// 操作场景：AutoJs6 远程运行前，将 CommonJS 入口及依赖递归打成单文件
// 当前手动步骤：解析静态 require -> 生成模块表 -> 输出 dist/main-autojs.js
// 输入参数：--entry、--output，均可省略
// 失败处理：动态 require、外部包、越过 src 边界或文件缺失时立即退出
// 输出：可直接导入 AutoJs6 的单文件脚本
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const sourceRoot = path.join(projectRoot, "src");

// ---- 构建戳 ----
// 「设备上装的到底是哪一轮的包」这个问题，语义版本只答了一半：版本号是手写的，
// 忘了改就一直是老数字。提交号与打包时间是构建那一刻才成立的事实，忘不掉。
//
// 为什么写进产物而不是写成 src 下的一个文件：src 是要提交的，每次构建都往里写
// 会把仓库弄脏，`git status` 从此永远不干净，真正的改动就藏在噪声里了。
function runGit(args) {
  const result = childProcess.spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout).trim();
}

function formatBuildTime(date) {
  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }
  // 本地时间，且不用 toLocaleString——它的格式随机器的区域设置变，
  // 同一份产物在两台机器上打出来会长得不一样。
  return (
    date.getFullYear() +
    "-" + pad(date.getMonth() + 1) +
    "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) +
    ":" + pad(date.getMinutes())
  );
}

function readBuildStamp() {
  const commit = runGit(["rev-parse", "--short", "HEAD"]);
  const status = runGit(["status", "--porcelain"]);
  return {
    commit: commit || "未知",
    // 查不出来时给 null 而不是 false：「没有未提交改动」和「不知道有没有」
    // 是两件事，后者不该被显示成前者。
    dirty: status === null ? null : status !== "",
    builtAt: formatBuildTime(new Date())
  };
}

const buildStamp = readBuildStamp();

function readArgument(name, defaultValue) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return defaultValue;
  }
  if (!process.argv[index + 1]) {
    throw new Error("参数缺少值: " + name);
  }
  return process.argv[index + 1];
}

function normalizeModuleId(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function assertInsideSource(filePath) {
  const relativePath = path.relative(sourceRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("模块越过 src 边界: " + filePath);
  }
}

function resolveModule(fromFile, request) {
  if (!request.startsWith(".")) {
    throw new Error("不支持外部模块: " + request + "，来源: " + fromFile);
  }

  const unresolvedPath = path.resolve(path.dirname(fromFile), request);
  const candidates = [
    unresolvedPath,
    unresolvedPath + ".js",
    path.join(unresolvedPath, "index.js")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      assertInsideSource(candidate);
      return candidate;
    }
  }
  throw new Error("找不到模块: " + request + "，来源: " + fromFile);
}

function indent(content, spaces) {
  const prefix = " ".repeat(spaces);
  return content
    .split(/\r?\n/)
    .map((line) => prefix + line)
    .join("\n");
}

// 取入口文件开头的模式指令。只认 "auto" 与 "ui"——AutoJs6 就这两种，
// 写错会静默按 auto 跑，UI 界面根本不出来，所以宁可在这里直接拒绝。
const VALID_ENTRY_DIRECTIVES = ["auto", "ui"];

function readEntryDirective(entryPath) {
  const source = fs.readFileSync(entryPath, "utf8");
  const withoutComments = source.replace(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)+/, "");
  const match = /^\s*(["'])([a-z]+)\1\s*;/.exec(withoutComments);
  if (!match) {
    return "auto";
  }
  const directive = match[2];
  if (VALID_ENTRY_DIRECTIVES.indexOf(directive) === -1) {
    throw new Error(
      "入口的模式指令无法识别: \"" + directive + "\"，只支持 " +
        VALID_ENTRY_DIRECTIVES.join(" / ")
    );
  }
  return directive;
}

function buildBundle(entryPath, outputPath) {
  const modules = new Map();
  const staticRequirePattern = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g;

  function collect(filePath) {
    const moduleId = normalizeModuleId(filePath);
    if (modules.has(moduleId)) {
      return moduleId;
    }

    const source = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    const sourceWithoutStaticRequires = source.replace(staticRequirePattern, "");
    if (/\brequire\s*\(/.test(sourceWithoutStaticRequires)) {
      throw new Error("只允许静态相对 require: " + filePath);
    }
    modules.set(moduleId, "");
    const transformedSource = source.replace(
      staticRequirePattern,
      (statement, quote, request) => {
        const dependencyPath = resolveModule(filePath, request);
        const dependencyId = collect(dependencyPath);
        return "require(" + JSON.stringify(dependencyId) + ")";
      }
    );
    modules.set(moduleId, transformedSource);
    return moduleId;
  }

  assertInsideSource(entryPath);
  const entryId = collect(entryPath);
  const moduleEntries = [];
  for (const [moduleId, source] of modules.entries()) {
    moduleEntries.push(
      "  " +
        JSON.stringify(moduleId) +
        ": function (module, exports, require) {\n" +
        indent(source, 4) +
        "\n  }"
    );
  }

  // AutoJs6 的模式指令（"auto" / "ui"）必须在产物的最顶部才生效，
  // 而入口文件的内容会被包进模块函数里，指令在那儿就失效了。
  // 所以按入口文件声明的指令提到顶部——入口是唯一事实来源，
  // 改成 UI 模式只需要改入口，不用记得同时改这个脚本。
  const entryDirective = readEntryDirective(entryPath);

  const bundle = [
    "// 此文件由 .docs/script/build-autojs-bundles.js 生成，请勿直接编辑。",
    JSON.stringify(entryDirective) + ";",
    "",
    // 构建戳放在模式指令之后、模块表之前：这里是脚本作用域，
    // 每个模块函数都是在同一个作用域里定义的，闭包能看到这个 var。
    // 读它的是 core/app-version-autojs.js，那边用 typeof 兜底，
    // 所以直接跑未打包的源码（没有这一行）也不会炸，只是少显示提交号和时间。
    "var __BUILD_STAMP__ = " + JSON.stringify(buildStamp) + ";",
    "",
    "(function (modules) {",
    "  var cache = {};",
    "  function require(moduleId) {",
    "    if (cache[moduleId]) {",
    "      return cache[moduleId].exports;",
    "    }",
    "    if (!Object.prototype.hasOwnProperty.call(modules, moduleId)) {",
    '      throw new Error("打包模块不存在: " + moduleId);',
    "    }",
    "    var module = { exports: {} };",
    "    cache[moduleId] = module;",
    "    modules[moduleId](module, module.exports, require);",
    "    return module.exports;",
    "  }",
    "  require(" + JSON.stringify(entryId) + ");",
    "})({",
    moduleEntries.join(",\n"),
    "});",
    ""
  ].join("\n");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bundle, "utf8");
  return modules.size;
}

// 入口不止一个：main（无界面，负责分派）与 menu（界面）。为什么拆成两个见 src/entry/main-autojs.js。
// 不给 --entry 时把 src/entry/ 下每个入口各打一份到 dist/ 同名文件，新增入口不用改这里；
// 给了 --entry 则只打那一个。
const explicitEntry = readArgument("--entry", null);
const jobs = [];
if (explicitEntry) {
  jobs.push({
    entry: path.resolve(projectRoot, explicitEntry),
    output: path.resolve(
      projectRoot,
      readArgument("--output", path.join("dist", path.basename(explicitEntry)))
    )
  });
} else {
  const entryDir = path.join(sourceRoot, "entry");
  const names = fs.readdirSync(entryDir).filter((name) => name.endsWith(".js")).sort();
  for (const name of names) {
    jobs.push({ entry: path.join(entryDir, name), output: path.join(projectRoot, "dist", name) });
  }
}

for (const job of jobs) {
  if (!fs.existsSync(job.entry)) {
    throw new Error("入口文件不存在: " + job.entry);
  }
  const moduleCount = buildBundle(job.entry, job.output);
  console.log(
    "已生成: " + path.relative(projectRoot, job.output) +
      "（" + readEntryDirective(job.entry) + " 模式，" + moduleCount + " 个模块）"
  );
}

// 打完一定要把构建戳打出来：它就是「装上去之后该在界面上看到什么」，
// 对不上就说明装的不是这一次打的包。
console.log(
  "构建戳: " + buildStamp.commit +
    (buildStamp.dirty === true ? "+（有未提交改动）" : "") +
    "  " + buildStamp.builtAt
);
