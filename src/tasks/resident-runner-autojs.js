// =====================================================================
// 通用任务：常驻调度入口
// 申请一次截图权限后进入循环不退出，到点按调度表触发业务用例。
// 这是无人值守的入口——授权是按会话的，进程活着授权就一直有效。
//
// 跑什么、什么时候跑全部在 src/config/schedule-autojs.js，本文件不含业务语义。
//
// 实际用的调度表 = 代码里的基表 + 设备上的增补层（schedule-store）。
// 增补层让录制出来的用例不重新打包也能进常驻：调度项的 taskId 写成
// recorded:<会话 id>，取任务时由 recorded-task 现场按会话目录造出来。
// =====================================================================

var resident = require("../core/resident-autojs.js");
var scheduleStore = require("../core/schedule-store-autojs.js");
var recordedTask = require("../core/recorded-task-autojs.js");
var schedule = require("../config/schedule-autojs.js");

module.exports = {
  id: "resident-runner",
  name: "常驻调度",
  launchGame: true,
  requiresCapture: true,
  // 与其他任务一致：先启动应用、后申请权限。
  // 有的应用在启动那一刻检测录屏，顺序反了它会自己退出。
  captureAfterLaunch: true,
  run: function (context) {
    // 任务登记表 require 了本文件，本文件又需要登记表来按 id 取任务——直接在
    // 模块顶层 require 会拿到一个还没赋值完的 module.exports（登记表用的是
    // 整体赋值而非逐字段挂载）。放到 run() 里，执行时登记表早已加载完毕。
    // 打包器按正则扫全文，函数体内的静态 require 同样会被收进产物。
    var registry = require("../task-registry-autojs.js");

    var overlay = scheduleStore.load(context.config);
    if (overlay.recoveredFrom) {
      // 增补层读坏了只降级、不中止：基表照常跑，但必须留下痕迹，
      // 否则人会以为"加进去的那条怎么不跑"是调度逻辑的问题。
      context.logger.warn("调度增补层读取失败，已按空表继续: " + overlay.recoveredFrom);
    }
    var merged = scheduleStore.merge(schedule, overlay);
    if (overlay.entries && overlay.entries.length > 0) {
      context.logger.info(
        "调度表已合并设备侧增补层 " + overlay.entries.length + " 条: " +
          scheduleStore.overlayPathOf(context.config)
      );
    }

    return resident.run(context, {
      schedule: merged,
      registry: recordedTask.wrapRegistry(registry, context.config)
    });
  }
};
