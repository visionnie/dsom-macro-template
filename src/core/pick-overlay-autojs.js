// =====================================================================
// 通用能力：浮在游戏上的单选列表（选一条 -> 确定）
// 设计约束：
//   - **选任务不能把人甩出游戏**。原来的「切换任务」是收摊 + 把 App 切回前台，
//     而人正站在游戏里，只是想换一条录制跑（2026-09-26 用户反馈，参照自动按键精灵：
//     它的任务选择也是浮在游戏上的一个对话框）
//   - 选中与确定**分两步**：点一行只是选中，再点「确定」才生效。
//     直接点一行就换任务的话，误触一下就换走了，而这工具操作的是真实游戏
//   - 本模块不认识任务：只管显示行、回报选了第几行。拿什么去跑由调用方决定
//   - 行在 XML 里一次性生成：floaty 窗口里只有 findView，没有数据源绑定那一套
//   - 内容超出 setSize 会被**直接裁掉、不会把窗口撑开**：尺寸按像素给，宁可留白
//     （这个项目已经踩过三次，最近一次是单步面板的「确定」整行没了）
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");

var PANEL_WIDTH = 640;
var PANEL_MAX_HEIGHT = 900;
// 上下各留一截：游戏多半是横屏 720 高，写死一个竖屏才放得下的数会被裁。
var PANEL_VERTICAL_MARGIN = 120;
var MAX_ROWS = 60;

var READY_WAIT_MS = 2000;
var UI_CALL_WAIT_MS = 1500;
var POLL_MS = 30;
var TAP_SLOP_PX = 12;
var DEFAULT_LEFT = 24;
var DEFAULT_TOP_GAP = 24;

// 选中那一行的底色与前缀。只靠底色的话，浅色游戏画面透上来时不够明显，
// 所以再给一个勾；没选中的用等宽的全角空格占位，免得文字左右跳。
var ROW_BG_NORMAL = "#1affffff";
var ROW_BG_PICKED = "#4d2e7d32";
var MARK_PICKED = "✔ ";
var MARK_NORMAL = "　";

function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function statusBarHeight() {
  try {
    var resources = context.getResources();
    var id = resources.getIdentifier("status_bar_height", "dimen", "android");
    if (id > 0) return resources.getDimensionPixelSize(id);
  } catch (error) {}
  return 48;
}

function buildLayout(rows, pickedIndex) {
  var lines = [
    '<vertical id="root" bg="#f2101418">',
    '  <horizontal id="header" bg="#f21b262e" gravity="center_vertical" padding="8 6">',
    // 抓手单独给一个控件：触摸会被子控件先吃掉，挂在根节点上几乎拖不动。
    '    <text id="dragGrip" text=" ⠿ " textColor="#9e9e9e" textSize="16sp" padding="6 2"/>',
    '    <text id="title" text="" textColor="#ffffff" textSize="14sp" layout_weight="1"/>',
    '    <text id="closeBtn" text=" × " textColor="#ff8a80" textSize="16sp" padding="10 2"/>',
    "  </horizontal>",
    '  <text id="hint" text="" textColor="#b0bec5" textSize="11sp" padding="10 6"/>',
    '  <ScrollView id="listScroll" layout_weight="1">',
    '    <vertical id="rowBox" padding="8 0">'
  ];
  for (var i = 0; i < rows.length && i < MAX_ROWS; i++) {
    var picked = i === pickedIndex;
    lines.push(
      '      <vertical id="row' + i + '" bg="' + (picked ? ROW_BG_PICKED : ROW_BG_NORMAL) +
        '" padding="10 8" marginTop="4">'
    );
    lines.push(
      '        <text id="rowTitle' + i + '" text="' +
        escapeXml((picked ? MARK_PICKED : MARK_NORMAL) + rows[i].title) +
        '" textColor="#ffffff" textSize="13sp"/>'
    );
    lines.push(
      '        <text id="rowSub' + i + '" text="' + escapeXml(rows[i].subtitle) +
        '" textColor="#b0bec5" textSize="11sp" marginTop="2"/>'
    );
    lines.push("      </vertical>");
  }
  return lines
    .concat([
      "    </vertical>",
      "  </ScrollView>",
      '  <horizontal id="footer" bg="#f21b262e" gravity="center_vertical" padding="8 6">',
      '    <text id="cancelBtn" text=" 取消 " textColor="#b0bec5" textSize="15sp" padding="14 6"/>',
      '    <text id="msg" text="" textColor="#ffd54f" textSize="11sp" layout_weight="1" marginLeft="8"/>',
      '    <text id="okBtn" text=" 确定 " textColor="#69f0ae" textSize="16sp" padding="16 6"/>',
      "  </horizontal>",
      "</vertical>"
    ])
    .join("\n");
}

