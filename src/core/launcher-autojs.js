// =====================================================================
// 通用能力：应用启动后的菜单界面
// 设计约束：
//   - 本模块只管界面与调度谁去跑，不含任何游戏语义
//   - 任务必须跑在工作线程：UI 线程被 sleep 阻塞会直接卡死界面
//   - 同一时刻只允许一个任务在跑，避免两个流程互相抢屏幕
//   - 布局写成字符串而不是 XML 字面量，否则 node --check 解析不了
// =====================================================================

var runtime = require("./runtime-autojs.js");

var DEFAULT_AUTO_START_SECONDS = 10;
var RECENT_RUN_LIMIT = 20;

// 当前是否有任务在跑。UI 线程与工作线程都读它，只做布尔判断，不需要锁。
var busy = false;

function xml(lines) {
  return lines.join("\n");
}

function pageHeader(title) {
  return [
    '<horizontal bg="#1976d2" padding="12 10" gravity="center_vertical">',
    '  <text id="pageTitle" text="' + title + '" textColor="#ffffff" textSize="18sp" layout_weight="1"/>',
    '  <text id="backButton" text="返回" textColor="#ffffff" textSize="15sp" padding="12 4"/>',
    "</horizontal>"
  ];
}

// ---- 主菜单 ----
function renderMenu(config, state) {
  var autoSeconds = state.autoStartSeconds;

  ui.layout(
    xml([
      '<vertical bg="#fafafa" h="*">',
      '  <vertical bg="#1976d2" padding="16 20">',
      '    <text text="' + config.project.name + ' 自动化" textColor="#ffffff" textSize="22sp"/>',
      '    <text id="subtitle" text="选择要做的事" textColor="#cfe3f7" textSize="13sp" marginTop="4"/>',
      "  </vertical>",
      // 必须能滚动：屏幕方向跟随前台应用，游戏留下横屏时按钮会被挤出屏幕外，
      // 最后一个按钮直接点不到。实测在 1280x720 横屏下「运行记录」就在屏幕外。
      '  <ScrollView layout_weight="1">',
      '    <vertical padding="16">',
      '      <button id="residentButton" text="开始常驻调度" style="Widget.AppCompat.Button.Colored" h="52"/>',
      '      <text id="countdownText" text="" textSize="13sp" textColor="#c62828" marginTop="6" gravity="center"/>',
      '      <button id="taskButton" text="任务列表" h="52" marginTop="12"/>',
      '      <button id="recordButton" text="录制用例" h="52" marginTop="12"/>',
      '      <button id="recordsButton" text="运行记录" h="52" marginTop="12"/>',
      "    </vertical>",
      "  </ScrollView>",
      '  <text id="statusBar" text="" textSize="12sp" textColor="#666666" padding="16 10"/>',
      "</vertical>"
    ])
  );

  var countdownTimer = null;
  var remaining = autoSeconds;

  function stopCountdown(reason) {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      ui.countdownText.setText(reason || "已取消自动进入");
    }
  }

  // 倒计时的意义：开机自启后没人点菜单，常驻必须自己起来；
  // 而人站在设备前时，任何一次点击都应该立刻取消它。
  // 只在第一次显示菜单时倒计时。任务跑完、从子页面返回都会重新渲染菜单，
  // 若每次都倒计时，人手动跑完一个任务、10 秒没碰屏幕就被拖进常驻（2026-09-15 实测）。
  var shouldCountDown = autoSeconds > 0 && !state.autoStartConsumed;
  state.autoStartConsumed = true;
  if (shouldCountDown) {
    ui.countdownText.setText(remaining + " 秒后自动进入常驻调度（点任意按钮取消）");
    countdownTimer = setInterval(function () {
      remaining -= 1;
      if (remaining > 0) {
        ui.countdownText.setText(remaining + " 秒后自动进入常驻调度（点任意按钮取消）");
        return;
      }
      stopCountdown("正在进入常驻调度…");
      runTaskInBackground(config, state, state.autoStartTask);
    }, 1000);
  }

  ui.residentButton.on("click", function () {
    stopCountdown("");
    runTaskInBackground(config, state, state.autoStartTask);
  });
  ui.taskButton.on("click", function () {
    stopCountdown("");
    renderTaskList(config, state);
  });
  ui.recordButton.on("click", function () {
    stopCountdown("");
    renderRecorder(config, state);
  });
  ui.recordsButton.on("click", function () {
    stopCountdown("");
    renderRecords(config, state);
  });

  refreshStatus(state);
}

