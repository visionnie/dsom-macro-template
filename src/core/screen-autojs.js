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
  var captureSpaceChecked = false;

  function requestPermission() {
    if (permissionGranted) {
      return;
    }

    logger.info("申请 MediaProjection 截图权限");

    var granted;
    if (captureConfig.width && captureConfig.height) {
      granted = requestScreenCapture(captureConfig.width, captureConfig.height);
    } else if (typeof captureConfig.landscape === "boolean") {
      // 兼容旧配置，默认不要用。在强制横屏的设备上传 true 会拿到竖屏画布，
      // 横屏画面被等比缩小成上下加黑边的窄带（已在 720x1280 横屏云机上复现）。
      granted = requestScreenCapture(captureConfig.landscape);
    } else {
      // 默认不传参，由 AutoJs6 按当前屏幕方向建立画布，截图尺寸与点击坐标空间一致。
      granted = requestScreenCapture();
    }

    if (!granted) {
      throw new Error("截图权限未授予");
    }
    permissionGranted = true;
  }

  // 截图空间必须与点击坐标空间一致，否则找图得到的坐标直接拿去点击会系统性偏移，
  // 而且偏移是静默的：任务照常执行，只是每一步都点在错误的位置。首次截图时校验一次。
  function assertCaptureSpace(image) {
    if (captureSpaceChecked) {
      return;
    }
    captureSpaceChecked = true;

    var imageWidth = image.getWidth();
    var imageHeight = image.getHeight();
    if (imageWidth !== device.width || imageHeight !== device.height) {
      throw new Error(
        "截图尺寸与点击坐标空间不一致: 截图 " +
          imageWidth +
          "x" +
          imageHeight +
          "，屏幕 " +
          device.width +
          "x" +
          device.height +
          "。请检查 config 的 capture 配置，默认应留空由 AutoJs6 自行决定"
      );
    }
    logger.info("截图坐标空间一致: " + imageWidth + "x" + imageHeight);
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
      assertCaptureSpace(image);
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

  // AutoJs6 默认用图像金字塔加速匹配，但小模板在粗层被 weakThreshold 剪枝后会直接丢失，
  // 表现为任何阈值都匹配不到——连从截图自身裁下来的图块都找不回来（实测 70x70 必现，
  // 300x100 正常）。level 为 1 表示不做金字塔，慢一些但结果可靠。
  var PYRAMID_SAFE_MIN_EDGE = 120;

  function withMatchDefaults(template, findOptions) {
    var options = findOptions || {};
    if (options.level === undefined) {
      var minEdge = Math.min(template.getWidth(), template.getHeight());
      if (minEdge < PYRAMID_SAFE_MIN_EDGE) {
        options.level = 1;
      }
    }
    return options;
  }

  function findTemplate(templatePath, findOptions) {
    ensurePermission();
    var template = images.read(templatePath);
    if (!template) {
      throw new Error("模板图片读取失败: " + templatePath);
    }

    try {
      var matchOptions = withMatchDefaults(template, findOptions);
      return withCapture(function (screenImage) {
        var point = images.findImage(screenImage, template, matchOptions);
        if (!point) {
          return null;
        }
        var templateWidth = template.getWidth();
        var templateHeight = template.getHeight();
        // findImage 返回的是匹配区域左上角。点击必须用中心点：
        // 按左上角点会落在按钮边缘，相邻控件靠得近时可能点中隔壁。
        return {
          x: point.x,
          y: point.y,
          width: templateWidth,
          height: templateHeight,
          centerX: point.x + Math.floor(templateWidth / 2),
          centerY: point.y + Math.floor(templateHeight / 2)
        };
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
