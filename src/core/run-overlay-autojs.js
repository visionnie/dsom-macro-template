// =====================================================================
// 通用能力：任务的悬浮遥控层（待命 / 运行中 / 结束菜单）
// 设计约束：
//   - **任务一跑起来，游戏就全屏盖住一切**。此前暂停/终止只做在 App 自己的页面上，
//     而那个页面在游戏后面，人根本看不见也点不到——等于没有。2026-09-17 用户实测反馈
//   - **点「运行」不直接开跑**，先出这一层待命条（运行 / 编辑 / 结束），
//     人在它上面再点「运行」才真的起跑（2026-09-24 用户要求）。
//     待命态**不拉游戏**：层就浮在 App 自己的任务列表上，拉游戏仍由 runtime 在开跑时做
//   - 三种形态共用一个窗口，靠 visibility 切换：
//       待命    ▶ 运行 / 编辑 / 结束
//       运行中  进度 + 暂停 / 结束
//       菜单    切换任务 / 再次执行 / 编辑主流程
//     「结束」在哪个形态点都落到菜单——跑完和手动停都是同一个问题：下一步干什么
//   - **可以拖，拖到贴边 3 秒后自己藏成把手**；不贴边就一直摊着，不自作主张收走
//     （原先是"4 秒不碰就收"，2026-09-24 用户要求改掉）
//   - 它只是个遥控器：暂停、终止都交给 run-control，跑什么、怎么跑一概不管
//   - **不可全屏、不吃触摸**：只占自己那一块。全屏可触摸的图层会把设备点废
//     （见 point-picker 的看门狗那段教训）
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");

// 尺寸必须给够：**悬浮窗内容超出 setSize 会被直接裁掉，不会把窗口撑开**。
// 2026-09-17 实机第一版 440x132，两行文字之后按钮那一排整个看不见——
// 而那一排正是暂停和结束。取点面板也踩过同一个坑。
//
// 三种形态各有各的尺寸，都按"宁可留白也别裁"给：
// 运行中要塞进度文字，最宽；待命只有三个短键；菜单是竖着的三行。
var RUN_WIDTH = 660;
var RUN_HEIGHT = 78;
// 430 不够：2026-09-24 实机，「结束」被裁成「结」。抓手 ⠿ 占的那一截容易漏算。
// 2026-10-04 待命条多了「定时」，560 装不下四个键，加到 700——
// 宽度比高度安全：横屏宽 1280，竖屏 720，700 两种方向都放得下。
var READY_WIDTH = 700;
var READY_HEIGHT = 78;
var MENU_WIDTH = 420;
// 菜单顶上那行是结果文字。成功那句很短，失败那句能折六行——**它会把下面的菜单项挤出窗口**。
// 2026-09-24 实机：一条方向超时的失败原因折了 6 行，「编辑主流程」整行被裁掉，
// 而这正是"跑挂了马上能修"的入口，最需要它的时候它不在。
//
// 治法是**截断文字**，不是把窗口一路调高：失败原因有多长没有上限，
// 照它调高度就是在追一个追不上的东西。完整原因在任务日志和 toast 里都有。
var MENU_TEXT_MAX_CHARS = 56;
var MENU_ONE_LINE_CHARS = 18;
// 2026-09-26 菜单从三项加到五项（多了「回到 App」与「结束」），高度跟着加：
// 每项约 70 像素。不加的话最底下那两项会被**直接裁掉**——这个项目已经踩过三次。
// 横屏只有 720 高，600 还放得下；再长就得考虑让菜单自己滚动了。
var MENU_HEIGHT_SHORT = 500;
var MENU_HEIGHT_LONG = 600;
// 藏起来之后剩的那一小块。**只剩一个小红标**，不写字——
// 2026-09-26 用户实机反馈「隐藏剩余有点多」，参照自动按键精灵：它藏起来只剩
// 边上一个小方块。原来的 132x60 里塞着「▶ 待命」四个字，占掉屏幕一整条，
// 藏了跟没藏差不多。
//
// 60 是权衡出来的：再小就点不中（手指按下去自己就盖住了），再大就又开始碍事。
// 跑着的时候里面显示「3/9」，三个字符在 60 宽里刚好放得下——
// 「藏起来也要看得见跑到第几步」这条不能丢，不然缩起来就等于瞎跑。
var HANDLE_WIDTH = 60;
var HANDLE_HEIGHT = 60;
// 把手上的字最多几个字符。超了就裁——**悬浮窗内容超出 setSize 会被直接裁掉**，
// 与其让它把「9」裁掉变成看不懂的「3/」，不如自己先截。
var HANDLE_TEXT_MAX_CHARS = 3;