function refreshStatus(state) {
  if (!ui.statusBar) return;
  ui.statusBar.setText(state.lastStatus || "就绪");
}

// ---- 任务列表 ----
function renderTaskList(config, state) {
  var registry = require("../task-registry-autojs.js");
  var ids = registry.listIds();
  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    var task = registry.get(ids[i]);
    rows.push({ id: ids[i], title: task.name, subtitle: ids[i] });
  }

  ui.layout(
    xml(
      ['<vertical bg="#fafafa" h="*">']
        .concat(pageHeader("任务列表"))
        .concat([
          '  <list id="taskList" layout_weight="1">',
          // w="*" 不能省：列表项默认按内容宽度排版，白色底就只铺到文字末尾，
          // 长短不一的行看起来像没对齐的碎片。
          '    <vertical padding="16 14" bg="#ffffff" w="*">',
          '      <text text="{{title}}" textSize="16sp" textColor="#212121"/>',
          '      <text text="{{subtitle}}" textSize="12sp" textColor="#888888" marginTop="2"/>',
          "    </vertical>",
          "  </list>",
          '  <text text="点一项立即执行；执行期间界面会留在这里" textSize="12sp" textColor="#666666" padding="16 10"/>',
          "</vertical>"
        ])
    )
  );

  ui.taskList.setDataSource(rows);
  ui.backButton.on("click", function () {
    renderMenu(config, state);
  });
  ui.taskList.on("item_click", function (item) {
    runTaskInBackground(config, state, item.id);
  });
}

// ---- 运行记录 ----
// 单次 result.json 回答不了"今天跑成什么样"，这里把最近的运行汇总到一屏。
function renderRecords(config, state) {
  ui.layout(
    xml(
      ['<vertical bg="#fafafa" h="*">']
        .concat(pageHeader("运行记录"))
        .concat([
          '  <list id="recordList" layout_weight="1">',
          '    <vertical padding="16 12" bg="#ffffff" w="*">',
          '      <horizontal w="*">',
          '        <text text="{{statusText}}" textSize="14sp" textColor="{{statusColor}}" w="56"/>',
          '        <text text="{{title}}" textSize="15sp" textColor="#212121" layout_weight="1"/>',
          "      </horizontal>",
          '      <text text="{{subtitle}}" textSize="12sp" textColor="#888888" marginTop="2"/>',
          "    </vertical>",
          "  </list>",
          '  <text id="recordHint" text="" textSize="12sp" textColor="#666666" padding="16 10"/>',
          "</vertical>"
        ])
    )
  );

  ui.backButton.on("click", function () {
    renderMenu(config, state);
  });

  var records = readRecentRuns(config);
  ui.recordList.setDataSource(records);
  ui.recordHint.setText(
    records.length > 0
      ? "共 " + records.length + " 条，最新在上"
      : "还没有运行记录。跑一次任务后再来看。"
  );
}

function statusLabel(status) {
  if (status === "passed") return "通过";
  if (status === "broken") return "中断";
  if (status === "failed") return "失败";
  return status || "未知";
}

function statusColor(status) {
  if (status === "passed") return "#2e7d32";
  if (status === "broken") return "#ef6c00";
  return "#c62828";
}

