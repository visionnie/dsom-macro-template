// =====================================================================
// 通用能力：启动应用、点击、滑动和等待非画面条件
// 设计约束：所有坐标动作先做边界检查，避免配置错误导致越界盲点
// =====================================================================

function create(options) {
  var logger = options.logger;
  var runtimeConfig = options.runtime || {};
  var defaultWaitMs = runtimeConfig.actionWaitMs || 500;

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

  function tap(point, waitMs) {
    assertCoordinate(point.x, point.y, point.name);
    logger.info(
      "点击 " + (point.name || "未命名坐标") + " (" + point.x + "," + point.y + ")"
    );
    if (!click(point.x, point.y)) {
      throw new Error("点击失败: " + (point.name || point.x + "," + point.y));
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

  function launchPackageAndWait(packageName, timeoutMs) {
    if (!packageName) {
      throw new Error("尚未配置游戏包名");
    }

    if (currentPackage() !== packageName) {
      logger.info("启动游戏: " + packageName);
      if (!app.launchPackage(packageName)) {
        throw new Error("游戏启动失败: " + packageName);
      }
    }

    var deadline = Date.now() + timeoutMs;
    while (currentPackage() !== packageName && Date.now() <= deadline) {
      sleep(runtimeConfig.pollIntervalMs || 250);
    }
    if (currentPackage() !== packageName) {
      throw new Error("等待游戏进入前台超时: " + packageName);
    }
    logger.info("游戏已进入前台");
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
    launchPackageAndWait: launchPackageAndWait,
    waitUntil: waitUntil
  };
}

module.exports = {
  create: create
};