// 贴边判定的容差：窗口任意一边离屏幕对应边不超过这个距离，就算"靠上去了"。
// 给到 24 像素是因为手指拖不准，差几像素还要人再推一次太难用。
var EDGE_SNAP_PX = 24;
// 贴边之后等多久自己藏起来。2026-09-24 用户定的 3 秒。
var EDGE_HIDE_MS = 3000;
// 默认落位**故意不贴任何边**：一建出来就贴边的话，人还没看见它就藏了。
var DEFAULT_LEFT = 48;
var DEFAULT_TOP_GAP = 24;
// 按下到抬起之内、位移不超过这个距离，算点一下而不是拖一下。
var TAP_SLOP_PX = 12;

var READY_WAIT_MS = 2000;
var UI_CALL_WAIT_MS = 1500;
var POLL_MS = 30;

// 倒计时那一行：节点名字最多显示几个字（超了自己截，别让它把「暂停」挤出窗口），
// 以及刷新节奏——还剩 10 秒以内按 100 毫秒刷，远了按 1 秒刷。
var COUNTDOWN_LABEL_MAX_CHARS = 10;
var COUNTDOWN_FINE_MS = 10000;
var COUNTDOWN_FINE_TICK_MS = 100;
var COUNTDOWN_COARSE_TICK_MS = 1000;

// 根节点带 id、不写宽高；三种形态放同一个窗口里靠 visibility 切换。
// 这是录制器控制条实测可用的形状，别改成在根节点上写宽高（findView 会返回 null）。
//
// 拖动抓手单独给一个控件（最左边那个 ⠿）：触摸事件在 ViewGroup 上会被子控件先吃掉，
// 把监听挂在根节点上的话，整条几乎全是按钮，真正能拖的只剩 padding 那几像素。
//
// 底色挪到 panel 和 handle 各自身上，根节点透明：藏成小红标时，
// 根节点若还带着黑底，那一小块就是「黑底 + 红标」两层，看着比实际更占地方。
var LAYOUT = [
  '<vertical id="root" bg="#00000000">',
  // 小红标：一格红色方块，跑着时里面是「3/9」。颜色选红是跟着自动按键精灵走的，
  // 它在任何游戏画面上都跳得出来，人一眼知道"脚本还在这儿"。
  '  <text id="handle" text="▶" bg="#e0d32f2f" textColor="#ffffff" textSize="12sp" gravity="center" padding="2"/>',
  '  <vertical id="panel" bg="#e0000000" padding="10 6">',
  '    <text id="title" text="" textColor="#ffffff" textSize="12sp"/>',
  '    <horizontal id="barRow" gravity="center_vertical">',
  '      <text id="dragGrip" text=" ⠿ " textColor="#9e9e9e" textSize="15sp" padding="6 2"/>',
  '      <text id="detail" text="" textColor="#e0e0e0" textSize="12sp"/>',
  '      <text id="startBtn" text=" ▶ 运行 " textColor="#69f0ae" textSize="14sp" padding="10 2"/>',
  '      <text id="pauseBtn" text=" 暂停 " textColor="#ffd54f" textSize="14sp" padding="10 2"/>',
  '      <text id="editBtn" text=" 编辑 " textColor="#90caf9" textSize="14sp" padding="10 2"/>',
  // 「定时」放在待命条上，不放进结束菜单：待命条就是"这条任务，马上要跑"的语境，
  // 正是人想起"让它每天自己跑"的时候。菜单那边已经五项了，再加一项要把高度推到
  // 670，而横屏只有 720 高——这个项目被"超出 setSize 直接裁掉"坑过六次，不赌第七次。
  '      <text id="scheduleBtn" text=" 定时 " textColor="#ffd54f" textSize="14sp" padding="10 2"/>',
  '      <text id="stopBtn" text=" 结束 " textColor="#ff8a80" textSize="14sp" padding="10 2"/>',
  "    </horizontal>",
  '    <vertical id="menuRow">',
  '      <text id="switchBtn" text=" ⇄  切换任务 " textColor="#ffffff" textSize="15sp" padding="12 10"/>',
  '      <text id="rerunBtn" text=" ↻  再次执行 " textColor="#69f0ae" textSize="15sp" padding="12 10"/>',
  '      <text id="editMainBtn" text=" ✎  编辑主流程 " textColor="#90caf9" textSize="15sp" padding="12 10"/>',
  // 「切换任务」2026-09-26 改成在游戏上选，不再切回 App。于是必须另给一个
  // 回 App 的口子，否则人从这一层再也回不去自己的界面。
  '      <text id="backAppBtn" text=" ⤺  回到 App " textColor="#ffffff" textSize="15sp" padding="12 10"/>',
  // 菜单原先没有关掉它的办法——唯一的出口就是「切换任务」，而它顺带把层收了。
  // 现在切换任务留在游戏里，就更需要一个「我看完了，收起来」。
  '      <text id="dismissBtn" text=" ✕  收起 " textColor="#ff8a80" textSize="15sp" padding="12 10"/>',
  "    </vertical>",
  "  </vertical>",
  "</vertical>"
].join("\n");