// 产出目录形如 <outputRoot>/<taskId>/<runId>/result.json，按 runId 倒序取最近若干条。
function readRecentRuns(config) {
  var rows = [];
  try {
    if (!files.exists(config.outputRoot)) {
      return rows;
    }
    var taskDirs = files.listDir(config.outputRoot, function (name) {
      return files.isDir(config.outputRoot + "/" + name);
    });
    for (var t = 0; t < taskDirs.length; t++) {
      var taskDir = config.outputRoot + "/" + taskDirs[t];
      var runIds = files.listDir(taskDir, function (name) {
        return files.isDir(taskDir + "/" + name);
      });
      for (var r = 0; r < runIds.length; r++) {
        var resultPath = taskDir + "/" + runIds[r] + "/result.json";
        if (!files.exists(resultPath)) continue;
        try {
          var raw = files.read(resultPath);
          if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
          var result = JSON.parse(raw);
          rows.push({
            sortKey: Number(runIds[r]) || 0,
            statusText: statusLabel(result.status),
            statusColor: statusColor(result.status),
            title: result.taskName || result.taskId,
            subtitle:
              formatTime(result.startedAt) +
              "　" +
              Math.round((result.durationMs || 0) / 1000) +
              " 秒" +
              (result.error ? "　" + firstLine(result.error) : "")
          });
        } catch (parseError) {
          // 单条记录坏掉不该让整页打不开。
          rows.push({
            sortKey: Number(runIds[r]) || 0,
            statusText: "损坏",
            statusColor: "#c62828",
            title: taskDirs[t],
            subtitle: "result.json 无法解析"
          });
        }
      }
    }
  } catch (error) {
    return rows;
  }

  rows.sort(function (a, b) {
    return b.sortKey - a.sortKey;
  });
  return rows.slice(0, RECENT_RUN_LIMIT);
}

function firstLine(text) {
  var line = String(text).split("\n")[0];
  return line.length > 40 ? line.slice(0, 40) + "…" : line;
}

function formatTime(isoText) {
  if (!isoText) return "";
  var date = new Date(isoText);
  if (isNaN(date.getTime())) return String(isoText);
  function pad(value) {
    return value < 10 ? "0" + value : String(value);
  }
  return (
    pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
    pad(date.getHours()) + ":" + pad(date.getMinutes())
  );
}

// ---- 录制 ----
// 录制只需要截图和日志，不需要运行时的启动/权限编排，
// 所以这里造一个最小上下文，而不是走 runtime.run。
function createRecordingContext(config, outputDir) {
  var loggerModule = require("./logger-autojs.js");
  var screenModule = require("./screen-autojs.js");
  var logger = loggerModule.create({ outputDir: outputDir });
  var screen = screenModule.create({
    logger: logger,
    outputDir: outputDir,
    capture: config.capture
  });
  return { config: config, logger: logger, screen: screen };
}

