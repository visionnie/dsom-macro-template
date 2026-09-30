// =====================================================================
// 通用能力：在**当前真实画面**上拖一个十字，拾取/修正一个点击坐标
// 设计约束：
//   - 录制时的截图与回放时的画面可能不是一回事。对着旧截图挪点击点治不了
//     "那一刻界面变了"，所以必须能对着此刻的真实画面改。见 STEP-DEBUG.md
//   - 与录制捕获层**正好相反**：那一层收到触摸要转发给游戏，这一层要**吃掉**触摸——
//     手指是在拖十字，不是在操作游戏。所以它可触摸、且不转发
//   - 四个窗口拼出来，每一个都只用已经在真机上验过的形态：
//       catcher  全屏可触摸，根节点带 id、不写宽高（findView 可用，同录制捕获层）
//       hbar/vbar 纯色条，尺寸一律 setSize（同 tap-marker，连 findView 都不需要）
//       panel    竖排文字 + 点击监听（同录制控制条）
//     不用 canvas：悬浮窗里拿到的是原生 View，没有 .on("draw") 那套
//   - 本模块不含游戏语义，也不碰会话数据：只负责"拿到一个点"，写回由调用方做
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");

var ARM_PX = 120;
var THICK_PX = 3;
// 面板尺寸按像素给。宽度不够会把「取消/确定」那一行挤出窗口——
// 2026-09-17 实机第一版就是这样：420 宽时读数折成两行，按钮整排看不见。
// 窄屏上再按屏幕宽收窄，别让面板比屏幕还宽。
var PANEL_WIDTH = 780;
var PANEL_HEIGHT = 190;
// 窗口 attach 之前 setSize / setPosition 会抛 NullPointerException，只能重试等就绪。
var READY_WAIT_MS = 2000;
var UI_CALL_WAIT_MS = 1500;
var POLL_MS = 30;
var NUDGE_PX = 2;
// 看门狗：全屏可触摸的图层会吃掉屏幕上**所有**触摸。忘了关、或者脚本页在后台被回收，
// 整台设备就只剩物理键能用了（2026-09-17 实机踩到：图层一直开着，
// 连 AutoJs6 都点不动，最后只能 kill -9）。所以它必须能自己关掉。
var AUTO_CLOSE_MS = 180000;
var WATCHDOG_POLL_MS = 500;

var BAR_LAYOUT = '<frame id="root" bg="#ffff1744"/>';
// 淡淡一层：要看得见底下的真实画面，又要让人知道自己在取点模式里。
var CATCHER_LAYOUT = '<frame id="root" bg="#22000000" w="*" h="*"/>';
var PANEL_LAYOUT = [
  '<vertical id="root" bg="#e6000000" padding="12 10">',
  '  <text id="readout" text="" textColor="#ffffff" textSize="15sp"/>',
  '  <text id="tips" text="拖动改点　方向键微调 2 像素" textColor="#9e9e9e" textSize="11sp" marginTop="2"/>',
  '  <horizontal marginTop="6">',
  '    <text id="leftBtn" text=" ← " textColor="#90caf9" textSize="18sp" padding="10 4"/>',
  '    <text id="upBtn" text=" ↑ " textColor="#90caf9" textSize="18sp" padding="10 4"/>',
  '    <text id="downBtn" text=" ↓ " textColor="#90caf9" textSize="18sp" padding="10 4"/>',
  '    <text id="rightBtn" text=" → " textColor="#90caf9" textSize="18sp" padding="10 4"/>',
  '    <text id="cancelBtn" text=" 取消 " textColor="#ff8a80" textSize="16sp" padding="12 4"/>',
  '    <text id="okBtn" text=" 确定 " textColor="#69f0ae" textSize="16sp" padding="12 4"/>',
  "  </horizontal>",
  "</vertical>"
].join("\n");

