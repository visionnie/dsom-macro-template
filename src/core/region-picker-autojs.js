// =====================================================================
// 通用能力：在**当前真实画面**上拖一个矩形（框模板图 / 框限制区域）
// 设计约束：
//   - 与 point-picker 是同一套形状：全屏捕获层 + 几个纯色条 + 一个面板。
//     那套在真机上验过（2026-09-17），这里照它来，不另发明
//   - **吃掉触摸、不转发**：手指是在拖框，不是在操作游戏
//   - 框出来的是**当前屏幕像素**，本模块不做任何归一化——
//     换算成用例里的比例是 recorded-case 的事，两处各算一遍必然算出两个结果
//   - 看门狗必须有：全屏可触摸的图层忘了关，整台设备就只剩物理键能用
//     （point-picker 踩过，见它的文件头）
//   - 面板尺寸按像素给，宁可留白：内容超出 setSize 会被直接裁掉
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");

var EDGE_PX = 3;
// 面板宽度不够时「取消 / 确定」会被挤出窗口，与 point-picker 同一个教训。
var PANEL_WIDTH = 780;
// **170 放不下**：2026-09-27 用户实机，标题 + 读数 + 提示 + 按钮四行算下来约 200 像素，
// 最底下那排「取消 / 用全屏 / 确定」整个被裁掉，人找不到地方确认。
// 这是本项目第五次踩「内容超出 setSize 会被直接裁掉」。
// 这次除了给够高度，还把提示挪到按钮那一行里去，少占一整行。
var PANEL_HEIGHT = 200;
var READY_WAIT_MS = 2000;
var UI_CALL_WAIT_MS = 1500;
var POLL_MS = 30;
// 太小的框几乎必然框到几个像素的纹理，换个画面就对不上。
// 与 recorded-case 的 ANCHOR_MIN_EDGE 同一个数，但这里只做提示，拒不拒绝由调用方定。
var MIN_EDGE_PX = 16;
var AUTO_CLOSE_MS = 180000;
var WATCHDOG_POLL_MS = 500;

var EDGE_LAYOUT = '<frame id="root" bg="#ff00e5ff"/>';
// 淡淡一层：要看得见底下的真实画面，又要让人知道自己在框选模式里。
var CATCHER_LAYOUT = '<frame id="root" bg="#22000000" w="*" h="*"/>';
var PANEL_LAYOUT = [
  '<vertical id="root" bg="#e6000000" padding="12 10">',
  '  <text id="title" text="" textColor="#ffffff" textSize="14sp"/>',
  '  <text id="readout" text="" textColor="#69f0ae" textSize="14sp" marginTop="2"/>',
  // 按钮那一行：取消在左、确定在右，中间用提示文字把两者撑开——
  // 提示单独占一行的话，四行内容必然超高，而超出去的正是这一排按钮。
  '  <horizontal gravity="center_vertical" marginTop="8">',
  '    <text id="cancelBtn" text=" 取消 " textColor="#ff8a80" textSize="16sp" padding="14 6"/>',
  '    <text id="tips" text="按住拖一个框" textColor="#9e9e9e" textSize="11sp" layout_weight="1" marginLeft="8"/>',
  '    <text id="fullBtn" text=" 用全屏 " textColor="#90caf9" textSize="15sp" padding="12 6"/>',
  '    <text id="okBtn" text=" 确定 " textColor="#69f0ae" textSize="16sp" padding="16 6"/>',
  "  </horizontal>",
  "</vertical>"
].join("\n");

