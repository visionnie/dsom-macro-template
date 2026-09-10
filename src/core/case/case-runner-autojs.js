// =====================================================================
// 通用能力：读取 JSON 用例、验证、按节点图执行
// 设计约束：
//   - 用例数据是明文 JSON。用户是数据所有者：可读、可改、可 diff、可 git 管理
//   - MVP 只支持三种节点类型：noop / tap / tapImage
//   - 节点跳转：@next 顺序、@end 结束成功、@abort 结束失败、或跳到具体节点 id
//   - 循环有明确访问上限：全局 maxNodeVisits 兜底，单节点可配 maxVisits + onExhausted
//   - 屏幕方向必须与 baseline 方向一致（有上限地等待），方向本身不做换算
//   - 分辨率通过 case-geometry 的 viewport 换算，baseline 与设备同尺寸时为恒等映射
// =====================================================================

var errors = require("../errors-autojs.js");
var geometry = require("./case-geometry-autojs.js");

var SCHEMA_VERSION = 1;
var DEFAULT_MAX_NODE_VISITS = 500;
var DEFAULT_TAP_IMAGE_WAIT_MS = 15000;
var DEFAULT_TAP_IMAGE_POLL_MS = 1500;
var DEFAULT_TAP_IMAGE_THRESHOLD = 0.85;
var DEFAULT_TAP_IMAGE_PRE_TAP_MS = 400;
var DEFAULT_ORIENTATION_WAIT_MS = 20000;
var DEFAULT_ORIENTATION_POLL_MS = 1000;

var VALID_TYPES = { noop: true, tap: true, tapImage: true };
var TERMINAL_TARGETS = { "@next": true, "@end": true, "@abort": true };

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function isNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function isRatio(value) {
  return isNumber(value) && value >= 0 && value <= 1;
}