function renderRecorder(config, state) {
  ui.layout(
    xml(
      ['<vertical bg="#fafafa" h="*">']
        .concat(pageHeader("录制用例"))
        .concat([
          '  <ScrollView layout_weight="1">',
          '    <vertical padding="16">',
          '      <text text="边操作游戏边录，每点一下记一个节点。" textSize="15sp" textColor="#212121"/>',
          '      <text textSize="13sp" textColor="#555555" marginTop="10" text="开始后会拉起游戏，屏幕上出现一个黑色小条显示已记录步数。你正常操作游戏即可，每次抬手记一个节点，并保存该步的截图。"/>',
          '      <text textSize="13sp" textColor="#c62828" marginTop="10" text="小条所在的左上角区域不会被记录，那里是「停止」和「撤销」。"/>',
          '      <text textSize="13sp" textColor="#555555" marginTop="10" text="录完在复核页把关键步骤升级成「点击图片」并框选锚点——死坐标换个分辨率就偏，锚点才稳。"/>',
          '      <button id="startButton" text="开始录制" style="Widget.AppCompat.Button.Colored" h="52" marginTop="20"/>',
          '      <text id="recorderHint" text="" textSize="12sp" textColor="#666666" marginTop="12"/>',
          "    </vertical>",
          "  </ScrollView>",
          "</vertical>"
        ])
    )
  );

  ui.backButton.on("click", function () {
    renderMenu(config, state);
  });

  ui.startButton.on("click", function () {
    if (busy) {
      toast("已有任务在运行");
      return;
    }
    ui.recorderHint.setText("正在申请截图权限…");
    ui.startButton.setEnabled(false);

    threads.start(function () {
      var recorder = require("./recorder-autojs.js");
      var sessionDir = config.outputRoot + "/recordings";
      var recordingContext = createRecordingContext(config, sessionDir);
      try {
        // UI 在前台，可以直接申请，不需要运行时那套切前台的绕法。
        recordingContext.screen.requestPermission();
      } catch (error) {
        ui.run(function () {
          ui.recorderHint.setText("截图权限没拿到，无法录制: " + error);
          ui.startButton.setEnabled(true);
        });
        return;
      }

      // 拉起游戏，让人直接开始操作；悬浮层是系统窗口，会盖在游戏之上。
      if (config.game && config.game.packageName) {
        app.launchPackage(config.game.packageName);
        sleep(config.runtime && config.runtime.launchSettleMs ? 3000 : 3000);
      }

      ui.run(function () {
        recorder.start(recordingContext, config, function (session, savedPath) {
          // 这个回调来自「停止」按钮的点击，跑在 UI 线程上。UI 线程里 sleep 会抛
          // 「UI 线程内无法执行阻塞操作」，整个脚本随之退出——session.json 已存盘，
          // 但复核页永远出不来（2026-09-15 实测）。所以切前台与等待都放进工作线程。
          threads.start(function () {
            // 录完把自己拉回前台，否则复核页显示在游戏后面看不见。
            // 切不回来也必须照常渲染复核页：会话已存盘，人从最近任务切回来还能接着框锚点。
            // 不接住的话异常会让这个线程静默死掉，复核页永远出不来（APK 缺权限时实测）。
            var message = "录制完成，已存盘";
            try {
              bringScriptToFront();
              sleep(600);
            } catch (error) {
              message += "。未能自动切回前台，请从最近任务切回本应用: " + (error.message || error);
            }
            ui.run(function () {
              renderRecordingReview(config, state, session, message);
            });
          });
        });
      });
    });
  });
}

// 把脚本自己的界面拉回前台。为什么不能用 app.launchPackage 见 foreground-autojs.js。
function bringScriptToFront() {
  require("./foreground-autojs.js").bringScriptToFront();
}

// ---- 录制结果复核 ----
// 录出来的全是死坐标。这一页负责把关键步骤升级成找图点击，再生成可回放的用例。
function renderRecordingReview(config, state, session, message) {
  var rows = [];
  var upgradedCount = 0;
  for (var i = 0; i < session.nodes.length; i++) {
    var node = session.nodes[i];
    var shot = session.shots[i];
    var isImage = node.type === "tapImage";
    if (isImage) upgradedCount++;
    rows.push({
      index: i,
      title: node.name + "　" + (isImage ? "找图点击" : "坐标点击"),
      titleColor: isImage ? "#2e7d32" : "#212121",
      subtitle: describeRecordedNode(node, shot)
    });
  }

  ui.layout(
    xml(
      ['<vertical bg="#fafafa" h="*">']
        .concat(pageHeader("录制结果"))
        .concat([
          '  <text id="reviewSummary" text="" textSize="13sp" textColor="#555555" padding="16 12"/>',
          '  <list id="reviewList" layout_weight="1">',
          '    <vertical padding="16 12" bg="#ffffff" w="*">',
          '      <text text="{{title}}" textSize="15sp" textColor="{{titleColor}}"/>',
          '      <text text="{{subtitle}}" textSize="12sp" textColor="#888888" marginTop="2"/>',
          "    </vertical>",
          "  </list>",
          '  <text textSize="12sp" textColor="#666666" padding="16 6" text="点一步进入框选锚点。死坐标换个分辨率就偏，关键步骤请升级成找图点击。"/>',
          '  <horizontal padding="8 4">',
          '    <button id="generateButton" text="生成用例" layout_weight="1"/>',
          '    <button id="replayButton" text="生成并回放" style="Widget.AppCompat.Button.Colored" layout_weight="1"/>',
          "  </horizontal>",
          "</vertical>"
        ])
    )
  );

  ui.reviewSummary.setText(
    (message ? message + "\n" : "") +
      "共 " + session.nodes.length + " 步，已升级 " + upgradedCount + " 步\n" + session.dir
  );
  ui.reviewList.setDataSource(rows);
  ui.reviewList.on("item_click", function (item) {
    renderAnchorPicker(config, state, session, item.index);
  });
  ui.backButton.on("click", function () {
    renderMenu(config, state);
  });
  ui.generateButton.on("click", function () {
    try {
      var casePath = writeRecordedCase(session);
      renderRecordingReview(config, state, session, "已生成用例: " + casePath);
    } catch (error) {
      renderRecordingReview(config, state, session, "生成失败: " + (error.message || error));
    }
  });
  ui.replayButton.on("click", function () {
    var casePath;
    try {
      casePath = writeRecordedCase(session);
    } catch (error) {
      renderRecordingReview(config, state, session, "生成失败: " + (error.message || error));
      return;
    }
    runTaskInBackground(config, state, createRecordedCaseTask(session, casePath));
  });
}

