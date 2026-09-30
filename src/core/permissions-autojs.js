// =====================================================================
// 通用能力：集中查看与跳转开启脚本需要的系统权限
// 设计约束：
//   - 只查状态、只跳系统设置页，**不代替用户点同意**。授权动作必须由人完成
//   - 每一项都要能说清「不开会怎样」，否则人不知道该不该开
//   - 截图授权（MediaProjection）是个例外：Android 不允许预授权，它只能在
//     真正要用时弹、且 Android 10 不记住。所以本模块只报告它**本次会话**的状态，
//     没有「去开启」的入口——想少弹只能靠会话内复用（capture-session-autojs.js）
//   - 查不到状态不能让页面崩掉：一律降级成 unknown，让人自己去设置里看
// =====================================================================

var captureSession = require("./capture-session-autojs.js");

function packageName() {
  return context.getPackageName();
}

// ---- 无障碍服务：点击的基础 ----
// 我们和市面上的按键精灵用的是同一套机制——AutoJs6 的 press/click/swipe
// 都走无障碍服务派发手势。不开就完全点不动。
function accessibilityEnabled() {
  try {
    var enabled = android.provider.Settings.Secure.getString(
      context.getContentResolver(),
      "enabled_accessibility_services"
    );
    if (!enabled) return false;
    return String(enabled).indexOf(packageName() + "/") >= 0;
  } catch (error) {
    return null;
  }
}

function openAccessibilitySettings() {
  app.startActivity({ action: "android.settings.ACCESSIBILITY_SETTINGS" });
}

// ---- 悬浮窗：录制器的捕获层要用 ----
function overlayEnabled() {
  try {
    return android.provider.Settings.canDrawOverlays(context);
  } catch (error) {
    return null;
  }
}

function openOverlaySettings() {
  app.startActivity({
    action: "android.settings.action.MANAGE_OVERLAY_PERMISSION",
    data: "package:" + packageName()
  });
}

// ---- 电池优化白名单：直接关系到长任务会不会被腰斩 ----
// 2026-09-16 实测：BOSS 任务跑到一半，脚本页在后台被系统回收，任务被静默腰斩、
// 没有任何报错（ONBOARDING 第 24 条）。加进白名单能明显缓解这类回收。
function batteryOptimizationIgnored() {
  try {
    var power = context.getSystemService(android.content.Context.POWER_SERVICE);
    return power.isIgnoringBatteryOptimizations(packageName());
  } catch (error) {
    return null;
  }
}

function openBatterySettings() {
  // 先试直接请求本应用加白名单的页面；不被支持时退回电池优化总列表，
  // 让人自己找到本应用。两者都失败就抛给调用方提示。
  try {
    app.startActivity({
      action: "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      data: "package:" + packageName()
    });
  } catch (error) {
    app.startActivity({ action: "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS" });
  }
}

// ---- 截图授权：只能报告，不能预开 ----
function captureGranted() {
  return captureSession.isGranted();
}

// 统一的清单，界面直接照着渲染。
// status: true 已开 / false 未开 / null 查不到
// openable: 有没有「去设置」入口
function list() {
  return [
    {
      key: "accessibility",
      name: "无障碍服务",
      required: true,
      status: accessibilityEnabled(),
      openable: true,
      detail: "点击的基础。不开则完全点不动屏幕。"
    },
    {
      key: "overlay",
      name: "悬浮窗",
      required: false,
      status: overlayEnabled(),
      openable: true,
      detail: "录制用例时的捕获层要用。只跑已有用例可以不开。"
    },
    {
      key: "battery",
      name: "后台保活（电池优化白名单）",
      required: false,
      status: batteryOptimizationIgnored(),
      openable: true,
      detail: "不开时长任务可能跑到一半被系统回收，且没有任何报错。"
    },
    {
      key: "capture",
      name: "截图授权（本次会话）",
      required: true,
      status: captureGranted(),
      openable: false,
      detail: "找图要用。Android 不允许预先开启，只能在用到时弹窗确认；" +
        "授权后同一次脚本会话内不再重复弹。"
    }
  ];
}

function open(key) {
  if (key === "accessibility") return openAccessibilitySettings();
  if (key === "overlay") return openOverlaySettings();
  if (key === "battery") return openBatterySettings();
  throw new Error("该权限没有可跳转的设置页: " + key);
}

module.exports = {
  list: list,
  open: open,
  accessibilityEnabled: accessibilityEnabled,
  overlayEnabled: overlayEnabled,
  batteryOptimizationIgnored: batteryOptimizationIgnored,
  captureGranted: captureGranted
};