// Windows 上用 PowerShell 或部分编辑器保存 JSON 会写入 UTF-8 BOM，
// JSON.parse 遇到它直接抛「Unexpected token」，而肉眼看文件完全正常。
// 用例是给人手写的数据文件，这个坑必须由加载方容错。
function stripBom(text) {
  if (text && text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

function loadCase(casePath) {
  if (!files.exists(casePath)) {
    // 部署问题（没推 cases/ 或打包漏了），不是用例本身写错，算 broken。
    throw errors.broken("用例文件不存在: " + casePath);
  }
  var raw = stripBom(files.read(casePath));
  var data;
  try {
    data = JSON.parse(raw);
  } catch (parseError) {
    throw new Error("用例 JSON 解析失败: " + parseError + "，路径: " + casePath);
  }
  validateCase(data);
  return data;
}

function validateCase(data) {
  if (!data || typeof data !== "object") {
    throw new Error("用例根必须是对象");
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      "用例 schemaVersion 不匹配，期望 " + SCHEMA_VERSION + "，实际 " + data.schemaVersion
    );
  }
  if (!data.id) throw new Error("用例缺少 id");
  if (!data.name) throw new Error("用例缺少 name");
  if (!isArray(data.nodes) || data.nodes.length === 0) {
    throw new Error("用例 nodes 必须是非空数组");
  }
  if (data.baseline) {
    if (!isNumber(data.baseline.width) || !isNumber(data.baseline.height)) {
      throw new Error("baseline 必须包含 width 与 height");
    }
  }
  // 前置依赖：本用例假定哪些任务已经跑过（例如 BOSS 用例假定游戏已在主城）。
  // case-runner 自己不执行它们——单跑一条用例时依赖由人负责；
  // 常驻调度器会读这个字段，按序补齐前置。
  if (data.requires != null) {
    if (!isArray(data.requires)) {
      throw new Error("requires 必须是数组");
    }
    for (var r = 0; r < data.requires.length; r++) {
      if (typeof data.requires[r] !== "string" || !data.requires[r]) {
        throw new Error("requires[" + r + "] 必须是非空字符串");
      }
    }
  }

  var seenIds = {};
  for (var index = 0; index < data.nodes.length; index++) {
    var node = data.nodes[index];
    if (!node || typeof node !== "object") {
      throw new Error("节点 [" + index + "] 不是对象");
    }
    if (!node.id) throw new Error("节点 [" + index + "] 缺少 id");
    if (seenIds[node.id]) throw new Error("节点 id 重复: " + node.id);
    seenIds[node.id] = true;
    if (!VALID_TYPES[node.type]) {
      throw new Error("节点 [" + node.id + "] 类型非法: " + node.type);
    }
    validateNodeParams(node);
    validateJumpTarget(node.onSuccess, node.id, "onSuccess", seenIds, data.nodes);
    validateJumpTarget(node.onFail, node.id, "onFail", seenIds, data.nodes);
    validateJumpTarget(node.onExhausted, node.id, "onExhausted", seenIds, data.nodes);

    // 有界循环：节点自己声明最多被访问几次，超出就走 onExhausted。
    // 强制要求成对出现——只给上限不给出口，等于把死循环换成了硬报错，
    // 而循环的意义正是"试够了就往下走"。
    if (node.maxVisits != null) {
      if (!isNumber(node.maxVisits) || node.maxVisits < 1) {
        throw new Error(
          "节点 [" + node.id + "] 的 maxVisits 必须是不小于 1 的数字"
        );
      }
      if (!node.onExhausted) {
        throw new Error(
          "节点 [" + node.id + "] 配了 maxVisits 就必须配 onExhausted，循环要有明确出口"
        );
      }
    }
  }
  if (data.entry && !seenIds[data.entry]) {
    throw new Error("entry 指向不存在的节点: " + data.entry);
  }
}

function validateNodeParams(node) {
  if (node.type === "tap") {
    if (!isRatio(node.rx) || !isRatio(node.ry)) {
      throw new Error("tap 节点 [" + node.id + "] 缺少或非法 rx/ry（0 到 1）");
    }
    return;
  }
  if (node.type === "tapImage") {
    if (!node.asset || typeof node.asset !== "string") {
      throw new Error("tapImage 节点 [" + node.id + "] 缺少 asset");
    }
    if (node.threshold != null && !isRatio(node.threshold)) {
      throw new Error("tapImage 节点 [" + node.id + "] 的 threshold 非法");
    }
    if (node.region) {
      var r = node.region;
      if (!isRatio(r.rx) || !isRatio(r.ry) || !isRatio(r.rw) || !isRatio(r.rh)) {
        throw new Error("tapImage 节点 [" + node.id + "] 的 region 非法");
      }
      if (r.rx + r.rw > 1 || r.ry + r.rh > 1) {
        throw new Error("tapImage 节点 [" + node.id + "] 的 region 越界");
      }
    }
  }
}

// 跳转目标校验用两遍循环：第一遍收集 id，第二遍再验证节点跳转（因为可能跳到后面的节点）。
// 简化做法：只在真正跳转时报错（跳到不存在的目标）。这里的校验放宽：只要不是保留字，就允许任意字符串。
function validateJumpTarget(target, nodeId, field, seenIds, allNodes) {
  if (target == null) return;
  if (typeof target !== "string") {
    throw new Error("节点 [" + nodeId + "] 的 " + field + " 必须是字符串");
  }
  if (TERMINAL_TARGETS[target]) return;
  // 不在这里强制 target 已在 seenIds 中：允许向前跳到还没扫到的节点。
  // 真正的存在性检查在执行时兜底。
}

function runCase(context, caseData) {
  var nodes = caseData.nodes;
  var idToIndex = {};
  for (var i = 0; i < nodes.length; i++) idToIndex[nodes[i].id] = i;

  // baseline 方向必须与设备方向一致：都竖屏或都横屏，MVP 不做换算。
  // 不一致会让归一化坐标 * device.width 得到荒唐位置，所以必须拦住。
  //
  // 但这里不能一锤子判断：屏幕方向跟随前台应用而变，而游戏被拉起后要过若干秒
  // 才真正转成横屏。实测拿到截图授权、把游戏拉回前台后仅 6 秒就跑用例，
  // 此时设备仍报竖屏，用例直接失败——失败的是时序，不是用例本身。
  // 因此改为有上限的轮询等待，超时才抛错。
  if (caseData.baseline) {
    waitForOrientation(context, caseData);
  }

  // 分辨率换算。baseline 与设备同尺寸时 scale=1、offset=0，是恒等映射，
  // 因此在录制设备上跑的结果与换算前完全一致；换到别的分辨率才真正生效。
  var viewport = createCaseViewport(context, caseData);

  var currentIndex = 0;
  if (caseData.entry) {
    if (!(caseData.entry in idToIndex)) {
      throw new Error("entry 节点不存在: " + caseData.entry);
    }
    currentIndex = idToIndex[caseData.entry];
  }

  var maxVisits = caseData.maxNodeVisits || DEFAULT_MAX_NODE_VISITS;
  var visits = 0;
  var nodeVisits = {};
  var results = [];

  while (true) {
    if (++visits > maxVisits) {
      throw new Error(
        "节点访问次数超过上限 " + maxVisits + "，可能存在死循环。已完成 " + results.length + " 步"
      );
    }

    var node = nodes[currentIndex];

    // 单节点的有界循环：访问次数用尽就走 onExhausted，不执行本次动作。
    // 计数放在执行之前，这样 maxVisits: 3 的语义是"最多执行 3 次"。
    nodeVisits[node.id] = (nodeVisits[node.id] || 0) + 1;
    if (node.maxVisits != null && nodeVisits[node.id] > node.maxVisits) {
      context.logger.info(
        "节点 [" + node.id + "] 已达访问上限 " + node.maxVisits + "，转向 " + node.onExhausted
      );
      results.push({
        id: node.id,
        name: node.name,
        type: node.type,
        status: "exhausted",
        visits: node.maxVisits
      });
      var exhaustedTarget = node.onExhausted;
      if (exhaustedTarget === "@end") return results;
      if (exhaustedTarget === "@abort") {
        throw new Error(
          "节点 [" + node.id + "] 达到访问上限 " + node.maxVisits + "，按 onExhausted 判定失败"
        );
      }
      if (exhaustedTarget === "@next") {
        currentIndex++;
        if (currentIndex >= nodes.length) return results;
        continue;
      }
      if (!(exhaustedTarget in idToIndex)) {
        throw new Error(
          "节点 [" + node.id + "] 的 onExhausted 目标不存在: " + exhaustedTarget
        );
      }
      currentIndex = idToIndex[exhaustedTarget];
      continue;
    }

    context.logger.info(
      "节点 [" + node.id + "] " + node.name + " (" + node.type + ")"
    );

    var startedAt = Date.now();
    var target;
    var stepResult = {
      id: node.id,
      name: node.name,
      type: node.type
    };
    try {
      executeNode(context, node, viewport);
      stepResult.status = "passed";
      stepResult.durationMs = Date.now() - startedAt;
      results.push(stepResult);
      target = node.onSuccess || "@next";
    } catch (error) {
      var detail = error && error.message ? String(error.message) : String(error);
      stepResult.status = "failed";
      stepResult.durationMs = Date.now() - startedAt;
      stepResult.error = detail;
      results.push(stepResult);
      context.logger.warn("节点失败 [" + node.id + "]: " + detail);
      target = node.onFail || "@abort";
      if (target === "@abort") {
        // 直接抛给上层 runtime：会走它的失败截图、result.json 保留原始错误的完整流程
        throw error;
      }
    }

    if (target === "@end") return results;
    if (target === "@next") {
      currentIndex++;
      if (currentIndex >= nodes.length) return results;
      continue;
    }
    if (!(target in idToIndex)) {
      throw new Error(
        "节点 [" + node.id + "] 的跳转目标不存在: " + target
      );
    }
    currentIndex = idToIndex[target];
  }
}

// device.width / device.height 是实时的：它们随前台应用的屏幕方向变化。
// 依据是 screen-autojs.js 的硬断言——截图尺寸与 device 尺寸不一致就抛错，
// 而横屏游戏里的用例能连续跑通，说明两者是一起变的。所以轮询它们有效。
function waitForOrientation(context, caseData) {
  var baseline = caseData.baseline;
  var baselineIsLandscape = baseline.width > baseline.height;
  var waitMs =
    caseData.orientationWaitMs != null
      ? caseData.orientationWaitMs
      : DEFAULT_ORIENTATION_WAIT_MS;
  var pollMs =
    caseData.orientationPollMs != null
      ? caseData.orientationPollMs
      : DEFAULT_ORIENTATION_POLL_MS;

  var describe = function () {
    return device.width + "x" + device.height;
  };
  var matched = function () {
    return (device.width > device.height) === baselineIsLandscape;
  };

  if (matched()) return;

  context.logger.info(
    "等待屏幕转到 baseline 方向（" +
      (baselineIsLandscape ? "横屏" : "竖屏") +
      "），当前 " +
      describe() +
      "，上限 " +
      waitMs +
      " 毫秒"
  );

  var deadline = Date.now() + waitMs;
  while (!matched()) {
    if (Date.now() >= deadline) {
      // 方向不对是环境/时序问题（游戏没起来或没转屏），不是用例写错，算 broken。
      throw errors.broken(
        "等待 " +
          waitMs +
          " 毫秒后屏幕方向仍与 baseline 不一致：baseline " +
          baseline.width +
          "x" +
          baseline.height +
          "，设备 " +
          describe() +
          "。MVP 不做方向换算，请确认目标应用已进入并完成旋转"
      );
    }
    sleep(pollMs);
  }
  context.logger.info("屏幕方向已匹配 baseline: " + describe());
}

// baseline 缺省时用设备自身当基线，得到恒等映射——没写 baseline 的用例行为不变。
function createCaseViewport(context, caseData) {
  var baseline = caseData.baseline
    ? { width: caseData.baseline.width, height: caseData.baseline.height,
        scaleStrategy: caseData.baseline.scaleStrategy }
    : { width: device.width, height: device.height };

  var viewport = geometry.createViewport(baseline, device.width, device.height);
  if (viewport.scaleX !== 1 || viewport.scaleY !== 1 ||
      viewport.offsetX !== 0 || viewport.offsetY !== 0) {
    context.logger.info("用例坐标换算: " + geometry.describe(viewport));
  }
  if (geometry.needsAspectReview(viewport)) {
    // 宽高比差太多时任何策略都不完全可信，明确告警而不是静默换算。
    context.logger.warn(
      "基线与设备宽高比差异超过 " + (geometry.ASPECT_WARNING_RATIO * 100) +
        "%，坐标换算结果需人工复核: " + geometry.describe(viewport)
    );
  }
  return viewport;
}

function executeNode(context, node, viewport) {
  if (node.type === "noop") return;
  if (node.type === "tap") return executeTap(context, node, viewport);
  if (node.type === "tapImage") return executeTapImage(context, node, viewport);
  throw new Error("未知节点类型: " + node.type);
}

function executeTap(context, node, viewport) {
  var point = geometry.resolvePoint(
    { rx: node.rx, ry: node.ry, name: node.name || node.rx + "," + node.ry },
    viewport
  );
  context.actions.tap(point, node.postWaitMs);
}

function executeTapImage(context, node, viewport) {
  var assetPath = context.assetPath(node.asset);
  var findOptions = {
    threshold: node.threshold != null ? node.threshold : DEFAULT_TAP_IMAGE_THRESHOLD
  };
  if (node.region) {
    findOptions.region = geometry.toFindImageRegion(node.region, viewport);
  }
  var waitMs = node.waitMs != null ? node.waitMs : DEFAULT_TAP_IMAGE_WAIT_MS;
  var pollMs = node.pollMs != null ? node.pollMs : DEFAULT_TAP_IMAGE_POLL_MS;

  var match = null;
  context.actions.waitUntil(
    node.name || node.asset,
    function () {
      match = context.screen.findTemplate(assetPath, findOptions);
      return match !== null;
    },
    waitMs,
    pollMs
  );

  if (node.click === false) return;

  sleep(node.preTapMs != null ? node.preTapMs : DEFAULT_TAP_IMAGE_PRE_TAP_MS);
  // 匹配到的中心点已经是设备像素，偏移量才是归一化的，按内容区尺寸换算。
  var tapPoint = geometry.applyOffset(
    { x: match.centerX, y: match.centerY },
    node.offset,
    viewport,
    node.name || node.asset
  );
  var tapX = tapPoint.x;
  var tapY = tapPoint.y;
  context.actions.tap(
    {
      x: tapX,
      y: tapY,
      name: node.name || node.asset
    },
    node.postWaitMs
  );
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  loadCase: loadCase,
  validateCase: validateCase,
  runCase: runCase
};
