// =====================================================================
// 任务登记：所有可执行任务必须在这里显式登记
// 设计约束：任务 ID 不重复，入口只按 ID 选择任务
// =====================================================================

var tasks = [
  require("./tasks/environment-check-autojs.js"),
  require("./tasks/launch-game-check-autojs.js")
];

function get(taskId) {
  for (var index = 0; index < tasks.length; index++) {
    if (tasks[index].id === taskId) {
      return tasks[index];
    }
  }
  throw new Error("未登记任务: " + taskId + "，可用任务: " + listIds().join(", "));
}

function listIds() {
  var ids = [];
  for (var index = 0; index < tasks.length; index++) {
    ids.push(tasks[index].id);
  }
  return ids;
}

module.exports = {
  get: get,
  listIds: listIds
};
