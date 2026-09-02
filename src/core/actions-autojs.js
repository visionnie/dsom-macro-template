// =====================================================================
// 通用能力：启动应用、点击、滑动和等待非画面条件
// 设计约束：所有坐标动作先做边界检查，避免配置错误导致越界盲点
// =====================================================================

function create(options) {
  var logger = options.logger;
  var runtimeConfig = options.runtime || {};
  var defaultWaitMs = runtimeConfig.actionWaitMs || 500;
  var tapDurationMs = runtimeConfig.tapDurationMs || 120;

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

    var succeeded = false;
    try {
      succeeded = press(point.x, point.y, tapDurationMs);
    } catch (error) {
      logger.warn("press 不可用，回退到 click: " + error);
    }
    if (!succeeded) {
      succeeded = click(point.x, point.y);
    }
    if (!succeeded) {
      throw new Error("点击失败: " + pointName);
    }
    sleep(waitMs === undefined ? defaultWaitMs : waitMs);
  }

  function drag(gestureConfig, waitMs) {
    assertCoordinate(gestureConfig.x1, gestureConfig.y1, gestureConfig.name + "起点");
    assertCoordinate(gestureConfig.x2, gestureConfig.y2, gestureConfig.name + "终点");
    logger.info("滑动 " + (gestureConfig.name || "未命名手势"));
    if (
      !swipe(
        gestureConfig.x1,
        gestureConfig.y1,
        gestureConfig.x2,
        gestureConfig.y2,
        gestureConfig.durationMs
      )
    ) {
      throw new Error("滑动失败: " + (gestureConfig.name || "未命名手势"));
    }
    sleep(waitMs === undefined ? defaultWaitMs : waitMs);
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

  // 只启动、不等待。供"必须先启动应用再申请截图权限"的任务使用：
  // 这类应用在启动时检测录屏，此时还没有截图权限，也就无法用画面判断前台。
  function launchPackage(packageName) {
    if (!packageName) {
      throw new Error("尚未配置游戏包名");
    }
    logger.info("启动游戏: " + packageName);
    if (!app.launchPackage(packageName)) {
      throw new Error("游戏启动失败: " + packageName);
    }
  }

  // options.confirmForeground：可选的画面判断，由任务提供（只有任务知道目标界面长什么样）。
  // 包名判断和画面判断任意一个成立即认为已进入前台，这样同一份任务在屏蔽包名查询的
  // 设备和正常设备上都能跑。
  function launchPackageAndWait(packageName, timeoutMs, options) {
    if (!packageName) {
      throw new Error("尚未配置游戏包名");
    }

    var launchOptions = options || {};
    var confirmForeground = launchOptions.confirmForeground;
    var packageBeforeLaunch = safeCurrentPackage();

    if (packageBeforeLaunch !== packageName) {
      logger.info("启动游戏: " + packageName);
      if (!app.launchPackage(packageName)) {
        throw new Error("游戏启动失败: " + packageName);
      }
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
      if (predicate()) {
        logger.info("条件满足: " + name);
        return true;
      }
      sleep(pollIntervalMs);
    }
    throw new Error("等待条件超时: " + name);
  }

  return {
    tap: tap,
    drag: drag,
    launchPackage: launchPackage,
    launchPackageAndWait: launchPackageAndWait,
    waitUntil: waitUntil
  };
}

module.exports = {
  create: create
};
