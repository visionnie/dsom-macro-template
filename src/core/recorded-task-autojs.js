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
function createTask(sessionId, sessionDir, casePath) {
  var caseRunner = require("./case/case-runner-autojs.js");
  return {
    id: taskIdOf(sessionId),
    name: "录制用例 " + sessionId,
    launchGame: true,
    requiresCapture: true,
    captureAfterLaunch: true,
    run: function (context) {
      var caseData = caseRunner.loadCase(casePath);
      return caseRunner.runCase(context, caseData, { caseDir: sessionDir });
    }
  };
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
  if (!files.exists(casePath)) {
    throw errors.broken(
      "录制会话 " + sessionId + " 还没生成用例（缺 case.json），先在复核页点「生成用例」"
    );
  }
  return createTask(sessionId, dir, casePath);
}

// 包一层任务登记表：recorded: 开头的现场解析，其余照旧走登记表。
// 常驻调度只通过 registry.get 取任务，包完之后 resident-autojs.js 一行都不用改。
function wrapRegistry(registry, config) {
  return {
    listIds: function () {
      return registry.listIds();
    },
    get: function (taskId) {
      if (isRecordedTaskId(taskId)) {
        return resolve(config, taskId);
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
  resolve: resolve,
  wrapRegistry: wrapRegistry
};
