// =====================================================================
// 通用能力：把 MediaProjection 截图授权提升为「一次脚本会话一份」
// 设计约束：
//   - 截图授权在 Android 10 无法记住，但它是**按会话**的：只要脚本进程不退出、
//     MediaProjection 会话不释放，就一直有效。所以「少弹几次」的唯一办法
//     是让整个脚本会话共用同一份授权，而不是每跑一个任务重新申请一次
//   - 此前 screen 模块把 permissionGranted 放在自己的闭包里，而 screen 是
//     runtime.run() 内部创建的——等于每跑一个任务就新建一次、重新申请一次。
//     2026-09-16 实测：同一个 APP、同一个进程连跑两次 environment-check，
//     第二次照样弹授权窗
//   - 状态放在模块级变量里。打包器的 require 带 cache，所以模块级变量
//     在同一个脚本引擎内天然是单例，不需要把对象一路传下去
//   - 无障碍服务解决的是「点击」，本模块解决的是「看见」。两者不能互相替代：
//     Android 10 的无障碍服务没有截屏能力（takeScreenshot 是 API 30 才加的），
//     而游戏是 H5 画布、没有控件树可读，所以找图必须靠截图
// =====================================================================

var errors = require("./errors-autojs.js");

var granted = false;
var grantedAt = 0;

// 申请授权。已经拿到过就直接复用，不再打扰人。
function request(logger, captureConfig) {
  if (granted) {
    if (logger) logger.info("复用本次会话已有的截图授权");
    return false;
  }

  if (logger) logger.info("申请 MediaProjection 截图权限");

  var config = captureConfig || {};
  var ok;
  if (config.width && config.height) {
    ok = requestScreenCapture(config.width, config.height);
  } else if (typeof config.landscape === "boolean") {
    // 兼容旧配置，默认不要用。在强制横屏的设备上传 true 会拿到竖屏画布，
    // 横屏画面被等比缩小成上下加黑边的窄带（已在 720x1280 横屏云机上复现）。
    ok = requestScreenCapture(config.landscape);
  } else {
    // 默认不传参，由 AutoJs6 按当前屏幕方向建立画布，截图尺寸与点击坐标空间一致。
    ok = requestScreenCapture();
  }

  if (!ok) {
    // 环境问题：人没点授权，或系统没弹出来。不是用例的错。
    throw errors.broken("截图权限未授予");
  }

  granted = true;
  grantedAt = Date.now();
  return true;
}

function isGranted() {
  return granted;
}

function grantedAtMs() {
  return grantedAt;
}

// 会话失效时调用，下次 request 会重新申请。
// 目前有一个已知触发点：授权时建立的画布方向与当前屏幕不一致
// （授权在竖屏、之后游戏转了横屏）。那种情况下继续用会静默点偏，
// 必须作废重来，宁可多弹一次窗。
function invalidate(reason, logger) {
  if (!granted) return;
  granted = false;
  grantedAt = 0;
  if (logger) logger.warn("截图会话已作废，下次将重新申请: " + reason);
}

module.exports = {
  request: request,
  isGranted: isGranted,
  grantedAtMs: grantedAtMs,
  invalidate: invalidate
};