var VISIBLE = 0;
var GONE = 8;

// 倒计时那一行长什么样。**纯函数、模块级**：它决定了跑起来时人唯一能看见的那句话，
// 值得在 PC 上直接喂数字验边界，而不是装到手机上盯着看。
// 格式照用户 2026-10-01 给的参考：`689秒后 第[1]步 >> 执行20分钟`。
function renderCountdown(remainingMs, step) {
  var remaining = remainingMs > 0 ? remainingMs : 0;
  var secondsText;
  if (remaining === 0) {
    secondsText = "0秒后";
  } else if (remaining < COUNTDOWN_FINE_MS) {
    // 不足十秒给一位小数：最后那几下的节奏看得见，才知道它真的在走。
    secondsText = (Math.round(remaining / 100) / 10) + "秒后";
  } else {
    secondsText = Math.round(remaining / 1000) + "秒后";
  }
  var label = String(step.label || "");
  if (label.length > COUNTDOWN_LABEL_MAX_CHARS) {
    // 超出 setSize 会被直接裁掉，与其让它把「暂停」挤出窗口，不如自己先截。
    label = label.substring(0, COUNTDOWN_LABEL_MAX_CHARS) + "…";
  }
  return secondsText + " 第[" + step.index + "]步 >> " + label;
}

// 贴 (0,0) 会被状态栏盖住：状态栏的层级在 APPLICATION_OVERLAY 之上，
// 收起成把手之后整个把手缩在状态栏后面，看不见也点不到（2026-09-17 实机）。
// 所以整条控制条从状态栏下面开始摆。游戏全屏沉浸时状态栏是隐藏的，
// 多这几十像素也不碍事。
function statusBarHeight() {
  try {
    var resources = context.getResources();
    var id = resources.getIdentifier("status_bar_height", "dimen", "android");
    if (id > 0) return resources.getDimensionPixelSize(id);
  } catch (error) {}
  return 48;
}

