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

const projectRoot = path.resolve(__dirname, "..", "..");
const sourceRoot = path.join(projectRoot, "src");

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

const entryPath = path.resolve(
  projectRoot,
  readArgument("--entry", "src/entry/main-autojs.js")
);
const outputPath = path.resolve(
  projectRoot,
  readArgument("--output", "dist/main-autojs.js")
);

if (!fs.existsSync(entryPath)) {
  throw new Error("入口文件不存在: " + entryPath);
}

const moduleCount = buildBundle(entryPath, outputPath);
console.log("已生成: " + path.relative(projectRoot, outputPath));
console.log("已打包模块: " + moduleCount);
