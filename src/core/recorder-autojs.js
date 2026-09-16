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
var PILL_WIDTH = 190;
var PILL_HEIGHT = 76;

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
  var pill = floaty.rawWindow(
    [
      '<vertical id="root" bg="#e0000000" padding="10 6">',
      '  <text id="counter" text="已记录 0 步" textColor="#ffffff" textSize="13sp"/>',
      '  <horizontal>',
      '    <text id="stopButton" text="  停止  " textColor="#ff8a80" textSize="15sp"/>',
      '    <text id="undoButton" text="  撤销  " textColor="#ffd54f" textSize="15sp"/>',
      "  </horizontal>",
      "</vertical>"
    ].join("\n")
  );
  // 窗口生命周期：从 threads.start -> ui.run 里创建时，findView 与 setSize
  // **都要等窗口 attach 之后**才可用——立刻调 findView 会全部返回 null，
  // 立刻调 setSize 会 NullPointerException。所以整套接线都推迟到定时器里做。
  // （在脚本顶层直接创建时 findView 是立刻可用的，两种时机不一样，别照搬。）
  var counterView = null;

  function refreshCounter() {
    if (!counterView) return;
    ui.run(function () {
      counterView.setText("已记录 " + session.nodes.length + " 步");
    });
  }

  function finish() {
    if (stopped) return;
    stopped = true;
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
    if (x < PILL_WIDTH && y < PILL_HEIGHT) {
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
      ui.run(function () {
        capture.setTouchable(false);
      });
      sleep(60);
      press(Math.round(x), Math.round(y), DEFAULT_TAP_DURATION_MS);
      sleep(FORWARD_SETTLE_MS);
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
      var stopView = pill.findView("stopButton");
      var undoView = pill.findView("undoButton");

      var missing = [];
      if (!captureRoot) missing.push("capture.root");
      if (!counterView) missing.push("pill.counter");
      if (!stopView) missing.push("pill.stopButton");
      if (!undoView) missing.push("pill.undoButton");
      if (missing.length > 0) {
        throw new Error("控件未找到: " + missing.join(", "));
      }

      stopView.setOnClickListener(function () {
        finish();
      });
      undoView.setOnClickListener(function () {
        undo();
      });
      captureRoot.setOnTouchListener(onCaptureTouch);

      capture.setSize(-1, -1);
      capture.setTouchable(true);
      pill.setSize(PILL_WIDTH, PILL_HEIGHT);
      pill.setPosition(0, 0);
      pill.setTouchable(true);

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
