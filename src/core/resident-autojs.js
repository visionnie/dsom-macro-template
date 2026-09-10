// =====================================================================
// 通用能力：常驻调度循环——申请一次截图权限后不退出，到点自己触发用例
// 设计约束：
//   - 截图授权（MediaProjection）在 Android 10 无法记住，但它是按会话的：
//     只要脚本进程不退出，授权就一直有效。所以无人值守的办法不是免授权，
//     而是不再反复拉起脚本。本模块就是那个不退出的进程。
//   - 循环必须有明确上限：时长、轮次、连续失败次数，三个都要有
//     （RULES.md：所有轮询、重试和业务循环必须有明确上限）
//   - 本模块不知道任何游戏语义：跑什么、什么时候跑，全部由调度表给出
//   - 单条任务失败不能掀翻整个循环，但连续失败到上限必须主动退出，
//     否则会变成一个整夜空转、还不停乱点的脚本
// =====================================================================

var errors = require("./errors-autojs.js");

var DEFAULT_TICK_INTERVAL_MS = 60000;
var DEFAULT_MAX_DURATION_MS = 12 * 3600 * 1000;
var DEFAULT_MAX_ITERATIONS = 2000;
var DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function isNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}

// 用本地日期做「今天」的键。跨天时计数自然归零，日常任务的语义就是按天算的。
function dateKeyOf(date) {
  return (
    date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
  );
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// "HH:MM" -> 当天第几分钟。调度表是给人读的，所以用字符串而不是毫秒。
//
// 特意接受 "24:00"（= 1440，当天结束）：游戏里的活动时间就是这么写的
// （圣兽之境显示「12:00 - 24:00」）。逼人改写成 23:59 只会让调度表
// 和游戏界面对不上，抄的时候更容易出错。
function parseHhMm(text, label) {
  var match = /^([0-9]{1,2}):([0-9]{2})$/.exec(String(text));
  if (!match) {
    throw new Error(label + " 必须形如 HH:MM，实际: " + text);
  }
  var hours = parseInt(match[1], 10);
  var minutes = parseInt(match[2], 10);
  if (minutes > 59) {
    throw new Error(label + " 的分钟超出范围: " + text);
  }
  if (hours > 24 || (hours === 24 && minutes !== 0)) {
    throw new Error(label + " 超出范围: " + text + "（小时最大 24，且 24 点只能是 24:00）");
  }
  return hours * 60 + minutes;
}

function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") {
    throw new Error("调度表必须是对象");
  }
  if (!isArray(schedule.entries) || schedule.entries.length === 0) {
    throw new Error("调度表 entries 必须是非空数组");
  }

  var seen = {};
  for (var i = 0; i < schedule.entries.length; i++) {
    var entry = schedule.entries[i];
    if (!entry.id) throw new Error("调度项 [" + i + "] 缺少 id");
    if (seen[entry.id]) throw new Error("调度项 id 重复: " + entry.id);
    seen[entry.id] = true;
    if (!entry.taskId) throw new Error("调度项 [" + entry.id + "] 缺少 taskId");

    if (entry.window) {
      parseHhMm(entry.window.from, "调度项 [" + entry.id + "] 的 window.from");
      parseHhMm(entry.window.to, "调度项 [" + entry.id + "] 的 window.to");
    }
    if (entry.maxRunsPerDay != null && (!isNumber(entry.maxRunsPerDay) || entry.maxRunsPerDay < 1)) {
      throw new Error("调度项 [" + entry.id + "] 的 maxRunsPerDay 必须是不小于 1 的数字");
    }
    if (entry.minIntervalMs != null && (!isNumber(entry.minIntervalMs) || entry.minIntervalMs < 0)) {
      throw new Error("调度项 [" + entry.id + "] 的 minIntervalMs 非法");
    }
    if (entry.requires != null && !isArray(entry.requires)) {
      throw new Error("调度项 [" + entry.id + "] 的 requires 必须是数组");
    }
  }
}

// 时间窗支持跨零点：from 22:00 to 02:00 表示晚上十点到次日两点。
function isWithinWindow(entry, now) {
  if (!entry.window) return true;
  var from = parseHhMm(entry.window.from, "window.from");
  var to = parseHhMm(entry.window.to, "window.to");
  var current = minutesOfDay(now);
  if (from <= to) {
    return current >= from && current <= to;
  }
  return current >= from || current <= to;
}

