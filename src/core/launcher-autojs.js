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
  if (autoSeconds > 0) {
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
          // 录完把自己拉回前台，否则复核页显示在游戏后面看不见。
          app.launchPackage(context.getPackageName());
          sleep(600);
          ui.run(function () {
            renderRecordingReview(config, state, session, savedPath);
          });
        });
      });
    });
  });
}

// ---- 录制结果复核 ----
function renderRecordingReview(config, state, session, savedPath) {
  var rows = [];
  for (var i = 0; i < session.nodes.length; i++) {
    var node = session.nodes[i];
    rows.push({
      title: node.name + "　" + node.type,
      subtitle:
        "rx " + node.rx + "　ry " + node.ry +
        (node.postWaitMs ? "　停顿 " + node.postWaitMs + "ms" : "")
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
          '      <text text="{{title}}" textSize="15sp" textColor="#212121"/>',
          '      <text text="{{subtitle}}" textSize="12sp" textColor="#888888" marginTop="2"/>',
          "    </vertical>",
          "  </list>",
          '  <text textSize="12sp" textColor="#666666" padding="16 10" text="会话已存盘。把它变成可回放用例还需要框锚点，当前版本请把 session.json 拉回 PC 处理。"/>',
          "</vertical>"
        ])
    )
  );

  ui.reviewSummary.setText(
    "共 " + session.nodes.length + " 步　已保存到\n" + savedPath
  );
  ui.reviewList.setDataSource(rows);
  ui.backButton.on("click", function () {
    renderMenu(config, state);
  });
}

// ---- 执行任务 ----
// 必须跑在工作线程：任务里全是 sleep 和阻塞轮询，放在 UI 线程会直接卡死界面，
// 连"正在运行"这几个字都刷不出来。
function runTaskInBackground(config, state, taskId) {
  if (busy) {
    toast("已有任务在运行");
    return;
  }
  busy = true;
  state.lastStatus = "正在运行: " + taskId;

  renderRunning(config, state, taskId);

  threads.start(function () {
    var registry = require("../task-registry-autojs.js");
    var summary;
    try {
      var task = registry.get(taskId);
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
// 于是正常进入菜单——两种形态用同一份入口，不需要两个 entry。
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

  var override = readTaskOverride();
  if (override) {
    runTaskInBackground(config, state, override);
    return;
  }
  renderMenu(config, state);
}

module.exports = {
  start: start,
  readRecentRuns: readRecentRuns,
  statusLabel: statusLabel
};
