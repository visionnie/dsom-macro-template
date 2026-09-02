// =====================================================================
// 通用能力：把用例中的归一化坐标换算成当前设备像素，实现一次录制多端回放
// 设计约束：不读取 device 全局对象，分辨率一律由调用方传入，便于在 PC 上验证换算
// 安全边界：换算结果越界立即抛错，绝不静默裁剪后盲点
// =====================================================================

var schema = require("./case-schema-autojs.js");

// 判定宽高比差异是否需要人工确认的阈值：超过 5% 时 fit 策略会出现明显留边。
var ASPECT_WARNING_RATIO = 0.05;

function round(value) {
  return Math.round(value);
}

// 建立基线分辨率到当前设备的映射。
// fit：等比缩放并居中，适合会自适应留边的游戏画面，跨机型更稳。
// stretch：横纵独立拉伸，只在确认画面本身会被拉伸时使用。
function createViewport(baseline, deviceWidth, deviceHeight) {
  if (!baseline || !baseline.width || !baseline.height) {
    throw new Error("用例缺少基线分辨率，无法换算坐标");
  }
  if (!deviceWidth || !deviceHeight) {
    throw new Error("设备分辨率无效: " + deviceWidth + "x" + deviceHeight);
  }

  var strategy = baseline.scaleStrategy || schema.DEFAULTS.scaleStrategy;
  var baselineAspect = baseline.width / baseline.height;
  var deviceAspect = deviceWidth / deviceHeight;
  var viewport = {
    strategy: strategy,
    baselineWidth: baseline.width,
    baselineHeight: baseline.height,
    deviceWidth: deviceWidth,
    deviceHeight: deviceHeight,
    aspectDeltaRatio: Math.abs(baselineAspect - deviceAspect) / baselineAspect
  };

  if (strategy === "stretch") {
    viewport.scaleX = deviceWidth / baseline.width;
    viewport.scaleY = deviceHeight / baseline.height;
    viewport.contentWidth = deviceWidth;
    viewport.contentHeight = deviceHeight;
    viewport.offsetX = 0;
    viewport.offsetY = 0;
    return viewport;
  }

  var scale = Math.min(deviceWidth / baseline.width, deviceHeight / baseline.height);
  viewport.scaleX = scale;
  viewport.scaleY = scale;
  viewport.contentWidth = round(baseline.width * scale);
  viewport.contentHeight = round(baseline.height * scale);
  viewport.offsetX = round((deviceWidth - viewport.contentWidth) / 2);
  viewport.offsetY = round((deviceHeight - viewport.contentHeight) / 2);
  return viewport;
}

// 宽高比差得太多时，任何换算策略都不可信，应由调用方记录告警或直接判定 broken。
function needsAspectReview(viewport) {
  return viewport.aspectDeltaRatio > ASPECT_WARNING_RATIO;
}

// 比例是右开区间，rx / ry 取 1 时正好落在内容区最后一个像素之外一格。
// 这一格是离散化的正常结果，允许收回；超出更多说明用例本身越界，留给 assertInsideDevice 报错。
function toPixelIndex(rawValue, minValue, spanLength) {
  var maxIndex = minValue + spanLength - 1;
  var pixel = round(rawValue);
  if (pixel > maxIndex && rawValue <= minValue + spanLength + 0.5) {
    return maxIndex;
  }
  return pixel;
}

function assertInsideDevice(x, y, viewport, name) {
  if (x < 0 || y < 0 || x >= viewport.deviceWidth || y >= viewport.deviceHeight) {
    throw new Error(
      (name || "坐标") +
        "换算后越界: (" +
        x +
        "," +
        y +
        ")，设备 " +
        viewport.deviceWidth +
        "x" +
        viewport.deviceHeight +
        "，基线 " +
        viewport.baselineWidth +
        "x" +
        viewport.baselineHeight
    );
  }
}

// 归一化点 -> 设备像素点，返回结构与 actions.tap 期望的入参一致。
function resolvePoint(point, viewport) {
  var x = toPixelIndex(
    viewport.offsetX + point.rx * viewport.contentWidth,
    viewport.offsetX,
    viewport.contentWidth
  );
  var y = toPixelIndex(
    viewport.offsetY + point.ry * viewport.contentHeight,
    viewport.offsetY,
    viewport.contentHeight
  );
  assertInsideDevice(x, y, viewport, point.name);
  return { x: x, y: y, name: point.name };
}

// 在已识别到的锚点像素位置上叠加归一化偏移，偏移量相对内容区尺寸。
function applyOffset(pixelPoint, offset, viewport, name) {
  if (!offset) {
    return { x: pixelPoint.x, y: pixelPoint.y, name: name || pixelPoint.name };
  }
  var x = toPixelIndex(
    pixelPoint.x + offset.rx * viewport.contentWidth,
    viewport.offsetX,
    viewport.contentWidth
  );
  var y = toPixelIndex(
    pixelPoint.y + offset.ry * viewport.contentHeight,
    viewport.offsetY,
    viewport.contentHeight
  );
  assertInsideDevice(x, y, viewport, name || pixelPoint.name);
  return { x: x, y: y, name: name || pixelPoint.name };
}

// 归一化矩形 -> 设备像素矩形，用于限定找图和 OCR 的搜索范围。
function resolveRegion(region, viewport) {
  var left = round(viewport.offsetX + region.rx * viewport.contentWidth);
  var top = round(viewport.offsetY + region.ry * viewport.contentHeight);
  var width = round(region.rw * viewport.contentWidth);
  var height = round(region.rh * viewport.contentHeight);

  if (width <= 0 || height <= 0) {
    throw new Error("区域换算后宽高为 0，请检查用例中的 rw / rh");
  }
  assertInsideDevice(left, top, viewport, "区域左上角");
  assertInsideDevice(left + width - 1, top + height - 1, viewport, "区域右下角");
  return { left: left, top: top, width: width, height: height };
}

// AutoJs6 的 images.findImage 接受 [x, y, width, height] 形式的区域参数。
function toFindImageRegion(region, viewport) {
  var rect = resolveRegion(region, viewport);
  return [rect.left, rect.top, rect.width, rect.height];
}

// 设备像素点 -> 归一化点，供录制器把抓到的真实坐标写回用例。
function toRatioPoint(x, y, viewport, name) {
  return {
    rx: (x - viewport.offsetX) / viewport.contentWidth,
    ry: (y - viewport.offsetY) / viewport.contentHeight,
    name: name
  };
}

function describe(viewport) {
  return (
    "基线 " +
    viewport.baselineWidth +
    "x" +
    viewport.baselineHeight +
    " -> 设备 " +
    viewport.deviceWidth +
    "x" +
    viewport.deviceHeight +
    "，策略 " +
    viewport.strategy +
    "，内容区 " +
    viewport.contentWidth +
    "x" +
    viewport.contentHeight +
    " 偏移 (" +
    viewport.offsetX +
    "," +
    viewport.offsetY +
    ")，宽高比差异 " +
    (viewport.aspectDeltaRatio * 100).toFixed(1) +
    "%"
  );
}

module.exports = {
  ASPECT_WARNING_RATIO: ASPECT_WARNING_RATIO,
  createViewport: createViewport,
  needsAspectReview: needsAspectReview,
  resolvePoint: resolvePoint,
  applyOffset: applyOffset,
  resolveRegion: resolveRegion,
  toFindImageRegion: toFindImageRegion,
  toRatioPoint: toRatioPoint,
  describe: describe
};
