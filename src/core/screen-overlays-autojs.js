// =====================================================================
// 通用能力：截图之前让常驻的悬浮层集体让开
// 设计约束：
//   - **截图会把悬浮层一起拍进去。** 运行控制条常驻在屏幕上，正好压住找图锚点时，
//     找图会稳定超时，而日志里只有一句"等待条件超时"——根本看不出是被自己挡的。
//     2026-09-17 实机踩到：控制条压住盒子「我的游戏」页的「热血封神H5」，第 3 步必失败
//   - 点击标记（tap-marker）不用登记：它在 tap 返回之前就自己收了，截图时本来就不在
//   - 取点图层也不用登记：取点是人在操作，期间不跑任务、不截图
//   - 让开与恢复都要等一帧真正生效：setVisibility / setSize 返回 != 画面已经更新，
//     这与录制器转发点击前必须等 setTouchable 生效是同一类问题（RECORDER.md 第 3 条坑）
//   - 任何一层出问题都不能连累截图本身：全部 try 住，让不开就照常拍
// =====================================================================

// 让开之后等的时间。这既要等画面更新，也要等窗口真的不再接收触摸——
// 后者更慢：录制器实测 setTouchable 生效要 250 毫秒左右（RECORDER.md 第 3 条坑），
// 收成 0x0 同理。找图轮询 1.5 秒一次、点击本身还有停顿，这点开销吃得下。
var SETTLE_MS = 150;

var entries = [];

// handle 需要提供 hideForCapture() / restoreAfterCapture()，都要是同步生效的。
function register(handle) {
  if (!handle) return function () {};
  entries.push(handle);
  return function unregister() {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] === handle) {
        entries.splice(i, 1);
        return;
      }
    }
  };
}

function count() {
  return entries.length;
}

// 返回 true 表示确实让开过，调用方拍完要记得 restore。
function hideForCapture() {
  if (entries.length === 0) return false;
  var hidden = false;
  for (var i = 0; i < entries.length; i++) {
    try {
      if (entries[i].hideForCapture()) hidden = true;
    } catch (error) {}
  }
  if (hidden) sleep(SETTLE_MS);
  return hidden;
}

function restoreAfterCapture() {
  for (var i = 0; i < entries.length; i++) {
    try {
      entries[i].restoreAfterCapture();
    } catch (error) {}
  }
}

module.exports = {
  SETTLE_MS: SETTLE_MS,
  register: register,
  count: count,
  hideForCapture: hideForCapture,
  restoreAfterCapture: restoreAfterCapture
};
