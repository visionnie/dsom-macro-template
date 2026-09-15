// =====================================================================
// 项目入口：无界面模式，只负责分派——开发路径直接跑任务，否则在主线程拉起菜单
// =====================================================================
// 为什么入口不是 "ui"：AutoJs6 启动 UI 脚本时先 startActivity、后把执行登记进查找表
// （ScriptEngineService.execute 里 executeInternal 返回后才 mScriptExecutions.put），
// 而 ScriptExecuteActivity.onCreate 按 id 查不到执行就直接 finish。
// 点图标启动时这一切发生在主线程，onCreate 必然排在 put 之后，没事；
// 开机自启的 launchOnBoot 却在工作线程里调，主线程若正闲着，onCreate 抢先执行、查不到、自关——
// 开机自启静默失效（2026-09-16 真机重启复现；root 给闲置进程发开机广播也能稳定复现）。
//
// 无界面脚本不经过 ScriptExecuteActivity，没有这个竞态。菜单改由本入口投递到主线程再启动，
// 与点图标同一时序。菜单本身见 menu-autojs.js。
//
// 开发路径（run-task.ps1）会在脚本同级写 task.txt：此时不出菜单，直接无界面跑指定任务，
// 与打包 APK 共用这一份入口。
// =====================================================================

"auto";

var config = require("../config/game-config-autojs.js");
var launcher = require("../core/launcher-autojs.js");

// 与本文件同级的菜单脚本。构建产出 dist/menu-autojs.js，推送与打包都放在 main 旁边。
var MENU_SCRIPT = "menu-autojs.js";
var MENU_LAUNCH_TIMEOUT_MS = 10000;

// 点图标会再跑一次本入口。无界面引擎很快结束，inrt 自带的「已在运行就不再启动」拦不住，
// 不自己查的话每点一次图标就多开一个菜单，两个常驻会抢屏幕。
function isMenuRunning() {
  try {
    var running = engines.all();
    for (var i = 0; i < running.length; i++) {
      if (String(running[i].getSource()).indexOf(MENU_SCRIPT) >= 0) {
        return true;
      }
    }
  } catch (error) {
    // 查不了就当没有：宁可偶发多开一个菜单，也不能让菜单永远起不来。
    log("查询运行中的脚本失败，按未运行处理: " + error);
  }
  return false;
}

function launchMenuOnMainThread() {
  var menuPath = files.path("./" + MENU_SCRIPT);
  if (!files.exists(menuPath)) {
    throw new Error("菜单脚本不存在: " + menuPath + "。构建、推送或打包漏了它");
  }
  if (isMenuRunning()) {
    log("菜单已在运行，不再重复启动");
    return;
  }

  var state = { done: false, error: null };
  // 必须在主线程发起：见文件头关于竞态的说明。
  new android.os.Handler(android.os.Looper.getMainLooper()).post(
    new java.lang.Runnable({
      run: function () {
        try {
          engines.execScriptFile(menuPath);
        } catch (error) {
          state.error = error;
        }
        state.done = true;
      }
    })
  );

  // 等投递的任务在主线程跑完再退出：本脚本一结束，运行时就回收了，晚到的回调可能用不了 engines。
  var deadline = Date.now() + MENU_LAUNCH_TIMEOUT_MS;
  while (!state.done) {
    if (Date.now() > deadline) {
      throw new Error("等待主线程启动菜单超时 " + MENU_LAUNCH_TIMEOUT_MS + " 毫秒");
    }
    sleep(50);
  }
  if (state.error) {
    throw state.error;
  }
}

var override = launcher.readTaskOverride();
if (override) {
  var registry = require("../task-registry-autojs.js");
  var runtime = require("../core/runtime-autojs.js");
  runtime.run(config, registry.get(override));
} else {
  launchMenuOnMainThread();
}