function runOnUi(action) {
  uiThread.run(action, UI_CALL_WAIT_MS);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// options: { x, y, logger, title }
// onDone(point)：确定时给 { x, y }，取消时给 null。回调在工作线程上触发。
//
// **必须从工作线程调用**：内部要 sleep 等窗口 attach。
function open(options, onDone) {
  var opts = options || {};
  var logger = opts.logger;
  var pointX = clamp(Math.round(opts.x || 0), 0, device.width - 1);
  var pointY = clamp(Math.round(opts.y || 0), 0, device.height - 1);
  var screenWidth = device.width;
  var screenHeight = device.height;

  var catcher = null;
  var hbar = null;
  var vbar = null;
  var panel = null;
  var closed = false;
  var finished = false;

  function closeAll() {
    if (closed) return;
    closed = true;
    var windows = [catcher, hbar, vbar, panel];
    try {
      runOnUi(function () {
        for (var i = 0; i < windows.length; i++) {
          if (!windows[i]) continue;
          try {
            windows[i].close();
          } catch (error) {}
        }
      });
    } catch (error) {
      if (logger) logger.warn("取点图层关闭失败: " + error);
    }
  }

  // reason: "ok" / "cancel" / "timeout" / "rotated"
  function finish(point, reason) {
    if (finished) return;
    finished = true;
    closeAll();
    // 回调放到工作线程：调用方通常要存盘、切前台，这些都不能在界面线程上做。
    threads.start(function () {
      try {
        onDone(point, reason || (point ? "ok" : "cancel"));
      } catch (error) {
        if (logger) logger.warn("取点回调出错: " + error);
      }
    });
  }

  // 读数要短：太长会在面板里折行，把按钮那一排挤出窗口。
  function describe() {
    return (
      "(" + pointX + "," + pointY + ")　" +
      (Math.round((pointX / screenWidth) * 1000) / 10) + "%, " +
      (Math.round((pointY / screenHeight) * 1000) / 10) + "%"
    );
  }

  var readoutView = null;

  // 十字与读数一起刷。两个条放在同一个 runnable 里摆，避免先移一根再移另一根时抖一下。
  function refresh() {
    var halfArm = Math.floor(ARM_PX / 2);
    var halfThick = Math.floor(THICK_PX / 2);
    var text = describe();
    try {
      runOnUi(function () {
        hbar.setPosition(pointX - halfArm, pointY - halfThick);
        vbar.setPosition(pointX - halfThick, pointY - halfArm);
        if (readoutView) readoutView.setText(text);
      });
    } catch (error) {
      if (logger) logger.warn("取点图层刷新失败: " + error);
    }
  }

  function moveTo(x, y) {
    pointX = clamp(Math.round(x), 0, screenWidth - 1);
    pointY = clamp(Math.round(y), 0, screenHeight - 1);
    refresh();
  }

  function nudge(dx, dy) {
    moveTo(pointX + dx, pointY + dy);
  }

  // 创建都在界面线程上做，与录制器一致。
  runOnUi(function () {
    catcher = floaty.rawWindow(CATCHER_LAYOUT);
    hbar = floaty.rawWindow(BAR_LAYOUT);
    vbar = floaty.rawWindow(BAR_LAYOUT);
    panel = floaty.rawWindow(PANEL_LAYOUT);
  });

  // attach 之前所有尺寸/位置操作都会抛，重试到不抛为止。
  var deadline = Date.now() + READY_WAIT_MS;
  while (true) {
    try {
      runOnUi(function () {
        catcher.setSize(-1, -1);
        catcher.setPosition(0, 0);
        catcher.setTouchable(true);
        hbar.setTouchable(false);
        vbar.setTouchable(false);
        hbar.setSize(ARM_PX, THICK_PX);
        vbar.setSize(THICK_PX, ARM_PX);
        panel.setTouchable(true);
        panel.setSize(Math.min(PANEL_WIDTH, screenWidth), PANEL_HEIGHT);
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        closeAll();
        throw error;
      }
      sleep(POLL_MS * 2);
    }
  }

  // 面板摆在离当前点远的那一半，别一上来就压住要改的地方。
  // 只在打开时定一次：拖动中面板跟着跳会让人抓不住它。
  var panelTop = pointY < screenHeight / 2 ? screenHeight - PANEL_HEIGHT : 0;

  runOnUi(function () {
    panel.setPosition(0, panelTop);
    readoutView = panel.findView("readout");
    var rootView = catcher.findView("root");
    var okView = panel.findView("okBtn");
    var cancelView = panel.findView("cancelBtn");
    var leftView = panel.findView("leftBtn");
    var rightView = panel.findView("rightBtn");
    var upView = panel.findView("upBtn");
    var downView = panel.findView("downBtn");

    var missing = [];
    if (!rootView) missing.push("catcher.root");
    if (!readoutView) missing.push("panel.readout");
    if (!okView) missing.push("panel.okBtn");
    if (!cancelView) missing.push("panel.cancelBtn");
    if (missing.length > 0) {
      throw new Error("取点图层控件未找到: " + missing.join(", "));
    }

    // 吃掉触摸，不转发：这一层就是用来拖十字的。
    // 以下回调全部跑在界面线程上。moveTo/finish 里的窗口操作走 uiThread.run，
    // 而它在界面线程上是就地执行、不 sleep、不等待——所以这里直接调是安全的。
    // （拖动一次会来几十个 MOVE 事件，每个都开线程的话线程会爆。）
    rootView.setOnTouchListener(function (view, event) {
      var action = event.getAction();
      if (action === event.ACTION_DOWN || action === event.ACTION_MOVE ||
          action === event.ACTION_UP) {
        // getRawX/getRawY 是屏幕坐标，与 press 用的是同一套（录制器靠这一点转发点击）。
        moveTo(event.getRawX(), event.getRawY());
      }
      return true;
    });

    okView.setOnClickListener(function () {
      finish({ x: pointX, y: pointY });
    });
    cancelView.setOnClickListener(function () {
      finish(null);
    });
    if (leftView) leftView.setOnClickListener(function () { nudge(-NUDGE_PX, 0); });
    if (rightView) rightView.setOnClickListener(function () { nudge(NUDGE_PX, 0); });
    if (upView) upView.setOnClickListener(function () { nudge(0, -NUDGE_PX); });
    if (downView) downView.setOnClickListener(function () { nudge(0, NUDGE_PX); });
  });

  refresh();
  if (logger) logger.info("取点图层已就绪: " + describe());

  // 看门狗：超时自己关，转屏也自己关。
  // 转屏之后十字和面板的位置都是按旧尺寸摆的，取到的坐标也不再对应同一个界面，
  // 留着只会误导人——直接当取消处理。
  threads.start(function () {
    var deadline = Date.now() + AUTO_CLOSE_MS;
    var bornWidth = device.width;
    var bornHeight = device.height;
    while (!finished) {
      sleep(WATCHDOG_POLL_MS);
      if (finished) return;
      if (device.width !== bornWidth || device.height !== bornHeight) {
        if (logger) logger.warn("取点期间屏幕转向了，图层已关闭");
        finish(null, "rotated");
        return;
      }
      if (Date.now() >= deadline) {
        if (logger) logger.warn("取点图层超时未确认，已自动关闭");
        finish(null, "timeout");
        return;
      }
    }
  });

  return {
    close: function () {
      finish(null, "cancel");
    }
  };
}

module.exports = {
  open: open
};
