// =====================================================================
// 通用能力：正在运行的任务的暂停与终止
// 设计约束：
//   - **协作式，不是线程挂起**。任务里全是 sleep 和找图轮询，硬挂起线程会把
//     截图会话和游戏状态卡在中间态。所以由执行循环在步骤之间主动调 checkpoint，
//     看到标志再停
//   - 代价要说清楚：暂停和终止**不是瞬时的**，最坏要等当前这一步跑完
//     （一个 tapImage 节点的找图超时默认 15 秒）。想更跟手只能把检查点插得更密，
//     代价是每次轮询多一次判断
//   - pause / resume / requestStop 只写标志，可以从 UI 线程调用；
//     checkpoint 会 sleep，**只能在工作线程里调用**（UI 线程 sleep 会让整个脚本退出）
//   - 状态放模块级变量：打包器的 require 带 cache，同一个脚本引擎内是单例
// =====================================================================

var errors = require("./errors-autojs.js");

// 暂停时的轮询间隔。取小一点，让「继续」按下去手感跟得上。
var PAUSE_POLL_MS = 200;

var paused = false;
var stopRequested = false;
var pausedSince = 0;

// ---- 抢占：只打断「当前这一趟子任务」，不打断外层的常驻循环 ----
// 为什么不能直接用 requestStop：常驻的主循环与它跑的子任务**共用这套模块级标志**
// （同一个脚本引擎内 require 带 cache）。置上 stopRequested 会让子任务停下来，
// 但下一拍常驻自己的 checkpoint 也会抛，整个常驻跟着退出——
// 而「强制执行」要的是"把当前这条停掉，去跑到点的那条"，常驻必须活着。
//
// 作用域是必须的：没有 beginPreemptable 圈定范围的话，抢占标志会在子任务结束后
// 继续挂着，被外层循环的 checkpoint 读到，表现就是"定时任务跑完，常驻莫名其妙退出了"。
var preemptRequested = false;
var preemptReason = "";
var preemptDepth = 0;
var preemptFired = false;

// ---- 后台定时调度器自己的停止开关 ----
// 这个项目里有**两条长命循环**：正在执行的任务，和后台那个每分钟看一次表的调度器。
// 上面那套 paused / stopRequested 属于前者——界面上的「暂停 / 终止」说的就是
// "把我正在跑的这件事停下来"。
//
// 2026-10-04 把调度器挪到后台之后，两者必须分开：调度器睡在 tick 之间时，
// 人在手点的任务上按一次「终止」，不该顺手把定时调度也关了
// （表现是"我停了一个任务，结果今晚的定时全没跑"，而且没有任何地方会说这件事）。
var schedulerStopRequested = false;

// 每次启动任务前调用，清掉上一轮遗留的标志。
function reset() {
  paused = false;
  stopRequested = false;
  pausedSince = 0;
  preemptRequested = false;
  preemptReason = "";
  preemptDepth = 0;
  preemptFired = false;
}

function pause() {
  if (stopRequested) return false;
  paused = true;
  pausedSince = Date.now();
  return true;
}

function resume() {
  paused = false;
  pausedSince = 0;
  return true;
}

function requestStop() {
  stopRequested = true;
  // 解除暂停，否则 checkpoint 会卡在等待循环里，终止要等到有人先点继续。
  paused = false;
  return true;
}

// 进入「这一趟可以被抢占」的范围。只有在范围内，checkpoint 才认抢占标志。
function beginPreemptable() {
  preemptDepth += 1;
  preemptRequested = false;
  preemptReason = "";
  preemptFired = false;
}

// 退出范围，并回答「这一趟到底是不是被抢占掉的」。
// 调用方拿它来决定这次失败算不算数：被抢占不是失败，不该计进连续失败、
// 更不该触发「补跑前置后重试一次」——前置补跑是给"游戏掉线了"准备的。
function endPreemptable() {
  if (preemptDepth > 0) preemptDepth -= 1;
  var fired = preemptFired;
  var reason = preemptReason;
  preemptRequested = false;
  preemptReason = "";
  preemptFired = false;
  return { preempted: fired, reason: reason };
}

// 只在范围内才算数。范围外调用直接返回 false，免得标志悬在那儿等下一个任务踩。
function requestPreempt(reason) {
  if (preemptDepth <= 0) return false;
  preemptRequested = true;
  preemptReason = String(reason || "被抢占");
  return true;
}

function isPreemptable() {
  return preemptDepth > 0;
}

function isPreemptRequested() {
  return preemptRequested;
}

