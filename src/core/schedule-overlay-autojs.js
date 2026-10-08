// =====================================================================
// 通用能力：浮在游戏上的「定时执行设置」
// 设计约束：
//   - **定时要挂在这条任务身上，点几下就设完**。2026-10-04 用户反馈：原来那一页是
//     个长表单，时间点要手打 "09:00, 13:30, 21:00"，还混着调度项 ID、每天几次、
//     最小间隔、时间窗、前置任务五样东西——而其中间隔与时间窗一旦填了定时就根本不生效。
//     用户原话：「这怎么弄，不应该这么设计」「我根本测试不了」
//   - 所以这一层只放定时相关的东西：开关、时间点、重复日期。其余的留在 App 的高级设置里
//   - **时间点用加/删，不用打字**。点 ＋ 进时分选择，点 ✕ 删掉一个
//   - 参考产品（自动按键精灵）的时间选择是系统的 TimePickerDialog。floaty 不是
//     Activity，弹系统对话框要另一套窗口类型，所以这里在层内自己画一个时分选择，
//     交互目标一样：全程点击，不碰键盘
//   - **「每天执行请全选」**（用户 2026-10-04 定）：七天全选 = 每天。一天都不选
//     直接拒绝保存——存下去就是一条永远不会跑的调度项，而界面上看着像设好了
//   - 本模块不认识调度表：只收一份当前设置、回报一份新设置。存哪儿、怎么校验由调用方管
//   - 行在 XML 里一次性生成：floaty 窗口里只有 findView，没有数据源绑定那一套。
//     时间点槽位预先铺满 MAX_TIMES 个，多出来的设成 GONE
//   - 内容超出 setSize 会被**直接裁掉、不会把窗口撑开**：正文一律放进 ScrollView
//     （这个项目已经踩过六次，最近一次是倒计时把「暂停」挤出了窗口）
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");
var overlayKeyboard = require("./overlay-keyboard-autojs.js");

var PANEL_WIDTH = 660;
var PANEL_MAX_HEIGHT = 980;
// 上下各留一截：游戏多半是横屏 720 高，写死一个竖屏才放得下的数会被裁。
var PANEL_VERTICAL_MARGIN = 100;

// 一天最多几个时间点。12 个够用（每两小时一次还有富余），
// 槽位是预先铺好的，这个数直接决定窗口高度，不宜再大。
var MAX_TIMES = 12;
var CHIPS_PER_ROW = 3;
var CHIP_ROWS = MAX_TIMES / CHIPS_PER_ROW;

var READY_WAIT_MS = 2000;
var UI_CALL_WAIT_MS = 1500;
var POLL_MS = 30;
var TAP_SLOP_PX = 12;
var DEFAULT_LEFT = 24;
var DEFAULT_TOP_GAP = 24;

var WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
var WORKDAYS = [1, 2, 3, 4, 5];

// 与 run-overlay 用同一套字面量，不走 android.view.View.VISIBLE：
// 那一套在真机上跑了几十轮，没必要为了"看着正式一点"换一种写法再赌一次。
var VISIBLE = 0;
var GONE = 8;

var ON_BG = "#4d2e7d32";
var OFF_BG = "#1affffff";
var ON_COLOR = "#69f0ae";
var OFF_COLOR = "#b0bec5";
var CHIP_BG = "#332196f3";

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

function pad2(value) {
  return (value < 10 ? "0" : "") + value;
}

function formatHhMm(hour, minute) {
  return pad2(hour) + ":" + pad2(minute);
}

