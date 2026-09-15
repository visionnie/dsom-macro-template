// =====================================================================
// 通用能力：把脚本自己切回前台
// 设计约束：UI 模式与无界面模式走不同的路，调用方不需要关心当前是哪一种
// =====================================================================
// 为什么不能一律 app.launchPackage(context.getPackageName())：
//   开发路径下宿主包是 AutoJs6，拉起来的是它的文件列表 MainActivity。
//   UI 模式的脚本页 ScriptExecuteActivity 与之同处一个任务栈，约 1 秒后被销毁，
//   脚本随之结束——工作线程被中断，runtime 的 catch 捕获不到，
//   result.json 停在 status: "running" 且没有 error（2026-09-15 实测）。
// UI 模式下有 activity 全局，用 moveTaskToFront 按任务栈拉回，不会重建界面。
// 无界面模式没有 activity，仍用 launchPackage，与此前实测跑通的行为一致。
// =====================================================================

function hasScriptActivity() {
  return typeof activity !== "undefined" && activity !== null;
}

// 返回实际走的途径，便于写进日志排查。
function bringScriptToFront() {
  if (hasScriptActivity()) {
    // 这里失败不退回 launchPackage：UI 模式下那条路会直接杀掉脚本页，
    // 静默退回只会把问题变成更难查的「脚本莫名结束」。
    var activityManager = context.getSystemService(android.content.Context.ACTIVITY_SERVICE);
    try {
      activityManager.moveTaskToFront(activity.getTaskId(), 0);
    } catch (error) {
      // 打包 APK 时 project.json 漏了 REORDER_TASKS 就会走到这里。开发路径的宿主 AutoJs6
      // 自带该权限，所以这个错只在打包后出现——把修法写进报错，别让人再去翻 logcat。
      if (String(error).indexOf("REORDER_TASKS") >= 0) {
        throw new Error(
          "切回前台缺少 android.permission.REORDER_TASKS 权限：打包时 project.json 的 permissions 必须包含它。原始错误: " + error
        );
      }
      throw error;
    }
    return "moveTaskToFront";
  }
  app.launchPackage(context.getPackageName());
  return "launchPackage";
}

module.exports = {
  bringScriptToFront: bringScriptToFront
};
