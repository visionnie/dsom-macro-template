// =====================================================================
// 通用能力：让悬浮层就地打字——拿键盘焦点，但不把人赶出游戏
//
// 为什么要有它：录制与编辑的一切操作都必须留在游戏画面上（用户 2026-10-01 明确要求）。
// 在这之前「改名」「填精确等待值」都要把 App 切回前台去打字，理由写在
// step-overlay 的文件头：floaty 窗口默认 NOT_FOCUSABLE、拿不到键盘焦点。
// 那条理由只对了一半——**窗口确实默认拿不到焦点，但它能要**。
//
// 2026-10-02 实机探针结论（AutoJs6 6.7.0 / SDK 29 / 720x1280 云机，游戏在前台）：
//   1. 本项目一直用的 `floaty.rawWindow` 身上就有 `requestFocus` / `disableFocus`
//   2. **必须在界面线程调**。工作线程直接调会抛
//      `CalledFromWrongThreadException`，而且抛完窗口仍是 NOT_FOCUSABLE——
//      表现是"输入框里光标在闪、字就是打不进去"，不报错也不留痕，
//      是这条链上最容易踩的一处静默失效
//   3. rawWindow 拿到焦点后 **NOT_TOUCH_MODAL 标志还在**，所以窗口外的触摸
//      照样落到游戏上，游戏点得动。`floaty.window` 不是：它拿焦点后那个标志没了，
//      全屏触摸都被它吃掉——同样是"能打字"，但代价是游戏点不动，等于白做
//   4. 拿焦点期间游戏仍是 `ResumedActivity`（dumpsys 实测），不会被顶到后台；
//      键盘焦点从游戏转到悬浮窗，游戏画面一动不动
//
// 用完必须还回去（`release`），并且有看门狗兜底：焦点攥在一个人已经不看的层上，
// 键盘和 BACK 就都归它了，而游戏那边表现成"按键没反应"，没人会往这儿想。
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");

var UI_CALL_WAIT_MS = 1500;
// 焦点最多攥这么久。点开改名又跑去玩游戏是常事，三分钟够打完一个名字了。
var HOLD_LIMIT_MS = 180000;
var WATCH_POLL_MS = 1000;

function inputMethodManager() {
  return context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
}

// window 是 floaty.rawWindow 的返回值。options: { logger, holdLimitMs, onAutoRelease }
function attach(window, options) {
  var opts = options || {};
  var logger = opts.logger;
  var holdLimitMs = opts.holdLimitMs || HOLD_LIMIT_MS;

  var focused = false;
  var watching = false;
  var deadline = 0;
  var lastView = null;

  function warn(text) {
    if (logger) logger.warn("悬浮层键盘: " + text);
  }

  // 看门狗只在攥着焦点期间活着，退出条件写在循环里，别留一个永不收口的线程。
  function startWatchdog() {
    if (watching) return;
    watching = true;
    threads.start(function () {
      try {
        while (focused) {
          sleep(WATCH_POLL_MS);
          if (!focused) break;
          if (Date.now() >= deadline) {
            warn("焦点攥太久，自动还回去");
            release();
            if (opts.onAutoRelease) {
              try { opts.onAutoRelease(); } catch (error) {}
            }
            break;
          }
        }
      } finally {
        watching = false;
      }
    });
  }

  // 要焦点 + 把光标落到 view 上 + 弹键盘。三步缺一不可：
  // 只要窗口焦点，光标不在输入框上，输入法不会接；只给输入框要焦点而窗口仍
  // NOT_FOCUSABLE，光标看着在、字打不进去。
  function focus(view) {
    try {
      uiThread.run(function () {
        window.requestFocus();
        if (view) {
          view.setFocusableInTouchMode(true);
          view.requestFocus();
          try {
            inputMethodManager().showSoftInput(
              view,
              android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT
            );
          } catch (error) {
            warn("弹键盘失败: " + error);
          }
        }
      }, UI_CALL_WAIT_MS);
    } catch (error) {
      warn("要焦点失败: " + error);
      return false;
    }
    lastView = view || null;
    focused = true;
    deadline = Date.now() + holdLimitMs;
    startWatchdog();
    return true;
  }

  // 人还在打字就把看门狗往后推一推。
  function keepAlive() {
    if (focused) deadline = Date.now() + holdLimitMs;
  }

  function isFocused() {
    return focused;
  }

  // 收键盘 + 还焦点。**重复调用安全**：关层、确定、取消、看门狗都会调到它。
  function release() {
    if (!focused) return;
    focused = false;
    var view = lastView;
    lastView = null;
    try {
      uiThread.run(function () {
        if (view) {
          try {
            inputMethodManager().hideSoftInputFromWindow(view.getWindowToken(), 0);
          } catch (error) {}
          try { view.clearFocus(); } catch (error) {}
        }
        window.disableFocus();
      }, UI_CALL_WAIT_MS);
    } catch (error) {
      warn("还焦点失败: " + error);
    }
  }

  return {
    focus: focus,
    release: release,
    keepAlive: keepAlive,
    isFocused: isFocused
  };
}

module.exports = {
  HOLD_LIMIT_MS: HOLD_LIMIT_MS,
  attach: attach
};