// options: {
//   logger, title, canEdit, canSchedule, mode（"ready" 或 "running"，缺省 "running"）,
//   onStart, onPause, onResume, onStop, onEdit, onSchedule, onSwitchTask, onRerun, onClose
// }
// 所有回调都在界面线程上触发：要 sleep 或存盘的自己开线程。
function create(options) {
  var opts = options || {};
  var logger = opts.logger;
  var window = null;
  var views = null;
  var closed = false;
  // "ready" 待命 / "running" 运行中 / "menu" 结束菜单
  var mode = opts.mode === "ready" ? "ready" : "running";
  var hidden = false;
  var paused = false;
  var canEdit = !!opts.canEdit;
  // 组合任务与录制用例都能挂定时，但调用方不给 onSchedule 就不显示这个键——
  // 显示一个点了没反应的按钮，比没有这个按钮更难查。
  var canSchedule = !!opts.canSchedule && !!opts.onSchedule;
  // 藏起来的定时器"代数"：重新计时就自增，旧的那个线程醒来发现代数变了就作废。
  var hideTimer = 0;
  // 倒计时的"代数"，同一个道理：每来一步就换一代，上一步那个刷新线程自己退出。
  var countdownGeneration = 0;
  var topOffset = statusBarHeight();
  var shapeWidth = RUN_WIDTH;
  var shapeHeight = RUN_HEIGHT;
  var menuHeight = MENU_HEIGHT_SHORT;
  // 当前窗口左上角。floaty 不提供读回位置的接口，只能自己记。
  var posX = DEFAULT_LEFT;
  var posY = topOffset + DEFAULT_TOP_GAP;
  // 藏起来之前摊开时在哪儿，展开时回到那儿。
  var expandedX = posX;
  var expandedY = posY;
  // 截图期间暂时收成 0x0，拍完恢复。见 screen-overlays-autojs.js。
  var duckedForCapture = false;
  var unregister = null;

  function runOnUi(action) {
    uiThread.run(action, UI_CALL_WAIT_MS);
  }

  function warn(text) {
    if (logger) logger.warn("运行控制条: " + text);
  }

  function screenWidth() {
    return device.width;
  }

  function screenHeight() {
    return device.height;
  }

  function sizeOfMode() {
    if (hidden) return { w: HANDLE_WIDTH, h: HANDLE_HEIGHT };
    if (mode === "ready") return { w: READY_WIDTH, h: READY_HEIGHT };
    if (mode === "menu") return { w: MENU_WIDTH, h: menuHeight };
    return { w: RUN_WIDTH, h: RUN_HEIGHT };
  }

  // 换形态之后窗口变大变小都可能把自己顶出屏幕，每次都夹回可见范围。
  // 上边界取状态栏高度，理由同 statusBarHeight 那段。
  function clampPosition() {
    var maxX = Math.max(0, screenWidth() - shapeWidth);
    var maxY = Math.max(topOffset, screenHeight() - shapeHeight);
    if (posX < 0) posX = 0;
    if (posX > maxX) posX = maxX;
    if (posY < topOffset) posY = topOffset;
    if (posY > maxY) posY = maxY;
  }

  // 贴边了没有：任意一条边挨上屏幕对应边就算。
  // 四条边都判，是因为这条长条在竖屏 720 宽的屏上左右几乎没有富余，
  // 只认左右的话人根本推不动它——往上顶或往下压才是顺手的动作。
  function nearestEdge() {
    var w = screenWidth();
    var h = screenHeight();
    var gaps = [
      { edge: "left", gap: posX },
      { edge: "right", gap: w - (posX + shapeWidth) },
      { edge: "top", gap: posY - topOffset },
      { edge: "bottom", gap: h - (posY + shapeHeight) }
    ];
    var best = gaps[0];
    for (var i = 1; i < gaps.length; i++) {
      if (gaps[i].gap < best.gap) best = gaps[i];
    }
    return best.gap <= EDGE_SNAP_PX ? best.edge : null;
  }

  // 应用当前形态。**窗口操作一律经 ui.run 投递**，不在点击回调里直接调：
  // 2026-09-17 实机上，直接在点击回调里 setSize 的那一版，点把手毫无反应
  // （窗口尺寸原样不动）。录制器控制条的展开/收起从一开始就是 ui.run 投递的，
  // 那条路是验过的，照它来。
  function applyShape() {
    var size = sizeOfMode();
    shapeWidth = size.w;
    shapeHeight = size.h;
    clampPosition();
    var showHandle = hidden;
    var showBar = !hidden && mode !== "menu";
    var showMenu = !hidden && mode === "menu";
    var showTitle = !hidden && mode === "menu";
    var running = mode === "running";
    var x = posX;
    var y = posY;
    ui.run(function () {
      if (closed || !views) return;
      try {
        views.handle.setVisibility(showHandle ? VISIBLE : GONE);
        views.panel.setVisibility(showHandle ? GONE : VISIBLE);
        views.barRow.setVisibility(showBar ? VISIBLE : GONE);
        views.menuRow.setVisibility(showMenu ? VISIBLE : GONE);
        views.title.setVisibility(showTitle ? VISIBLE : GONE);
        views.startBtn.setVisibility(mode === "ready" ? VISIBLE : GONE);
        views.pauseBtn.setVisibility(running ? VISIBLE : GONE);
        views.detail.setVisibility(running ? VISIBLE : GONE);
        // 待命态也给「编辑」：这条任务要是上次就跑歪了，人多半是先来改它。
        views.editBtn.setVisibility(mode === "ready" && canEdit ? VISIBLE : GONE);
        // 「定时」只在待命态给：跑着的时候那一行要留给进度与暂停，
        // 而人也不会在任务跑到一半时去改它几点跑。
        views.scheduleBtn.setVisibility(mode === "ready" && canSchedule ? VISIBLE : GONE);
        views.editMainBtn.setVisibility(canEdit ? VISIBLE : GONE);
        window.setPosition(x, y);
        if (!duckedForCapture) window.setSize(shapeWidth, shapeHeight);
      } catch (error) {
        warn("切换形态失败: " + error);
      }
    });
  }

  // 截图前让开、拍完回来。收成 0x0 而不是改可见性：尺寸归零最干脆，
  // 也不用担心某个子视图还残留在画面上。由 screen-overlays 统一调度。
  function hideForCapture() {
    if (closed || duckedForCapture) return false;
    duckedForCapture = true;
    try {
      uiThread.run(function () {
        window.setSize(0, 0);
      }, UI_CALL_WAIT_MS);
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
      uiThread.run(function () {
        window.setSize(shapeWidth, shapeHeight);
      }, UI_CALL_WAIT_MS);
    } catch (error) {
      warn("截图后没能恢复: " + error);
    }
  }

  function cancelHideTimer() {
    // 靠代数作废，不用 clearTimeout：见 scheduleHide 里为什么不能用 setTimeout。
    hideTimer++;
  }

  // 贴边之后过 EDGE_HIDE_MS 自己藏成把手。
  //
  // **不能用 setTimeout**：本模块是在跑任务的那个工作线程上建起来的，
  // 它建完就一头扎进 runtime.run 阻塞几十秒，定时器排在它的消息队列里根本轮不上，
  // 等任务跑完才触发——那时收起已经没意义了（2026-09-17 实机：全程没收起过）。
  function scheduleHide() {
    var mine = ++hideTimer;
    threads.start(function () {
      sleep(EDGE_HIDE_MS);
      if (closed || hidden) return;
      if (mine !== hideTimer) return;
      if (!nearestEdge()) return;
      expandedX = posX;
      expandedY = posY;
      hidden = true;
      snapHandleToEdge();
      applyShape();
    });
  }

  // 藏起来的把手要贴在它刚才靠的那条边上，别缩在屏幕中间。
  function snapHandleToEdge() {
    var edge = nearestEdge();
    if (edge === "left") posX = 0;
    else if (edge === "right") posX = screenWidth() - HANDLE_WIDTH;
    else if (edge === "top") posY = topOffset;
    else if (edge === "bottom") posY = screenHeight() - HANDLE_HEIGHT;
  }

  // 人主动展开之后就别再自作主张收走，否则他正要点结束，按钮没了
  // （录制器控制条踩过这个坑）。所以展开只取消定时器，不重新计时——
  // 要再藏起来，得他自己再把它推到边上。
  function expand() {
    cancelHideTimer();
    hidden = false;
    posX = expandedX;
    posY = expandedY;
    applyShape();
  }

  // 拖动：按下记住手指与窗口左上角的偏移，移动时原样跟手，抬起再判贴边。
  // **回调跑在界面线程上**，窗口操作直接调是安全的（uiThread.run 在界面线程上
  // 是就地执行、不 sleep、不等待）。拖一次会来几十个 MOVE 事件，
  // 每个都开线程的话线程会爆——point-picker 已经踩过，照它的写法来。
  function attachDrag(view, onTap) {
    var grabX = 0;
    var grabY = 0;
    var startX = 0;
    var startY = 0;
    var moved = false;
    view.setOnTouchListener(function (v, event) {
      var action = event.getAction();
      // getRawX/getRawY 是屏幕坐标，与 setPosition 同一套（tap-marker 靠这一点定位）。
      var rawX = event.getRawX();
      var rawY = event.getRawY();
      if (action === event.ACTION_DOWN) {
        grabX = rawX - posX;
        grabY = rawY - posY;
        startX = rawX;
        startY = rawY;
        moved = false;
        cancelHideTimer();
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
      if (action === event.ACTION_UP || action === event.ACTION_CANCEL) {
        if (!moved) {
          if (onTap) onTap();
          return true;
        }
        if (!hidden) {
          expandedX = posX;
          expandedY = posY;
          // 贴边了才藏；没贴边就一直摊着，这是 2026-09-24 定下的规矩。
          if (nearestEdge()) scheduleHide();
        }
        return true;
      }
      return true;
    });
  }

  try {
    runOnUi(function () {
      window = floaty.rawWindow(LAYOUT);
    });
  } catch (error) {
    warn("建不出来，本次运行没有悬浮控制条: " + error);
    return null;
  }

  // attach 之前 setSize / findView 都不可用，重试到就绪。
  var initialSize = mode === "ready"
    ? { w: READY_WIDTH, h: READY_HEIGHT }
    : { w: RUN_WIDTH, h: RUN_HEIGHT };
  shapeWidth = initialSize.w;
  shapeHeight = initialSize.h;
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
        handle: window.findView("handle"),
        panel: window.findView("panel"),
        barRow: window.findView("barRow"),
        menuRow: window.findView("menuRow"),
        title: window.findView("title"),
        dragGrip: window.findView("dragGrip"),
        detail: window.findView("detail"),
        startBtn: window.findView("startBtn"),
        pauseBtn: window.findView("pauseBtn"),
        editBtn: window.findView("editBtn"),
        scheduleBtn: window.findView("scheduleBtn"),
        stopBtn: window.findView("stopBtn"),
        switchBtn: window.findView("switchBtn"),
        rerunBtn: window.findView("rerunBtn"),
        editMainBtn: window.findView("editMainBtn"),
        backAppBtn: window.findView("backAppBtn"),
        dismissBtn: window.findView("dismissBtn")
      };
      var missing = [];
      for (var key in views) {
        if (!views[key]) missing.push(key);
      }
      if (missing.length > 0) {
        throw new Error("控件未找到: " + missing.join(", "));
      }

      views.detail.setText(mode === "ready" ? "" : "正在启动…");
      views.handle.setText("▶");

      // 抓手和把手都能拖。把手还兼着"点一下展开"，靠位移大小区分点与拖。
      attachDrag(views.dragGrip, null);
      attachDrag(views.handle, function () {
        expand();
      });

      views.startBtn.setOnClickListener(function () {
        cancelHideTimer();
        if (opts.onStart) opts.onStart();
      });
      views.scheduleBtn.setOnClickListener(function () {
        cancelHideTimer();
        if (opts.onSchedule) opts.onSchedule();
      });
      views.pauseBtn.setOnClickListener(function () {
        cancelHideTimer();
        paused = !paused;
        views.pauseBtn.setText(paused ? " 继续 " : " 暂停 ");
        if (paused) {
          if (opts.onPause) opts.onPause();
        } else if (opts.onResume) {
          opts.onResume();
        }
      });
      // 「结束」在待命态与运行态点的含义不同，但落点一样：都进菜单。
      // 跑着的时候得先真的把任务停下来，停完由 setFinished 切菜单；
      // 待命态没东西可停，就地切。
      views.stopBtn.setOnClickListener(function () {
        cancelHideTimer();
        if (mode === "running") {
          views.detail.setText("正在终止…");
          if (opts.onStop) opts.onStop();
          return;
        }
        setMenu("已结束");
      });
      views.editBtn.setOnClickListener(function () {
        if (opts.onEdit) opts.onEdit();
      });
      views.switchBtn.setOnClickListener(function () {
        if (opts.onSwitchTask) opts.onSwitchTask();
      });
      views.rerunBtn.setOnClickListener(function () {
        if (opts.onRerun) opts.onRerun();
      });
      views.editMainBtn.setOnClickListener(function () {
        if (opts.onEdit) opts.onEdit();
      });
      views.backAppBtn.setOnClickListener(function () {
        if (opts.onBackToApp) opts.onBackToApp();
      });
      // 收起就是把这一层关掉，不动任务、不动界面。
      views.dismissBtn.setOnClickListener(function () {
        close();
        if (opts.onClose) opts.onClose();
      });

      applyShape();
    });
  } catch (error) {
    warn("接线失败: " + error);
    try {
      runOnUi(function () { window.close(); });
    } catch (closeError) {}
    return null;
  }

  // 登记给截图调度：找图截图前它要让开，否则会挡住锚点（见 screen-overlays）。
  unregister = require("./screen-overlays-autojs.js").register({
    hideForCapture: hideForCapture,
    restoreAfterCapture: restoreAfterCapture
  });

  // 待命 -> 运行中。点了待命态的「运行」之后由调用方切过来。
  function setRunning(title) {
    if (closed) return;
    mode = "running";
    paused = false;
    try {
      runOnUi(function () {
        if (!views) return;
        views.pauseBtn.setText(" 暂停 ");
        views.detail.setText("正在启动…");
        views.handle.setText("▶");
        if (title) views.title.setText(title);
        applyShape();
      });
    } catch (error) {
      warn("切运行态失败: " + error);
    }
  }

  // ---- 倒计时：距离下一个动作还有多久 ----
  // 2026-10-01 用户要求，参照自动按键精灵：跑着的时候那条写的是
  // 「689秒后 第[1]步 >> 执行20分钟」——多久之后、做第几步、那一步叫什么。
  //
  // 为什么要它：这一版起一步可以先等二十分钟再动，而原来的进度条只写「第 3/9 步」，
  // 挂在那儿一动不动时，人分不清是脚本死了还是正按录制的节奏等着。
  //
  // 刷新放工作线程 + ui.run 单程投递，**不走 uiThread.run**：那个要等界面线程回话
  // （30 毫秒一轮询），一秒刷一次就白白占住两个线程。
  //
  // step: { index, total, label, preWaitMs }
  // 每来一步就换一代，上一代的倒计时线程看到代号变了自己退出——
  // 不这么做的话，连着两步之间会有两个线程抢着写同一行字。
  function setStep(step) {
    if (closed || mode !== "running") return;
    countdownGeneration += 1;
    var generation = countdownGeneration;
    var deadline = Date.now() + (step.preWaitMs > 0 ? step.preWaitMs : 0);
    var shortText = step.index + "/" + step.total;

    function paint() {
      var text = renderCountdown(deadline - Date.now(), step);
      ui.run(function () {
        if (closed || !views || generation !== countdownGeneration) return;
        if (mode !== "running") return;
        views.detail.setText(text);
        var brief = shortText;
        if (brief.length > HANDLE_TEXT_MAX_CHARS) {
          brief = brief.substring(0, HANDLE_TEXT_MAX_CHARS);
        }
        views.handle.setText(brief);
      });
    }

    paint();
    if (deadline - Date.now() <= 0) return;

    threads.start(function () {
      while (!closed && generation === countdownGeneration) {
        var remaining = deadline - Date.now();
        if (remaining <= 0) {
          paint();
          return;
        }
        // 远了一秒刷一次，近了一百毫秒刷一次：二十分钟的等待没必要一秒十次，
        // 而最后一秒要是还按秒刷，看着就是从「1秒后」直接跳到动作。
        sleep(remaining > COUNTDOWN_FINE_MS ? COUNTDOWN_COARSE_TICK_MS : COUNTDOWN_FINE_TICK_MS);
        if (closed || generation !== countdownGeneration) return;
        paint();
      }
    });
  }

  // 藏起来之后把手上也要看得见跑到第几步——不然缩起来就等于瞎跑。
  function setProgress(text, shortText) {
    if (closed || mode !== "running") return;
    // 有人要直接往这一行写字（比如补跑前置），就把倒计时作废——
    // 否则那个还在走的线程下一拍就把这句话盖掉，而它说的还是上一步的事。
    countdownGeneration += 1;
    try {
      runOnUi(function () {
        if (!views) return;
        views.detail.setText(text);
        // 小红标只有 60 像素宽，进度得按「3/9」这种最短写法给，长了自己截。
        if (shortText) {
          var brief = String(shortText);
          if (brief.length > HANDLE_TEXT_MAX_CHARS) {
            brief = brief.substring(0, HANDLE_TEXT_MAX_CHARS);
          }
          views.handle.setText(brief);
        }
      });
    } catch (error) {
      warn("刷新进度失败: " + error);
    }
  }

  // 切到结束菜单：切换任务 / 再次执行 / 编辑主流程。
  // 跑完和手动结束都走这里——两种情况下人要回答的是同一个问题：下一步干什么。
  // 所以它不自动消失，这是"跑挂了马上能修"的入口。
  function setMenu(summary) {
    if (closed) return;
    mode = "menu";
    // 跑完了就别再有人往那一行写倒计时：换一代，等着的那个线程自己退出。
    countdownGeneration += 1;
    var text = String(summary || "已结束");
    if (text.length > MENU_TEXT_MAX_CHARS) {
      text = text.substring(0, MENU_TEXT_MAX_CHARS) + "…";
    }
    menuHeight = text.length > MENU_ONE_LINE_CHARS
      ? MENU_HEIGHT_LONG
      : MENU_HEIGHT_SHORT;
    cancelHideTimer();
    // 菜单是要人看的，藏着就没意义了：切过来时一定摊开。
    hidden = false;
    try {
      runOnUi(function () {
        if (!views) return;
        views.title.setText(text);
        views.detail.setText("");
        views.handle.setText("✔");
        applyShape();
      });
    } catch (error) {
      warn("切菜单失败: " + error);
    }
  }

  function setFinished(summary, nextCanEdit) {
    if (nextCanEdit != null) canEdit = !!nextCanEdit;
    setMenu(summary);
  }

  function close() {
    if (closed) return;
    closed = true;
    countdownGeneration += 1;
    cancelHideTimer();
    if (unregister) {
      try { unregister(); } catch (error) {}
      unregister = null;
    }
    try {
      runOnUi(function () {
        try {
          window.close();
        } catch (error) {}
      });
    } catch (error) {}
  }

  return {
    setRunning: setRunning,
    // 跑到新的一步：带着「还要等多久」进来，这一层自己倒计时。
    setStep: setStep,
    setProgress: setProgress,
    setFinished: setFinished,
    setMenu: setMenu,
    // 让开 / 回来：定时浮层盖在这一层上面时用。
    // **不让开的话，待命条的「运行」就露在定时层旁边**，手一歪点下去直接起跑一个真任务。
    // 复用截图让路那套（收成 0x0），省得再造一套可见性管理。
    duck: hideForCapture,
    unduck: restoreAfterCapture,
    close: close
  };
}

module.exports = {
  create: create,
  // 导出是为了能在 PC 上验那一行字的边界（0 秒、不足十秒的小数、超长节点名）。
  renderCountdown: renderCountdown
};
