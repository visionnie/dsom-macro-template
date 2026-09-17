// =====================================================================
// 通用能力：边操作边录——每点一下记一个节点
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

var DEFAULT_TAP_DURATION_MS = 120;
var FORWARD_SETTLE_MS = 180;
// 等「捕获层已让出触摸」的上限，以及确认之后再多留的一拍。
var TOUCHABLE_WAIT_MS = 800;
// setTouchable(false) 的回调返回 != 窗口真的不再接收触摸：AutoJs6 改的是 LayoutParams，
// 要等 WindowManager 做完一次 relayout 才生效。60 毫秒实测不够（回调已返回、
// 转发出去的那一下仍被捕获层吃掉，表现为"步数照记、游戏没反应"）。
var FORWARD_GUARD_MS = 250;

// 展开态与收起态的控制条尺寸。
// 宽度要放得下「停止 / 撤销 / 收起」三个按钮：窄了会换行，把第二行顶出窗口外面，
// 人就点不到停止了（2026-09-17 实测 190 宽时就是这样）。
var PILL_WIDTH = 290;
var PILL_HEIGHT = 88;
// 收起后只剩一个小把手贴在左上角。做这件事是因为控制条会盖住游戏左上角，
// 而那一块恰好是任务栏和状态数值（2026-09-17 用户实测反馈）。
var HANDLE_WIDTH = 56;
var HANDLE_HEIGHT = 40;
// 多久没碰控制条就自动收起。参考自动按键精灵的交互。
var AUTO_COLLAPSE_MS = 3000;

