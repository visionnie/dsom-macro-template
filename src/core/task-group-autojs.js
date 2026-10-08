// =====================================================================
// 通用能力：把组合任务解析成可执行任务（group:<组合 id>）
// 设计约束：
//   - **只做一次启动前置，然后顺序跑完各段。** 组合的典型用法是「登录 → 挂机」，
//     后一段依赖前一段挣来的状态。若每段都各走一遍完整前置，第二段的 launch
//     会把第一段的状态踢掉——2026-09-18 在一个真实游戏上实测的数据能说明为什么：
//       登录那一段  第一步竖屏 -> startFromHome=true  -> 把启动器首页顶出来
//       挂机那一段  第一步横屏 -> startFromHome=false -> 只 launchPackage，不动状态
//     所以前置标志按**第一段**取，后面各段只跑用例本身
//   - 一段失败就整个失败，不继续往下跑。「登录失败了还接着挂机」只会对着
//     登录界面乱点。要「失败也继续」等真有这种用例再加，成员已经是对象、留得下开关
//   - 与 recorded-task 同构：都由 registry 包装层现场解析，
//     常驻调度与手动运行走同一条路
//   - 本模块不含游戏语义
// =====================================================================

var errors = require("./errors-autojs.js");

var GROUP_PREFIX = "group:";

function isGroupTaskId(taskId) {
  return typeof taskId === "string" && taskId.indexOf(GROUP_PREFIX) === 0;
}

function taskIdOf(groupId) {
  return GROUP_PREFIX + groupId;
}

function groupIdOf(taskId) {
  return String(taskId).slice(GROUP_PREFIX.length);
}

// 把成员逐个解析成录制任务。任何一段解析不出来都当场抛：
// 组合跑到一半才发现第三段的录制被删了，前两段已经把游戏操作过一半，
// 那时候报错既救不回来也说不清楚。宁可一步都别跑。
function resolveMembers(config, group) {
  var recordedTask = require("./recorded-task-autojs.js");
  var members = group.members || [];
  if (members.length === 0) {
    throw errors.broken("组合任务「" + (group.name || group.id) + "」还没有任何一段");
  }
  var resolved = [];
  for (var i = 0; i < members.length; i++) {
    var sessionId = members[i].sessionId;
    try {
      resolved.push({
        sessionId: sessionId,
        task: recordedTask.resolve(config, recordedTask.taskIdOf(sessionId))
      });
    } catch (error) {
      throw errors.broken(
        "组合任务「" + (group.name || group.id) + "」第 " + (i + 1) + " 段取不到: " +
          (error.message || error)
      );
    }
  }
  return resolved;
}

function resolve(config, taskId) {
  var store = require("./task-group-store-autojs.js");
  var groupId = groupIdOf(taskId);
  if (!groupId) {
    throw new Error("组合任务 id 缺少组合号: " + taskId);
  }
  var group = store.get(config, groupId);
  if (!group) {
    throw errors.broken("组合任务不存在: " + groupId);
  }

  var resolved = resolveMembers(config, group);
  var first = resolved[0].task;

  // 前置标志：启动方式跟**第一段**走，截图授权只要有任意一段需要就申请。
  // 授权是会话级的，一次申请后面各段都能用。
  var needsCapture = false;
  for (var i = 0; i < resolved.length; i++) {
    if (resolved[i].task.requiresCapture) needsCapture = true;
  }

  return {
    id: taskId,
    name: group.name || "组合任务 " + groupId,
    launchGame: true,
    captureAfterLaunch: true,
    requiresCapture: needsCapture,
    startFromHome: first.startFromHome === true,
    run: function (context) {
      var logger = context.logger;
      logger.info(
        "组合任务「" + (group.name || groupId) + "」共 " + resolved.length + " 段：" +
          describeMembers(resolved)
      );

      var steps = [];
      for (var m = 0; m < resolved.length; m++) {
        var member = resolved[m];
        logger.info(
          "第 " + (m + 1) + "/" + resolved.length + " 段：" + member.task.name +
            "（会话 " + member.sessionId + "）"
        );
        // 不接住异常：一段失败就让它往上抛，整个组合失败。
        // runtime 会把 broken 与 failed 分流，这里不该替它判断。
        var memberSteps = member.task.run(context) || [];
        for (var s = 0; s < memberSteps.length; s++) {
          // 步骤名前面加上第几段，否则汇总里一堆「1 点击」根本分不出是哪一段的。
          var step = memberSteps[s];
          steps.push({
            id: step.id,
            name: "[" + (m + 1) + "/" + resolved.length + " " + member.task.name + "] " + step.name,
            type: step.type,
            status: step.status,
            durationMs: step.durationMs,
            error: step.error
          });
        }
        logger.info("第 " + (m + 1) + " 段完成：" + member.task.name);
      }
      return steps;
    }
  };
}

function describeMembers(resolved) {
  var names = [];
  for (var i = 0; i < resolved.length; i++) {
    names.push(resolved[i].task.name);
  }
  return names.join(" → ");
}

module.exports = {
  GROUP_PREFIX: GROUP_PREFIX,
  isGroupTaskId: isGroupTaskId,
  taskIdOf: taskIdOf,
  groupIdOf: groupIdOf,
  resolve: resolve
};
