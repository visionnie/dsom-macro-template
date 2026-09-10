// =====================================================================
// 常驻调度表：跑什么、什么时候跑
// 通用运行时不含业务语义，游戏相关的编排全部落在这个文件里。
//
// 三个上限必须保留（RULES.md：所有业务循环必须有明确上限）：
//   maxDurationMs           常驻最长跑多久，到点主动退出
//   maxIterations           最多检查多少轮
//   maxConsecutiveFailures  连续失败多少次就退出，避免整夜空转乱点
// =====================================================================

module.exports = {
  // 每隔多久检查一次有没有到点的任务。
  tickIntervalMs: 60000,

  // 常驻最长 12 小时。超过就退出，交给下一次开机自启或人工拉起。
  maxDurationMs: 12 * 60 * 60 * 1000,
  maxIterations: 2000,
  maxConsecutiveFailures: 5,

  // 模板里不预置任何业务调度项，由各游戏项目自行填写。
  // 字段说明：
  //   id              调度项标识，用于结果汇总里的分组
  //   taskId          要执行的任务，必须已登记在 task-registry 中
  //   window          可选，{ from: "HH:MM", to: "HH:MM" }，支持跨零点
  //   maxRunsPerDay   可选，默认 1
  //   minIntervalMs   可选，两次运行之间的最小间隔
  //   requires        可选，前置任务 id 列表。只有本任务失败时才补跑，然后重试一次
  entries: [
    {
      id: "environment-check",
      taskId: "environment-check",
      maxRunsPerDay: 1
    }
  ]
};
