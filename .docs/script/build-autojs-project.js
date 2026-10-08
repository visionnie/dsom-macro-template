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
const appVersion = require(path.join(projectRoot, "src/config/version-autojs.js"));

// 以下字段名与取值取自 AutoJs6 6.7 打包界面回写的 project.json，不是猜的。
// 支持库用 libs 控制，取值是界面上的可读名称。
// 注意：除 OpenCV 外的库（各类 OCR、OpenCC 等）需要先在 AutoJs6 中安装对应插件，
// 否则打包会直接失败并提示「缺少 xxx 所需的插件」。
const DEFAULT_LIBS = ["OpenCV"];

// REORDER_TASKS 不能少：运行时用 moveTaskToFront 把脚本页切回前台（申请截图权限前、录制停止后），
// 缺它会抛 SecurityException。开发路径不受影响是因为宿主 AutoJs6 自带这个权限，
// 所以只有打包后才暴露（2026-09-15 实测）。它是 normal 级权限，声明即在安装时自动授予。
const DEFAULT_PERMISSIONS = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
  "android.permission.INTERNET",
  "android.permission.MANAGE_EXTERNAL_STORAGE",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.RECEIVE_BOOT_COMPLETED",
  "android.permission.REORDER_TASKS",
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

// versionCode 由版本号推出来，不单独维护：两个要人同步的数字必然有一天对不上，
// 而 Android 只看 versionCode，对不上的后果是「明明装了新包，系统认为是旧的」。
function deriveVersionCode(versionName) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(versionName);
  if (!match) {
    throw new Error(
      "版本号必须形如 0.6.0（三段数字），当前为: " + versionName
    );
  }
  return (
    Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3])
  );
}

// package.json 的 version 与 src/config/version-autojs.js 必须一致：
// 前者是 Git 标签对齐的依据（见 RULES.md 分支规则），后者是设备上显示的版本。
// 两边不一致就意味着「设备上显示 0.6.0，标签打的却是 0.5.0」，
// 那时候谁也说不清手里这个包到底是什么。宁可现在拒绝生成。
function assertVersionInSync(versionName) {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8").replace(/^﻿/, "")
  );
  if (packageJson.version !== versionName) {
    throw new Error(
      "版本号不一致：package.json 是 " + packageJson.version +
        "，src/config/version-autojs.js 是 " + versionName +
        "。改版本要同时改这两处"
    );
  }
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

// 默认值来自 src/config/version-autojs.js，那是版本号的唯一事实来源。
// 原先这里硬编码 "1.0.0"，于是每个包的版本名都一样，装完谁也看不出装的是哪一轮。
const versionName = readArgument("--version-name", appVersion.name);
if (versionName === appVersion.name) {
  assertVersionInSync(versionName);
} else {
  // 显式覆盖是留给临时包的（比如给人试一版而不想动版本号），但必须吵一声：
  // 打出来的包和仓库里写的版本对不上，事后翻起来只会更费劲。
  console.warn(
    "警告: --version-name 覆盖了配置里的 " + appVersion.name +
      "，这个包与仓库记录的版本对不上"
  );
}
const versionCode = Number(
  readArgument("--version-code", String(deriveVersionCode(versionName)))
);
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

// 菜单是第二个入口，由 main.js 在主线程拉起（原因见 src/entry/main-autojs.js）。
// 文件名必须与入口里的 MENU_SCRIPT 一致，且与 main.js 同级；漏了它 APK 点开什么都不出。
const menuBundlePath = path.join(projectRoot, "dist/menu-autojs.js");
if (!fs.existsSync(menuBundlePath)) {
  throw new Error("缺少菜单构建产物，请先执行 npm run build: " + menuBundlePath);
}
fs.copyFileSync(menuBundlePath, path.join(outputDir, "menu-autojs.js"));

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