function runOnUi(action) {
  uiThread.run(action, UI_CALL_WAIT_MS);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// options: { logger, title, allowFull, box }
//   allowFull：给不给「用全屏」那个按钮。框模板图时不给——全屏当模板没有意义。
//   box：上次框的位置 { left, top, width, height }，一进来就画出来；
//        直接点确定就是沿用它，拖一下才替换。
// onDone(box, reason)：确定时给 { left, top, width, height }（当前屏幕像素），
//   取消 / 超时 / 转屏时给 null。reason: "ok" / "cancel" / "timeout" / "rotated" / "full"
//   选了「用全屏」时 box 为 null、reason 为 "full"——那是"不限制区域"的意思，
//   与取消要分得开。
//
// **必须从工作线程调用**：内部要 sleep 等窗口 attach。
function open(options, onDone) {
  var opts = options || {};
  var logger = opts.logger;
  var screenWidth = device.width;
  var screenHeight = device.height;

  var catcher = null;
  var panel = null;
  var edges = [];
  var closed = false;
  var finished = false;
  // 还没拖过时为 null：没框就点确定要拦住，不能给调用方一个 0x0 的框。
  //
  // **上次框在哪，一进来就画出来**（2026-09-27 用户要求）：没有它，人根本
  // 无从知道上次框的是什么，只能凭印象重框——而重框的结果多半和上次不一样。
  // 直接点确定就是沿用上次那个框。
  var box = opts.box ? {
    left: clamp(Math.round(opts.box.left), 0, device.width),
    top: clamp(Math.round(opts.box.top), 0, device.height),
    width: Math.round(opts.box.width),
    height: Math.round(opts.box.height)
  } : null;
  var untouched = box !== null;
  var anchorX = 0;
  var anchorY = 0;
  var readoutView = null;

  function closeAll() {
    if (closed) return;
    closed = true;
    var windows = [catcher, panel].concat(edges);
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
      if (logger) logger.warn("框选图层关闭失败: " + error);
    }
  }

  function finish(result, reason) {
    if (finished) return;
    finished = true;
    closeAll();
    // 回调放工作线程：调用方通常要截图、裁剪、存盘，这些都不能在界面线程上做。
    threads.start(function () {
      try {
        onDone(result, reason || (result ? "ok" : "cancel"));
      } catch (error) {
        if (logger) logger.warn("框选回调出错: " + error);
      }
    });
  }

  function describe() {
    if (!box) return "还没框（按住屏幕拖一个框）";
    var small = box.width < MIN_EDGE_PX || box.height < MIN_EDGE_PX;
    return (untouched ? "上次的框　" : "") +
      box.width + "x" + box.height +
      "　起点 (" + box.left + "," + box.top + ")" +
      (small ? "　太小了" : "");
  }

  // 四条边摆到位。四个窗口一次摆完，避免先移一条再移另一条时抖。
  function refresh() {
    var text = describe();
    var current = box;
    try {
      runOnUi(function () {
        if (readoutView) readoutView.setText(text);
        if (edges.length < 4) return;
        if (!current) {
          for (var i = 0; i < 4; i++) {
            try { edges[i].setSize(0, 0); } catch (error) {}
          }
          return;
        }
        // 上、下、左、右
        edges[0].setSize(current.width, EDGE_PX);
        edges[0].setPosition(current.left, current.top);
        edges[1].setSize(current.width, EDGE_PX);
        edges[1].setPosition(current.left, current.top + current.height - EDGE_PX);
        edges[2].setSize(EDGE_PX, current.height);
        edges[2].setPosition(current.left, current.top);
        edges[3].setSize(EDGE_PX, current.height);
        edges[3].setPosition(current.left + current.width - EDGE_PX, current.top);
      });
    } catch (error) {
      if (logger) logger.warn("框选图层刷新失败: " + error);
    }
  }

  function updateBox(x2, y2) {
    untouched = false;
    var x = clamp(Math.round(x2), 0, screenWidth);
    var y = clamp(Math.round(y2), 0, screenHeight);
    var left = Math.min(anchorX, x);
    var top = Math.min(anchorY, y);
    box = {
      left: left,
      top: top,
      width: Math.abs(x - anchorX),
      height: Math.abs(y - anchorY)
    };
    refresh();
  }

  runOnUi(function () {
    catcher = floaty.rawWindow(CATCHER_LAYOUT);
    for (var i = 0; i < 4; i++) {
      edges.push(floaty.rawWindow(EDGE_LAYOUT));
    }
    panel = floaty.rawWindow(PANEL_LAYOUT);
  });

  // attach 之前所有尺寸 / 位置操作都会抛，重试到不抛为止。
  var deadline = Date.now() + READY_WAIT_MS;
  while (true) {
    try {
      runOnUi(function () {
        catcher.setSize(-1, -1);
        catcher.setPosition(0, 0);
        catcher.setTouchable(true);
        for (var i = 0; i < edges.length; i++) {
          edges[i].setTouchable(false);
          edges[i].setSize(0, 0);
        }
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

  runOnUi(function () {
    // 面板贴底：框选多半在画面中上部，贴底最不挡事。
    panel.setPosition(0, screenHeight - PANEL_HEIGHT);
    readoutView = panel.findView("readout");
    var titleView = panel.findView("title");
    var rootView = catcher.findView("root");
    var okView = panel.findView("okBtn");
    var cancelView = panel.findView("cancelBtn");
    var fullView = panel.findView("fullBtn");

    var missing = [];
    if (!rootView) missing.push("catcher.root");
    if (!readoutView) missing.push("panel.readout");
    if (!okView) missing.push("panel.okBtn");
    if (!cancelView) missing.push("panel.cancelBtn");
    if (!fullView) missing.push("panel.fullBtn");
    if (missing.length > 0) {
      throw new Error("框选图层控件未找到: " + missing.join(", "));
    }

    if (titleView) titleView.setText(String(opts.title || "框一个区域"));
    fullView.setVisibility(opts.allowFull ? 0 : 8);
    var tipsView = panel.findView("tips");
    if (tipsView && box) {
      tipsView.setText("拖一下替换，直接确定沿用");
    }

    // 以下回调全部跑在界面线程上；refresh 里的窗口操作走 uiThread.run，
    // 它在界面线程上是就地执行，直接调是安全的（拖一次会来几十个 MOVE 事件，
    // 每个都开线程的话线程会爆——point-picker 踩过）。
    rootView.setOnTouchListener(function (view, event) {
      var action = event.getAction();
      var rawX = event.getRawX();
      var rawY = event.getRawY();
      if (action === event.ACTION_DOWN) {
        anchorX = clamp(Math.round(rawX), 0, screenWidth);
        anchorY = clamp(Math.round(rawY), 0, screenHeight);
        updateBox(rawX, rawY);
        return true;
      }
      if (action === event.ACTION_MOVE || action === event.ACTION_UP) {
        updateBox(rawX, rawY);
        return true;
      }
      return true;
    });

    okView.setOnClickListener(function () {
      if (!box || box.width < MIN_EDGE_PX || box.height < MIN_EDGE_PX) {
        readoutView.setText(
          box ? "框太小了（至少 " + MIN_EDGE_PX + "x" + MIN_EDGE_PX + "）" : "先按住屏幕拖一个框"
        );
        return;
      }
      finish(box, "ok");
    });
    cancelView.setOnClickListener(function () {
      finish(null, "cancel");
    });
    fullView.setOnClickListener(function () {
      finish(null, "full");
    });
  });

  refresh();
  if (logger) logger.info("框选图层已就绪: " + (opts.title || ""));

  // 看门狗：超时自己关，转屏也自己关。转屏之后框的位置对应的已经不是同一个界面了。
  threads.start(function () {
    var watchdogDeadline = Date.now() + AUTO_CLOSE_MS;
    var bornWidth = device.width;
    var bornHeight = device.height;
    while (!finished) {
      sleep(WATCHDOG_POLL_MS);
      if (finished) return;
      if (device.width !== bornWidth || device.height !== bornHeight) {
        if (logger) logger.warn("框选期间屏幕转向了，图层已关闭");
        finish(null, "rotated");
        return;
      }
      if (Date.now() >= watchdogDeadline) {
        if (logger) logger.warn("框选图层超时未确认，已自动关闭");
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
  MIN_EDGE_PX: MIN_EDGE_PX,
  open: open
};
