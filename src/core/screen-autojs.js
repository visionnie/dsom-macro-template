// =====================================================================
// 通用能力：申请截图权限、保存阶段截图、等待画面条件和模板匹配
// 设计约束：本模块负责图片生命周期，调用方不持有未回收的 Image 对象
// =====================================================================

function sanitizeName(name) {
  return String(name || "screen").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function create(options) {
  var logger = options.logger;
  var outputDir = options.outputDir;
  var captureConfig = options.capture || {};
  var permissionGranted = false;

  function requestPermission() {
    if (permissionGranted) {
      return;
    }

    logger.info("申请 MediaProjection 截图权限");
    if (!requestScreenCapture(!!captureConfig.landscape)) {
      throw new Error("截图权限未授予");
    }
    permissionGranted = true;
  }

  function ensurePermission() {
    if (!permissionGranted) {
      throw new Error("尚未申请截图权限");
    }
  }

  function withCapture(callback) {
    ensurePermission();
    var image = captureScreen();
    try {
      return callback(image);
    } finally {
      if (image) {
        image.recycle();
      }
    }
  }

  function saveStage(name) {
    return withCapture(function (image) {
      var path =
        outputDir + "/" + Date.now() + "-" + sanitizeName(name) + ".png";
      images.save(image, path, "png", 100);
      logger.info("阶段截图: " + path);
      return path;
    });
  }

  function getRgb(image, x, y) {
    var pixel = images.pixel(image, x, y);
    return {
      red: colors.red(pixel),
      green: colors.green(pixel),
      blue: colors.blue(pixel)
    };
  }

  function waitFor(name, predicate, timeoutMs, pollIntervalMs) {
    var deadline = Date.now() + timeoutMs;
    var lastDetail = "";

    while (Date.now() <= deadline) {
      var matched = withCapture(function (image) {
        var result = predicate(image);
        if (result && typeof result === "object") {
          lastDetail = result.detail || "";
          return !!result.matched;
        }
        return !!result;
      });

      if (matched) {
        logger.info("画面条件满足: " + name);
        return true;
      }
      sleep(pollIntervalMs);
    }

    throw new Error(
      "等待画面条件超时: " + name + (lastDetail ? "，最后状态: " + lastDetail : "")
    );
  }

  function findTemplate(templatePath, findOptions) {
    ensurePermission();
    var template = images.read(templatePath);
    if (!template) {
      throw new Error("模板图片读取失败: " + templatePath);
    }

    try {
      return withCapture(function (screenImage) {
        var point = images.findImage(screenImage, template, findOptions || {});
        return point ? { x: point.x, y: point.y } : null;
      });
    } finally {
      template.recycle();
    }
  }

  return {
    requestPermission: requestPermission,
    hasPermission: function () {
      return permissionGranted;
    },
    withCapture: withCapture,
    saveStage: saveStage,
    getRgb: getRgb,
    waitFor: waitFor,
    findTemplate: findTemplate
  };
}

module.exports = {
  create: create
};
