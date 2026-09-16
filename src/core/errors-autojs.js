// =====================================================================
// 通用能力：给错误打上「环境问题」标记，让报告能把 broken 与 failed 分开统计
// 设计约束：
//   - broken 表示环境或前置条件不成立（权限没给、应用起不来、素材缺失、
//     屏幕方向不对），不是业务缺陷；failed 才是用例真的没通过
//   - 两者混在一起统计，通过率会失去意义，人也会渐渐不再相信这份报告
//   - 只用一个字符串字段标记，不引入自定义 Error 子类：
//     Rhino 下继承 Error 的行为不完全可靠，instanceof 判断会漏
// =====================================================================

var BROKEN_KIND = "broken";
// 人主动按了暂停页上的「终止」。既不是业务失败也不是环境问题，
// 混进任何一边都会污染统计——报告里得看得出「这次是人自己叫停的」。
var CANCELLED_KIND = "cancelled";

// 造一个已标记为环境问题的错误。
function broken(message) {
  var error = new Error(message);
  error.kind = BROKEN_KIND;
  return error;
}

// 给已有错误补上标记，返回原对象，便于 `throw markBroken(error)` 就地转换。
function markBroken(error) {
  if (error && typeof error === "object") {
    error.kind = BROKEN_KIND;
  }
  return error;
}

function isBroken(error) {
  return !!(error && error.kind === BROKEN_KIND);
}

// 造一个「人主动终止」的错误。由 run-control 的检查点抛出。
function cancelled(message) {
  var error = new Error(message);
  error.kind = CANCELLED_KIND;
  return error;
}

function isCancelled(error) {
  return !!(error && error.kind === CANCELLED_KIND);
}

// 供运行时把异常翻译成 result.status。
// 顺序有讲究：cancelled 要先判，它不该被算成 failed。
function statusOf(error) {
  if (isCancelled(error)) return CANCELLED_KIND;
  return isBroken(error) ? BROKEN_KIND : "failed";
}

module.exports = {
  BROKEN_KIND: BROKEN_KIND,
  CANCELLED_KIND: CANCELLED_KIND,
  broken: broken,
  markBroken: markBroken,
  isBroken: isBroken,
  cancelled: cancelled,
  isCancelled: isCancelled,
  statusOf: statusOf
};
