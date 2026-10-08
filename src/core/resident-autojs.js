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
var control = require("./run-control-autojs.js");
var runtime = require("./runtime-autojs.js");
var appVersion = require("./app-version-autojs.js");

// 多久判一次"该不该跑"。
//
// 这一拍是**纯内存算术**：拿已经在手里的调度项和当天汇总比一下时间，不读盘。
// 所以可以给得很密——2 秒，人设的那一分钟一到基本就触发。
//
// 原先 60 秒，意味着设 00:49 可能要等到 00:49:47 才动，人盯着表只会以为没生效
// （2026-10-04 用户连撞三轮）。中间改成 20 秒也只是把这个落差缩小，没解决根子：
// **真正费的是读文件，不是判断。** 两者分开之后，判断就没有理由慢。
var DEFAULT_TICK_INTERVAL_MS = 2000;

// 多久重读一次调度表。**这一下才是要读盘 + 解析 + 校验 + 重建可执行清单的那段。**
// 10 秒：人在界面上存完定时，最多 10 秒后调度器就认了，而整夜也只是几千次小文件读。
var SCHEDULE_RELOAD_INTERVAL_MS = 10000;

var DEFAULT_MAX_DURATION_MS = 12 * 3600 * 1000;

// 后台定时调度能活多久。**与前台那次常驻分开算**（2026-10-05）。
//
// 前台的 12 小时是给"人点一下、跑一夜"设的。后台这条不一样：它是定时的守夜人，
// 人设完就走，第二天、第三天的点都指望它。按 12 小时算的话，晚上 20 点开的 App
// 到早上 8 点就悄悄退出，而 9 点那个定时还好好写在界面上——
// 这正是"定时又没生效"最难查的一种：昨天验过能跑，今天就不跑了。
//
// 7 天：仍然是个明确上限（RULES.md 要求所有循环都有上限），但远长于
// "人多久会重开一次 App"，而 App 一起来就会把它接回去（launcher.start）。
var BACKGROUND_MAX_DURATION_MS = 7 * 24 * 3600 * 1000;
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
    // 定时执行：每天几点（HH:MM 列表）+ 周几（1~7，周一到周日）。
    // 格式错了必须当场抛：一个写错的时间点的表现是"那一天什么都没发生"，
    // 而无人值守时没人看得出来。
    if (entry.times != null) {
      if (!isArray(entry.times) || entry.times.length === 0) {
        throw new Error("调度项 [" + entry.id + "] 的 times 必须是非空数组");
      }
      for (var t = 0; t < entry.times.length; t++) {
        parseHhMm(entry.times[t], "调度项 [" + entry.id + "] 的 times[" + t + "]");
      }
    }
    if (entry.weekdays != null) {
      if (!isArray(entry.weekdays) || entry.weekdays.length === 0) {
        throw new Error("调度项 [" + entry.id + "] 的 weekdays 必须是非空数组（1=周一 … 7=周日）");
      }
      for (var w = 0; w < entry.weekdays.length; w++) {
        var day = Number(entry.weekdays[w]);
        if (!isNumber(day) || day < 1 || day > 7 || Math.round(day) !== day) {
          throw new Error(
            "调度项 [" + entry.id + "] 的 weekdays 只能是 1 到 7 的整数（1=周一 … 7=周日），实际: " +
              entry.weekdays[w]
          );
        }
      }
      if (entry.times == null) {
        throw new Error("调度项 [" + entry.id + "] 配了 weekdays 却没有 times：只给星期几说不出什么时候跑");
      }
    }
    // 停用：留着这条调度项，但本轮不跑。
    // 为什么不直接删掉：人多半只是想先停一阵，删了之后几个时间点得重新一个个加回来。
    if (entry.enabled != null && entry.enabled !== true && entry.enabled !== false) {
      throw new Error("调度项 [" + entry.id + "] 的 enabled 只能是 true 或 false");
    }
    // 强制执行：到点时把正在跑的那条停掉，让位给这条。
    // 只对定时调度有意义——没有 times 就没有"到点"这回事，配了也永远不会触发，
    // 与其让它静静地什么都不做，不如当场说清楚。
    if (entry.force != null) {
      if (entry.force !== true && entry.force !== false) {
        throw new Error("调度项 [" + entry.id + "] 的 force 只能是 true 或 false");
      }
      if (entry.force === true && entry.times == null) {
        throw new Error("调度项 [" + entry.id + "] 配了 force 却没有 times：强制执行只对定时调度有意义");
      }
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

// ---- 定时执行：每周几、每天几点 ----
// 用户 2026-10-02 要的「定时执行」：选周一到周日，再给当天的几个时间点。
// 与原来的「时间窗 + 最小间隔」是**两种不同的调度**，可以共存：
//   时间窗   = "这段时间里可以跑"，什么时候跑由间隔和上限决定（BOSS 刷新那类）
//   定时     = "到这个点就跑一次"（日常、定时活动那类）
// 一条调度项写了 times 就按定时走，没写就还是老的那套——老调度项一个字不用改。
//
// 星期用 1~7（周一到周日），与界面上的排列一致。JS 的 getDay() 是 0~6 且周日为 0，
// 只在这里换算一次，别让这个差异流到别处去。
function weekdayOf(now) {
  var day = now.getDay();
  return day === 0 ? 7 : day;
}

// 到点的判定要有一个宽限：常驻的 tick 是 60 秒一轮，而且上一个任务可能正跑着，
// 掐着秒判等于"错过这一分钟就整天不跑了"。宽限内跑过一次就不再跑第二次。
var TIME_POINT_GRACE_MS = 10 * 60 * 1000;

// 守望线程多久看一次表。15 秒：比 tick 的 60 秒密，人能感觉到"到点就停"；
// 又不至于密到让一个只读文件的循环整天空转。
var FORCE_WATCH_INTERVAL_MS = 15000;

// 到点要截图授权时，最多等人回应多久。
// 45 秒：人在设备前的话足够点一下；人不在的话，与其让调度器在这儿吊死，
// 不如记一行跳过这一条——到点判定有 10 分钟宽限，他回来点完下一拍就跑。
var CAPTURE_WAIT_MS = 45000;

// 最近的一个定时点是几点、还有多久。
//
// **这一行是给人看的。** 到点判定按分钟、检查按拍，人设完定时盯着屏幕时
// 完全不知道它在等什么——2026-10-04 用户连着三轮以为"定时又没生效"，
// 其中一次只是还差半分钟没到那一拍。把等待对象写出来，省掉所有猜测。
// nameOf 可选：界面上要显示的是任务名，日志里显示调度项 id 就够了。
// **两边共用这一个算法**——各算一遍迟早出现"界面说下一个 11:03、调度器等的是别的点"。
function describeNextTimePoint(entries, now, nameOf) {
  var nowMinutes = minutesOfDay(now);
  var best = null;
  for (var i = 0; i < entries.length; i++) {
    var points = parseTimePoints(entries[i]);
    for (var p = 0; p < points.length; p++) {
      // 今天剩下的点；都过了就算到明天，这样"下一个"永远有答案。
      var wait = points[p].minutes - nowMinutes;
      if (wait < 0) wait += 24 * 60;
      if (!best || wait < best.wait) {
        best = { wait: wait, text: points[p].text, entry: entries[i] };
      }
    }
  }
  if (!best) return "没有定时点，按时间窗与间隔跑";
  var who = nameOf ? nameOf(best.entry) : "[" + best.entry.id + "]";
  return "下一个定时 " + best.text + "（" + who + "，约 " + best.wait + " 分钟后）";
}

// 调度表里有没有勾了强制执行的。一条都没有就不起守望线程——
// 绝大多数情况下没人勾它，没必要白养一个线程。
function hasForceEntry(entries) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].force === true) return true;
  }
  return false;
}