function describeRecordedNode(node, shot) {
  var parts = [];
  if (node.type === "tapImage") {
    var box = shot && shot.anchorBox;
    parts.push(box ? "锚点 " + box.width + "x" + box.height : "锚点 " + node.asset);
    if (node.offset) parts.push("偏移 " + node.offset.rx + "," + node.offset.ry);
  } else if (shot) {
    parts.push("坐标 (" + shot.x + "," + shot.y + ")");
  }
  if (shot) parts.push(shot.deviceWidth + "x" + shot.deviceHeight);
  if (node.postWaitMs) parts.push("停顿 " + node.postWaitMs + "ms");
  return parts.join("　");
}

// 生成的用例与锚点图放在同一个会话目录，用例以 assetBase: "case" 相对自身引用锚点。
// 写盘前用设备侧同一份 validateCase 校验，坏用例不落盘。
function writeRecordedCase(session) {
  var recordedCase = require("./case/recorded-case-autojs.js");
  var caseRunner = require("./case/case-runner-autojs.js");
  var caseData = recordedCase.buildCase(session);
  caseRunner.validateCase(caseData);
  var casePath = session.dir + "/case.json";
  files.write(casePath, JSON.stringify(caseData, null, 2) + "\n");
  return casePath;
}

// 回放用的临时任务，不进任务登记表：录制用例是设备上现生成的数据，不是仓库里的代码。
function createRecordedCaseTask(session, casePath) {
  var caseRunner = require("./case/case-runner-autojs.js");
  return {
    id: "recorded-case",
    name: "回放录制 " + session.id,
    // 与业务用例一致：先确保游戏在前台，再申请截图权限（有的盒子启动时检测录屏）。
    launchGame: true,
    requiresCapture: true,
    captureAfterLaunch: true,
    run: function (taskContext) {
      var caseData = caseRunner.loadCase(casePath);
      return caseRunner.runCase(taskContext, caseData, { caseDir: session.dir });
    }
  };
}