// options: {
//   logger, title, hint,
//   rows: [{ title, subtitle }],
//   pickedIndex,                    // 进来时默认选中哪一行，-1 表示都不选
//   onConfirm(index),               // 点「确定」；本层已经自己关掉了
//   onCancel()                      // 点「取消」或「×」；本层已经自己关掉了
// }
// 回调都在界面线程上触发：要 sleep 的自己开线程。
//
// **必须从工作线程调用**：建窗口要等 attach。建不出来返回 null。
function open(options) {
  var opts = options || {};
  var logger = opts.logger;
  var rows = opts.rows || [];
  var picked = typeof opts.pickedIndex === "number" ? opts.pickedIndex : -1;
  var window = null;
  var views = null;
  var closed = false;
  var topOffset = statusBarHeight();
  var posX = DEFAULT_LEFT;
  var posY = topOffset + DEFAULT_TOP_GAP;
  var shapeWidth = PANEL_WIDTH;
  var shapeHeight = PANEL_WIDTH;

  function warn(text) {
    if (logger) logger.warn("选择浮层: " + text);
  }

  function runOnUi(action) {
    uiThread.run(action, UI_CALL_WAIT_MS);
  }

  function panelHeight() {
    var room = device.height - PANEL_VERTICAL_MARGIN;
    return Math.max(360, Math.min(PANEL_MAX_HEIGHT, room));
  }

  function clampPosition() {
    var maxX = Math.max(0, device.width - shapeWidth);
    var maxY = Math.max(topOffset, device.height - shapeHeight);
    if (posX < 0) posX = 0;
    if (posX > maxX) posX = maxX;
    if (posY < topOffset) posY = topOffset;
    if (posY > maxY) posY = maxY;
  }

  function close() {
    if (closed) return;
    closed = true;
    try {
      runOnUi(function () {
        try { window.close(); } catch (error) {}
      });
    } catch (error) {}
  }

  function repaintRow(index) {
    var row = window.findView("row" + index);
    var titleView = views.rowTitles[index];
    if (!row || !titleView) return;
    var isPicked = index === picked;
    try {
      row.setBackgroundColor(colors.parseColor(isPicked ? ROW_BG_PICKED : ROW_BG_NORMAL));
    } catch (error) {}
    titleView.setText((isPicked ? MARK_PICKED : MARK_NORMAL) + rows[index].title);
  }

  function pick(index) {
    if (index === picked) return;
    var previous = picked;
    picked = index;
    if (previous >= 0) repaintRow(previous);
    repaintRow(index);
    views.msg.setText("");
  }

  function attachDrag(view) {
    var grabX = 0;
    var grabY = 0;
    var startX = 0;
    var startY = 0;
    var moved = false;
    view.setOnTouchListener(function (v, event) {
      var action = event.getAction();
      var rawX = event.getRawX();
      var rawY = event.getRawY();
      if (action === event.ACTION_DOWN) {
        grabX = rawX - posX;
        grabY = rawY - posY;
        startX = rawX;
        startY = rawY;
        moved = false;
        return true;
      }
      if (action === event.ACTION_MOVE) {
        if (Math.abs(rawX - startX) > TAP_SLOP_PX ||
            Math.abs(rawY - startY) > TAP_SLOP_PX) {
          moved = true;
        }
        if (moved) {
          posX = Math.round(rawX - grabX);
          posY = Math.round(rawY - grabY);
          clampPosition();
          try {
            window.setPosition(posX, posY);
          } catch (error) {}
        }
        return true;
      }
      return true;
    });
  }

  try {
    runOnUi(function () {
      window = floaty.rawWindow(buildLayout(rows, picked));
    });
  } catch (error) {
    warn("建不出来: " + error);
    return null;
  }

  shapeHeight = panelHeight();
  clampPosition();
  var deadline = Date.now() + READY_WAIT_MS;
  while (true) {
    try {
      runOnUi(function () {
        window.setTouchable(true);
        window.setSize(shapeWidth, shapeHeight);
        window.setPosition(posX, posY);
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        warn("窗口没能就绪: " + error);
        try {
          runOnUi(function () { window.close(); });
        } catch (closeError) {}
        return null;
      }
      sleep(POLL_MS * 2);
    }
  }

  try {
    runOnUi(function () {
      views = {
        title: window.findView("title"),
        hint: window.findView("hint"),
        msg: window.findView("msg"),
        dragGrip: window.findView("dragGrip"),
        closeBtn: window.findView("closeBtn"),
        cancelBtn: window.findView("cancelBtn"),
        okBtn: window.findView("okBtn"),
        rowTitles: []
      };
      var missing = [];
      for (var key in views) {
        if (key === "rowTitles") continue;
        if (!views[key]) missing.push(key);
      }
      if (missing.length > 0) {
        throw new Error("控件未找到: " + missing.join(", "));
      }

      views.title.setText(String(opts.title || "请选择"));
      views.hint.setText(
        rows.length === 0
          ? "一条都没有"
          : String(opts.hint || "点一条选中，再点「确定」")
      );

      for (var i = 0; i < rows.length && i < MAX_ROWS; i++) {
        var row = window.findView("row" + i);
        views.rowTitles.push(window.findView("rowTitle" + i));
        if (row) {
          // 闭包里要的是这一行的序号，不是循环结束后的 i。
          (function (index) {
            row.setOnClickListener(function () {
              pick(index);
            });
          })(i);
        }
      }

      attachDrag(views.dragGrip);

      views.closeBtn.setOnClickListener(function () {
        close();
        if (opts.onCancel) opts.onCancel();
      });
      views.cancelBtn.setOnClickListener(function () {
        close();
        if (opts.onCancel) opts.onCancel();
      });
      views.okBtn.setOnClickListener(function () {
        if (picked < 0 || picked >= rows.length) {
          views.msg.setText("先点一条");
          return;
        }
        var chosen = picked;
        close();
        if (opts.onConfirm) opts.onConfirm(chosen);
      });
    });
  } catch (error) {
    warn("接线失败: " + error);
    try {
      runOnUi(function () { window.close(); });
    } catch (closeError) {}
    return null;
  }

  return {
    close: close
  };
}

module.exports = {
  open: open
};