function parseTimePoints(entry) {
  var list = [];
  if (!isArray(entry.times)) return list;
  for (var i = 0; i < entry.times.length; i++) {
    list.push({ text: entry.times[i], minutes: parseHhMm(entry.times[i], "定时时间点") });
  }
  return list;
}

// 今天这个时间点跑过没有。判据是**当天汇总里的运行历史**，不另开一份状态文件——
// 多一份状态就多一处对不上的可能，而汇总本来就按天存着每次运行的起始时间。
function hasRunAtPoint(state, point, now) {
  var history = state.history || [];
  for (var i = 0; i < history.length; i++) {
    // 被抢占的那一趟不算"这个点跑过了"：它是被我们自己打断的，没跑完。
    // 算进去的话，一条定时任务被抢占一次就整天不再重试，而宽限期明明还没过。
    if (history[i].status === "preempted") continue;
    var startedAt = Date.parse(history[i].startedAt);
    if (!startedAt) continue;
    var started = new Date(startedAt);
    if (started.toDateString() !== now.toDateString()) continue;
    var startedMinutes = started.getHours() * 60 + started.getMinutes();
    var diff = startedMinutes - point.minutes;
    if (diff >= 0 && diff <= TIME_POINT_GRACE_MS / 60000) return true;
  }
  return false;
}

// 今天是不是这条调度项要跑的星期。没配 weekdays 就是每天。
function matchesWeekday(entry, now) {
  if (!isArray(entry.weekdays) || entry.weekdays.length === 0) return true;
  var today = weekdayOf(now);
  for (var w = 0; w < entry.weekdays.length; w++) {
    if (Number(entry.weekdays[w]) === today) return true;
  }
  return false;
}

// 定时调度此刻该不该跑。返回 null 表示"这条不是定时调度"，由老逻辑接着判。
function decideByTimes(entry, state, now) {
  var points = parseTimePoints(entry);
  if (points.length === 0) return null;

  if (!matchesWeekday(entry, now)) {
    var today = weekdayOf(now);
    return { due: false, reason: "今天（周" + "一二三四五六日".charAt(today - 1) + "）不在重复日期里" };
  }

  var nowMinutes = minutesOfDay(now);
  var nearest = null;
  for (var i = 0; i < points.length; i++) {
    var diff = nowMinutes - points[i].minutes;
    if (diff < 0 || diff > TIME_POINT_GRACE_MS / 60000) continue;
    if (hasRunAtPoint(state, points[i], now)) continue;
    if (!nearest || points[i].minutes > nearest.minutes) nearest = points[i];
  }
  if (!nearest) {
    return { due: false, reason: "没有到点的时间点（" + entry.times.join(" ") + "）" };
  }
  return { due: true, reason: "到点 " + nearest.text };
}

// ---- 设备时钟被改了 ----
// 2026-10-05 在云机上当场撞见：十几分钟的真实时间里，系统时钟从 07:52 跳到 11:08
// （往前 3 小时 4 分，锁文件里的心跳时间戳跟着跳，不是显示问题）。云机开着自动对时，
// 盒子的时钟跑偏之后被 NTP 一把拽回来，一次就能跨掉三个小时。
//
// 对定时的后果是致命且无声的：**被跳过去的那段里的时间点永远不会到**，
// 而到点判定的宽限只有 10 分钟。界面上那几个时间点还好好写着，日志里什么都没有。
// 这很可能就是"设了某个点，它一声不吭"的真凶之一。
//
// 判据只能用单调时钟：elapsedRealtime 从开机起只增不减，不受改表影响。
// 墙上时间走的量与它对不上，差的那部分就是被人（或 NTP）改掉的。
var CLOCK_JUMP_TOLERANCE_MS = 90000;

function monotonicNow() {
  try {
    return Number(android.os.SystemClock.elapsedRealtime());
  } catch (error) {
    // PC 侧探针里没有 android——拿不到就退化成"不检测跳变"，而不是炸掉整个调度。
    return null;
  }
}

// 被时钟跳过去的那些点，补跑一次。
// **只补最保守的那一类**：往前跳、同一天、点正好落在跳过去的那段里、今天还没跑过。
// 往回跳不补（那些点还会再到一次），跨天不补（半夜突然动游戏比漏跑更糟）。
// 调用方负责"一次跳变只补一轮"，否则跑完的那次记在跳变之后的时刻上，
// hasRunAtPoint 认不出它补的是哪个点，会一直补下去。
function decideMissedByClockJump(entry, state, jump, now) {
  if (!jump || jump.deltaMs <= 0) return null;
  var points = parseTimePoints(entry);
  if (points.length === 0) return null;
  if (!matchesWeekday(entry, now)) return null;

  var from = new Date(jump.fromAt);
  var to = new Date(jump.toAt);
  if (from.toDateString() !== to.toDateString()) return null;
  if (to.toDateString() !== now.toDateString()) return null;

  var fromMinutes = minutesOfDay(from);
  var toMinutes = minutesOfDay(to);
  var missed = null;
  for (var i = 0; i < points.length; i++) {
    var minutes = points[i].minutes;
    if (minutes <= fromMinutes || minutes > toMinutes) continue;
    if (hasRunAtPoint(state, points[i], now)) continue;
    if (!missed || minutes > missed.minutes) missed = points[i];
  }
  if (!missed) return null;
  return {
    due: true,
    reason:
      "补跑 " + missed.text + "：设备时钟从 " + hhmmOf(from) + " 跳到 " + hhmmOf(to) +
      "，这个点被整段跳过去了"
  };
}

