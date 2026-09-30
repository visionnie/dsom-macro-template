// =====================================================================
// 通用能力：边操作边录——每做一个动作记一个节点（点击 / 长按 / 滑动）
// =====================================================================
// 捕获途径的选择（2026-09-11 在云机上实测得出）：
//   - events.observeTouch() 旁路监听最干净，游戏照常收到点击，但它依赖
//     root 跑 getevent 读 /dev/input。本机 root 可用，然而 getevent -pl
//     里没有 ABS_MT_POSITION，注入点击也收不到，判定不可靠。
//   - 无障碍服务只能拿控件级事件，而游戏是 H5 画布，没有控件可拿。
//   - 悬浮窗拦截实测可行：透明全屏层收到触摸后记录坐标，再把这一下转发给游戏。
//     代价是必须在转发期间把自己设为不可触摸，否则转发的那一下又打回自己身上。
//
// 设计约束：
//   - 本模块不含游戏语义，只产出节点数据
//   - 每次点击都在**转发之前**截图：那张图是"点这一下时屏幕长什么样"，
//     后续要靠它框锚点，点完再截就晚了
//   - 控制条占用的区域不记录节点，否则点"停止"会先被记成一个节点
// =====================================================================

var recordedCase = require("./case/recorded-case-autojs.js");
var uiThread = require("./ui-thread-autojs.js");

var DEFAULT_TAP_DURATION_MS = 120;
// ---- 手势识别（2026-09-30）----
// 按下到抬手之间：位移超过 swipeSlopPx 算滑动，原地按住超过 longPressMs 算长按，
// 其余仍是点击。在这之前捕获层只在抬手时记一个坐标，划一道和按住不放都被记成点击，
// 而回放只会"点一下"——录制什么就执行什么这条在滑动上根本不成立。
//
// 两个阈值可在 config.recorder 里改：手感这种东西实机上说不对就得当场调。
// 24 像素：注入点击的落点是逐像素准的（2026-09-18 连拍实测），但人手在游戏上
// 点一下常带一点划，给一倍多的余量，免得点击被误判成一道极短的滑动。
var SWIPE_SLOP_PX = 24;
var LONG_PRESS_MS = 600;
// 转发与记录都用真实的手势时长，但必须有界：人按住不放走开一分钟，
// 录出来就是一条 60 秒的长按，回放时整条任务卡在那儿等它。
var MIN_SWIPE_DURATION_MS = 120;
var MAX_SWIPE_DURATION_MS = 3000;
var MIN_LONG_PRESS_MS = 300;
var MAX_LONG_PRESS_MS = 5000;
var FORWARD_SETTLE_MS = 180;
// 等「捕获层已让出触摸」的上限，以及确认之后再多留的一拍。
var TOUCHABLE_WAIT_MS = 800;
// setTouchable(false) 的回调返回 != 窗口真的不再接收触摸：AutoJs6 改的是 LayoutParams，
// 要等 WindowManager 做完一次 relayout 才生效。60 毫秒实测不够（回调已返回、
// 转发出去的那一下仍被捕获层吃掉，表现为"步数照记、游戏没反应"）。
var FORWARD_GUARD_MS = 250;

// 展开态与收起态的控制条尺寸。
// 宽度要放得下一整排按钮：窄了会换行，把第二行顶出窗口外面，
// 人就点不到停止了（2026-09-17 实测 190 宽时就是这样）。
// 2026-09-27 按钮从「停止/撤销/收起」变成「暂停/撤销/放弃/完成/收起」，宽度跟着加。
// 代价是控制条盖住的左上角变大，而那块区域录不到——所以它 3 秒没人碰就自己缩成小把手。
var PILL_WIDTH = 470;
var PILL_HEIGHT = 96;
// 控制条不能贴 (0,0)：状态栏的层级在 APPLICATION_OVERLAY 之上，贴顶会被它整个盖住。
// 游戏全屏时状态栏是隐藏的，所以一直没暴露；2026-09-17 在盒子界面（非全屏）录制时
// 收起的小把手 56x40 完全缩在 48px 的状态栏后面，**点不到，也就停不了录制**。
function statusBarHeight() {
  try {
    var resources = context.getResources();
    var id = resources.getIdentifier("status_bar_height", "dimen", "android");
    if (id > 0) return resources.getDimensionPixelSize(id);
  } catch (error) {}
  return 48;
}
// 收起后只剩一个小把手贴在左上角。做这件事是因为控制条会盖住游戏左上角，
// 而那一块恰好是任务栏和状态数值（2026-09-17 用户实测反馈）。
var HANDLE_WIDTH = 56;
var HANDLE_HEIGHT = 40;
// 多久没碰控制条就自动收起。参考自动按键精灵的交互。
var AUTO_COLLAPSE_MS = 3000;

// ---- 补录一个动作的图层（captureOneGesture）----
// 尺寸一律按像素给（内容超出 setSize 会被直接裁掉，本项目踩过五次）。
// 提示条摆在**左上角、状态栏下面**，和录制控制条同一个位置：
// 压在它下面的那一块录不到（触摸先被它接走），而录制时录不到的本来就是这一块——
// 换个位置就等于多出一块"平时能录、补录时录不到"的区域，没人记得住。
var CAPTURE_ONE_BAR_WIDTH = 560;
var CAPTURE_ONE_BAR_HEIGHT = 104;
var CAPTURE_ONE_READY_WAIT_MS = 2000;
var CAPTURE_ONE_UI_WAIT_MS = 1500;
var CAPTURE_ONE_FORWARD_GUARD_MS = 250;
var CAPTURE_ONE_SHOT_SETTLE_MS = 150;
// 全屏可触摸的层忘了关，整台设备就只剩物理键能用（point-picker 2026-09-17 实机踩到）。
var CAPTURE_ONE_AUTO_CLOSE_MS = 180000;