// ---- 跨运行的结果累积 ----
// 单次 result.json 回答不了「今天日常刷没刷、昨天是否正常」。
// 按天写一份汇总，常驻进程重启也能接着往里追加。
function summaryPathOf(config, dateKey) {
  return config.outputRoot + "/resident/" + dateKey + ".json";
}

function loadSummary(config, dateKey) {
  var path = summaryPathOf(config, dateKey);
  if (!files.exists(path)) {
    return { date: dateKey, entries: {} };
  }
  try {
    var raw = files.read(path);
    if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    var parsed = JSON.parse(raw);
    if (!parsed.entries) parsed.entries = {};
    return parsed;
  } catch (error) {
    // 汇总损坏不该拖垮常驻循环，重建一份并继续。
    return { date: dateKey, entries: {}, recoveredFrom: String(error) };
  }
}

function saveSummary(config, summary) {
  var path = summaryPathOf(config, summary.date);
  files.ensureDir(config.outputRoot + "/resident/");
  files.write(path, JSON.stringify(summary, null, 2) + "\n");
  return path;
}

function entryStateOf(summary, entryId) {
  if (!summary.entries[entryId]) {
    summary.entries[entryId] = { runs: 0, passed: 0, failed: 0, broken: 0, history: [] };
  }
  return summary.entries[entryId];
}

// ---- 判定一条调度项此刻是否该跑 ----
function decide(entry, state, now, tickStartedAt) {
  if (!isWithinWindow(entry, now)) {
    return { due: false, reason: "不在时间窗内" };
  }
  var maxRuns = entry.maxRunsPerDay != null ? entry.maxRunsPerDay : 1;
  if (state.runs >= maxRuns) {
    return { due: false, reason: "今日已达上限 " + maxRuns + " 次" };
  }
  if (entry.minIntervalMs && state.lastRunAt) {
    var elapsed = tickStartedAt - state.lastRunAt;
    if (elapsed < entry.minIntervalMs) {
      return {
        due: false,
        reason: "距上次运行仅 " + Math.round(elapsed / 1000) + " 秒，未到最小间隔"
      };
    }
  }
  return { due: true };
}

// ---- 执行一条调度项 ----
// 前置依赖不能无脑先跑：以 rxfs 为例，login 用例假定停在盒子首页，
// 而游戏已经在主城时跑它必然失败。所以策略是「先直接跑，失败了再补前置重试一次」，
// 既覆盖「会话掉了」，也不会在一切正常时白跑一遍登录。重试只有一次，有界。
function runEntry(context, registry, entry, requires) {
  var logger = context.logger;
  var task = registry.get(entry.taskId);

  try {
    return { status: "passed", steps: task.run(context) || [] };
  } catch (firstError) {
    var detail = firstError && firstError.message ? String(firstError.message) : String(firstError);
    logger.warn("调度项 [" + entry.id + "] 首次执行失败: " + detail);

    if (!requires || requires.length === 0) {
      return { status: errors.statusOf(firstError), error: detail };
    }

    logger.info("补跑前置任务后重试一次: " + requires.join(", "));
    try {
      for (var i = 0; i < requires.length; i++) {
        var prerequisite = registry.get(requires[i]);
        logger.info("前置任务: " + prerequisite.name + " [" + requires[i] + "]");
        prerequisite.run(context);
      }
    } catch (prerequisiteError) {
      var prerequisiteDetail =
        prerequisiteError && prerequisiteError.message
          ? String(prerequisiteError.message)
          : String(prerequisiteError);
      logger.warn("前置任务也失败: " + prerequisiteDetail);
      return {
        status: errors.statusOf(prerequisiteError),
        error: "首次失败: " + detail + "；前置补跑也失败: " + prerequisiteDetail
      };
    }

    try {
      return { status: "passed", steps: task.run(context) || [], recoveredByPrerequisite: true };
    } catch (secondError) {
      var secondDetail =
        secondError && secondError.message ? String(secondError.message) : String(secondError);
      return {
        status: errors.statusOf(secondError),
        error: "补跑前置后仍失败: " + secondDetail
      };
    }
  }
}

// 用例自身声明的 requires 与调度项的 requires 合并，调度项优先补充。
function resolveRequires(entry, registry) {
  var merged = [];
  var seen = {};
  var lists = [entry.requires || []];
  for (var l = 0; l < lists.length; l++) {
    for (var i = 0; i < lists[l].length; i++) {
      var id = lists[l][i];
      if (!seen[id]) {
        seen[id] = true;
        merged.push(id);
      }
    }
  }
  return merged;
}

