// =====================================================================
// 通用能力：申请截图权限、保存阶段截图、等待画面条件和模板匹配
// 设计约束：本模块负责图片生命周期，调用方不持有未回收的 Image 对象
// =====================================================================

var errors = require("./errors-autojs.js");
// 截图授权提到了会话级：screen 模块是每跑一个任务新建一次的，
// 授权状态不能跟着它走，否则每个任务都要人重新点一次（见 capture-session 文件头）。
var captureSession = require("./capture-session-autojs.js");
var control = require("./run-control-autojs.js");

function sanitizeName(name) {
  return String(name || "screen").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function create(options) {
  var logger = options.logger;
  var outputDir = options.outputDir;
  var captureConfig = options.capture || {};
  // 记的是"在哪个屏幕尺寸下验过"，不是"验过没有"。
  // 一条用例可以横跨屏幕方向（盒子竖屏点进游戏 -> 游戏横屏），只验一次的话，
  // 转屏之后画布还是授权那一刻的旧方向，而检查已经被标记做过了——
  // 于是找图在一张对不上的画布里进行，静默点偏，正是这个断言本来要拦的事。
  var captureSpaceCheckedFor = null;

  function requestPermission() {
    captureSession.request(logger, captureConfig);
  }

  // 截图空间必须与点击坐标空间一致，否则找图得到的坐标直接拿去点击会系统性偏移，
  // 而且偏移是静默的：任务照常执行，只是每一步都点在错误的位置。首次截图时校验一次。
  function assertCaptureSpace(image) {
    var screenSize = device.width + "x" + device.height;
    if (captureSpaceCheckedFor === screenSize) {
      return;
    }

    var imageWidth = image.getWidth();
    var imageHeight = image.getHeight();
    if (imageWidth !== device.width || imageHeight !== device.height) {
      // 授权是会话级复用的，画布在授权那一刻按当时的屏幕方向建立。
      // 如果之后屏幕转了向（例如授权时竖屏、游戏起来后转横屏），画布就对不上了。
      // 继续用只会每一步都点偏，而且是静默的——所以把会话作废，宁可下次多弹一次窗。
      captureSession.invalidate(
        "截图画布 " + imageWidth + "x" + imageHeight +
          " 与当前屏幕 " + device.width + "x" + device.height + " 不一致",
        logger
      );
      throw errors.broken(
        "截图尺寸与点击坐标空间不一致: 截图 " +
          imageWidth +
          "x" +
          imageHeight +
          "，屏幕 " +
          device.width +
          "x" +
          device.height +
          "。多为授权后屏幕转向所致，已作废截图会话，下次运行会重新申请"
      );
    }
    captureSpaceCheckedFor = screenSize;
    logger.info("截图坐标空间一致: " + imageWidth + "x" + imageHeight);
  }

  function ensurePermission() {
    if (!captureSession.isGranted()) {
      throw errors.broken("尚未申请截图权限");
    }
  }

  function withCapture(callback) {
    ensurePermission();
    // 常驻的悬浮层（运行控制条）先让开：截图会把它们一起拍进去，
    // 压住找图锚点时找图会稳定超时，而日志里只有一句"等待条件超时"。
    var overlays = require("./screen-overlays-autojs.js");
    var hidden = false;
    var image;
    try {
      hidden = overlays.hideForCapture();
      image = captureScreen();
    } finally {
      if (hidden) overlays.restoreAfterCapture();
    }
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

  // 保存到调用方指定的路径。录制器需要按步号命名并落在会话目录里，
  // saveStage 的"当前任务目录 + 时间戳"命名对它不适用。
  function saveTo(path) {
    return withCapture(function (image) {
      files.ensureDir(path.substring(0, path.lastIndexOf("/") + 1));
      images.save(image, path, "png", 100);
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
      control.checkpoint(logger);
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

  // level 是图像金字塔层数：0 表示完全不降采样、按原分辨率匹配，最慢但最可靠。
  // 默认走金字塔加速，小模板在粗层被剪枝后会直接丢失，表现为任何阈值都匹配不到。
  //
  // 2026-09-17 在主城画面上实测（同一张固化截图，findImage）：
  //
  //     自裁块 120x36    level 0 命中 / level 1 未命中 / 默认未命中
  //     按钮锚点 58x40   level 0 命中 / level 1 命中   / 默认命中
  //
  // 也就是说 level 1 **不是**总会失效，但 level 0 在实测里从没比它差过。
  // 漏匹配是静默的（任务照跑，只是永远找不到），排查成本远高于多花的那点匹配时间，
  // 而本项目的锚点都是人手框的小图块（实测 58x40 到 210x65），不降采样的耗时可以忽略。
  // 所以默认一律 level: 0；调用方显式传了 level 就尊重调用方。
  //
  // 注意：这条只解决「同一张图能不能被找到」。锚点本身过期（界面改版、背景变了）
  // 是另一回事，任何 level 都救不回来，只能重新人工框选。
  function withMatchDefaults(template, findOptions) {
    var options = findOptions || {};
    if (options.level === undefined) {
      options.level = 0;
    }
    return options;
  }

  function findTemplate(templatePath, findOptions) {
    ensurePermission();
    var template = images.read(templatePath);
    if (!template) {
      // 素材缺失属于环境问题：多半是没推 assets/ 或打包漏了，不是用例写错。
      throw errors.broken("模板图片读取失败: " + templatePath);
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

  // 认一遍当前屏幕有哪些文字。给「点击文字」用，也给界面上的「认一下」用——
  // 两处必须走同一条路：人在面板上看到的词，就是回放时拿去匹配的词。
  // 走 withCapture 是必须的：悬浮层要先让开，否则把自己的界面也认进去了
  // （找图踩过同样的坑，表现是稳定失败且看不出根因）。
  function detectTexts(detectOptions) {
    ensurePermission();
    var ocrApi = require("./ocr-autojs.js").create({ logger: logger });
    return withCapture(function (screenImage) {
      return ocrApi.detect(screenImage, detectOptions);
    });
  }

  // 找这段文字在哪儿。找不到返回 null，由调用方决定是重试还是判失败。
  function findText(wanted, findOptions) {
    ensurePermission();
    var ocrApi = require("./ocr-autojs.js").create({ logger: logger });
    return withCapture(function (screenImage) {
      return ocrApi.find(screenImage, wanted, findOptions);
    });
  }

  return {
    requestPermission: requestPermission,
    hasPermission: function () {
      return captureSession.isGranted();
    },
    withCapture: withCapture,
    saveStage: saveStage,
    saveTo: saveTo,
    getRgb: getRgb,
    waitFor: waitFor,
    findTemplate: findTemplate,
    detectTexts: detectTexts,
    findText: findText
  };
}

module.exports = {
  create: create
};
