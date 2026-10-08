// =====================================================================
// 通用能力：把设备上录制出来的用例解析成可执行任务，让调度表能引用它
// 设计约束：
//   - 录制用例是**设备上现生成的数据**，不是仓库里的代码，进不了静态的任务登记表；
//     而调度表只认 taskId。约定前缀 recorded:<会话 id> 把两边接起来，
//     取任务时现场按会话目录造一个任务对象出来
//   - 锚点图与用例同在会话目录，所以用例是 assetBase: "case"，必须传 caseDir
//   - 会话目录或 case.json 不存在是环境问题（broken），不是业务失败：
//     录制被删掉、SD 卡没挂上都属于这一类，不该算进用例通过率
//   - 本模块不含游戏语义
// =====================================================================

var errors = require("./errors-autojs.js");

var RECORDED_PREFIX = "recorded:";

function isRecordedTaskId(taskId) {
  return typeof taskId === "string" && taskId.indexOf(RECORDED_PREFIX) === 0;
}

function taskIdOf(sessionId) {
  return RECORDED_PREFIX + sessionId;
}

function sessionIdOf(taskId) {
  return String(taskId).slice(RECORDED_PREFIX.length);
}

function sessionDirOf(config, sessionId) {
  return config.outputRoot + "/recordings/" + sessionId;
}

// 造一个回放录制用例的任务。不进任务登记表：登记表是代码，这是数据。
// 三个前置开关与业务用例一致——有的盒子在启动那一刻检测录屏，
// 所以先启动游戏、后申请截图权限。
// options.regenerated：本次跑之前按 session.json 重新生成过 case.json，写进日志。
// options.name：人取的名字，运行页与结果里显示它。
// options.startNodeId：**从这个节点开始跑**，前面的跳过（2026-10-06 用户要的
//   「从该节点开始运行」）。调的是 runCase 本来就有的 entry，不是另一条执行路径——
//   另写一条的结果必然是两条路的方向断言、坐标换算、等待语义各走各的。
//   给了个不存在的 id 时 runCase 自己会报「entry 节点不存在」，不在这儿兜。
function createTask(sessionId, sessionDir, casePath, options) {
  var caseRunner = require("./case/case-runner-autojs.js");
  var opts = options || {};
  return {
    id: taskIdOf(sessionId),
    name: opts.name || "录制用例 " + sessionId,
    launchGame: true,
    // 只有找图步骤才需要"看见"屏幕。全是死坐标的录制只需要无障碍服务点得动，
    // 却曾经照样申请截图权限——Android 10 的 MediaProjection 不能预授权、不能记住，
    // 于是每跑一次都要人在几秒内点一下弹窗，无人值守时直接判 broken。
    requiresCapture: caseNeedsCapture(casePath),
    captureAfterLaunch: true,
    // 从盒子界面开始录的用例，要的是盒子**首页**，不是"盒子上次停在哪一页"。
    startFromHome: caseStartsFromHome(casePath),
    run: function (context) {
      if (opts.regenerated) {
        context.logger.info("用例有未生成的改动，已按 session.json 重新生成后再跑");
      }
      var caseData = caseRunner.loadCase(casePath);
      if (opts.startNodeId) {
        // 写进日志：事后看记录时，"这一趟只跑了后半截"必须说得出来，
        // 否则看到的是一条步数对不上的记录，而没人记得当时是从中间起的。
        context.logger.info("从指定节点开始跑: " + opts.startNodeId + "（它前面的步骤跳过）");
        caseData.entry = opts.startNodeId;
      }
      return caseRunner.runCase(context, caseData, { caseDir: sessionDir });
    }
  };
}