function run(context, options) {
  var logger = context.logger;
  var config = context.config;
  var schedule = options.schedule;
  var registry = options.registry;

  validateSchedule(schedule);

  var tickIntervalMs = schedule.tickIntervalMs || DEFAULT_TICK_INTERVAL_MS;
  var maxDurationMs = schedule.maxDurationMs || DEFAULT_MAX_DURATION_MS;
  var maxIterations = schedule.maxIterations || DEFAULT_MAX_ITERATIONS;
  var maxConsecutiveFailures =
    schedule.maxConsecutiveFailures || DEFAULT_MAX_CONSECUTIVE_FAILURES;

  // 登记表里必须真的有这些任务，否则等到点才发现调不动。
  for (var i = 0; i < schedule.entries.length; i++) {
    registry.get(schedule.entries[i].taskId);
    var requires = resolveRequires(schedule.entries[i], registry);
    for (var r = 0; r < requires.length; r++) {
      registry.get(requires[r]);
    }
  }

  var startedAt = Date.now();
  var deadline = startedAt + maxDurationMs;
  var iterations = 0;
  var consecutiveFailures = 0;
  var steps = [];

  logger.info(
    "常驻调度启动：" +
      schedule.entries.length +
      " 条调度项，每 " +
      Math.round(tickIntervalMs / 1000) +
      " 秒检查一次，最长运行 " +
      Math.round(maxDurationMs / 60000) +
      " 分钟"
  );

  while (true) {
    if (++iterations > maxIterations) {
      logger.info("达到轮次上限 " + maxIterations + "，常驻退出");
      break;
    }
    var tickStartedAt = Date.now();
    if (tickStartedAt >= deadline) {
      logger.info("达到时长上限，常驻退出");
      break;
    }

    var now = new Date();
    var dateKey = dateKeyOf(now);
    var summary = loadSummary(config, dateKey);

    for (var e = 0; e < schedule.entries.length; e++) {
      var entry = schedule.entries[e];
      var state = entryStateOf(summary, entry.id);
      var decision = decide(entry, state, now, tickStartedAt);
      if (!decision.due) {
        continue;
      }

      logger.info("触发调度项 [" + entry.id + "] -> 任务 " + entry.taskId);
      var entryStartedAt = Date.now();
      var outcome = runEntry(context, registry, entry, resolveRequires(entry, registry));
      var durationMs = Date.now() - entryStartedAt;

      state.runs += 1;
      state.lastRunAt = Date.now();
      state[outcome.status] = (state[outcome.status] || 0) + 1;
      state.history.push({
        startedAt: new Date(entryStartedAt).toISOString(),
        status: outcome.status,
        durationMs: durationMs,
        error: outcome.error,
        recoveredByPrerequisite: outcome.recoveredByPrerequisite
      });

      steps.push({
        id: entry.id,
        name: entry.taskId,
        status: outcome.status,
        durationMs: durationMs,
        error: outcome.error
      });

      if (outcome.status === "passed") {
        consecutiveFailures = 0;
        logger.info(
          "调度项 [" + entry.id + "] 完成，耗时 " + Math.round(durationMs / 1000) + " 秒"
        );
      } else {
        consecutiveFailures += 1;
        logger.warn(
          "调度项 [" + entry.id + "] " + outcome.status + "，连续失败 " + consecutiveFailures + " 次"
        );
      }

      saveSummary(config, summary);

      if (consecutiveFailures >= maxConsecutiveFailures) {
        logger.error(
          "连续失败达到上限 " + maxConsecutiveFailures + " 次，常驻主动退出，避免整夜空转乱点"
        );
        saveSummary(config, summary);
        return steps;
      }
    }

    // 睡到下一个检查点。用剩余时间取小，避免最后一轮睡过了时长上限。
    var remaining = deadline - Date.now();
    if (remaining <= 0) {
      logger.info("达到时长上限，常驻退出");
      break;
    }
    sleep(Math.min(tickIntervalMs, remaining));
  }

  logger.info(
    "常驻结束：共 " + iterations + " 轮，执行 " + steps.length + " 次任务，" +
      "运行 " + Math.round((Date.now() - startedAt) / 60000) + " 分钟"
  );
  return steps;
}

module.exports = {
  run: run,
  validateSchedule: validateSchedule,
  isWithinWindow: isWithinWindow,
  parseHhMm: parseHhMm,
  dateKeyOf: dateKeyOf,
  decide: decide
};