// ---- 框选锚点 ----
// 锚点坚持人工框：自动挑会把动态背景框进去，平均像素差 26 就再也匹配不上。
function renderAnchorPicker(config, state, session, index) {
  var recorder = require("./recorder-autojs.js");
  var recordedCase = require("./case/recorded-case-autojs.js");
  var node = session.nodes[index];
  var shot = session.shots[index];

  var image = shot && shot.path && files.exists(shot.path) ? images.read(shot.path) : null;
  if (!image) {
    renderRecordingReview(config, state, session, node.name + " 没有截图，无法框选锚点");
    return;
  }

  ui.layout(
    xml(
      ['<vertical bg="#000000" h="*">']
        .concat(pageHeader(node.name + " 框选锚点"))
        .concat([
          '  <canvas id="board" layout_weight="1"/>',
          '  <text textColor="#dddddd" textSize="12sp" padding="12 6" text="在截图上拖出一个框，框住稳定不变的图案（按钮、标题），别框动态背景。红点是当时点下去的位置，可以不在框里。"/>',
          '  <horizontal padding="8 4" bg="#fafafa">',
          '    <button id="confirmButton" text="升级找图" style="Widget.AppCompat.Button.Colored" layout_weight="1"/>',
          '    <button id="keepButton" text="保持坐标" layout_weight="1"/>',
          '    <button id="deleteButton" text="删除此步" layout_weight="1"/>',
          "  </horizontal>",
          "</vertical>"
        ])
    )
  );

  var imageWidth = image.getWidth();
  var imageHeight = image.getHeight();
  var placement = null;
  var dragBox = null;
  var closed = false;

  var boxPaint = new Paint();
  boxPaint.setStyle(Paint.Style.STROKE);
  boxPaint.setStrokeWidth(4);
  boxPaint.setColor(colors.parseColor("#ff5252"));
  var tapPaint = new Paint();
  tapPaint.setStyle(Paint.Style.FILL);
  tapPaint.setColor(colors.parseColor("#ff1744"));

  ui.board.on("draw", function (canvas) {
    // 离开本页后图片会被回收，画布线程可能还会再回调一两帧。
    if (closed) return;
    var canvasWidth = canvas.getWidth();
    var canvasHeight = canvas.getHeight();
    var scale = Math.min(canvasWidth / imageWidth, canvasHeight / imageHeight);
    placement = {
      scale: scale,
      offsetX: (canvasWidth - imageWidth * scale) / 2,
      offsetY: (canvasHeight - imageHeight * scale) / 2
    };
    canvas.drawColor(colors.parseColor("#000000"));
    canvas.drawBitmap(
      image.getBitmap(),
      null,
      new android.graphics.RectF(
        placement.offsetX,
        placement.offsetY,
        placement.offsetX + imageWidth * scale,
        placement.offsetY + imageHeight * scale
      ),
      null
    );
    canvas.drawCircle(placement.offsetX + shot.x * scale, placement.offsetY + shot.y * scale, 8, tapPaint);

    if (dragBox) {
      canvas.drawRect(
        Math.min(dragBox.x1, dragBox.x2), Math.min(dragBox.y1, dragBox.y2),
        Math.max(dragBox.x1, dragBox.x2), Math.max(dragBox.y1, dragBox.y2),
        boxPaint
      );
    } else if (shot.anchorBox) {
      var box = shot.anchorBox;
      canvas.drawRect(
        placement.offsetX + box.left * scale,
        placement.offsetY + box.top * scale,
        placement.offsetX + (box.left + box.width) * scale,
        placement.offsetY + (box.top + box.height) * scale,
        boxPaint
      );
    }
  });

  ui.board.setOnTouchListener(function (view, event) {
    var action = event.getAction();
    var x = event.getX();
    var y = event.getY();
    if (action === event.ACTION_DOWN) {
      dragBox = { x1: x, y1: y, x2: x, y2: y };
    } else if (dragBox && (action === event.ACTION_MOVE || action === event.ACTION_UP)) {
      dragBox.x2 = x;
      dragBox.y2 = y;
    }
    return true;
  });

  // 先换页再回收：画布随布局一起销毁，晚一点回收图片，避免最后一帧画到已回收的位图。
  function leave(message) {
    renderRecordingReview(config, state, session, message);
    closed = true;
    setTimeout(function () {
      try { image.recycle(); } catch (error) {}
    }, 500);
  }

  ui.backButton.on("click", function () {
    leave();
  });

  ui.confirmButton.on("click", function () {
    if (!dragBox || !placement) {
      toast("先在截图上拖出一个框");
      return;
    }
    var imageBox;
    var upgraded;
    try {
      imageBox = recordedCase.viewBoxToImageBox(dragBox, placement, imageWidth, imageHeight);
      upgraded = recordedCase.toTapImageNode(node, shot, imageBox);
    } catch (error) {
      toast(error.message || String(error));
      return;
    }
    ui.confirmButton.setEnabled(false);
    // 裁图与写盘放工作线程，别卡住界面。
    threads.start(function () {
      var anchorPath = session.dir + "/" + upgraded.asset;
      try {
        files.ensureDir(anchorPath.substring(0, anchorPath.lastIndexOf("/") + 1));
        var clip = images.clip(image, imageBox.left, imageBox.top, imageBox.width, imageBox.height);
        try {
          images.save(clip, anchorPath, "png", 100);
        } finally {
          clip.recycle();
        }
        session.nodes[index] = upgraded;
        shot.anchorBox = imageBox;
        recorder.saveSession(session);
      } catch (error) {
        ui.run(function () {
          toast("锚点保存失败: " + error);
          ui.confirmButton.setEnabled(true);
        });
        return;
      }
      ui.run(function () {
        leave(node.name + " 已升级为找图点击（锚点 " + imageBox.width + "x" + imageBox.height + "）");
      });
    });
  });

  ui.keepButton.on("click", function () {
    if (node.type !== "tapImage") {
      leave();
      return;
    }
    session.nodes[index] = recordedCase.toTapNode(node, shot);
    delete shot.anchorBox;
    recorder.saveSession(session);
    leave(node.name + " 已还原为坐标点击");
  });

  // 只从会话里摘掉，截图与锚点文件留在磁盘上：误删还能从文件找回来。
  ui.deleteButton.on("click", function () {
    session.nodes.splice(index, 1);
    session.shots.splice(index, 1);
    recorder.saveSession(session);
    leave("已删除 " + node.name);
  });
}