// 用例里有没有找图步骤，决定这一跑要不要截图权限。
// 读不出来就按「需要」处理：宁可多弹一次窗，也不要让一条找图用例在没有权限的情况下
// 跑到那一步才发现（那时游戏已经被操作过一半了）。
function readCase(casePath) {
  if (!files.exists(casePath)) return null;
  var raw = files.read(casePath);
  if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

function caseNeedsCapture(casePath) {
  try {
    var caseData = readCase(casePath);
    if (!caseData) return true;
    var recordedCase = require("./case/recorded-case-autojs.js");
    var nodes = caseData.nodes || [];
    for (var i = 0; i < nodes.length; i++) {
      // 找图要看屏幕，**点击文字同样要**：它靠截屏去认字。
      // 漏掉认字节点的表现是"每次都认不出那段字"，而日志里只有一句没找到——
      // 这正是「判据各写一份」会埋的那种坑，所以一律走 recorded-case 的两个判别函数。
      if (recordedCase.usesImage(nodes[i])) return true;
      if (nodes[i] && nodes[i].type === "tapText") return true;
    }
    return false;
  } catch (error) {
    return true;
  }
}

// 这条用例要不要从应用首页起跑。
//
// 判据是**第一步录制时是竖屏**：盒子自己的界面是竖屏，游戏是横屏。
// 所以"第一步竖屏"等于"这条用例是从盒子界面开始的"，那它就需要盒子停在首页；
// 而 `launchPackage` 只会把盒子恢复到上次那一页（多半是游戏里，横屏），
// 第一步于是永远等不到竖屏（2026-09-17 用户连撞两次）。
//
// 第一步就是横屏的用例（录制时已经在游戏里）不能这么干：把首页顶出来
// 等于把人踢出游戏，正好和它要的状态相反。
// 用例里显式写了 startFromHome 就听它的，判据只是缺省值。
function caseStartsFromHome(casePath) {
  try {
    var caseData = readCase(casePath);
    if (!caseData) return false;
    if (caseData.startFromHome != null) return caseData.startFromHome === true;
    var first = caseData.nodes && caseData.nodes[0];
    var baseline = (first && first.baseline) || caseData.baseline;
    if (!baseline) return false;
    return baseline.height > baseline.width;
  } catch (error) {
    return false;
  }
}

// case.json 是 session.json 的产物。人在步骤编辑页改完（改名、挪点、框锚点、调停顿）
// 只写 session.json，case.json 就旧了——而跑的是 case.json。
// 指望人记得回复核页点一下「生成用例」是不成立的，尤其常驻到点自己跑时根本没人在。
// 所以在这里按修改时间兜底：session 比 case 新（或 case 压根不存在）就先重新生成。
function lastModifiedOf(path) {
  try {
    return new java.io.File(path).lastModified();
  } catch (error) {
    return 0;
  }
}

function ensureFreshCase(sessionDir, casePath) {
  var sessionPath = sessionDir + "/session.json";
  if (!files.exists(sessionPath)) return false;
  var caseAt = files.exists(casePath) ? lastModifiedOf(casePath) : 0;
  // 取不到修改时间（0）就按"需要重新生成"处理：多生成一次只是几毫秒，
  // 而漏生成会让人对着旧用例查半天。
  if (caseAt > 0 && lastModifiedOf(sessionPath) <= caseAt) return false;

  var recorder = require("./recorder-autojs.js");
  var recordedCase = require("./case/recorded-case-autojs.js");
  var caseRunner = require("./case/case-runner-autojs.js");
  var session = recorder.loadSession(sessionDir);
  var caseData = recordedCase.buildCase(session);
  // 与复核页同一份校验：坏用例不落盘，宁可保留上一版能跑的。
  caseRunner.validateCase(caseData);
  files.write(casePath, JSON.stringify(caseData, null, 2) + "\n");
  return true;
}

// 按 recorded:<会话 id> 取任务。缺什么就说缺什么——调度表里留着一条指向
// 已删录制的调度项时，日志里得能直接看出是哪个会话没了。
function resolve(config, taskId) {
  var sessionId = sessionIdOf(taskId);
  if (!sessionId) {
    throw new Error("录制任务 id 缺少会话号: " + taskId);
  }
  var dir = sessionDirOf(config, sessionId);
  if (!files.exists(dir)) {
    throw errors.broken("录制会话不存在: " + dir);
  }
  var casePath = dir + "/case.json";

  var regenerated = false;
  try {
    regenerated = ensureFreshCase(dir, casePath);
  } catch (error) {
    // 会话本身有问题（没步骤了、锚点框丢了…）。这是数据问题不是业务失败，
    // 而且说得出是哪一条录制，人回步骤编辑页就能改。
    throw errors.broken(
      "录制会话 " + sessionId + " 的改动生成不了用例: " + (error.message || error)
    );
  }

  if (!files.exists(casePath)) {
    throw errors.broken(
      "录制会话 " + sessionId + " 还没生成用例（缺 case.json），先在复核页点「生成用例」"
    );
  }

  var name = null;
  try {
    name = require("./recorder-autojs.js").loadSession(dir).name;
  } catch (error) {
    // 名字只是显示用，读不到就退回默认名，不该拦住运行。
  }
  return createTask(sessionId, dir, casePath, { regenerated: regenerated, name: name });
}

// 彻底删掉一条录制：会话目录、任务列表里的那一行、挂在它上面的常驻调度项，三样一起。
//
// 为什么必须一起删：三份数据分别存在三个地方，少删一处就留下幽灵——
//   - 只删目录：任务列表里剩一条标红「打不开这次录制」
//   - 只摘列表：常驻半夜照样按调度项去跑它，取不到任务只能报 broken
//   - 只删调度：用户以为删干净了，下次打开列表它还在
// 这是**不可撤销**的，调用方必须自己做二次确认。
//
// 路径护栏：只删 <outputRoot>/recordings/<会话 id>，且会话 id 必须是纯数字。
// 这个函数删的是整个目录树，一旦拼错路径后果不可逆，宁可多一道判断。
function removeSession(config, sessionId) {
  var id = String(sessionId);
  if (!/^[0-9]+$/.test(id)) {
    throw new Error("会话 id 不合法，拒绝删除: " + id);
  }

  var taskStore = require("./task-store-autojs.js");
  var scheduleStore = require("./schedule-store-autojs.js");
  var groupStore = require("./task-group-store-autojs.js");

  var result = {
    sessionId: id,
    dirRemoved: false,
    listRemoved: false,
    scheduleRemoved: [],
    groupsTouched: []
  };

  // 先摘引用、后删目录。顺序反过来的话，删完目录若摘引用时出错，
  // 留下的就是「指向已删录制」的引用——正是最难查的那种脏数据。
  result.listRemoved = taskStore.removeEntry(config, id).removed;
  result.scheduleRemoved = scheduleStore.removeByTaskId(config, taskIdOf(id)).removed;
  // 组合里引用着它的那一段也要摘掉。留着的话组合会跑到那一段才炸，
  // 而那时前面几段已经把游戏操作过一半了。
  result.groupsTouched = groupStore.removeMemberEverywhere(config, id);

  var dir = sessionDirOf(config, id);
  if (files.exists(dir)) {
    files.removeDir(dir);
    result.dirRemoved = !files.exists(dir);
    if (!result.dirRemoved) {
      throw new Error("会话目录没能删掉: " + dir);
    }
  }
  return result;
}

// 包一层任务登记表：recorded: 与 group: 开头的现场解析，其余照旧走登记表。
// 常驻调度只通过 registry.get 取任务，包完之后 resident-autojs.js 一行都不用改。
// 组合任务也从这里进，所以「挂常驻」对组合和单条录制是同一套路径。
function wrapRegistry(registry, config) {
  var taskGroup = require("./task-group-autojs.js");
  return {
    listIds: function () {
      return registry.listIds();
    },
    get: function (taskId) {
      if (isRecordedTaskId(taskId)) {
        return resolve(config, taskId);
      }
      if (taskGroup.isGroupTaskId(taskId)) {
        return taskGroup.resolve(config, taskId);
      }
      return registry.get(taskId);
    }
  };
}

module.exports = {
  RECORDED_PREFIX: RECORDED_PREFIX,
  isRecordedTaskId: isRecordedTaskId,
  taskIdOf: taskIdOf,
  sessionIdOf: sessionIdOf,
  sessionDirOf: sessionDirOf,
  createTask: createTask,
  ensureFreshCase: ensureFreshCase,
  removeSession: removeSession,
  resolve: resolve,
  wrapRegistry: wrapRegistry
};
