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

// 每次启动任务前调用，清掉上一轮遗留的标志。
function reset() {
  paused = false;
  stopRequested = false;
  pausedSince = 0;
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
    pausedSince: pausedSince
  };
}

// 执行循环的协作检查点。只能在工作线程里调用。
function checkpoint(logger) {
  if (stopRequested) {
    throw errors.cancelled("任务被手动终止");
  }
  if (!paused) {
    return;
  }

  if (logger) logger.info("任务已暂停，等待继续…");
  while (paused && !stopRequested) {
    sleep(PAUSE_POLL_MS);
  }
  if (stopRequested) {
    throw errors.cancelled("任务在暂停状态下被终止");
  }
  if (logger) logger.info("任务继续");
}

module.exports = {
  PAUSE_POLL_MS: PAUSE_POLL_MS,
  reset: reset,
  pause: pause,
  resume: resume,
  requestStop: requestStop,
  isPaused: isPaused,
  isStopRequested: isStopRequested,
  state: state,
  checkpoint: checkpoint
};