function clampRange(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function gestureThresholds(config) {
  var custom = (config && config.recorder) || {};
  return {
    swipeSlopPx: custom.swipeSlopPx != null ? custom.swipeSlopPx : SWIPE_SLOP_PX,
    longPressMs: custom.longPressMs != null ? custom.longPressMs : LONG_PRESS_MS
  };
}

// 按下点 + 抬手点 + 按住多久 -> 一个动作。
// **只看这两个点，不看中途轨迹**：直线滑动里轨迹给不出更多信息，
// 画圈那类又表达不了（用例里没有这种动作），记下来只会让人以为支持。
function classifyGesture(down, up, thresholds) {
  var dx = up.x - down.x;
  var dy = up.y - down.y;
  var heldMs = Math.max(0, up.at - down.at);
  if (Math.abs(dx) > thresholds.swipeSlopPx || Math.abs(dy) > thresholds.swipeSlopPx) {
    return {
      type: "swipe",
      x: down.x,
      y: down.y,
      x2: up.x,
      y2: up.y,
      durationMs: clampRange(heldMs, MIN_SWIPE_DURATION_MS, MAX_SWIPE_DURATION_MS)
    };
  }
  if (heldMs >= thresholds.longPressMs) {
    // 原地长按取**按下点**：抬手前手指常挪十几像素，而人瞄的是按下那一下。
    return {
      type: "longTap",
      x: down.x,
      y: down.y,
      pressMs: clampRange(heldMs, MIN_LONG_PRESS_MS, MAX_LONG_PRESS_MS)
    };
  }
  // 点击仍取抬手点：这是 2026-09-17 起一直在用、连拍逐像素验过的行为，不动它。
  return { type: "tap", x: up.x, y: up.y };
}

function describeGesture(gesture) {
  var head = "(" + Math.round(gesture.x) + "," + Math.round(gesture.y) + ")";
  if (gesture.type === "swipe") {
    return "滑动 " + head + " -> (" + Math.round(gesture.x2) + "," +
      Math.round(gesture.y2) + ") " + gesture.durationMs + "ms";
  }
  if (gesture.type === "longTap") {
    return "长按 " + head + " " + gesture.pressMs + "ms";
  }
  return "点击 " + head;
}

// 把人刚做的这一下转发给游戏。**动作类型必须跟着走**：
// 划一道却只转发一次点击，就是"步数照记、游戏没反应"那类静默失效
// （2026-09-17 在 setTouchable 时序上已经踩过一次同样的表现）。
function forwardGesture(gesture) {
  if (gesture.type === "swipe") {
    return swipe(
      Math.round(gesture.x),
      Math.round(gesture.y),
      Math.round(gesture.x2),
      Math.round(gesture.y2),
      gesture.durationMs
    );
  }
  return press(
    Math.round(gesture.x),
    Math.round(gesture.y),
    gesture.type === "longTap" ? gesture.pressMs : DEFAULT_TAP_DURATION_MS
  );
}

// 会话目录：<outputRoot>/recordings/<sessionId>/
function createSession(config) {
  var sessionId = String(Date.now());
  var dir = config.outputRoot + "/recordings/" + sessionId;
  files.ensureDir(dir + "/");
  return {
    id: sessionId,
    dir: dir,
    startedAt: Date.now(),
    nodes: [],
    shots: []
  };
}

// 这一步的截图叫什么。**按节点 id 取，不按"第几步"取**：
// 序号会随删除、插入、重排变，而按序号拼出来的名字会撞上磁盘上已有的那张
// （删掉第 3 步再往后录一步，算出来的 03.png 正是刚删那步留下的文件，直接被覆盖）。
// 老会话的截图路径原样存在 shot.path 里，改这个规则不影响它们。
function shotFileName(nodeId) {
  return nodeId + ".png";
}

// gesture（classifyGesture 的产物）-> 一个节点 + 一条截图记录。
// **录制中追加和事后补录共用这一处**：两边各拼一遍的话，补进来的一步迟早
// 和录出来的一步长得不一样，而"补的能跑、录的不能跑"这种差异没人查得清。
//
// 尺寸优先用 gesture 自己带的（补录时它是做动作那一刻定下来的），
// 没带就按当前屏幕算。nodeId 与 name 由调用方给：id 决定截图文件名，
// 得比截图落盘更早定下来；name 里的序号只有调用方知道该排第几。
function buildGestureNode(gesture, nodeId, name, shotPath) {
  var width = gesture.deviceWidth || device.width;
  var height = gesture.deviceHeight || device.height;
  function ratio(value, span) {
    return Math.round(Math.max(0, Math.min(1, value / span)) * 10000) / 10000;
  }
  var node = {
    id: nodeId,
    // 默认名带序号和动作词，复核页可以改。名字只用来给人看（列表、日志），
    // 素材与跳转都认 id，改名不会牵动任何东西。
    name: name,
    type: gesture.type,
    rx: ratio(gesture.x, width),
    ry: ratio(gesture.y, height)
  };
  var shot = {
    nodeId: node.id,
    path: shotPath,
    deviceWidth: width,
    deviceHeight: height,
    x: Math.round(gesture.x),
    y: Math.round(gesture.y)
  };
  if (gesture.type === "swipe") {
    node.rx2 = ratio(gesture.x2, width);
    node.ry2 = ratio(gesture.y2, height);
    node.durationMs = gesture.durationMs;
    // 像素值也留在 shot 里：挪坐标、改类型都要拿它重算，
    // 归一化值反算回像素会带进舍入误差（与点击的 x/y 同一个道理）。
    shot.x2 = Math.round(gesture.x2);
    shot.y2 = Math.round(gesture.y2);
    shot.durationMs = gesture.durationMs;
  }
  if (gesture.type === "longTap") {
    node.pressMs = gesture.pressMs;
    shot.pressMs = gesture.pressMs;
  }
  return { node: node, shot: shot };
}

// 录制过程中往会话末尾追加一步。nodeId 由调用方先算好——截图要在**转发之前**
// 落盘，而文件名跟着 id 走，所以 id 必须比节点本身先定下来。
function addGestureNode(session, gesture, nodeId, shotPath, gapMs) {
  var built = buildGestureNode(
    gesture,
    nodeId,
    recordedCase.defaultNodeName(session.nodes.length + 1, gesture.type),
    shotPath
  );
  // 两个动作之间人停顿了多久，就是这一步之后界面需要多久——比拍脑袋填默认值准。
  // 只在停顿明显时才写，避免给每一步都塞一个没意义的等待。
  // **按"上一步做完 -> 这一步按下"算**，不含按住的那段：长按 2 秒是动作本身的时长，
  // 算进等待里的话每条长按后面都会白挂一个两秒的停顿。
  if (gapMs != null && gapMs > 400) {
    built.node.postWaitMs = Math.min(10000, Math.round(gapMs / 100) * 100);
  }
  session.nodes.push(built.node);
  session.shots.push(built.shot);
  return built.node;
}

function saveSession(session) {
  var payload = {
    sessionId: session.id,
    // 人给这条录制取的名字。存在会话里而不是 case.json 里：case.json 是会话的产物，
    // 改完步骤会被重新生成，名字必须活在生成它的那份数据上。
    name: session.name,
    startedAt: new Date(session.startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    baseline: session.baseline || { width: device.width, height: device.height },
    nodes: session.nodes,
    shots: session.shots
  };
  var path = session.dir + "/session.json";
  files.write(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

// ---- 录制主体 ----
// onStop(session, savedPath) 在点「完成」时回调；调用方决定接下来给人看什么。
// options: {
//   session: 已有会话——「继续录制」用，节点往后追加，不新建目录
//   onCancel(reason): 点「放弃」时回调，此时什么都没保存
// }
//
// **起手是待命态，不是直接开录**（2026-09-27 用户要求，参照自动按键精灵）：
// 屏幕上先浮出「▶ 开始录制 / 放弃」，人自己把游戏调到要录的那一页，再点开始。
// 原先是一进来就录，于是人还在找页面的那几下全被记成废节点。
//
// 待命态**不建捕获层**：那一层是全屏可触摸的，建早了人就没法正常操作游戏了。
function start(context, config, onStop, options) {
  var opts = options || {};
  var continuing = !!opts.session;
  var session = opts.session || createSession(config);
  // 继续录制时，「放弃」只该丢掉这一趟新加的，不能把之前录好的一起删了。
  var baseNodeCount = session.nodes.length;
  var screen = context.screen;
  var logger = context.logger;
  // 上一个动作**抬手**的时刻，用来算下一步之前人停了多久。
  var lastTapAt = null;
  // 还没抬手的那一下按在哪儿、什么时候按的。抬手时才连起来判动作类型。
  var pendingDown = null;
  var thresholds = gestureThresholds(config);
  var stopped = false;
  // "ready" 待命（没有捕获层）/ "recording" 正在记 / "paused" 暂停记录
  var phase = "ready";
  // 放弃要点两次：一趟录制丢了就是丢了，误触的代价太大。
  var discardArmed = false;
  // 转发期间必须吞掉所有触摸。只靠 setTouchable(false) 不够：它走 ui.run 是异步的，
  // 转发的那一下会赶在生效之前落回捕获层，于是一次点击记成两步（实测 3 次点击记了 5 步）。
  // 这个标志在触摸回调里同步置位，不依赖任何时序。
  var forwarding = false;

  // 全屏透明捕获层。淡淡上一层色，让人知道自己正处在录制状态——
  // 完全透明的话，忘了还在录、回头发现记了一堆废节点。
  //
  // **必须在控制条之前创建，哪怕待命态还用不上它。**
  // 两个都是 APPLICATION_OVERLAY，后建的压在上面；捕获层是全屏可触摸的，
  // 一旦压过控制条，「暂停 / 放弃 / 完成」就全点不到了——
  // 点在控制条上的手指会被捕获层截走，而它对那块区域的处理是"不记录也不转发"，
  // 于是那一下什么都不会发生，人只能 kill 掉 App（2026-09-27 实测，
  // dumpsys 里控制条窗口始终是 56x40，从没展开过）。
  //
  // 待命期间它 0x0 且不可触摸，等于不存在；真开始录才铺满全屏。
  var capture = floaty.rawWindow(
    '<frame id="root" bg="#11000000" w="*" h="*"/>'
  );
  var captureReady = false;

  // 控制条单独一个窗口，浮在捕获层之上。
  // 布局刻意保持简单：根节点带 id、子节点不写宽高。实测在根节点上写 w/h、
  // 在子节点上写 w 时，findView 会返回 null——尺寸交给 setSize 去管。
  // 两个形态放在同一个窗口里，靠 visibility 切换：
  // handle 是收起后的小把手，panel 是展开后的完整控制条。
  // 尺寸仍然由 setSize 管，布局里一律不写 w/h（写了 findView 会返回 null）。
  var pill = floaty.rawWindow(
    [
      '<vertical id="root" bg="#e0000000">',
      '  <text id="handle" text=" ● 录 " textColor="#ff8a80" textSize="14sp" padding="8 8"/>',
      '  <vertical id="panel" padding="10 6">',
      '    <text id="counter" text="待命" textColor="#ffffff" textSize="13sp"/>',
      // 待命态那一排：人还没开始录，只有「开始」和「放弃」。
      '    <horizontal id="readyRow">',
      '      <text id="beginButton" text=" ▶ 开始录制 " textColor="#69f0ae" textSize="15sp"/>',
      '      <text id="readyCancelButton" text=" 放弃 " textColor="#ff8a80" textSize="15sp"/>',
      "    </horizontal>",
      // 录制态那一排。「停止」改叫「完成」——它做的是存盘收工，不是中止；
      // 真正的中止是旁边那个「放弃」（2026-09-27 用户要求把两者分开）。
      '    <horizontal id="recordRow">',
      '      <text id="pauseButton" text=" 暂停 " textColor="#ffd54f" textSize="15sp"/>',
      '      <text id="undoButton" text=" 撤销 " textColor="#ffd54f" textSize="15sp"/>',
      '      <text id="discardButton" text=" 放弃 " textColor="#ff8a80" textSize="15sp"/>',
      '      <text id="finishButton" text=" 完成 " textColor="#69f0ae" textSize="15sp"/>',
      '      <text id="collapseButton" text=" 收起 " textColor="#90caf9" textSize="15sp"/>',
      "    </horizontal>",
      "  </vertical>",
      "</vertical>"
    ].join("\n")
  );
  // 窗口生命周期：从 threads.start -> ui.run 里创建时，findView 与 setSize
  // **都要等窗口 attach 之后**才可用——立刻调 findView 会全部返回 null，
  // 立刻调 setSize 会 NullPointerException。所以整套接线都推迟到定时器里做。
  // （在脚本顶层直接创建时 findView 是立刻可用的，两种时机不一样，别照搬。）
  var counterView = null;
  var handleView = null;
  var panelView = null;
  var readyRowView = null;
  var recordRowView = null;
  var pauseView = null;
  var discardView = null;
  // 控制条当前占多大——触摸排除区要按它算，收起后不能再排除整块 190x76，
  // 否则左上角一大片区域永远录不到。
  var pillWidth = PILL_WIDTH;
  var pillHeight = PILL_HEIGHT;
  var pillTop = statusBarHeight();
  var collapsed = false;
  var collapseTimer = null;

  // 计数区顺带当状态栏用：待命 / 正在录 / 已暂停，三种状态人一眼要分得出来，
  // 否则「以为在录其实没录」和它的反面都会白忙一趟。
  function counterText() {
    if (phase === "ready") {
      return continuing
        ? "待命　已有 " + session.nodes.length + " 步，点开始接着录"
        : "待命　点「开始录制」再操作游戏";
    }
    var head = phase === "paused" ? "已暂停" : "正在录";
    return head + "　已记录 " + session.nodes.length + " 步";
  }

  function refreshCounter() {
    if (!counterView) return;
    ui.run(function () {
      counterView.setText(counterText());
    });
  }

  // 按当前阶段刷新控制条：待命只给「开始 / 放弃」，录起来之后才给
  // 「暂停 / 撤销 / 放弃 / 完成」。两排共用一个窗口，靠 visibility 切换。
  function applyPhase() {
    var ready = phase === "ready";
    ui.run(function () {
      if (stopped) return;
      if (readyRowView) readyRowView.setVisibility(ready ? 0 : 8);
      if (recordRowView) recordRowView.setVisibility(ready ? 8 : 0);
      if (pauseView) pauseView.setText(phase === "paused" ? " 继续 " : " 暂停 ");
      if (discardView) discardView.setText(" 放弃 ");
      if (counterView) counterView.setText(counterText());
    });
  }

  // ---- 控制条的展开 / 收起 ----
  // 控制条固定在左上角，会盖住游戏的任务栏和状态数值。参考自动按键精灵的做法：
  // 不碰它就自动缩成一个小把手，点把手再展开。
  function applyCollapsed(next) {
    collapsed = next;
    pillWidth = next ? HANDLE_WIDTH : PILL_WIDTH;
    pillHeight = next ? HANDLE_HEIGHT : PILL_HEIGHT;
    ui.run(function () {
      if (stopped) return;
      if (handleView) handleView.setVisibility(next ? 0 : 8);   // 0=VISIBLE, 8=GONE
      if (panelView) panelView.setVisibility(next ? 8 : 0);
      pill.setSize(pillWidth, pillHeight);
    });
  }

  function cancelCollapseTimer() {
    if (collapseTimer !== null) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  }

  // 每次碰控制条都重新计时。录制点击不重置——那是在操作游戏，不该把控制条唤回来挡路。
  function scheduleCollapse() {
    cancelCollapseTimer();
    collapseTimer = setTimeout(function () {
      collapseTimer = null;
      if (!stopped && !collapsed) applyCollapsed(true);
    }, AUTO_COLLAPSE_MS);
  }

  // 人主动点把手展开，就**不再自动收起**——自动收只服务于「初次显示后让开位置」。
  // 早先展开后也重排 3 秒定时器，结果是人刚展开、还没来得及点「停止」就被收走了
  // （2026-09-17 实测：展开后隔了 3 秒多去点停止，那块已经不是控制条，
  // 于是被当成游戏点击记成了一个节点）。
  function expandPill() {
    cancelCollapseTimer();
    if (collapsed) applyCollapsed(false);
  }

  // 点计数区手动收起，给人一个明确的收回入口。
  function collapsePill() {
    cancelCollapseTimer();
    if (!collapsed) applyCollapsed(true);
  }

  // ---- 待命 -> 开始录 ----
  // 捕获层到这一刻才建：它全屏可触摸，早建一秒人就早一秒操作不了游戏。
  // 建完同样要等 attach 才能 findView / setSize（见文件里关于窗口时机的说明）。
  function beginRecording() {
    if (stopped || phase !== "ready") return;
    if (!captureReady) {
      toast("捕获层还没就绪，稍等一下再点");
      return;
    }
    phase = "recording";
    discardArmed = false;
    pendingDown = null;
    try {
      capture.setSize(-1, -1);
      capture.setTouchable(true);
    } catch (error) {
      phase = "ready";
      logger.warn("捕获层没能铺开: " + error);
      toast("录制启动失败: " + error);
      return;
    }
    applyPhase();
    logger.info("开始录制，会话目录: " + session.dir);
    // 说清记什么：这一版起划一道、按住不放都会被记成对应的动作，
    // 人不知道的话还是只会点——能力加了等于没加。
    toast("开始录制：点一下 / 划一道 / 按住不放都会记下来");
    scheduleCollapse();
  }

  // 暂停：把捕获层让出触摸，点击直接落到游戏上，不记也不转发。
  // 为什么不是关掉捕获层：那层淡色是「你还在一次录制里」的唯一提示，
  // 关了人就会忘记自己还没点完成。
  function togglePause() {
    if (stopped || phase === "ready") return;
    phase = phase === "paused" ? "recording" : "paused";
    discardArmed = false;
    // 按住的时候被按了暂停，那一下就不该再连成手势。
    pendingDown = null;
    var touchable = phase === "recording";
    ui.run(function () {
      if (capture) {
        try { capture.setTouchable(touchable); } catch (error) {}
      }
    });
    applyPhase();
    toast(phase === "paused" ? "已暂停，点击不再记录" : "继续记录");
  }

  // 放弃：什么都不保存。新录的连目录一起删；继续录制的只删这一趟新加的截图，
  // 之前录好的那些一个都不能动——session.json 本来就还没写回去。
  function discard() {
    if (stopped) return;
    if (phase !== "ready" && !discardArmed) {
      discardArmed = true;
      ui.run(function () {
        if (discardView) discardView.setText(" 真的放弃？ ");
      });
      return;
    }
    stopped = true;
    cancelCollapseTimer();
    closeWindows();
    try {
      if (continuing) {
        for (var i = session.shots.length - 1; i >= baseNodeCount; i--) {
          var shot = session.shots[i];
          if (shot && shot.path) {
            try { files.remove(shot.path); } catch (error) {}
          }
        }
        session.nodes.length = baseNodeCount;
        session.shots.length = baseNodeCount;
      } else {
        files.removeDir(session.dir);
      }
    } catch (error) {
      logger.warn("放弃录制时清理失败: " + error);
    }
    logger.info("已放弃这次录制" + (continuing ? "（保留之前的 " + baseNodeCount + " 步）" : ""));
    if (opts.onCancel) opts.onCancel(session);
  }

  function closeWindows() {
    if (capture) {
      try { capture.close(); } catch (error) {}
      capture = null;
    }
    try { pill.close(); } catch (error) {}
  }

  function finish() {
    if (stopped) return;
    // 待命态点不到「完成」（那一排根本没显示），这里是兜底：
    // 一步没录就存盘，会在列表里留下一条空录制，谁也不知道它是什么。
    if (phase === "ready") return;
    stopped = true;
    cancelCollapseTimer();
    closeWindows();
    // 基线在停止这一刻定下来并随会话保存，取第一步截图的尺寸。
    // 之后复核页（竖屏）改完节点还会再存盘，若那时实时读 device，基线会被悄悄改成竖屏。
    session.baseline = session.shots.length > 0
      ? { width: session.shots[0].deviceWidth, height: session.shots[0].deviceHeight }
      : { width: device.width, height: device.height };
    var savedPath = saveSession(session);
    logger.info("录制结束，共 " + session.nodes.length + " 步，已保存: " + savedPath);
    onStop(session, savedPath);
  }

  function undo() {
    if (session.nodes.length === 0) {
      toast("还没有可撤销的步骤");
      return;
    }
    var removed = session.nodes.pop();
    var shot = session.shots.pop();
    if (shot && shot.path) {
      try { files.remove(shot.path); } catch (error) {}
    }
    toast("已撤销 " + removed.name);
    refreshCounter();
  }

  function onCaptureTouch(view, event) {
    if (stopped) return false;
    // 暂停时一律不接：窗口已经让出触摸，理论上到不了这儿，
    // 但 setTouchable 生效有延迟，中间那几十毫秒的点击不该被记进来。
    if (phase !== "recording") return false;
    // 转发中的触摸一律吞掉：那是我们自己打出去的那一下又落了回来。
    if (forwarding) return true;

    var action = event.getAction();
    // 按下只记下来，不产生节点：动作是什么，要等抬手才知道
    // （原地抬手是点击，划出去是滑动，按着不动是长按）。
    if (action === event.ACTION_DOWN) {
      pendingDown = { x: event.getRawX(), y: event.getRawY(), at: Date.now() };
      return true;
    }
    if (action === event.ACTION_CANCEL) {
      pendingDown = null;
      return true;
    }
    if (action !== event.ACTION_UP) {
      return true;
    }

    var up = { x: event.getRawX(), y: event.getRawY(), at: Date.now() };
    var down = pendingDown;
    pendingDown = null;
    // 收不到按下就退化成一次点击，别把这一下丢掉：窗口刚铺开、
    // 或者上一下还在转发时按下的那一次，都可能只剩抬手到得了这儿。
    if (!down) down = { x: up.x, y: up.y, at: up.at };

    // 控制条区域内的触摸交给控制条，不记录也不转发。
    // **按按下点判**：按抬手点判的话，从控制条上往外划的那一下会被记成一步滑动。
    // 用当前尺寸而不是展开态的固定值：收起后排除区要跟着缩小。
    // 排除区要跟着控制条的实际位置走——它从状态栏下面开始，不是贴顶。
    if (down.x < pillWidth && down.y >= pillTop && down.y < pillTop + pillHeight) {
      return false;
    }

    var gesture = classifyGesture(down, up, thresholds);

    // 同步置位，必须在开线程之前——线程调度慢一拍就来不及挡了。
    forwarding = true;

    // 转发和截图都会阻塞，放进工作线程，别卡住触摸回调。
    threads.start(function () {
      var gapMs = lastTapAt === null ? null : down.at - lastTapAt;
      lastTapAt = up.at;

      var nodeId = recordedCase.nextNodeId(session.nodes);
      var shotPath = session.dir + "/" + shotFileName(nodeId);
      try {
        // 必须在转发之前截：这张图是"做这一下时屏幕长什么样"，
        // 做完再截拍到的是下一个界面，框锚点就框错了。
        // 滑动也一样——手势被捕获层吞着，游戏画面还没动，所以这时候截到的
        // 仍是这一道滑动开始前的那一页。
        screen.saveTo(shotPath);
      } catch (error) {
        logger.warn("录制截图失败: " + error);
        shotPath = null;
      }

      var node = addGestureNode(session, gesture, nodeId, shotPath, gapMs);
      refreshCounter();

      // 转发这一下给游戏。转发期间必须让自己不可触摸，
      // 否则这一下会再次落回捕获层，形成自己点自己的死循环。
      //
      // **必须确认 setTouchable(false) 真的生效了再 press。** ui.run 是异步的，
      // 早先的写法是 ui.run 之后 sleep(60) 就转发——赶在属性生效之前打出去的那一下
      // 会落回捕获层，而 forwarding 标志正好把它吞掉：**步数照记，游戏收不到点击**
      // （2026-09-17 用户实测「记了 4 步但游戏没反应」就是这个）。
      // 改成在回调末尾置位、这边轮询等待，不再赌时序。
      var touchableOff = false;
      ui.run(function () {
        // 这一下转发还在排队时，人可能已经点了「完成」或「放弃」，窗口就没了。
        // 当成"让出成功"往下走：窗口都关了，自然不会再把点击吃回去。
        if (capture) capture.setTouchable(false);
        touchableOff = true;
      });
      var offDeadline = Date.now() + TOUCHABLE_WAIT_MS;
      while (!touchableOff && Date.now() < offDeadline) {
        sleep(10);
      }
      if (!touchableOff) {
        // 没等到就不要转发了：转发出去也只会被自己吞掉，
        // 白记一个节点还让人以为游戏卡了。
        logger.warn("捕获层未能及时让出触摸，本次点击不转发");
      } else {
        // 属性生效到窗口真正不再接收事件之间还有一小段，给它一拍。
        sleep(FORWARD_GUARD_MS);
        // 转发的是**同一种动作**：滑动转发 swipe、长按转发带时长的 press。
        // 转发失败要说出来——人手上那一下没落到游戏里，而节点已经记下了，
        // 不提示的话录完回放才发现整条对不上。
        if (!forwardGesture(gesture)) {
          logger.warn("转发失败，这一下游戏可能没收到: " + describeGesture(gesture));
        }
        sleep(FORWARD_SETTLE_MS);
      }

      ui.run(function () {
        // 转发完要把触摸收回来——但人可能在这期间点了暂停或完成，
        // 那时候收回来就等于偷偷又开始记了。
        if (!stopped && capture && phase === "recording") capture.setTouchable(true);
      });
      // 再多等一拍才解除吞噬：setTouchable(true) 生效与残留事件送达之间还有窗口期。
      sleep(120);
      forwarding = false;

      logger.info("录制 " + node.id + " " + describeGesture(gesture));
    });

    return true;
  }

  // 接线统一推迟：见上方关于窗口 attach 时机的说明。
  setTimeout(function () {
    try {
      var captureRoot = capture.findView("root");
      if (!captureRoot) throw new Error("capture.root 未找到");
      captureRoot.setOnTouchListener(onCaptureTouch);
      // 待命期间收成 0x0 且不可触摸：窗口已经建好（占住了 z 序），但不挡人操作游戏。
      capture.setSize(0, 0);
      capture.setTouchable(false);
      captureReady = true;

      counterView = pill.findView("counter");
      handleView = pill.findView("handle");
      panelView = pill.findView("panel");
      readyRowView = pill.findView("readyRow");
      recordRowView = pill.findView("recordRow");
      pauseView = pill.findView("pauseButton");
      discardView = pill.findView("discardButton");
      var beginView = pill.findView("beginButton");
      var readyCancelView = pill.findView("readyCancelButton");
      var undoView = pill.findView("undoButton");
      var finishView = pill.findView("finishButton");
      var collapseView = pill.findView("collapseButton");

      var missing = [];
      var required = {
        capture: captureRoot,
        counter: counterView, handle: handleView, panel: panelView,
        readyRow: readyRowView, recordRow: recordRowView,
        beginButton: beginView, readyCancelButton: readyCancelView,
        pauseButton: pauseView, undoButton: undoView,
        discardButton: discardView, finishButton: finishView,
        collapseButton: collapseView
      };
      for (var key in required) {
        // 报名字要报准：查这条错时，"capture.root 没找到"和"控制条少个按钮"
        // 要去看的地方完全不同。
        if (!required[key]) missing.push(key === "capture" ? "capture.root" : "pill." + key);
      }
      if (missing.length > 0) {
        throw new Error("控件未找到: " + missing.join(", "));
      }

      beginView.setOnClickListener(function () {
        cancelCollapseTimer();
        beginRecording();
      });
      readyCancelView.setOnClickListener(function () {
        cancelCollapseTimer();
        discard();
      });
      pauseView.setOnClickListener(function () {
        cancelCollapseTimer();
        togglePause();
      });
      undoView.setOnClickListener(function () {
        undo();
      });
      discardView.setOnClickListener(function () {
        cancelCollapseTimer();
        discard();
      });
      finishView.setOnClickListener(function () {
        cancelCollapseTimer();
        finish();
      });
      // 收起态的小把手：点一下展开，之后不再自动收起。
      handleView.setOnClickListener(function () {
        expandPill();
      });
      collapseView.setOnClickListener(function () {
        collapsePill();
      });

      pill.setSize(PILL_WIDTH, PILL_HEIGHT);
      pill.setPosition(0, pillTop);
      pill.setTouchable(true);
      handleView.setVisibility(8);
      panelView.setVisibility(0);
      applyPhase();
      // 待命态**不自动收起**：人正等着点「开始录制」，收走了还得先找把手。
      // 收起的计时改到真的开始录之后再排（见 beginRecording）。

      logger.info("录制待命层就绪，会话目录: " + session.dir);
      toast(continuing ? "待命：点「开始录制」接着录" : "待命：点「开始录制」再操作游戏");
    } catch (error) {
      logger.warn("录制悬浮层初始化失败: " + error);
      toast("录制启动失败: " + error);
      closeWindows();
    }
  }, 800);

  return {
    session: session,
    stop: finish,
    discard: discard
  };
}

// ---- 只录一个动作（「在此后插入一步」用）----
// 一层全屏捕获 + 一条提示条。人在游戏上做一个动作就自己收摊，把这个动作交回调用方。
// **插到哪儿、怎么存盘全由调用方决定**：本模块不碰顺序语义。
//
// 与 start() 共用同一套识别（classifyGesture）、截图时机（转发之前）和转发
// （forwardGesture）。共用是硬要求——补录进来的一步必须和录出来的一步一模一样，
// 否则"补的能跑、录的不能跑"这种差异没人查得清。
//
// options: { shotPath（必填，这一步的截图存哪儿）, logger, title }
// done(gesture, reason)：
//   gesture = { type, x, y, x2, y2, durationMs, pressMs, deviceWidth, deviceHeight, shotPath }
//   取消 / 超时 / 转屏时 done(null, "cancel" | "timeout" | "rotated")
//
// **必须在工作线程调用**：建窗口要等 attach，会 sleep。
function captureOneGesture(context, config, options, done) {
  var opts = options || {};
  var logger = opts.logger || context.logger;
  var thresholds = gestureThresholds(config);
  var capture = null;
  var bar = null;
  var closed = false;
  var finished = false;
  var pendingDown = null;

  function runOnUi(action) {
    uiThread.run(action, CAPTURE_ONE_UI_WAIT_MS);
  }

  function closeAll() {
    if (closed) return;
    closed = true;
    try {
      runOnUi(function () {
        if (capture) {
          try { capture.close(); } catch (error) {}
        }
        if (bar) {
          try { bar.close(); } catch (error) {}
        }
      });
    } catch (error) {
      if (logger) logger.warn("补录图层关闭失败: " + error);
    }
  }

  // gesture 为 null 就是没录成。两种情况都在这里收口，保证窗口一定被关掉——
  // 全屏可触摸的层忘了关，整台设备就只剩物理键能用（point-picker 的那条教训）。
  function finish(gesture, reason) {
    if (finished) return;
    finished = true;
    threads.start(function () {
      var shotPath = null;
      if (gesture) {
        shotPath = opts.shotPath;
        try {
          // 提示条先收成 0x0：**把自己的界面拍进这一步的截图里**，之后拿它框锚点
          // 就会把那块界面框进模板，回放时永远匹配不上（2026-09-27 踩过）。
          // close() 返回 != 画面已经更新，所以收完要等一拍再拍。
          runOnUi(function () {
            if (bar) bar.setSize(0, 0);
          });
          sleep(CAPTURE_ONE_SHOT_SETTLE_MS);
          // 截图仍在**转发之前**：这张图是"做这一下时屏幕长什么样"。
          context.screen.saveTo(shotPath);
        } catch (error) {
          if (logger) logger.warn("补录截图失败: " + error);
          shotPath = null;
        }
      }
      closeAll();
      if (gesture) {
        // 先把图层关掉再转发，就不用再走 setTouchable 那套时序了。
        // 但 close() 返回 != 窗口真的没了（与"裁图前等 250 毫秒"同一类问题），
        // 所以仍要等一拍，否则这一下会落回正在消失的捕获层上。
        sleep(CAPTURE_ONE_FORWARD_GUARD_MS);
        if (!forwardGesture(gesture)) {
          if (logger) logger.warn("补录转发失败，这一下游戏可能没收到: " + describeGesture(gesture));
        }
        sleep(FORWARD_SETTLE_MS);
        gesture.shotPath = shotPath;
      }
      try {
        done(gesture, reason || (gesture ? "ok" : "cancel"));
      } catch (error) {
        if (logger) logger.warn("补录回调出错: " + error);
      }
    });
  }

  // 捕获层先建、提示条后建：z 序就是创建顺序，反了的话全屏捕获层会压住提示条，
  // 「取消」点不到（ONBOARDING 第 25 条，2026-09-27 在录制器上踩过）。
  runOnUi(function () {
    capture = floaty.rawWindow('<frame id="root" bg="#22000000" w="*" h="*"/>');
    bar = floaty.rawWindow(
      [
        '<vertical id="root" bg="#e6000000" padding="12 8">',
        '  <text id="tips" text="" textColor="#ffffff" textSize="14sp"/>',
        '  <horizontal marginTop="6">',
        '    <text id="cancelBtn" text=" 取消 " textColor="#ff8a80" textSize="16sp" padding="14 4"/>',
        "  </horizontal>",
        "</vertical>"
      ].join("\n")
    );
  });

  var deadline = Date.now() + CAPTURE_ONE_READY_WAIT_MS;
  while (true) {
    try {
      runOnUi(function () {
        capture.setSize(-1, -1);
        capture.setPosition(0, 0);
        capture.setTouchable(true);
        bar.setTouchable(true);
        bar.setSize(Math.min(CAPTURE_ONE_BAR_WIDTH, device.width), CAPTURE_ONE_BAR_HEIGHT);
        // 不能贴 (0,0)：状态栏的层级在 APPLICATION_OVERLAY 之上，贴顶会被它整个盖住，
        // 于是「取消」点不到（2026-09-17 在录制控制条上踩过一次）。
        bar.setPosition(0, statusBarHeight());
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        closeAll();
        throw error;
      }
      sleep(30);
    }
  }

  runOnUi(function () {
    var rootView = capture.findView("root");
    var tipsView = bar.findView("tips");
    var cancelView = bar.findView("cancelBtn");
    if (!rootView || !tipsView || !cancelView) {
      throw new Error(
        "补录图层控件未找到: " +
          (!rootView ? "capture.root " : "") +
          (!tipsView ? "bar.tips " : "") +
          (!cancelView ? "bar.cancelBtn" : "")
      );
    }
    tipsView.setText(String(opts.title || "在游戏上做一个动作：点一下 / 划一道 / 按住不放"));
    rootView.setOnTouchListener(function (view, event) {
      if (finished) return false;
      var action = event.getAction();
      if (action === event.ACTION_DOWN) {
        pendingDown = { x: event.getRawX(), y: event.getRawY(), at: Date.now() };
        return true;
      }
      if (action === event.ACTION_CANCEL) {
        pendingDown = null;
        return true;
      }
      if (action !== event.ACTION_UP) return true;
      var up = { x: event.getRawX(), y: event.getRawY(), at: Date.now() };
      var down = pendingDown || { x: up.x, y: up.y, at: up.at };
      pendingDown = null;
      var gesture = classifyGesture(down, up, thresholds);
      // 尺寸在这一刻定下来：这一步的归一化坐标要按它算，
      // 之后转屏也不该让已经录好的这一步跟着变。
      gesture.deviceWidth = device.width;
      gesture.deviceHeight = device.height;
      finish(gesture, "ok");
      return true;
    });
    cancelView.setOnClickListener(function () {
      finish(null, "cancel");
    });
  });

  if (logger) logger.info("补录图层已就绪，等一个动作");

  // 看门狗：超时自己关，转屏也自己关（转屏之后这一下的坐标空间就变了）。
  threads.start(function () {
    var watchdogDeadline = Date.now() + CAPTURE_ONE_AUTO_CLOSE_MS;
    var bornWidth = device.width;
    var bornHeight = device.height;
    while (!finished) {
      sleep(500);
      if (finished) return;
      if (device.width !== bornWidth || device.height !== bornHeight) {
        if (logger) logger.warn("补录期间屏幕转向了，图层已关闭");
        finish(null, "rotated");
        return;
      }
      if (Date.now() >= watchdogDeadline) {
        if (logger) logger.warn("补录图层超时未操作，已自动关闭");
        finish(null, "timeout");
        return;
      }
    }
  });
}

// 读回已存盘的会话，供「打开已有录制」回到复核页继续框锚点、生成用例、回放。
// 返回结构与 createSession 的内存对象一致，saveSession 可以原样写回。
function loadSession(dir) {
  var path = dir + "/session.json";
  if (!files.exists(path)) {
    throw new Error("会话文件不存在: " + path);
  }
  var raw = files.read(path);
  if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  var data = JSON.parse(raw);
  // saveSession 会 new Date(startedAt)，这里必须还原成毫秒数，否则再存盘就是 Invalid Date。
  var startedAt = Date.parse(data.startedAt);
  return {
    id: String(data.sessionId),
    dir: dir,
    name: data.name || null,
    startedAt: isNaN(startedAt) ? Date.now() : startedAt,
    baseline: data.baseline,
    nodes: data.nodes || [],
    shots: data.shots || []
  };
}

// 列出录制会话，最新的在前。打不开的会话标出来而不是跳过：人得知道有东西坏了。
function listSessions(config, limit) {
  var root = config.outputRoot + "/recordings";
  var rows = [];
  if (!files.exists(root)) return rows;
  var names = files.listDir(root, function (name) {
    return files.isDir(root + "/" + name);
  });
  for (var i = 0; i < names.length; i++) {
    var dir = root + "/" + names[i];
    if (!files.exists(dir + "/session.json")) continue;
    var row = { id: names[i], dir: dir, sortKey: Number(names[i]) || 0 };
    try {
      var session = loadSession(dir);
      var upgraded = 0;
      for (var n = 0; n < session.nodes.length; n++) {
        if (session.nodes[n].type === "tapImage") upgraded++;
      }
      row.stepCount = session.nodes.length;
      row.upgradedCount = upgraded;
      row.hasCase = files.exists(dir + "/case.json");
      row.startedAt = session.startedAt;
      row.name = session.name || null;
    } catch (error) {
      row.broken = String(error && error.message ? error.message : error);
    }
    rows.push(row);
  }
  rows.sort(function (a, b) {
    return b.sortKey - a.sortKey;
  });
  return limit ? rows.slice(0, limit) : rows;
}

module.exports = {
  start: start,
  captureOneGesture: captureOneGesture,
  shotFileName: shotFileName,
  buildGestureNode: buildGestureNode,
  // 识别规则只有这一份。导出它是为了能在 PC 上直接喂坐标验阈值——
  // 手势这种东西上真机之前先把边界算清楚，比在设备前反复划便宜得多。
  gestureThresholds: gestureThresholds,
  classifyGesture: classifyGesture,
  describeGesture: describeGesture,
  saveSession: saveSession,
  loadSession: loadSession,
  listSessions: listSessions
};