// "09:30" -> 570。认不出来返回 null，由调用方决定怎么办——
// 这里不抛：一条存坏了的时间点不该让整个层开不出来。
function parseHhMm(text) {
  // 中文输入法打出来的冒号是全角「：」，数字也可能是全角。不归一的话，
  // 人明明写对了格式却被判成非法——而他看屏幕上那行字跟正确的一模一样，
  // 根本不会想到是标点的问题。顺手把常见的几种分隔也认了（. 与空格）。
  var normalized = String(text == null ? "" : text)
    .trim()
    .replace(/[０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    })
    .replace(/[：．。\.\s]+/g, ":");
  // 光打四个数字（0930）也认：手机上少按一个符号就是少一次切输入法。
  if (/^[0-9]{4}$/.test(normalized)) {
    normalized = normalized.slice(0, 2) + ":" + normalized.slice(2);
  }
  var matched = /^([0-9]{1,2}):([0-9]{2})$/.exec(normalized);
  if (!matched) return null;
  var hour = parseInt(matched[1], 10);
  var minute = parseInt(matched[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

// 时间点按时刻排序并去重。人是一个一个加的，加出来的顺序未必是时间顺序，
// 而「09:00 21:30 13:00」这种排法看一眼就以为自己填错了。
function normalizeTimes(list) {
  var seen = {};
  var minutes = [];
  for (var i = 0; i < list.length; i++) {
    var value = parseHhMm(list[i]);
    if (value == null) continue;
    if (seen[value]) continue;
    seen[value] = true;
    minutes.push(value);
  }
  minutes.sort(function (a, b) {
    return a - b;
  });
  var result = [];
  for (var m = 0; m < minutes.length; m++) {
    result.push(formatHhMm(Math.floor(minutes[m] / 60), minutes[m] % 60));
  }
  return result;
}

function buildLayout() {
  var lines = [
    '<vertical id="root" bg="#f2101418">',
    '  <horizontal id="header" bg="#f21b262e" gravity="center_vertical" padding="8 6">',
    // 抓手单独给一个控件：触摸会被子控件先吃掉，挂在根节点上几乎拖不动。
    '    <text id="dragGrip" text=" ⠿ " textColor="#9e9e9e" textSize="16sp" padding="6 2"/>',
    '    <text id="title" text="定时执行设置" textColor="#ffffff" textSize="14sp" layout_weight="1"/>',
    '    <text id="closeBtn" text=" × " textColor="#ff8a80" textSize="16sp" padding="10 2"/>',
    "  </horizontal>",
    '  <ScrollView id="bodyScroll" layout_weight="1">',
    '    <vertical id="body" padding="12 8">',
    // mainBox 整块在"选时间"的时候收起来。
    //
    // **不收的话底部那行「取消 / 确定」会被裁掉**：窗口高度是 setSize 定死的，
    // 内容超出直接截断、不会把窗口撑开，而被截掉的恰恰是窗口外的页脚——
    // 人怎么滑都滑不出来（2026-10-04 用户实机：横屏 720 高，面板停在提示那一行）。
    // 继续调高是追不上的（横屏就这么高），所以改成"选时间时只显示选时间"。
    '      <vertical id="mainBox">',
    // ---- 两个开关 ----
    '      <horizontal gravity="center_vertical" marginTop="2">',
    '        <text text="开启定时" textColor="#ffffff" textSize="14sp" layout_weight="1"/>',
    '        <text id="enabledBtn" text=" 关 " textColor="' + OFF_COLOR +
      '" textSize="14sp" bg="' + OFF_BG + '" padding="18 6"/>',
    "      </horizontal>",
    // 说明文字一律收短：横屏只有 720 高，每多一行就离"底下那行被裁掉"近一步
    // （2026-10-04 用户截图里，星期按钮整排已经看不见了）。
    '      <horizontal gravity="center_vertical" marginTop="8">',
    '        <text text="强制执行（到点停掉正在跑的）" textColor="#ffffff" textSize="14sp" layout_weight="1"/>',
    '        <text id="forceBtn" text=" 关 " textColor="' + OFF_COLOR +
      '" textSize="14sp" bg="' + OFF_BG + '" padding="18 6"/>',
    "      </horizontal>",
    // ---- 时间点 ----
    '      <text text="每日定时" textColor="#ffffff" textSize="13sp" marginTop="14"/>',
    '      <text id="timesHint" text="" textColor="#78909c" textSize="11sp" marginTop="1"/>',
    '      <vertical id="chipBox" marginTop="4">'
  ];
  for (var r = 0; r < CHIP_ROWS; r++) {
    lines.push('        <horizontal id="chipRow' + r + '" marginTop="4">');
    for (var c = 0; c < CHIPS_PER_ROW; c++) {
      var index = r * CHIPS_PER_ROW + c;
      lines.push(
        '          <horizontal id="chip' + index + '" bg="' + CHIP_BG +
          '" gravity="center_vertical" padding="10 6" marginRight="6">'
      );
      lines.push(
        '            <text id="chipText' + index +
          '" text="00:00" textColor="#ffffff" textSize="14sp" padding="4 2"/>'
      );
      lines.push(
        '            <text id="chipDel' + index +
          '" text=" ✕ " textColor="#ff8a80" textSize="14sp" padding="8 2"/>'
      );
      lines.push("          </horizontal>");
    }
    // ＋ 跟在最后一行末尾：它要随着时间点个数换位置，所以每行都备一个，
    // 真正显示哪一个由 repaint 决定。
    lines.push(
      '          <text id="addBtn' + r + '" text=" ＋ " textColor="' + ON_COLOR +
        '" textSize="16sp" bg="' + OFF_BG + '" padding="14 6"/>'
    );
    lines.push("        </horizontal>");
  }
  lines = lines.concat([
    "      </vertical>",
    // ---- 重复日期 ----
    '      <text text="重复日期" textColor="#ffffff" textSize="13sp" marginTop="14"/>',
    // 三个快捷键挪到标题这一行，省掉单独一行——横屏下这一行的有无，
    // 决定了底下那排星期按钮露不露得出来。
    '      <horizontal gravity="center_vertical" marginTop="1">',
    '        <text text="每天执行请全选" textColor="#78909c" textSize="11sp" layout_weight="1"/>',
    '        <text id="allBtn" text=" 全选 " textColor="#90caf9" textSize="13sp" bg="' +
      OFF_BG + '" padding="10 4" marginRight="4"/>',
    '        <text id="workdayBtn" text=" 工作日 " textColor="#90caf9" textSize="13sp" bg="' +
      OFF_BG + '" padding="10 4" marginRight="4"/>',
    '        <text id="noneBtn" text=" 清空 " textColor="#90caf9" textSize="13sp" bg="' +
      OFF_BG + '" padding="10 4"/>',
    "      </horizontal>",
    '      <horizontal id="weekRow" marginTop="4">'
  ]);
  for (var w = 0; w < 7; w++) {
    lines.push(
      '        <text id="week' + (w + 1) + '" text="' + WEEKDAY_LABELS[w] +
        '" textColor="' + OFF_COLOR + '" textSize="14sp" bg="' + OFF_BG +
        '" gravity="center" layout_weight="1" padding="0 8" marginRight="4"/>'
    );
  }
  return lines
    .concat([
      "      </horizontal>",
      "      </vertical>",
      // ---- 时分选择（平时藏着，点 ＋ 或点时间点才出来）----
      '      <vertical id="pickerBox" bg="#1affffff" padding="10 10" marginTop="12" visibility="gone">',
      '        <text id="pickerTitle" text="选择时间" textColor="#ffffff" textSize="13sp"/>',
      // 时间本身就是个输入框：点它直接打字（2026-10-04 用户问「为什么不能直接编辑」）。
      // 浮层拿键盘的能力 v0.16.0 就有了，这里一开始只给了加减键，等于把它晾着。
      // 加减键留着——改个整点按一下比打四个字符快。
      '        <input id="pickerInput" text="00:00" textColor="' + ON_COLOR +
        '" textSize="28sp" gravity="center" marginTop="4" singleLine="true"/>',
      '        <text id="pickerTip" text="点上面那行可以直接打字，格式 HH:MM" textColor="#78909c" textSize="11sp" gravity="center"/>',
      // 「取消 / 加入」紧跟在时间下面（2026-10-04 用户要求：放时间下边方便保存）。
      // 原先排在两行加减键之后，横屏下离时间隔着大半个面板，改完还得往下够一下。
      // 加减键留在下面：它们是"微调"，不是每次都用。
      '        <horizontal marginTop="8">',
      '          <text id="pickerCancel" text=" 取消 " textColor="#b0bec5" textSize="14sp" padding="14 6" layout_weight="1" gravity="center"/>',
      '          <text id="pickerOk" text=" 加入 " textColor="' + ON_COLOR +
        '" textSize="16sp" padding="14 6" layout_weight="1" gravity="center"/>',
      "        </horizontal>",
      '        <horizontal marginTop="6" gravity="center_vertical">',
      '          <text text="时" textColor="#b0bec5" textSize="13sp" w="36" gravity="center"/>',
      '          <text id="hourDown" text=" －1 " textColor="#ffffff" textSize="15sp" bg="' +
        OFF_BG + '" padding="14 6" layout_weight="1" gravity="center"/>',
      '          <text id="hourUp" text=" ＋1 " textColor="#ffffff" textSize="15sp" bg="' +
        OFF_BG + '" padding="14 6" layout_weight="1" gravity="center" marginLeft="6"/>',
      "        </horizontal>",
      '        <horizontal marginTop="6" gravity="center_vertical">',
      '          <text text="分" textColor="#b0bec5" textSize="13sp" w="36" gravity="center"/>',
      '          <text id="minuteDown5" text=" －5 " textColor="#ffffff" textSize="15sp" bg="' +
        OFF_BG + '" padding="10 6" layout_weight="1" gravity="center"/>',
      '          <text id="minuteDown1" text=" －1 " textColor="#ffffff" textSize="15sp" bg="' +
        OFF_BG + '" padding="10 6" layout_weight="1" gravity="center" marginLeft="6"/>',
      '          <text id="minuteUp1" text=" ＋1 " textColor="#ffffff" textSize="15sp" bg="' +
        OFF_BG + '" padding="10 6" layout_weight="1" gravity="center" marginLeft="6"/>',
      '          <text id="minuteUp5" text=" ＋5 " textColor="#ffffff" textSize="15sp" bg="' +
        OFF_BG + '" padding="10 6" layout_weight="1" gravity="center" marginLeft="6"/>',
      "        </horizontal>",
      "      </vertical>",
      "    </vertical>",
      "  </ScrollView>",
      '  <horizontal id="footer" bg="#f21b262e" gravity="center_vertical" padding="8 6">',
      '    <text id="cancelBtn" text=" 取消 " textColor="#b0bec5" textSize="15sp" padding="14 6"/>',
      '    <text id="msg" text="" textColor="#ffd54f" textSize="11sp" layout_weight="1" marginLeft="8"/>',
      '    <text id="okBtn" text=" 确定 " textColor="' + ON_COLOR +
        '" textSize="16sp" padding="16 6"/>',
      "  </horizontal>",
      "</vertical>"
    ])
    .join("\n");
}

// options: {
//   logger, title,
//   enabled, force,                 // 两个开关的初值
//   times: ["09:00", ...],          // 当前时间点
//   weekdays: [1..7],               // 当前重复日期；空数组按"全选"显示
//   onConfirm({ enabled, force, times, weekdays }),   // 本层已自己关掉
//   onCancel()
// }
// 回调都在界面线程上触发：要 sleep 的自己开线程。
//
// **必须从工作线程调用**：建窗口要等 attach。建不出来返回 null。
function open(options) {
  var opts = options || {};
  var logger = opts.logger;
  var window = null;
  var views = null;
  var closed = false;
  var topOffset = statusBarHeight();
  var posX = DEFAULT_LEFT;
  var posY = topOffset + DEFAULT_TOP_GAP;
  var shapeWidth = PANEL_WIDTH;
  var shapeHeight = PANEL_WIDTH;

  var enabled = opts.enabled === true;
  var force = opts.force === true;
  var times = normalizeTimes(opts.times || []);
  // 存进来的空数组 = 老语义的"每天"。界面按"全选"显示，与新规矩对齐。
  var weekdays = {};
  var incoming = opts.weekdays || [];
  if (incoming.length === 0) {
    for (var d = 1; d <= 7; d++) weekdays[d] = true;
  } else {
    for (var i = 0; i < incoming.length; i++) weekdays[Number(incoming[i])] = true;
  }

  // 时分选择的草稿。editingIndex >= 0 表示在改某一个已有的点，-1 表示在加新的。
  var pickerOpen = false;
  var pickerHour = 9;
  var pickerMinute = 0;
  var editingIndex = -1;
  var keyboard = null;
  // 跑任务 / 截图期间暂时收成 0x0，完事恢复。见 screen-overlays-autojs.js。
  var duckedForCapture = false;
  var unregister = null;

  function warn(text) {
    if (logger) logger.warn("定时浮层: " + text);
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

  // ---- 跑任务时让开 ----
  // 2026-10-05 查出来的真凶候选：这一层**是可触摸的，而且一直没登记进
  // screen-overlays**。于是人把定时层开着等到点（这正是验定时最自然的姿势），
  // 到点注入的点击只要落在这块 660x620 的区域里，就被它整个吃掉——
  // **注入的手势和真手指一样，会被最上层的可触摸窗口拦下**（09-17 在点击上治过，
  // 09-30 在滑动上治过，这一层是新开的，又漏了一次）。
  // 任务照样一路 passed，因为"点出去了"和"游戏收到了"从来是两回事。
  //
  // 运行控制条和编辑层早就登记了，这一层补上同一道。
  function hideForCapture() {
    if (closed || duckedForCapture) return false;
    duckedForCapture = true;
    try {
      runOnUi(function () {
        window.setSize(0, 0);
      });
      return true;
    } catch (error) {
      duckedForCapture = false;
      return false;
    }
  }

  function restoreAfterCapture() {
    if (closed || !duckedForCapture) return;
    duckedForCapture = false;
    try {
      runOnUi(function () {
        window.setSize(shapeWidth, shapeHeight);
      });
    } catch (error) {
      warn("让开之后没能恢复: " + error);
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    // **登记要先摘掉**：层都没了还留在让开名单里，下一次截图或点击会去碰一个
    // 已经关掉的窗口，异常被 screen-overlays 吞掉，表现是"偶尔让不开"。
    if (unregister) {
      try { unregister(); } catch (error) {}
      unregister = null;
    }
    // 关层之前先把焦点还回去。层没了而焦点还攥着的话，
    // 人回到游戏里按什么都没反应，而屏幕上已经没有任何东西能解释这件事。
    try {
      if (keyboard) keyboard.release();
    } catch (error) {}
    try {
      runOnUi(function () {
        try { window.close(); } catch (error) {}
      });
    } catch (error) {}
  }

  function setToggle(view, on) {
    try {
      view.setText(on ? " 开 " : " 关 ");
      view.setTextColor(colors.parseColor(on ? ON_COLOR : OFF_COLOR));
      view.setBackgroundColor(colors.parseColor(on ? ON_BG : OFF_BG));
    } catch (error) {}
  }

  function selectedWeekdays() {
    var list = [];
    for (var day = 1; day <= 7; day++) {
      if (weekdays[day]) list.push(day);
    }
    return list;
  }

  function repaintTimes() {
    // ＋ 跟在最后一个时间点后面。满了就一个都不显示，并在提示里说清楚——
    // 一个点不动的 ＋ 比没有 ＋ 更让人困惑。
    var used = times.length;
    var addRow = used >= MAX_TIMES ? -1 : Math.floor(used / CHIPS_PER_ROW);
    for (var index = 0; index < MAX_TIMES; index++) {
      var chip = window.findView("chip" + index);
      if (!chip) continue;
      if (index < used) {
        chip.setVisibility(VISIBLE);
        var label = views.chipTexts[index];
        if (label) label.setText(times[index]);
      } else {
        chip.setVisibility(GONE);
      }
    }
    for (var r = 0; r < CHIP_ROWS; r++) {
      var row = window.findView("chipRow" + r);
      var add = views.addButtons[r];
      if (add) add.setVisibility(r === addRow ? VISIBLE : GONE);
      // 整行既没有时间点也没有 ＋ 就收起来，免得留下一排空白。
      if (row) {
        var rowHasChip = r * CHIPS_PER_ROW < used;
        row.setVisibility(rowHasChip || r === addRow ? VISIBLE : GONE);
      }
    }
    views.timesHint.setText(
      times.length === 0
        ? "一个时间点都没有，点 ＋ 加一个"
        : times.length >= MAX_TIMES
          ? "已经到上限 " + MAX_TIMES + " 个，想加先删一个"
          : "点时间可以改，点 ✕ 删掉"
    );
  }

  function repaintWeekdays() {
    for (var day = 1; day <= 7; day++) {
      var view = views.weekButtons[day];
      if (!view) continue;
      var on = !!weekdays[day];
      try {
        view.setTextColor(colors.parseColor(on ? "#ffffff" : OFF_COLOR));
        view.setBackgroundColor(colors.parseColor(on ? ON_BG : OFF_BG));
      } catch (error) {}
    }
  }

  // 人正在打字时**不要去动输入框的字**：一边打一边被重写，光标会跳回头、
  // 打一半的内容还会被抹掉。加减键是明确的改值动作，那时才回写。
  function repaintPicker(writeValue) {
    if (writeValue !== false && !(keyboard && keyboard.isFocused())) {
      views.pickerInput.setText(formatHhMm(pickerHour, pickerMinute));
    }
    views.pickerTitle.setText(editingIndex >= 0 ? "改这个时间点" : "加一个时间点");
    views.pickerOk.setText(editingIndex >= 0 ? " 改好了 " : " 加入 ");
    views.pickerBox.setVisibility(pickerOpen ? VISIBLE : GONE);
    // 选时间的时候把上面那一大块收起来：开关、时间点、重复日期加起来比窗口还高，
    // 不收的话底下那行「取消 / 确定」会被裁到窗口外，人怎么滑都滑不出来。
    views.mainBox.setVisibility(pickerOpen ? GONE : VISIBLE);
  }

  // 加减键改值：**先把输入框里现在写的读回来**，再加减。
  // 不读的话，人手打了 18:00 又点一下 ＋1 分，会从内存里那个旧值上算，
  // 结果跳回一个他没见过的时间——而界面上没有任何解释。
  function nudgePicker(deltaMinutes) {
    syncPickerFromInput();
    var total = (pickerHour * 60 + pickerMinute + deltaMinutes + 1440) % 1440;
    pickerHour = Math.floor(total / 60);
    pickerMinute = total % 60;
    views.pickerInput.setText(formatHhMm(pickerHour, pickerMinute));
    views.msg.setText("");
  }

  // 把输入框里的字读进草稿。认不出来就保持原值，不在这儿报错——
  // 报错的时机是点「加入」，打到一半每个字符都弹一句红字没法用。
  function syncPickerFromInput() {
    var typed = parseHhMm(String(views.pickerInput.getText()));
    if (typed == null) return false;
    pickerHour = Math.floor(typed / 60);
    pickerMinute = typed % 60;
    return true;
  }

  function openPicker(index) {
    editingIndex = index;
    var base = index >= 0 ? parseHhMm(times[index]) : null;
    if (base == null) {
      // 加新的：从当前时刻的下一个整点起步，比固定 00:00 少点好几下。
      var now = new Date();
      base = (now.getHours() + 1) % 24 * 60;
    }
    pickerHour = Math.floor(base / 60);
    pickerMinute = base % 60;
    pickerOpen = true;
    views.msg.setText("");
    // 换一个时间点编辑时先收键盘：上一个框的焦点还攥着的话，
    // 打的字会落进一个已经不显示的框里。
    stopTyping();
    views.pickerInput.setText(formatHhMm(pickerHour, pickerMinute));
    repaintPicker(false);
  }

  function closePicker() {
    pickerOpen = false;
    editingIndex = -1;
    stopTyping();
    repaintPicker(false);
  }

  // 收键盘、把焦点还给游戏。**每条退出路径都要经过它**：
  // 加入 / 取消 / 确定 / 关层 / 换一步 / 删掉一个时间点。
  // 漏一条就是"键盘攥着不放"——人回到游戏里按什么都没反应，还查不出所以然
  // （2026-10-02 在 step-overlay 上踩过同一处）。
  function stopTyping() {
    if (keyboard) keyboard.release();
  }

  function commitPicker() {
    // 以输入框里的字为准。打完直接点「加入」是最顺的那条路，
    // 要求人先点一下别处把值"确认"掉，等于白加一步。
    var raw = String(views.pickerInput.getText()).trim();
    if (!syncPickerFromInput()) {
      views.msg.setText("时间要写成 HH:MM，比如 09:30。现在是: " + (raw || "(空)"));
      return;
    }
    var text = formatHhMm(pickerHour, pickerMinute);
    var next = times.slice();
    if (editingIndex >= 0 && editingIndex < next.length) {
      next[editingIndex] = text;
    } else {
      next.push(text);
    }
    var merged = normalizeTimes(next);
    // 加重复了就说一句。悄悄去重的话，人点了「加入」却什么都没多出来，
    // 只会以为是没点着。
    if (merged.length === times.length && editingIndex < 0) {
      views.msg.setText(text + " 已经有了");
      closePicker();
      return;
    }
    times = merged;
    closePicker();
    repaintTimes();
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
      window = floaty.rawWindow(buildLayout());
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

  // 登记给"让开"调度：找图截图要让开，**注入点击之前同样要让开**——
  // 这一层是可触摸的，压在游戏上就会把到点的点击吃掉（见 hideForCapture 那段）。
  unregister = require("./screen-overlays-autojs.js").register({
    hideForCapture: hideForCapture,
    restoreAfterCapture: restoreAfterCapture
  });

  // 键盘能力挂在窗口上，要等窗口就绪之后。看门狗到点自动还焦点，
  // 顺手把那一行字说清楚——不说的话人会以为输入框坏了。
  keyboard = overlayKeyboard.attach(window, {
    logger: logger,
    onAutoRelease: function () {
      try {
        runOnUi(function () {
          if (closed || !views) return;
          views.msg.setText("太久没动，键盘先还给游戏了。要改再点一下时间");
        });
      } catch (error) {}
    }
  });

  try {
    runOnUi(function () {
      views = {
        title: window.findView("title"),
        msg: window.findView("msg"),
        dragGrip: window.findView("dragGrip"),
        closeBtn: window.findView("closeBtn"),
        cancelBtn: window.findView("cancelBtn"),
        okBtn: window.findView("okBtn"),
        enabledBtn: window.findView("enabledBtn"),
        forceBtn: window.findView("forceBtn"),
        timesHint: window.findView("timesHint"),
        allBtn: window.findView("allBtn"),
        workdayBtn: window.findView("workdayBtn"),
        noneBtn: window.findView("noneBtn"),
        pickerBox: window.findView("pickerBox"),
        mainBox: window.findView("mainBox"),
        pickerTitle: window.findView("pickerTitle"),
        pickerInput: window.findView("pickerInput"),
        pickerTip: window.findView("pickerTip"),
        pickerOk: window.findView("pickerOk"),
        pickerCancel: window.findView("pickerCancel"),
        hourUp: window.findView("hourUp"),
        hourDown: window.findView("hourDown"),
        minuteUp1: window.findView("minuteUp1"),
        minuteDown1: window.findView("minuteDown1"),
        minuteUp5: window.findView("minuteUp5"),
        minuteDown5: window.findView("minuteDown5"),
        chipTexts: [],
        addButtons: [],
        weekButtons: {}
      };
      var missing = [];
      for (var key in views) {
        if (key === "chipTexts" || key === "addButtons" || key === "weekButtons") continue;
        if (!views[key]) missing.push(key);
      }
      if (missing.length > 0) {
        throw new Error("控件未找到: " + missing.join(", "));
      }

      views.title.setText(String(opts.title || "定时执行设置"));

      for (var index = 0; index < MAX_TIMES; index++) {
        views.chipTexts.push(window.findView("chipText" + index));
        var delView = window.findView("chipDel" + index);
        var textView = views.chipTexts[index];
        // 闭包里要的是这一个槽位的序号，不是循环结束后的 index。
        (function (slot) {
          if (textView) {
            textView.setOnClickListener(function () {
              if (slot < times.length) openPicker(slot);
            });
          }
          if (delView) {
            delView.setOnClickListener(function () {
              if (slot >= times.length) return;
              stopTyping();
              var removed = times[slot];
              times = times.slice(0, slot).concat(times.slice(slot + 1));
              if (pickerOpen) closePicker();
              repaintTimes();
              views.msg.setText("删掉了 " + removed);
            });
          }
        })(index);
      }

      for (var r = 0; r < CHIP_ROWS; r++) {
        var addView = window.findView("addBtn" + r);
        views.addButtons.push(addView);
        if (addView) {
          addView.setOnClickListener(function () {
            if (times.length >= MAX_TIMES) {
              views.msg.setText("最多 " + MAX_TIMES + " 个时间点");
              return;
            }
            openPicker(-1);
          });
        }
      }

      for (var day = 1; day <= 7; day++) {
        var weekView = window.findView("week" + day);
        views.weekButtons[day] = weekView;
        if (weekView) {
          (function (which) {
            weekView.setOnClickListener(function () {
              weekdays[which] = !weekdays[which];
              repaintWeekdays();
              views.msg.setText("");
            });
          })(day);
        }
      }

      views.allBtn.setOnClickListener(function () {
        for (var d = 1; d <= 7; d++) weekdays[d] = true;
        repaintWeekdays();
        views.msg.setText("");
      });
      views.workdayBtn.setOnClickListener(function () {
        for (var d = 1; d <= 7; d++) weekdays[d] = false;
        for (var i = 0; i < WORKDAYS.length; i++) weekdays[WORKDAYS[i]] = true;
        repaintWeekdays();
        views.msg.setText("");
      });
      views.noneBtn.setOnClickListener(function () {
        for (var d = 1; d <= 7; d++) weekdays[d] = false;
        repaintWeekdays();
        views.msg.setText("一天都不选 = 永远不跑");
      });

      views.enabledBtn.setOnClickListener(function () {
        enabled = !enabled;
        setToggle(views.enabledBtn, enabled);
        views.msg.setText("");
      });
      views.forceBtn.setOnClickListener(function () {
        force = !force;
        setToggle(views.forceBtn, force);
        views.msg.setText("");
      });

      views.hourUp.setOnClickListener(function () { nudgePicker(60); });
      views.hourDown.setOnClickListener(function () { nudgePicker(-60); });
      views.minuteUp1.setOnClickListener(function () { nudgePicker(1); });
      views.minuteDown1.setOnClickListener(function () { nudgePicker(-1); });
      views.minuteUp5.setOnClickListener(function () { nudgePicker(5); });
      views.minuteDown5.setOnClickListener(function () { nudgePicker(-5); });
      views.pickerOk.setOnClickListener(commitPicker);
      views.pickerCancel.setOnClickListener(closePicker);

      // 按在时间那一行上就把键盘焦点要过来。
      // **返回 false 不吃事件**：吃了的话光标落不到你按的那个位置、也选不中字
      // （2026-10-02 实测，setOnClickListener 在 NOT_FOCUSABLE 下根本不触发，
      // 表现是"光标出来了、字一个没进去"）。
      views.pickerInput.setOnTouchListener(function (target, event) {
        try {
          if (event.getAction() === android.view.MotionEvent.ACTION_DOWN && keyboard) {
            if (keyboard.isFocused()) {
              keyboard.keepAlive();
            } else if (!keyboard.focus(target)) {
              views.msg.setText("键盘要不过来，用下面的加减键改");
            }
          }
        } catch (error) {
          warn("要焦点失败: " + error);
        }
        return false;
      });

      views.closeBtn.setOnClickListener(function () {
        close();
        if (opts.onCancel) opts.onCancel();
      });
      views.cancelBtn.setOnClickListener(function () {
        close();
        if (opts.onCancel) opts.onCancel();
      });
      views.okBtn.setOnClickListener(function () {
        var days = selectedWeekdays();
        // 开着定时才校验这两条：关掉定时就是"这条不按时间跑"，
        // 此时时间点填没填、星期选没选都不影响结果。
        if (enabled) {
          if (times.length === 0) {
            views.msg.setText("先加一个时间点");
            return;
          }
          if (days.length === 0) {
            views.msg.setText("一天都没选，每天执行请点「全选」");
            return;
          }
        }
        var result = {
          enabled: enabled,
          force: force,
          times: times.slice(),
          weekdays: days
        };
        close();
        if (opts.onConfirm) opts.onConfirm(result);
      });

      setToggle(views.enabledBtn, enabled);
      setToggle(views.forceBtn, force);
      repaintTimes();
      repaintWeekdays();
      repaintPicker();
      attachDrag(views.dragGrip);
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
  MAX_TIMES: MAX_TIMES,
  open: open,
  parseHhMm: parseHhMm,
  formatHhMm: formatHhMm,
  normalizeTimes: normalizeTimes
};