function hhmmOf(date) {
  var h = date.getHours();
  var m = date.getMinutes();
  return (h < 10 ? "0" + h : h) + ":" + (m < 10 ? "0" + m : m);
}

function describeDuration(ms) {
  var minutes = Math.round(Math.abs(ms) / 60000);
  if (minutes < 60) return minutes + " 分钟";
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  return hours + " 小时" + (rest > 0 ? " " + rest + " 分钟" : "");
}

// ---- 判定一条调度项此刻是否该跑 ----
function decide(entry, state, now, tickStartedAt) {
  // 定时调度优先：写了 times 就按"到点跑一次"判，**不再看时间窗与最小间隔**——
  // 那两样是另一种调度的语言，混在一起会出现"到点了却因为间隔没到而不跑"，
  // 而界面上明明写着每天 09:58 跑。每天最多几次仍然管用，它是兜底的上限。
  var byTimes = decideByTimes(entry, state, now);
  if (byTimes) {
    if (!byTimes.due) return byTimes;
    // **没显式设过上限就不拿次数卡它。**
    //
    // 定时调度本来就有自己的去重：hasRunAtPoint 保证"同一个时间点今天只跑一次"，
    // 三个点就最多跑三次，不需要再加一道计数。
    // 而原先按 times.length 推上限，在**人白天改了时间点**时会变成一道暗闸：
    // 2026-10-04 用户只配了一个点，00:49 跑过一次之后把时间改成 01:11，
    // 到点却一直不动——因为 runs(1) >= 上限(1)。界面上什么都没说，
    // 而那句「今日已达上限」只存在于一个被主循环丢掉的 reason 里。
    // 他为此反复试了四五轮，每一轮都以为是定时又坏了。
    //
    // 显式设过的仍然照办（高级设置里填的那个），那是人明确要的兜底。
    if (entry.maxRunsPerDay != null && state.runs >= entry.maxRunsPerDay) {
      return { due: false, reason: "今日已达上限 " + entry.maxRunsPerDay + " 次" };
    }
    return byTimes;
  }
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
// 前置依赖不能无脑先跑：典型的登录用例假定停在启动器首页，
// 而游戏已经进到主界面时跑它必然失败。所以策略是「先直接跑，失败了再补前置重试一次」，
// 既覆盖「会话掉了」，也不会在一切正常时白跑一遍登录。重试只有一次，有界。
function runEntry(context, registry, entry, requires) {
  var logger = context.logger;
  var task = registry.get(entry.taskId);

  try {
    return { status: "passed", steps: task.run(context) || [] };
  } catch (firstError) {
    var detail = firstError && firstError.message ? String(firstError.message) : String(firstError);

    // 被抢占不是失败：既不补跑前置（那是给"游戏掉线了"准备的），
    // 也不计进连续失败。**这个判断必须排在最前面**——漏了它的表现是
    // "强制执行把挂机停掉，紧接着常驻去跑了一遍登录"，而日志里看着像是挂机真的失败了。
    // 这里只查不清标志，范围的开合由主循环管（它才知道这一趟什么时候真结束）。
    if (control.isPreemptFired()) {
      logger.info("调度项 [" + entry.id + "] 让位给定时任务: " + detail);
      return { status: "preempted", error: detail };
    }

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

// ---- 这一趟的证据 ----
// 2026-10-06：后台到点跑的那一趟在盘上几乎什么都不留——没有 result.json、
// 没有自己的日志、一张截图也没有。于是「到点那十几秒游戏里到底动了没有」
// 这个问题只能靠人到点时守在设备前看 toast 配合画面，**第二天再问就谁也答不上来**：
// 日志只在 logcat 里（会滚掉），当天汇总里只有一行状态和耗时。
//
// 这里补齐三样，形状与人在 App 里点「运行」跑出来的那一趟**完全一致**
// （`<outputRoot>/<taskId>/<runId>/`），所以「运行记录」那一页不改一行就看得见它们：
//   result.json   和 runtime.run 同一套字段，外加 trigger / scheduleEntryId
//   latest.log    靠 logger 的分支：同一行同时进常驻长日志和这一趟自己的日志
//   两张截图      起跑前、跑完后各一张
//
// **那两张截图是唯一能分开"点出去了"和"游戏照着做了"的东西**，日志永远只证明前者
// （10-05 那三趟日志里点击全部派发成功，而画面动没动至今没有盘上的证据）。
//
// 为什么不是每一步都截：那 13 秒是刚验收过的「准时」，每步两张图会把它拖长，
// 而起跑前后这一对已经回答了"动了没动"。真要定位是哪一步偏了再加。
//
// **一条都不许影响任务本身**：建目录、截图、写盘各自 try/catch，失败只记一句。
// 证据是为了排查，不能自己变成故障源。
function runEntryWithEvidence(context, registry, entry, requires) {
  var config = context.config;
  var logger = context.logger;
  var task = null;
  try {
    task = registry.get(entry.taskId);
  } catch (lookupError) {
    // 认不出任务不在这儿判死：runEntry 会原样报出来，那句话比这里更具体。
  }

  var startedAt = new Date();
  var runDir = null;
  try {
    runDir =
      config.outputRoot + "/" + runtime.toPathSegment(entry.taskId) + "/" + startedAt.getTime();
    files.ensureDir(runDir + "/");
  } catch (dirError) {
    runDir = null;
    logger.warn("这一趟的运行目录建不出来，只能记日志: " + (dirError.message || dirError));
  }

  // 截图走 screen.saveTo：它和找图共用 withCapture，会先把悬浮层让开
  // （不让开就把运行条、点击十字一起拍进去，而那正好压在要看的画面上）。
  function shoot(name) {
    if (!runDir) return null;
    try {
      if (!context.screen || !context.screen.hasPermission()) {
        logger.warn("没有截图授权，这一趟留不下画面证据（" + name + "）");
        return null;
      }
      return context.screen.saveTo(runDir + "/" + name + ".png");
    } catch (error) {
      logger.warn("截图没存下来（" + name + "）: " + (error.message || error));
      return null;
    }
  }

  // 文件名一律 ASCII：中文名在 adb pull 时踩过坑（任务 id 里的冒号那次），
  // 页面上显示什么由界面决定，盘上的名字不跟着变。
  var shots = { before: null, after: null };
  if (runDir && logger.beginBranch) logger.beginBranch(runDir);
  var outcome = null;
  try {
    // **起跑就先写一份 `status: "running"`。**
    //
    // 2026-10-06 实测：16:40 那趟定时跑在盘上只留下 01-before.png 和半截日志，
    // 没有 result.json——因为脚本引擎被重建、线程当场被杀，**finally 没执行**
    // （见 launcher 的 startSchedulerWatchdog 注释，那条链已经查清）。
    // 光靠 finally 写，就等于"被硬杀的那趟在记录里完全不存在"，
    // 而那恰恰是最该留下痕迹的一趟：事后看到的是"今天少跑了一次，不知道为什么"。
    //
    // 先写一份，跑完再覆盖。于是盘上永远有这一趟的记录，
    // 卡在 running 没被覆盖就说明它没能跑完。界面据此显示「没跑完」。
    if (runDir) {
      writeScheduledResult(context, entry, task, {
        runDir: runDir,
        startedAt: startedAt,
        finishedAt: null,
        outcome: null,
        shots: shots,
        running: true
      });
    }
    shots.before = shoot("01-before");
    outcome = runEntry(context, registry, entry, requires);
  } finally {
    // 跑完后那张、result.json、关分支三件都在 finally 里：
    // **这一趟抛出去了也要留下证据**，失败那一趟的证据恰恰是最想看的。
    var finishedAt = new Date();
    shots.after = shoot("02-after");
    if (runDir) {
      writeScheduledResult(context, entry, task, {
        runDir: runDir,
        startedAt: startedAt,
        finishedAt: finishedAt,
        outcome: outcome,
        shots: shots
      });
    }
    if (runDir && logger.endBranch) logger.endBranch();
  }

  // 运行目录挂回去：当天汇总里的每一条 history 据此指向"这一趟的证据在哪"，
  // 界面才能从"今天跑了 3 次"点进某一次。
  if (outcome && runDir) {
    outcome.runDir = runDir;
    outcome.screenshots = shots;
  }
  return outcome;
}

// 和 runtime.run 的 result 同一套字段，外加「这是定时自己起的」这几条。
// 字段对齐不是洁癖：「运行记录」那一页按 result.json 读，对不上就只能另写一页。
// info.running 为真表示这是起跑那一刻写的占位，还没有结果。
function writeScheduledResult(context, entry, task, info) {
  var config = context.config;
  var logger = context.logger;
  var outcome = info.outcome;
  var result = {
    projectId: config.project && config.project.id,
    taskId: entry.taskId,
    taskName: (task && task.name) || entry.name || entry.taskId,
    status: info.running ? "running" : outcome ? outcome.status : "broken",
    startedAt: info.startedAt.toISOString(),
    finishedAt: info.finishedAt ? info.finishedAt.toISOString() : null,
    durationMs: info.finishedAt
      ? info.finishedAt.getTime() - info.startedAt.getTime()
      : null,
    // 这一趟是定时自己起的，不是人点的。两种混在「运行记录」里不标出来，
    // 就分不清"昨晚它真的自己跑了"和"是我手点的那一次"——而这正是要证明的事。
    trigger: "schedule",
    scheduleEntryId: entry.id,
    scheduleTimes: entry.times || null,
    steps: (outcome && outcome.steps) || [],
    screenshots: info.shots
  };
  if (info.running) {
    // 占位那份不写 error：它还没出错，只是还没跑完。
  } else if (!outcome) {
    result.error = "这一趟异常退出，没有拿到结果";
  } else if (outcome.error) {
    result.error = outcome.error;
  }
  if (outcome && outcome.recoveredByPrerequisite) {
    result.recoveredByPrerequisite = true;
  }
  // 事后查一个失败，第一个要排除的就是「当时装的根本不是我改过的那版」。
  try {
    result.build = appVersion.info(config);
  } catch (versionError) {}
  try {
    result.device = {
      width: device.width,
      height: device.height,
      sdkInt: device.sdkInt,
      brand: device.brand,
      model: device.model
    };
  } catch (deviceError) {}

  try {
    files.write(info.runDir + "/result.json", JSON.stringify(result, null, 2) + "\n");
    // 占位那次不喊：每趟喊两遍"已落盘"，真正有意义的那句反而被淹掉。
    if (!info.running) logger.info("这一趟的记录已落盘: " + info.runDir);
  } catch (error) {
    logger.warn("result.json 没写下来: " + (error.message || error));
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

  // 后台模式：这个循环是常驻的定时调度，不是人点出来的一个任务。
  // 两处不同——循环的停止开关是自己的，以及**每跑一条才去抢执行锁**
  // （睡在 tick 之间时不占锁，人照样能手点任务跑）。
  // **声明必须排在 buildUsableEntries 之前**：那里要按它决定"内置调度项跑不跑"，
  // 而第一次调用就在下面几十行，var 提升只会给到 undefined。
  var background = options.background === true;
  var runLock = background ? require("./run-lock-autojs.js") : null;

  var tickIntervalMs = schedule.tickIntervalMs || DEFAULT_TICK_INTERVAL_MS;
  var maxDurationMs = background
    ? BACKGROUND_MAX_DURATION_MS
    : schedule.maxDurationMs || DEFAULT_MAX_DURATION_MS;
  // 轮次上限**按时长推**，不写死一个常数。
  //
  // 它本来只是"别无限循环"的兜底，而写死 2000 的话，拍一密就成了另一条命门：
  // 2 秒一拍时 2000 轮才 67 分钟，调度器会在夜里自己退出，而日志里只有一句
  // 「达到轮次上限」——人根本不会想到是因为我把检查调快了。
  // 推出来就永远排在时长上限后面，调快拍子不会把它踩响。
  var maxIterations =
    schedule.maxIterations || Math.ceil(maxDurationMs / tickIntervalMs) + 100;
  var maxConsecutiveFailures =
    schedule.maxConsecutiveFailures || DEFAULT_MAX_CONSECUTIVE_FAILURES;

  // 登记表里必须真的有这些任务，否则等到点才发现调不动。
  //
  // 但「取不到」分两种，不能一视同仁：
  //   - 任务没登记：调度表写错了，是代码问题，直接抛，让人马上看见
  //   - broken：任务本身是设备上的数据（例如录制用例的会话被删了）。
  //     为这一条掀翻整个常驻，等于让一条陈旧调度项赔上整夜的无人值守。
  //     跳过它、留下警告，其余照跑。
  // quiet: 重新加载时不要把同样几行警告每分钟再打一遍。
  function buildUsableEntries(table, quiet) {
    var usable = [];
    for (var i = 0; i < table.entries.length; i++) {
      var candidate = table.entries[i];
      // 停用的直接跳过，并且说一句。不说的话，人在界面上把定时关了，
      // 过两天回来看日志只会发现这条从来没跑过，分不清是关了还是坏了。
      if (candidate.enabled === false) {
        if (!quiet) logger.info("调度项 [" + candidate.id + "] 已停用，本轮跳过");
        continue;
      }
      // **后台定时调度只跑"人挂了定时的那几条"。**
      //
      // 代码基表里的内置调度项（BOSS 那类按时间窗 + 最小间隔跑的）不算。
      // 2026-10-05 用户明确要求去掉：他只是给一条录制设了个定时，而设完定时
      // 会顺带把后台调度器拉起来，于是那张基表上的 BOSS 也跟着自己跑了两趟
      // （00:00 一趟、01:03 一趟，后一趟失败还拖了一次登录补跑，在游戏里乱点 100 秒）。
      // 人看到的是"我设的定时没动静，倒是莫名跑了别的"。
      //
      // 菜单上那个「开始常驻调度」是人明确点出来的，仍按整张表跑——那是另一种意图。
      if (background && !(isArray(candidate.times) && candidate.times.length > 0)) {
        if (!quiet) {
          logger.info("调度项 [" + candidate.id + "] 没有定时点，后台定时调度不碰它");
        }
        continue;
      }
      try {
        registry.get(candidate.taskId);
        var requires = resolveRequires(candidate, registry);
        for (var r = 0; r < requires.length; r++) {
          registry.get(requires[r]);
        }
        usable.push(candidate);
      } catch (resolveError) {
        if (!errors.isBroken(resolveError)) {
          throw resolveError;
        }
        if (!quiet) {
          logger.warn(
            "调度项 [" + candidate.id + "] 本轮跳过: " +
              (resolveError.message || resolveError)
          );
        }
      }
    }
    return usable;
  }

  // 调度表变没变。只看真正影响"什么时候跑哪条"的字段——
  // updatedAt 之类每次保存都变的东西不能看，否则每保存一次都报一遍"有变化"。
  function fingerprintOf(entries) {
    var parts = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      parts.push([
        e.id,
        e.taskId,
        (e.times || []).join("/"),
        (e.weekdays || []).join("/"),
        e.force === true ? "F" : "",
        e.maxRunsPerDay == null ? "" : e.maxRunsPerDay,
        e.minIntervalMs == null ? "" : e.minIntervalMs,
        e.window ? e.window.from + "-" + e.window.to : ""
      ].join(","));
    }
    return parts.join("|");
  }

  var usableEntries = buildUsableEntries(schedule, false);
  var scheduleFingerprint = fingerprintOf(usableEntries);
  if (usableEntries.length === 0) {
    throw errors.broken(
      "调度表里没有一条可执行的调度项，常驻不启动" +
        "（内置调度项默认停用，设备上的任务要先点行上的「定时」挂一个）"
    );
  }

  var startedAt = Date.now();
  var deadline = startedAt + maxDurationMs;
  // 上一拍的墙上时间与单调时间，用来发现设备时钟被改过（见 decideMissedByClockJump）。
  var lastWallAt = startedAt;
  var lastMonoAt = monotonicNow();
  // 刚发现的那次跳变。**只在发现它的那一拍里有效**，一轮判完就清掉——
  // 补跑的那次运行记在跳变之后的时刻上，hasRunAtPoint 认不出它补的是哪个点，
  // 留着就会每一拍都认为"这个点还没补"，于是一直补下去。
  var pendingClockJump = null;
  var iterations = 0;
  var consecutiveFailures = 0;
  var steps = [];
  var runningEntryId = null;
  var preemptedThisTick = false;
  // 上次重读调度表是什么时候。判断每 2 秒一次，重读 10 秒一次——
  // 把"算一下"和"读盘"分开，才能把判断给得很密而不烧设备。
  var lastReloadAt = 0;
  // 每条调度项上一次"不跑"的理由。只在理由变了的时候写日志，
  // 否则 2 秒一拍会把同一句话刷满整个日志。
  var lastSkipReason = {};
  // 当天汇总留在内存里。**这个文件只有调度器自己写**，没有第二个写入方，
  // 所以不必每一拍都从盘上捞一遍；跨天了才重新读。
  var summaryCache = null;
  var summaryDateKey = "";

  function currentSummary(now) {
    var key = dateKeyOf(now);
    if (summaryCache && summaryDateKey === key) return summaryCache;
    summaryCache = loadSummary(config, key);
    summaryDateKey = key;
    return summaryCache;
  }
  function loopCheckpoint() {
    if (background) {
      control.schedulerCheckpoint();
      return;
    }
    control.checkpoint(logger);
  }

  // 这一条跑起来要不要截图。主任务或任一前置要，就算要——
  // 漏判的表现是任务跑到第一个找图步骤才发现没授权，那时游戏已经被拉到前台、
  // 点了一半了。
  function entryNeedsCapture(entry) {
    try {
      if (registry.get(entry.taskId).requiresCapture !== false) return true;
      var requires = resolveRequires(entry, registry);
      for (var i = 0; i < requires.length; i++) {
        if (registry.get(requires[i]).requiresCapture !== false) return true;
      }
    } catch (error) {
      // 取不到任务的事由 runEntry 去报，这里保守按"要"处理。
      return true;
    }
    return false;
  }

  // 到点了才要截图授权，而且**等不到就放手**。
  //
  // requestScreenCapture() 是阻塞的：没人点那个系统弹窗它就一直等下去。
  // 2026-10-04 实测，调度器就是这么吊死七分钟的，而锁的心跳照跳、界面照常，
  // 外面一点看不出来。所以这里把它扔到工作线程上，主循环只等有限的时间：
  // 等不到就跳过这一条，下一拍照样继续——**绝不让一个弹窗换掉整夜的调度**。
  //
  // 那个线程仍挂在弹窗上，这是故意的：人回头点了「立即开始」，
  // 授权就落到会话里，下一条直接可用，不用再弹一次。
  function ensureCaptureForEntry(entry) {
    if (!entryNeedsCapture(entry)) return true;
    if (context.screen.hasPermission()) return true;

    // 后台应用弹不出授权窗，先把自己切到前台。
    try {
      require("./foreground-autojs.js").bringScriptToFront();
      control.sleepInterruptibly(config.runtime.foregroundSettleMs || 3000, logger);
    } catch (error) {
      logger.warn("切回前台申请授权失败，仍试一次: " + (error.message || error));
    }

    var state = { finished: false, ok: false, error: null };
    threads.start(function () {
      try {
        context.screen.requestPermission();
        state.ok = true;
      } catch (requestError) {
        state.error = requestError;
      } finally {
        state.finished = true;
      }
    });

    var deadline = Date.now() + CAPTURE_WAIT_MS;
    while (!state.finished && Date.now() < deadline) {
      loopCheckpoint();
      sleep(500);
    }
    if (!state.finished) {
      logger.warn(
        "截图授权等了 " + Math.round(CAPTURE_WAIT_MS / 1000) +
          " 秒没人回应，调度项 [" + entry.id + "] 这一拍先跳过。" +
          "人点了授权之后，下一拍就能跑"
      );
      return false;
    }
    if (!state.ok) {
      logger.warn(
        "截图授权没拿到，调度项 [" + entry.id + "] 跳过: " +
          (state.error && state.error.message ? state.error.message : state.error)
      );
      return false;
    }
    return true;
  }

  function loopSleep(ms) {
    if (background) {
      control.schedulerSleep(ms);
      return;
    }
    control.sleepInterruptibly(ms, logger);
  }

  logger.info(
    "常驻调度启动：" +
      usableEntries.length +
      " 条调度项，每 " +
      Math.round(tickIntervalMs / 1000) +
      " 秒判一次、每 " +
      Math.round(SCHEDULE_RELOAD_INTERVAL_MS / 1000) +
      " 秒重读一次调度表，最长运行 " +
      Math.round(maxDurationMs / 60000) +
      " 分钟。" +
      describeNextTimePoint(usableEntries, new Date())
  );

  // ---- 强制执行的守望线程 ----
  // 为什么非要另起一个线程：主循环在 runEntry 里一待就是几十分钟（挂机那类任务），
  // 这期间它根本不会去看表。没有这个线程的话，「强制执行」的实际表现是
  // "等当前任务自己跑完才去跑定时的那条"——那跟不勾它一模一样，等于加了个假开关。
  //
  // 它只写标志，不碰界面、不碰锁、不跑任务：抢占之后真正去跑的仍然是主循环。
  var watcherStopped = false;
  var forceWatcher = null;
  // 后台模式下**无条件起守望线程**：调度表现在是每拍重读的，
  // 「强制执行」可能是调度器跑起来之后才被勾上的。按启动那一刻有没有 force 来决定
  // 起不起它，表现就是"勾了强制执行，但要重启 App 才生效"——
  // 而界面上那个开关看着已经生效了。
  // 它每 15 秒只读一个小 JSON，没有 force 的调度项时立刻跳过，代价可以忽略。
  if (background || hasForceEntry(usableEntries)) {
    forceWatcher = threads.start(function () {
      while (!watcherStopped) {
        sleep(FORCE_WATCH_INTERVAL_MS);
        if (watcherStopped) break;
        try {
          if (!control.isPreemptable()) continue;
          if (control.isPreemptRequested()) continue;
          var watchNow = new Date();
          var watchSummary = loadSummary(config, dateKeyOf(watchNow));
          for (var i = 0; i < usableEntries.length; i++) {
            var candidateEntry = usableEntries[i];
            if (candidateEntry.force !== true) continue;
            // 自己不抢自己：打断了再从头跑一遍，白费一次次数。
            if (candidateEntry.id === runningEntryId) continue;
            var candidateState = entryStateOf(watchSummary, candidateEntry.id);
            var verdict = decide(candidateEntry, candidateState, watchNow, Date.now());
            if (!verdict.due) continue;
            if (control.requestPreempt(
              "强制执行 [" + candidateEntry.id + "] " + (verdict.reason || "到点")
            )) {
              logger.warn(
                "定时任务 [" + candidateEntry.id + "] " + (verdict.reason || "到点") +
                  "，正在让 [" + runningEntryId + "] 让位"
              );
            }
            break;
          }
        } catch (watchError) {
          // 守望线程绝不能把自己炸掉：它死了之后强制执行就静默失效，
          // 而界面上那个开关还勾着——正是本项目最危险的那类失效。
          logger.warn("强制执行守望出错（不影响常驻）: " + (watchError.message || watchError));
        }
      }
    });
  }

  try {
  while (true) {
    // 每轮开头过一次检查点。常驻是全项目最长命的循环（默认最长跑 12 小时），
    // 没有它的话「终止」按钮按下去只是把标志置上，没人去看——
    // 2026-09-18 实测：界面停在「正在终止: resident-runner」，
    // 实际要等到轮次上限或 720 分钟时长上限才会退，用户只能 kill 掉整个 App。
    //
    // 后台模式走自己那个开关：这时候它不是"人点出来的一个任务"，
    // 而是一直活着的定时调度。人在别的任务上按「终止」不该把它一起关掉。
    loopCheckpoint();

    // **每一拍都重读调度表。**
    // 2026-10-04 用户设了 21:11，到点什么都没发生——而调度器活得好好的、
    // 日志里一切正常。原因是调度表只在启动那一刻读过一次（21:06），
    // 而那条定时是 21:10 存进去的，它手上那份表里根本没有这个时间点。
    // 「设完定时就该生效」这件事，光靠"没在跑就起一个"不够：
    // **已经在跑的那个也得看得见新表。**
    if (options.reloadSchedule && Date.now() - lastReloadAt >= SCHEDULE_RELOAD_INTERVAL_MS) {
      lastReloadAt = Date.now();
      try {
        var fresh = options.reloadSchedule();
        validateSchedule(fresh);
        var rebuilt = buildUsableEntries(fresh, true);
        var freshPrint = fingerprintOf(rebuilt);
        if (freshPrint !== scheduleFingerprint) {
          scheduleFingerprint = freshPrint;
          usableEntries = rebuilt;
          logger.info(
            "调度表有变动，已重新加载：" + rebuilt.length + " 条可执行。" +
              describeNextTimePoint(rebuilt, new Date())
          );
        }
      } catch (reloadError) {
        // 新表有问题就继续用手上这份，绝不因此退出：
        // 调度器死掉等于整夜无人值守一起没，而那时没人在看。
        logger.warn("重新加载调度表失败，仍按上一份跑: " + (reloadError.message || reloadError));
      }
    }

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
    var summary = currentSummary(now);

    // 设备时钟被改了没有。墙上时间走的量应当与单调时钟一致，差出去的就是被改掉的部分。
    var monoNow = monotonicNow();
    if (monoNow != null && lastMonoAt != null) {
      var expectedWallAt = lastWallAt + (monoNow - lastMonoAt);
      var driftMs = tickStartedAt - expectedWallAt;
      if (Math.abs(driftMs) > CLOCK_JUMP_TOLERANCE_MS) {
        pendingClockJump = {
          fromAt: expectedWallAt,
          toAt: tickStartedAt,
          deltaMs: driftMs
        };
        logger.warn(
          "设备时钟被改过：从 " + hhmmOf(new Date(expectedWallAt)) + " 跳到 " +
            hhmmOf(new Date(tickStartedAt)) + "（" +
            (driftMs > 0 ? "往前" : "往回") + " " + describeDuration(driftMs) +
            "）。往前跳会把这段里的定时点整个跳过去，下面按需补跑一次"
        );
        // 留在当天汇总里：界面要据此说明"今天为什么有个点没动静"。
        if (!isArray(summary.clockJumps)) summary.clockJumps = [];
        summary.clockJumps.push({
          at: new Date(tickStartedAt).toISOString(),
          fromHhMm: hhmmOf(new Date(expectedWallAt)),
          toHhMm: hhmmOf(new Date(tickStartedAt)),
          deltaMs: driftMs
        });
        saveSummary(config, summary);
      }
    }
    lastWallAt = tickStartedAt;
    lastMonoAt = monoNow;

    for (var e = 0; e < usableEntries.length; e++) {
      var entry = usableEntries[e];
      var state = entryStateOf(summary, entry.id);
      var decision = decide(entry, state, now, tickStartedAt);
      // 到点判定没放行时，再看一眼这个点是不是被时钟跳变整段跳过去了。
      // 放在 decide 外面：decide 是纯函数，喂数据就能在 PC 上验，别把"设备时钟"这种
      // 只有真机才有的东西塞进去。
      if (!decision.due && pendingClockJump) {
        var missed = decideMissedByClockJump(entry, state, pendingClockJump, now);
        if (missed) decision = missed;
      }
      if (!decision.due) {
        // **把"为什么不跑"说出来。**
        // 这个理由原先只活在 decide 的返回值里，被这儿直接丢掉——于是
        // 「今日已达上限」「今天不在重复日期里」这类拦截对人完全不可见，
        // 表现就是"定时又没触发"，而日志干干净净（2026-10-04 用户连撞五轮）。
        // 只在理由变了的时候说一次：2 秒一拍，每拍都写等于把日志冲垮。
        if (lastSkipReason[entry.id] !== decision.reason) {
          lastSkipReason[entry.id] = decision.reason;
          if (decision.reason) {
            logger.info("调度项 [" + entry.id + "] 暂不跑: " + decision.reason);
          }
        }
        continue;
      }
      delete lastSkipReason[entry.id];

      // 后台模式下执行锁是**一条一抢**的。抢不到说明人正在手点任务跑，
      // 这时候不能插进去动游戏——跳过这一拍，到点判定有 10 分钟宽限，等会儿再来。
      // **抢不到不算失败**：它根本没跑，计进连续失败会把整夜的无人值守赔掉。
      var entryLock = null;
      if (background) {
        entryLock = runLock.acquire(config, entry.taskId);
        if (!entryLock) {
          var holder = runLock.inspect(config);
          logger.info(
            "调度项 [" + entry.id + "] 到点了，但有任务在跑（" +
              (holder ? holder.taskId : "未知") + "），这一拍先让开"
          );
          continue;
        }
      }

      // 截图授权也推到这一刻才要。要不到就把锁还回去、跳过这一条——
      // **不能占着锁去等弹窗**：那期间人点任何任务都会被顶回「已有任务在运行」。
      if (background && !ensureCaptureForEntry(entry)) {
        if (entryLock) {
          try { entryLock.release(); } catch (releaseError) {}
        }
        continue;
      }

      // 后台模式起步时**没有拉游戏**（那会把刚打开 App 的人扔进游戏里）。
      // 所以真要跑一条的时候，这里补上：把游戏切到前台，等它站稳再开点。
      // **必须走 actions.launchPackage**，不是裸 app.launchPackage——
      // 后者会把盒子的任务栈整个重置掉（2026-09-24 查清的根因）。
      //
      // **游戏已经在前台就别再拉一次。** 拉一次要 6 秒（`foregroundSettleMs`
      // 是给"刚切过去，画面还没站稳"留的），而定时跑的常态恰恰是人正看着游戏——
      // 白等这 6 秒，到点那一下就被推到了 HH:MM:06 以后。
      // 2026-10-05 用户问"为什么不准时"，这 6 秒是其中的一半。
      if (background) {
        try {
          if (config.game && config.game.packageName) {
            // 前台是谁要走 actions.foregroundPackage（root 读 dumpsys）。
            // **不能用 currentPackage()**：这台云机的 ROM 屏蔽了它，恒返回
            // com.android.systemui（陷阱 9，launch-game-check 的文件头也记着）。
            // 用它判就永远判成"不在前台"，这段优化等于没写。
            // 读不出来（返回 null）照旧拉一次：多拉最多慢几秒，
            // 漏拉是把五下点击打在别的应用上。
            var alreadyInFront =
              context.actions.foregroundPackage() === config.game.packageName;
            if (alreadyInFront) {
              logger.info("游戏已经在前台，直接开跑");
            } else {
              logger.info("定时触发前先把游戏切到前台");
              context.actions.launchPackage(config.game.packageName);
              control.sleepInterruptibly(config.runtime.foregroundSettleMs || 3000, logger);
            }
          }
        } catch (launchError) {
          // 拉不起来不在这儿判死：任务自己的第一步会校验落在哪一页，
          // 由它给出"到底卡在哪"的具体原因，比这里一句"启动失败"有用。
          logger.warn("切游戏到前台失败，仍按原计划跑: " + (launchError.message || launchError));
        }
      }

      logger.info("触发调度项 [" + entry.id + "] -> 任务 " + entry.taskId);
      // **到点要让人当场看见。** 后台定时跑的时候屏幕上没有运行条、没有进度，
      // 人盯着游戏只能从画面猜它跑没跑——猜错就变成"定时又没生效"
      // （2026-10-05 用户第三次这么说，而那一次日志里 5 步点击全在）。
      // 结果也报一句：跑完同样没有任何界面痕迹。
      if (background) {
        try { toast("定时到点，开始跑：" + (entry.name || entry.id)); } catch (error) {}
      }
      var entryStartedAt = Date.now();
      var outcome;
      // 圈出「这一趟可以被抢占」的范围。开合必须成对，否则抢占标志会漏到
      // 外层循环的 checkpoint 上，表现是定时任务跑完常驻自己莫名退出。
      runningEntryId = entry.id;
      control.beginPreemptable();
      try {
        outcome = runEntryWithEvidence(context, registry, entry, resolveRequires(entry, registry));
      } finally {
        control.endPreemptable();
        runningEntryId = null;
        // 执行锁必须在这儿还：**从抢到锁到进 finally 之间不能有裸露的可抛语句**
        // （2026-09-26 那次锁泄漏就是这么来的，锁带心跳，泄漏一次就是永久的）。
        if (entryLock) {
          try { entryLock.release(); } catch (releaseError) {}
        }
      }
      var durationMs = Date.now() - entryStartedAt;

      // 被抢占的那一趟不算"跑过一次"：它没跑完，上限不该因此被吃掉一格。
      if (outcome.status !== "preempted") {
        state.runs += 1;
      }
      state.lastRunAt = Date.now();
      state[outcome.status] = (state[outcome.status] || 0) + 1;
      state.history.push({
        startedAt: new Date(entryStartedAt).toISOString(),
        status: outcome.status,
        durationMs: durationMs,
        error: outcome.error,
        recoveredByPrerequisite: outcome.recoveredByPrerequisite,
        // 这一趟的证据在哪。汇总里只有"跑了、成功、13 秒"的时候，
        // 想再往下看一层就只能去翻 logcat；有了这条，界面能直接点进去。
        runDir: outcome.runDir || null
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
      } else if (outcome.status === "preempted") {
        // 让位不是失败，连续失败计数一个字都不动。
        logger.info(
          "调度项 [" + entry.id + "] 被抢占，跑了 " + Math.round(durationMs / 1000) + " 秒"
        );
      } else {
        consecutiveFailures += 1;
        logger.warn(
          "调度项 [" + entry.id + "] " + outcome.status + "，连续失败 " + consecutiveFailures + " 次"
        );
      }

      saveSummary(config, summary);

      if (background) {
        try {
          toast(
            "定时跑完：" + (entry.name || entry.id) + " " +
              (outcome.status === "passed" ? "成功" : outcome.status) +
              "，" + Math.round(durationMs / 1000) + " 秒"
          );
        } catch (toastError) {}
      }

      if (consecutiveFailures >= maxConsecutiveFailures) {
        logger.error(
          "连续失败达到上限 " + maxConsecutiveFailures + " 次，常驻主动退出，避免整夜空转乱点"
        );
        saveSummary(config, summary);
        return steps;
      }

      // 刚腾出位置就别接着按原顺序往下走了：抢占的目的就是让到点的那条**马上**跑。
      // 这一轮剩下的调度项下一拍照样会被判一遍，而到点判定有 10 分钟宽限，漏不掉。
      if (outcome.status === "preempted") {
        preemptedThisTick = true;
        break;
      }
    }

    // 这次跳变的补跑机会用掉了，不管刚才有没有人用上。
    // 留着它就会每一拍都重判一遍同一个"被跳过去的点"，补到天荒地老。
    pendingClockJump = null;

    // 睡到下一个检查点。用剩余时间取小，避免最后一轮睡过了时长上限。
    // **必须用可中断的睡眠**：tick 间隔默认 60 秒，裸 sleep 会让「终止」在这一分钟里
    // 完全没反应，看起来就是卡死了。
    var remaining = deadline - Date.now();
    if (remaining <= 0) {
      logger.info("达到时长上限，常驻退出");
      break;
    }
    // 刚抢占完不睡这一觉：睡满 60 秒才去跑那条定时任务，就把"强制执行"
    // 变成了"强制执行，但要等一分钟"。只过一次检查点保证终止仍然跟手。
    if (preemptedThisTick) {
      preemptedThisTick = false;
      loopCheckpoint();
      continue;
    }
    loopSleep(Math.min(tickIntervalMs, remaining));
  }
  } finally {
    // 守望线程必须跟着常驻一起死。留着它的话，下一次常驻启动就有两个线程在写
    // 同一个抢占标志，而多出来的那个认的是上一轮的调度表。
    watcherStopped = true;
    if (forceWatcher) {
      try { forceWatcher.interrupt(); } catch (interruptError) {}
    }
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
  decide: decide,
  // 下面四个是给界面用的：定时到底在不在工作，这件事必须在 App 里看得见，
  // 而不是只活在 logcat 里（2026-10-05：用户连着几轮以为定时没生效，
  // 其实它每次都跑了，只是界面上没有任何地方说得出来）。
  // **判定与显示共用同一份算法**，各写一套迟早出现"界面说下一个 11:03、
  // 调度器等的却是别的点"。
  describeNextTimePoint: describeNextTimePoint,
  // 时钟跳变在设备上没法说跳就跳，只能在 PC 上喂一个跳变对象验边界，所以导出。
  decideMissedByClockJump: decideMissedByClockJump,
  parseTimePoints: parseTimePoints,
  // 证据落盘这一段在设备上只能靠"等到点、再去翻目录"来验，一轮要等一个定时点。
  // 导出它是为了在 PC 上喂假 context 直接验：目录怎么拼的、字段齐不齐、
  // 任务抛出去的那一趟还留不留证据——这几样不该等真机。
  runEntryWithEvidence: runEntryWithEvidence,
  matchesWeekday: matchesWeekday,
  loadSummary: loadSummary,
  describeDuration: describeDuration,
  TIME_POINT_GRACE_MS: TIME_POINT_GRACE_MS
};
