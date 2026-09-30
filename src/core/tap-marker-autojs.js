// =====================================================================
// 通用能力：点击时在落点上闪一个红十字，让人看得见脚本点在哪
// 设计约束：
//   - 只是给人看的提示，绝不能影响任务本身。悬浮窗没权限、建不出来、
//     界面线程不响应，一律静默降级成"不显示"，不往上抛
//   - 悬浮层必须不可触摸，否则十字自己会把这一下点击吃掉（录制器踩过这个坑）
//   - **必须在 tap 返回之前收掉**：截图会把悬浮层一并拍进去，
//     十字留在画面上，下一步找图就是在一张被划花的图上找
//   - 十字由两个纯色窗口拼成，布局里不写任何宽高——尺寸一律由 setSize 给。
//     悬浮窗布局里写宽高会让 findView 返回 null（RECORDER.md 第 2 条坑），
//     这样连 findView 都不需要，少一处会 null 的地方
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");

var DEFAULT_DURATION_MS = 400;
// 十字的臂长与笔画粗细，单位是像素（setSize 收的就是像素）。
var ARM_PX = 90;
var THICK_PX = 5;
// 窗口 attach 之前 setSize / setPosition 会抛 NullPointerException，
// 没有别的办法判断就绪，只能重试到不抛为止。
var READY_WAIT_MS = 1500;
var UI_CALL_WAIT_MS = 1000;
var POLL_MS = 30;
// 根节点带 id、不写宽高：这是录制器实测下来 findView / setSize 都正常的形状。
var BAR_LAYOUT = '<frame id="root" bg="#ffff1744"/>';

// 派到界面线程并等它做完，异常带回来（见 ui-thread-autojs.js）。
// 从界面线程调用会在它的 sleep 上抛错，本模块一律接住并关掉标记——
// 任务不会因为一个提示功能而失败。
function runOnUi(action) {
  uiThread.run(action, UI_CALL_WAIT_MS);
}

// options.durationMs：十字停留多久，0 或负数表示不显示。
function create(options) {
  var opts = options || {};
  var logger = opts.logger;
  var durationMs = opts.durationMs == null ? DEFAULT_DURATION_MS : opts.durationMs;
  var enabled = durationMs > 0;
  var bars = null;
  var shownAt = 0;
  var visible = false;

  function warn(text) {
    if (logger) logger.warn(text);
  }

  function disable(reason) {
    enabled = false;
    visible = false;
    warn("点击标记已关闭，任务照常进行: " + reason);
    closeBars();
  }

  function closeBars() {
    if (!bars) return;
    var closing = bars;
    bars = null;
    try {
      runOnUi(function () {
        for (var i = 0; i < closing.length; i++) {
          try {
            closing[i].close();
          } catch (error) {}
        }
      });
    } catch (error) {
      // 关不掉就算了：脚本结束时悬浮窗会跟着回收。
    }
  }

  function ensureBars() {
    if (bars) return bars;
    var created = [];
    // 与录制器一致：悬浮窗在界面线程上创建。
    runOnUi(function () {
      created.push(floaty.rawWindow(BAR_LAYOUT));
      created.push(floaty.rawWindow(BAR_LAYOUT));
    });

    var deadline = Date.now() + READY_WAIT_MS;
    while (true) {
      try {
        runOnUi(function () {
          for (var i = 0; i < created.length; i++) {
            created[i].setTouchable(false);
            // 先收成 0 尺寸藏起来，免得建好的一瞬间在左上角闪一下。
            created[i].setSize(0, 0);
            created[i].setPosition(0, 0);
          }
        });
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          runOnUi(function () {
            for (var i = 0; i < created.length; i++) {
              try {
                created[i].close();
              } catch (closeError) {}
            }
          });
          throw error;
        }
        sleep(POLL_MS * 2);
      }
    }

    bars = created;
    return bars;
  }

  // 在 (x, y) 显示十字。坐标就是 press 用的屏幕坐标：
  // 悬浮窗的位置与触摸的 getRawX/getRawY 同一个坐标系（录制器靠这一点转发点击）。
  function show(x, y) {
    if (!enabled) return;
    try {
      var current = ensureBars();
      var left = Math.round(x);
      var top = Math.round(y);
      var halfArm = Math.floor(ARM_PX / 2);
      var halfThick = Math.floor(THICK_PX / 2);
      // 两个窗口在同一个 runnable 里摆好，避免先移后放大时在旧位置闪一帧。
      runOnUi(function () {
        current[0].setSize(ARM_PX, THICK_PX);
        current[0].setPosition(left - halfArm, top - halfThick);
        current[1].setSize(THICK_PX, ARM_PX);
        current[1].setPosition(left - halfThick, top - halfArm);
      });
      shownAt = Date.now();
      visible = true;
    } catch (error) {
      disable(error && error.message ? error.message : String(error));
    }
  }

  // 收掉十字。**会先把它留够 durationMs**：点击本身只有一百多毫秒，
  // 立刻收人根本看不见。这段等待由调用方的 actionWaitMs 吸收，不额外拖慢任务。
  function hide() {
    if (!visible) return;
    var remaining = durationMs - (Date.now() - shownAt);
    if (remaining > 0) sleep(remaining);
    visible = false;
    var current = bars;
    if (!current) return;
    try {
      runOnUi(function () {
        current[0].setSize(0, 0);
        current[1].setSize(0, 0);
      });
    } catch (error) {
      disable(error && error.message ? error.message : String(error));
    }
  }

  function close() {
    visible = false;
    closeBars();
  }

  return {
    show: show,
    hide: hide,
    close: close,
    isEnabled: function () {
      return enabled;
    }
  };
}

module.exports = {
  DEFAULT_DURATION_MS: DEFAULT_DURATION_MS,
  create: create
};
