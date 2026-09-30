// =====================================================================
// 通用能力：启动应用、点击、长按、滑动和等待非画面条件
// 设计约束：所有坐标动作先做边界检查，避免配置错误导致越界盲点
// =====================================================================

var errors = require("./errors-autojs.js");
var control = require("./run-control-autojs.js");
var tapMarker = require("./tap-marker-autojs.js");

function create(options) {
  var logger = options.logger;
  var runtimeConfig = options.runtime || {};
  var defaultWaitMs = runtimeConfig.actionWaitMs || 500;
  var tapDurationMs = runtimeConfig.tapDurationMs || 120;
  // 点在哪里要看得见：脚本注入的点击不会在屏幕上留下任何痕迹，
  // 人盯着看只能看到"界面突然变了"，点偏了更是完全无从判断。
  // runtime.tapMarkerMs 设为 0 可关掉。
  var marker = tapMarker.create({
    logger: logger,
    durationMs: runtimeConfig.tapMarkerMs
  });

  function assertCoordinate(x, y, name) {
    if (x < 0 || y < 0 || x >= device.width || y >= device.height) {
      throw new Error(
        (name || "坐标") +
          "超出屏幕范围: (" +
          x +
          "," +
          y +
          ")，屏幕 " +
          device.width +
          "x" +
          device.height
      );
    }
  }

  // click() 派发的手势时长极短，H5 与自绘界面经常收不到，实测在游戏盒子上约一半点击丢失，
  // 表现为"坐标正确、日志显示已点击、界面毫无反应"。press() 可指定按压时长，明显更可靠。
  function tap(point, waitMs) {
    assertCoordinate(point.x, point.y, point.name);
    var pointName = point.name || point.x + "," + point.y;
    logger.info("点击 " + pointName + " (" + point.x + "," + point.y + ")");

    // 常驻悬浮层先让开。它们是**可触摸**的：落在它们下面的那一下会被它们吃掉，
    // 而注入的点击和真手指一样会被最上层的窗口截走
    // （2026-09-17 实机：运行控制条压住 App 的返回按钮，点击全被它接走）。
    var overlays = require("./screen-overlays-autojs.js");
    var overlaysDucked = false;
    try {
      overlaysDucked = overlays.hideForCapture();
    } catch (error) {}

    marker.show(point.x, point.y);
    var succeeded = false;
    var pressedAt;
    try {
      try {
        succeeded = press(point.x, point.y, tapDurationMs);
      } catch (error) {
        logger.warn("press 不可用，回退到 click: " + error);
      }
      if (!succeeded) {
        succeeded = click(point.x, point.y);
      }
    } finally {
      pressedAt = Date.now();
      // 十字必须在这里收掉，哪怕点击失败：截图会把悬浮层一起拍进去，
      // 留着它下一步就是在一张被划花的图上找图。
      marker.hide();
      if (overlaysDucked) {
        try {
          overlays.restoreAfterCapture();
        } catch (error) {}
      }
    }
    if (!succeeded) {
      throw new Error("点击失败: " + pointName);
    }
    // 十字停留的那段时间算进 waitMs 里。这样开着标记也不会比原来慢，
    // 只有 waitMs 比停留时间还短时才真的多等了几十毫秒。
    var wait = waitMs === undefined ? defaultWaitMs : waitMs;
    var waited = Date.now() - pressedAt;
    if (wait > waited) {
      sleep(wait - waited);
    }
  }

  // 注入的手势和真手指一样会被最上层的可触摸窗口截走，所以滑动、长按都要走
  // 与 tap 同一道护栏：悬浮层先让开、标记落在起点上、拍完收掉。
  // 收标记必须放在 finally 里——留着它下一步就是在一张被划花的图上找图。
  // 返回手势结束的时刻，供调用方把标记停留的那段算进 waitMs 里。
  function withGestureGuard(x, y, perform) {
    var overlays = require("./screen-overlays-autojs.js");
    var overlaysDucked = false;
    try {
      overlaysDucked = overlays.hideForCapture();
    } catch (error) {}
    marker.show(x, y);
    var succeeded = false;
    var finishedAt;
    try {
      succeeded = perform();
    } finally {
      finishedAt = Date.now();
      marker.hide();
      if (overlaysDucked) {
        try {
          overlays.restoreAfterCapture();
        } catch (error) {}
      }
    }
    return { succeeded: succeeded, finishedAt: finishedAt };
  }

  function settle(waitMs, finishedAt) {
    var wait = waitMs === undefined ? defaultWaitMs : waitMs;
    var waited = Date.now() - finishedAt;
    if (wait > waited) {
      sleep(wait - waited);
    }
  }

  function drag(gestureConfig, waitMs) {
    var name = gestureConfig.name || "未命名手势";
    assertCoordinate(gestureConfig.x1, gestureConfig.y1, name + "起点");
    assertCoordinate(gestureConfig.x2, gestureConfig.y2, name + "终点");
    var durationMs = gestureConfig.durationMs || runtimeConfig.swipeDurationMs || 300;
    logger.info(
      "滑动 " + name + " (" + gestureConfig.x1 + "," + gestureConfig.y1 + ") -> (" +
        gestureConfig.x2 + "," + gestureConfig.y2 + ") " + durationMs + " 毫秒"
    );
    var outcome = withGestureGuard(gestureConfig.x1, gestureConfig.y1, function () {
      return swipe(
        gestureConfig.x1,
        gestureConfig.y1,
        gestureConfig.x2,
        gestureConfig.y2,
        durationMs
      );
    });
    if (!outcome.succeeded) {
      throw new Error("滑动失败: " + name);
    }
    settle(waitMs, outcome.finishedAt);
  }

  // 长按：press 本来就收按压时长，与 tap 的区别只有这个数。
  // 单独给一个函数而不是让 tap 多一个参数：日志要说得清"这一下按了多久"，
  // 排查"长按没生效"时第一眼看的就是它。
  function longPress(point, pressMs, waitMs) {
    assertCoordinate(point.x, point.y, point.name);
    var pointName = point.name || point.x + "," + point.y;
    var heldMs = pressMs || runtimeConfig.longPressMs || 800;
    logger.info("长按 " + pointName + " (" + point.x + "," + point.y + ") " + heldMs + " 毫秒");
    var outcome = withGestureGuard(point.x, point.y, function () {
      return press(point.x, point.y, heldMs);
    });
    if (!outcome.succeeded) {
      throw new Error("长按失败: " + pointName);
    }
    settle(waitMs, outcome.finishedAt);
  }

  // 目标应用的进程在不在。返回 true / false / null（查不出来）。
  //
  // 为什么要知道这个：拉起应用后要干等 launchSettleMs（本机 25 秒）才敢申请截图权限，
  // 那段等待是为**冷启动**设的——盒子在启动那一刻会检测录屏，发现就自己退出。
  // 而进程已经在了就说明这道检测早就过了，那 25 秒纯属白等。
  //
  // 为什么用 root 跑 pidof：Android 10 的 ActivityManager 只看得见自己的进程，
  // 而 currentPackage() 在部分云机上被 ROM 屏蔽（见 safeCurrentPackage）。
  // 本机 root 可用（RECORDER.md：shell("id", true) 返回 uid=0）。
  // 拿不到确定答案就返回 null，让调用方按"不知道"保守处理，绝不缩短等待。
  function isPackageRunning(packageName) {
    if (!packageName) return null;
    try {
      // 带上 || echo 哨兵：pidof 查不到时退出码也是非 0，单看退出码分不出
      // "没在跑"和"root 不可用 / 没有 pidof 这个命令"。
      var result = shell("pidof " + packageName + " || echo __none__", true);
      if (!result || result.code !== 0) return null;
      var output = String(result.result || "").trim();
      if (!output) return null;
      if (output.indexOf("__none__") >= 0) return false;
      return /\d/.test(output);
    } catch (error) {
      return null;
    }
  }

  // 现在前台是谁。用 root 读 dumpsys，比 currentPackage() 可靠（后者在这类 ROM 上
  // 常被屏蔽）。读不出来返回 null，调用方按"不知道"处理。
  function foregroundPackage() {
    try {
      var result = shell("dumpsys window | grep mCurrentFocus | tail -1", true);
      if (!result || result.code !== 0) return null;
      var text = String(result.result || "");
      var matched = text.match(/u0\s+([A-Za-z0-9_.]+)\//);
      return matched ? matched[1] : null;
    } catch (error) {
      return null;
    }
  }

  // 部分 ROM（尤其云机）会屏蔽前台包名查询：currentPackage() 恒定返回系统包名，
  // currentActivity() 直接返回权限拒绝记录。所以这里不能假设该接口一定可用。
  function safeCurrentPackage() {
    try {
      return currentPackage();
    } catch (error) {
      return null;
    }
  }

  // 直接把应用的**首页**顶到前台，而不是恢复它上次停在哪一页。
  // launchPackage 走的是 launcher intent，Android 会把整个任务栈按原样恢复：
  // 上次停在游戏里，拉起来就还在游戏里。而从首页开始录的用例需要的是首页本身。
  //
  // 注意这句话到 2026-09-24 才真正成立：在那之前 launchPackage 用的是
  // app.launchPackage，它其实会把任务栈重置掉（见下面那一大段）。
  // 两者的区别一直写在这儿，实现却没做到——排查时因此一直没往这边怀疑。
  // 拉不起来就退回 launchPackage——首页拉不动不该让整个任务直接失败。
  function launchHome(packageName, activityName) {
    if (!packageName) {
      throw errors.broken("尚未配置游戏包名");
    }
    if (!activityName) {
      return launchPackage(packageName);
    }
    var component = packageName + "/" + activityName;
    logger.info("拉起应用首页: " + component);
    // 先用 root 跑 am start：本机 root 可用（RECORDER.md），而 am start -n 的语义
    // 就是"把这个 activity 顶到前台"，最直接。
    try {
      var result = shell("am start -n " + component, true);
      if (result && result.code === 0) {
        return "am";
      }
      logger.warn("am start 没成功（code " + (result ? result.code : "?") + "），换 startActivity");
    } catch (error) {
      logger.warn("am start 不可用: " + error);
    }
    // 退路：显式组件 + MAIN/LAUNCHER。缺 action 时部分 ROM 解析不出来，
    // 于是"日志说拉起了、画面其实没动"——2026-09-17 实机就是这样，
    // 结果第一步的点击打在了脚本自己的界面上。
    try {
      app.startActivity({
        action: "android.intent.action.MAIN",
        packageName: packageName,
        className: activityName,
        flags: ["activity_new_task"]
      });
      return "startActivity";
    } catch (error) {
      logger.warn("拉不起首页，退回普通启动: " + error);
      launchPackage(packageName);
      return "package";
    }
  }

  // 把应用切到前台，**能恢复就恢复，绝不重置它的任务栈**。
  //
  // 为什么不用 app.launchPackage：它走 getLaunchIntentForPackage，那个 intent
  // 除了 component 还多调了一次 setPackage()。而已有任务的根 intent 里没有 pkg，
  // 于是这个 intent **匹配不上已有任务**，Android 不会去恢复它，而是在栈顶
  // 新起一个入口活动；入口活动再跳首页，整个栈就塌回只剩首页。
  //
  // 2026-09-24 两个只差一个 setPackage 的探针，同样的起点（游戏在前台、sz=3）：
  //   flg=0x10000000                  cmp=.../WelcomeActivity  -> sz 保持 3，游戏原样恢复
  //   flg=0x10000000 pkg=<包名>       cmp=.../WelcomeActivity  -> sz 一度变 4，随后塌成 1
  // 两个 intent 的 flag 完全一样，都**没有** FLAG_ACTIVITY_RESET_TASK_IF_NEEDED——
  // 所以别再往 flag 上找原因了，差别就是那个 pkg。
  //
  // 对这个项目的后果是致命的：游戏是跑在宿主应用某个活动里的 H5，活动一销毁，
  // 登录态跟着没。于是"每跑一个任务就要重新登录一次"，而日志里一切正常。
  function resumeByLauncherIntent(packageName) {
    var launchIntent = context.getPackageManager().getLaunchIntentForPackage(packageName);
    if (!launchIntent) return false;
    var component = launchIntent.getComponent();
    if (!component) return false;
    var Intent = android.content.Intent;
    // 重新造一个，而不是在拿到的那个上 setPackage(null)——
    // 原来那个还可能带着别的东西，重造最干净。
    var intent = new Intent(Intent.ACTION_MAIN);
    intent.addCategory(Intent.CATEGORY_LAUNCHER);
    intent.setComponent(component);
    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    context.startActivity(intent);
    return true;
  }

  // 只启动、不等待。供"必须先启动应用再申请截图权限"的任务使用：
  // 这类应用在启动时检测录屏，此时还没有截图权限，也就无法用画面判断前台。
  function launchPackage(packageName) {
    if (!packageName) {
      throw errors.broken("尚未配置游戏包名");
    }
    logger.info("启动游戏: " + packageName);
    try {
      if (resumeByLauncherIntent(packageName)) {
        return;
      }
      logger.warn("解析不出启动入口，退回 app.launchPackage（会重置任务栈）");
    } catch (error) {
      logger.warn("按恢复方式启动失败，退回 app.launchPackage（会重置任务栈）: " + error);
    }
    if (!app.launchPackage(packageName)) {
      throw errors.broken("游戏启动失败: " + packageName);
    }
  }

  // options.confirmForeground：可选的画面判断，由任务提供（只有任务知道目标界面长什么样）。
  // 包名判断和画面判断任意一个成立即认为已进入前台，这样同一份任务在屏蔽包名查询的
  // 设备和正常设备上都能跑。
  function launchPackageAndWait(packageName, timeoutMs, options) {
    if (!packageName) {
      throw errors.broken("尚未配置游戏包名");
    }

    var launchOptions = options || {};
    var confirmForeground = launchOptions.confirmForeground;
    var packageBeforeLaunch = safeCurrentPackage();

    if (packageBeforeLaunch !== packageName) {
      // 走同一条"恢复而不是重置"的路，理由见 launchPackage 上面那段。
      launchPackage(packageName);
    }

    var deadline = Date.now() + timeoutMs;
    var packageEverChanged = false;

    while (Date.now() <= deadline) {
      // 任务提供了画面判断时，以画面为准，不看包名。
      // 任务之所以提供它，正是因为本机的包名查询不可信：实测会在应用尚未出现时
      // 就报告"已在前台"（假阳性），若让两者竞争，不可靠的那个会先返回。
      if (confirmForeground) {
        if (confirmForeground()) {
          logger.info("游戏已进入前台（画面判断）");
          return "screen";
        }
      } else {
        var currentPackageName = safeCurrentPackage();
        if (currentPackageName !== packageBeforeLaunch) {
          packageEverChanged = true;
        }
        if (currentPackageName === packageName) {
          logger.info("游戏已进入前台（包名判断）");
          return "package";
        }
      }
      control.checkpoint(logger);
      sleep(runtimeConfig.pollIntervalMs || 250);
    }

    // 区分两种失败：应用真的没起来，还是本设备根本读不到前台包名。
    // 后者如果只报"等待超时"，会让人一直去查游戏而不是去查设备能力。
    if (!packageEverChanged && !confirmForeground) {
      throw new Error(
        "等待游戏进入前台超时: " +
          packageName +
          "。currentPackage() 全程为 " +
          packageBeforeLaunch +
          "，本设备可能屏蔽了前台包名查询，需要为该任务提供 confirmForeground 画面判断"
      );
    }
    throw new Error("等待游戏进入前台超时: " + packageName);
  }

  function waitUntil(name, predicate, timeoutMs, pollIntervalMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      // 检查点放在轮询里而不是只放在节点之间：一个 tapImage 的找图超时默认 15 秒，
      // 只在节点边界检查的话，按下暂停最坏要等 15 秒才有反应。
      control.checkpoint(logger);
      if (predicate()) {
        logger.info("条件满足: " + name);
        return true;
      }
      sleep(pollIntervalMs);
    }
    throw new Error("等待条件超时: " + name);
  }

  // 任务跑完由 runtime 调用。常驻模式下一个引擎要跑很多次任务，
  // 不收的话悬浮窗会一轮攒一对。
  function dispose() {
    marker.close();
  }

  return {
    tap: tap,
    drag: drag,
    longPress: longPress,
    isPackageRunning: isPackageRunning,
    foregroundPackage: foregroundPackage,
    launchPackage: launchPackage,
    launchHome: launchHome,
    launchPackageAndWait: launchPackageAndWait,
    waitUntil: waitUntil,
    dispose: dispose
  };
}

module.exports = {
  create: create
};
