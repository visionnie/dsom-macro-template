// =====================================================================
// 操作场景：把当前项目组装成 AutoJs6 项目目录，供在手机上打包成独立 APK
// 当前手动步骤：读配置 -> 生成 project.json -> 复制单文件与素材 -> 打印后续步骤
// 输入参数：--package、--version-name、--version-code、--output、--run-on-boot、--libs
// 失败处理：缺少构建产物、配置非法或包名非法时立即退出
// 输出：dist/project/ 目录，推到手机后由 AutoJs6 的「打包应用」生成 APK
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const config = require(path.join(projectRoot, "src/config/game-config-autojs.js"));

// 以下字段名与取值取自 AutoJs6 6.7 打包界面回写的 project.json，不是猜的。
// 支持库用 libs 控制，取值是界面上的可读名称。
// 注意：除 OpenCV 外的库（各类 OCR、OpenCC 等）需要先在 AutoJs6 中安装对应插件，
// 否则打包会直接失败并提示「缺少 xxx 所需的插件」。
const DEFAULT_LIBS = ["OpenCV"];

const DEFAULT_PERMISSIONS = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
  "android.permission.INTERNET",
  "android.permission.MANAGE_EXTERNAL_STORAGE",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.WAKE_LOCK",
  "android.permission.WRITE_EXTERNAL_STORAGE"
];

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

function hasFlag(name) {
  return process.argv.includes(name);
}

function assertValidPackageName(packageName) {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) {
    throw new Error(
      "Android 包名非法: " + packageName + "，需形如 com.company.product"
    );
  }
}

function copyDirectory(fromDir, toDir, filter) {
  fs.mkdirSync(toDir, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const fromPath = path.join(fromDir, entry.name);
    const toPath = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      count += copyDirectory(fromPath, toPath, filter);
    } else if (!filter || filter(entry.name)) {
      fs.copyFileSync(fromPath, toPath);
      count++;
    }
  }
  return count;
}

const bundlePath = path.join(projectRoot, "dist/main-autojs.js");
const assetsDir = path.join(projectRoot, "src/assets");
const casesDir = path.join(projectRoot, "src/cases");
const outputDir = path.resolve(
  projectRoot,
  readArgument("--output", "dist/project")
);

if (!fs.existsSync(bundlePath)) {
  throw new Error("缺少构建产物，请先执行 npm run build: " + bundlePath);
}
// 打包后素材与 main.js 同级，只有相对路径才解析得到。
if (!config.assetsRoot || config.assetsRoot.charAt(0) !== ".") {
  throw new Error(
    "打包要求 assetsRoot 为相对路径（以 . 开头），当前为: " + config.assetsRoot
  );
}

const packageName = readArgument(
  "--package",
  "com.dsom.macro." + config.project.id.replace(/-/g, "")
);
assertValidPackageName(packageName);

const versionName = readArgument("--version-name", "1.0.0");
const versionCode = Number(readArgument("--version-code", "1"));
if (!Number.isInteger(versionCode) || versionCode < 1) {
  throw new Error("--version-code 必须是正整数");
}

const libs = readArgument("--libs", DEFAULT_LIBS.join(","))
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item);
if (libs.indexOf("OpenCV") < 0) {
  throw new Error("libs 必须包含 OpenCV，否则找图会静默失效");
}

const abis = readArgument("--abis", "arm64-v8a")
  .split(",")
  .map((item) => item.trim())
  .filter((item) => item);

// 清空输出目录，避免上一次打包遗留的素材混进新包。
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

// main.js 是 AutoJs6 项目约定的入口名，内容就是我们打好的单文件。
fs.copyFileSync(bundlePath, path.join(outputDir, "main.js"));

// 素材必须与 main.js 同级，配置里的 ./assets 才解析得到。
const assetCount = copyDirectory(
  assetsDir,
  path.join(outputDir, "assets"),
  (name) => name.toLowerCase().endsWith(".png")
);

// 用例 JSON 同样要与 main.js 同级：case-runner 用 files.path("cases/xxx.json") 加载。
let caseCount = 0;
if (fs.existsSync(casesDir)) {
  caseCount = copyDirectory(
    casesDir,
    path.join(outputDir, "cases"),
    (name) => name.toLowerCase().endsWith(".json")
  );
}

const projectConfig = {
  name: config.project.name,
  packageName: packageName,
  versionName: versionName,
  versionCode: versionCode,
  main: "main.js",
  abis: abis,
  libs: libs,
  assets: [],
  useFeatures: [],
  launchConfig: {
    launcherVisible: true,
    // 开机自启。无人值守场景需要，但云机重启后各项权限是否保留需实测确认。
    runOnBoot: hasFlag("--run-on-boot"),
    hideLogs: true,
    displaySplash: false,
    splashText: config.project.name
  },
  permissions: DEFAULT_PERMISSIONS,
  signatureScheme: "V1 + V2",
  // build 是打包输出目录，不能再被打进包里。
  ignore: ["build"]
};

fs.writeFileSync(
  path.join(outputDir, "project.json"),
  JSON.stringify(projectConfig, null, 4) + "\n",
  "utf8"
);

const relativeOutput = path.relative(projectRoot, outputDir);
console.log("已生成 AutoJs6 项目: " + relativeOutput);
console.log("  入口: main.js");
console.log("  素材: assets/（" + assetCount + " 个 png）");
console.log("  用例: cases/（" + caseCount + " 个 json）");
console.log("  包名: " + packageName + "  版本: " + versionName + " (" + versionCode + ")");
console.log("  支持库: " + libs.join(", ") + "   ABI: " + abis.join(", "));
console.log("  开机自启: " + (projectConfig.launchConfig.runOnBoot ? "是" : "否"));
console.log("");
console.log("下一步：推送该目录到手机，在 AutoJs6 文件列表中找到它，");
console.log("        点右侧菜单的「打包应用」，再点右下角按钮生成 APK。");