// 「这一趟已经因为抢占被打断了」。只查不清，给 catch 分支判断用——
// 清标志是 endPreemptable 的事，两处都清会出现"第一处清掉了，第二处判成没抢占"。
function isPreemptFired() {
  return preemptFired;
}

function isPaused() {
  return paused;
}

function isStopRequested() {
  return stopRequested;
}

function state() {
  return {
    paused: paused,
    stopRequested: stopRequested,
    pausedSince: pausedSince,
    preemptable: preemptDepth > 0,
    preemptRequested: preemptRequested,
    preemptReason: preemptReason
  };
}

// 执行循环的协作检查点。只能在工作线程里调用。
function checkpoint(logger) {
  if (stopRequested) {
    throw errors.cancelled("任务被手动终止");
  }
  // 抢占排在暂停之前：暂停着的任务也该被定时任务抢走，
  // 否则人按了暂停去吃饭，到点的那条就永远等不到它让位。
  if (preemptRequested && preemptDepth > 0) {
    preemptFired = true;
    paused = false;
    throw errors.cancelled(preemptReason || "被抢占");
  }
  if (!paused) {
    return;
  }

  if (logger) logger.info("任务已暂停，等待继续…");
  while (paused && !stopRequested && !preemptRequested) {
    sleep(PAUSE_POLL_MS);
  }
  if (stopRequested) {
    throw errors.cancelled("任务在暂停状态下被终止");
  }
  if (preemptRequested && preemptDepth > 0) {
    preemptFired = true;
    paused = false;
    throw errors.cancelled(preemptReason || "被抢占");
  }
  if (logger) logger.info("任务继续");
}

// 可被暂停/终止打断的等待。切成 500 毫秒一段，每段之间过一次检查点。
// 粒度取 500：再细意义不大（人感知不到），再粗按下终止要等太久。
//
// **凡是要等超过一两秒的地方都得用它，别用裸 sleep。**
// 裸 sleep 期间「终止」按钮按了也没用——标志置上了，但没人去看。
// 2026-09-18 实测：常驻调度两次 tick 之间是 sleep(60000)，循环里又没有检查点，
// 结果点了终止界面显示「正在终止」却一直停不下来，只能 kill 掉整个 App。
// 越是长命的循环越要守这条。
// ---- 调度器专用的检查点与睡眠 ----
// 与上面那套同构，只是认另一个标志。**调度器的 tick 间隔默认 60 秒**，
// 裸 sleep 会让「停止定时调度」在这一分钟里完全没反应（2026-09-18 在常驻上踩过一次，
// 当时只能 kill 掉整个 App）。
function resetScheduler() {
  schedulerStopRequested = false;
}

function requestSchedulerStop() {
  schedulerStopRequested = true;
  return true;
}

function isSchedulerStopRequested() {
  return schedulerStopRequested;
}

function schedulerCheckpoint() {
  if (schedulerStopRequested) {
    throw errors.cancelled("定时调度已停止");
  }
}

function schedulerSleep(totalMs) {
  var sliceMs = 500;
  var remaining = totalMs;
  while (remaining > 0) {
    schedulerCheckpoint();
    var step = remaining < sliceMs ? remaining : sliceMs;
    sleep(step);
    remaining -= step;
  }
  schedulerCheckpoint();
}

function sleepInterruptibly(totalMs, logger) {
  var sliceMs = 500;
  var remaining = totalMs;
  while (remaining > 0) {
    checkpoint(logger);
    var step = remaining < sliceMs ? remaining : sliceMs;
    sleep(step);
    remaining -= step;
  }
  checkpoint(logger);
}

module.exports = {
  PAUSE_POLL_MS: PAUSE_POLL_MS,
  reset: reset,
  pause: pause,
  resume: resume,
  requestStop: requestStop,
  beginPreemptable: beginPreemptable,
  endPreemptable: endPreemptable,
  requestPreempt: requestPreempt,
  isPreemptable: isPreemptable,
  isPreemptRequested: isPreemptRequested,
  isPreemptFired: isPreemptFired,
  isPaused: isPaused,
  isStopRequested: isStopRequested,
  state: state,
  checkpoint: checkpoint,
  sleepInterruptibly: sleepInterruptibly,
  resetScheduler: resetScheduler,
  requestSchedulerStop: requestSchedulerStop,
  isSchedulerStopRequested: isSchedulerStopRequested,
  schedulerCheckpoint: schedulerCheckpoint,
  schedulerSleep: schedulerSleep
};