function pad(value, width) {
  var text = String(value);
  while (text.length < width) text = "0" + text;
  return text;
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

// 归一化：录制时按当前设备尺寸换算，回放时再按 baseline 换回去。
// 这里必须实时读 device，因为屏幕方向会跟着前台应用变。
function toRatio(x, y) {
  return {
    rx: Math.max(0, Math.min(1, x / device.width)),
    ry: Math.max(0, Math.min(1, y / device.height))
  };
}

function addTapNode(session, x, y, shotPath, gapMs) {
  var index = session.nodes.length + 1;
  var ratio = toRatio(x, y);
  var node = {
    id: "step-" + pad(index, 2),
    name: "第 " + index + " 步",
    type: "tap",
    rx: Math.round(ratio.rx * 10000) / 10000,
    ry: Math.round(ratio.ry * 10000) / 10000
  };
  // 两次点击之间人停顿了多久，就是这一步之后界面需要多久——比拍脑袋填默认值准。
  // 只在停顿明显时才写，避免给每一步都塞一个没意义的等待。
  if (gapMs != null && gapMs > 400) {
    node.postWaitMs = Math.min(10000, Math.round(gapMs / 100) * 100);
  }
  session.nodes.push(node);
  session.shots.push({
    nodeId: node.id,
    path: shotPath,
    deviceWidth: device.width,
    deviceHeight: device.height,
    x: Math.round(x),
    y: Math.round(y)
  });
  return node;
}

function saveSession(session) {
  var payload = {
    sessionId: session.id,
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
// onStop(session) 在停止时回调；调用方负责把界面切到复核页。
function start(context, config, onStop) {
  var session = createSession(config);
  var screen = context.screen;
  var logger = context.logger;
  var lastTapAt = null;
  var stopped = false;
  // 转发期间必须吞掉所有触摸。只靠 setTouchable(false) 不够：它走 ui.run 是异步的，
  // 转发的那一下会赶在生效之前落回捕获层，于是一次点击记成两步（实测 3 次点击记了 5 步）。
  // 这个标志在触摸回调里同步置位，不依赖任何时序。
  var forwarding = false;

  // 全屏透明捕获层。淡淡上一层色，让人知道自己正处在录制状态——
  // 完全透明的话，忘了还在录、回头发现记了一堆废节点。
  var capture = floaty.rawWindow(
    '<frame id="root" bg="#11000000" w="*" h="*"/>'
  );

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
      '    <text id="counter" text="已记录 0 步" textColor="#ffffff" textSize="13sp"/>',
      '    <horizontal>',
      '      <text id="stopButton" text=" 停止 " textColor="#ff8a80" textSize="15sp"/>',
      '      <text id="undoButton" text=" 撤销 " textColor="#ffd54f" textSize="15sp"/>',
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
  // 控制条当前占多大——触摸排除区要按它算，收起后不能再排除整块 190x76，
  // 否则左上角一大片区域永远录不到。
  var pillWidth = PILL_WIDTH;
  var pillHeight = PILL_HEIGHT;
  var collapsed = false;
  var collapseTimer = null;

  function refreshCounter() {
    if (!counterView) return;
    ui.run(function () {
      counterView.setText("已记录 " + session.nodes.length + " 步");
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

  function finish() {
    if (stopped) return;
    stopped = true;
    cancelCollapseTimer();
    try { capture.close(); } catch (error) {}
    try { pill.close(); } catch (error) {}
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
    // 转发中的触摸一律吞掉：那是我们自己打出去的那一下又落了回来。
    if (forwarding) return true;
    // 只在抬手时记一次。按下就记的话，滑动会被记成一串点。
    if (event.getAction() !== event.ACTION_UP) {
      return true;
    }
    var x = event.getRawX();
    var y = event.getRawY();

    // 控制条区域内的触摸交给控制条，不记录也不转发。
    // 用当前尺寸而不是展开态的固定值：收起后排除区要跟着缩小。
    if (x < pillWidth && y < pillHeight) {
      return false;
    }

    // 同步置位，必须在开线程之前——线程调度慢一拍就来不及挡了。
    forwarding = true;

    // 转发和截图都会阻塞，放进工作线程，别卡住触摸回调。
    threads.start(function () {
      var now = Date.now();
      var gapMs = lastTapAt === null ? null : now - lastTapAt;
      lastTapAt = now;

      var shotPath = session.dir + "/" + pad(session.nodes.length + 1, 2) + ".png";
      try {
        // 必须在转发之前截：这张图是"点这一下时屏幕长什么样"，
        // 点完再截拍到的是下一个界面，框锚点就框错了。
        screen.saveTo(shotPath);
      } catch (error) {
        logger.warn("录制截图失败: " + error);
        shotPath = null;
      }

      var node = addTapNode(session, x, y, shotPath, gapMs);
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
        capture.setTouchable(false);
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
        press(Math.round(x), Math.round(y), DEFAULT_TAP_DURATION_MS);
        sleep(FORWARD_SETTLE_MS);
      }

      ui.run(function () {
        if (!stopped) capture.setTouchable(true);
      });
      // 再多等一拍才解除吞噬：setTouchable(true) 生效与残留事件送达之间还有窗口期。
      sleep(120);
      forwarding = false;

      logger.info("录制 " + node.id + " (" + Math.round(x) + "," + Math.round(y) + ")");
    });

    return true;
  }

  // 接线统一推迟：见上方关于窗口 attach 时机的说明。
  setTimeout(function () {
    try {
      var captureRoot = capture.findView("root");
      counterView = pill.findView("counter");
      handleView = pill.findView("handle");
      panelView = pill.findView("panel");
      var stopView = pill.findView("stopButton");
      var undoView = pill.findView("undoButton");
      var collapseView = pill.findView("collapseButton");

      var missing = [];
      if (!captureRoot) missing.push("capture.root");
      if (!counterView) missing.push("pill.counter");
      if (!handleView) missing.push("pill.handle");
      if (!panelView) missing.push("pill.panel");
      if (!stopView) missing.push("pill.stopButton");
      if (!undoView) missing.push("pill.undoButton");
      if (!collapseView) missing.push("pill.collapseButton");
      if (missing.length > 0) {
        throw new Error("控件未找到: " + missing.join(", "));
      }

      stopView.setOnClickListener(function () {
        cancelCollapseTimer();
        finish();
      });
      undoView.setOnClickListener(function () {
        undo();
      });
      // 收起态的小把手：点一下展开，之后不再自动收起。
      handleView.setOnClickListener(function () {
        expandPill();
      });
      collapseView.setOnClickListener(function () {
        collapsePill();
      });
      captureRoot.setOnTouchListener(onCaptureTouch);

      capture.setSize(-1, -1);
      capture.setTouchable(true);
      pill.setSize(PILL_WIDTH, PILL_HEIGHT);
      pill.setPosition(0, 0);
      pill.setTouchable(true);
      // 初始展开，让人看见录制已开始；3 秒没碰就自己缩回去。
      handleView.setVisibility(8);
      panelView.setVisibility(0);
      scheduleCollapse();

      logger.info("录制悬浮层就绪，会话目录: " + session.dir);
      toast("录制已开始");
    } catch (error) {
      logger.warn("录制悬浮层初始化失败: " + error);
      toast("录制启动失败: " + error);
      try { capture.close(); } catch (closeError) {}
      try { pill.close(); } catch (closeError) {}
    }
  }, 800);

  return {
    session: session,
    stop: finish
  };
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
  saveSession: saveSession,
  loadSession: loadSession,
  listSessions: listSessions
};