// ---- 执行任务 ----
// 必须跑在工作线程：任务里全是 sleep 和阻塞轮询，放在 UI 线程会直接卡死界面，
// 连"正在运行"这几个字都刷不出来。
// taskOrId：登记表里的任务 ID，或现造的任务对象（如录制用例的回放）。
function runTaskInBackground(config, state, taskOrId) {
  if (busy) {
    toast("已有任务在运行");
    return;
  }
  busy = true;
  var taskId = typeof taskOrId === "string" ? taskOrId : taskOrId.id;
  state.lastStatus = "正在运行: " + taskId;

  renderRunning(config, state, taskId);

  threads.start(function () {
    var registry = require("../task-registry-autojs.js");
    var summary;
    try {
      var task = typeof taskOrId === "string" ? registry.get(taskOrId) : taskOrId;
      runtime.run(config, task);
      summary = "完成: " + taskId;
    } catch (error) {
      summary = "失败: " + (error && error.message ? error.message : String(error));
    }
    busy = false;
    state.lastStatus = summary;
    // 工作线程不能直接碰视图，必须回到 UI 线程更新。
    ui.run(function () {
      renderMenu(config, state);
      toast(summary);
    });
  });
}

function renderRunning(config, state, taskId) {
  ui.layout(
    xml([
      '<vertical bg="#fafafa" h="*" gravity="center">',
      '  <text text="正在运行" textSize="20sp" gravity="center"/>',
      '  <text text="' + taskId + '" textSize="14sp" textColor="#666666" gravity="center" marginTop="8"/>',
      '  <text textSize="12sp" textColor="#888888" gravity="center" marginTop="24" text="截图授权弹窗出现时请点「立即开始」"/>',
      "</vertical>"
    ])
  );
}

// 开发路径（run-task.ps1）会在脚本同级写一个 task.txt。它存在就说明这次是
// 「跑指定任务并取回结果」，不该弹菜单挡在中间。打包成 APK 后包内没有这个文件，
// 于是正常进入菜单。由无界面入口 main-autojs.js 读取并分派，菜单本身不再判断。
function readTaskOverride() {
  try {
    var overridePath = files.path("task.txt");
    if (!files.exists(overridePath)) return null;
    var taskId = String(files.read(overridePath)).replace(/^﻿/, "").trim();
    return taskId || null;
  } catch (error) {
    return null;
  }
}

function start(config) {
  var launcherConfig = config.launcher || {};
  var autoStartSeconds =
    launcherConfig.autoStartSeconds != null
      ? launcherConfig.autoStartSeconds
      : DEFAULT_AUTO_START_SECONDS;

  var state = {
    autoStartSeconds: autoStartSeconds,
    autoStartTask: launcherConfig.autoStartTask || "resident-runner",
    lastStatus: ""
  };

  // task.txt 的分派在无界面入口 main-autojs.js 里做，走到这里就是要出菜单。
  renderMenu(config, state);
}

module.exports = {
  start: start,
  readTaskOverride: readTaskOverride,
  readRecentRuns: readRecentRuns,
  statusLabel: statusLabel
};
