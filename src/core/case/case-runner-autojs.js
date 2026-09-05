// =====================================================================
// 通用能力：读取 JSON 用例、验证、按节点图执行
// 设计约束：
//   - 用例数据是明文 JSON。用户是数据所有者：可读、可改、可 diff、可 git 管理
//   - MVP 只支持三种节点类型：noop / tap / tapImage
//   - 节点跳转：@next 顺序、@end 结束成功、@abort 结束失败、或跳到具体节点 id
//   - 循环有明确访问上限，防止节点跳转成环导致设备空转
//   - 屏幕方向必须与 baseline 方向一致，不做换算（MVP 不承担跨方向回放）
// =====================================================================

var SCHEMA_VERSION = 1;
var DEFAULT_MAX_NODE_VISITS = 500;
var DEFAULT_TAP_IMAGE_WAIT_MS = 15000;
var DEFAULT_TAP_IMAGE_POLL_MS = 1500;
var DEFAULT_TAP_IMAGE_THRESHOLD = 0.85;
var DEFAULT_TAP_IMAGE_PRE_TAP_MS = 400;

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

function loadCase(casePath) {
  if (!files.exists(casePath)) {
    throw new Error("用例文件不存在: " + casePath);
  }
  var raw = files.read(casePath);
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
  // 不一致时立即抛错，避免归一化坐标 * device.width 得到荒唐位置。
  if (caseData.baseline) {
    var deviceIsLandscape = device.width > device.height;
    var baselineIsLandscape = caseData.baseline.width > caseData.baseline.height;
    if (deviceIsLandscape !== baselineIsLandscape) {
      throw new Error(
        "屏幕方向与 baseline 不一致：baseline " +
          caseData.baseline.width +
          "x" +
          caseData.baseline.height +
          "，设备 " +
          device.width +
          "x" +
          device.height +
          "。MVP 不做方向换算，请先把画面转到匹配方向"
      );
    }
  }

  var currentIndex = 0;
  if (caseData.entry) {
    if (!(caseData.entry in idToIndex)) {
      throw new Error("entry 节点不存在: " + caseData.entry);
    }
    currentIndex = idToIndex[caseData.entry];
  }

  var maxVisits = caseData.maxNodeVisits || DEFAULT_MAX_NODE_VISITS;
  var visits = 0;
  var results = [];

  while (true) {
    if (++visits > maxVisits) {
      throw new Error(
        "节点访问次数超过上限 " + maxVisits + "，可能存在死循环。已完成 " + results.length + " 步"
      );
    }

    var node = nodes[currentIndex];
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
      executeNode(context, node);
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

function executeNode(context, node) {
  if (node.type === "noop") return;
  if (node.type === "tap") return executeTap(context, node);
  if (node.type === "tapImage") return executeTapImage(context, node);
  throw new Error("未知节点类型: " + node.type);
}

function executeTap(context, node) {
  var deviceX = Math.floor(node.rx * device.width);
  var deviceY = Math.floor(node.ry * device.height);
  context.actions.tap(
    {
      x: deviceX,
      y: deviceY,
      name: node.name || node.rx + "," + node.ry
    },
    node.postWaitMs
  );
}

function executeTapImage(context, node) {
  var assetPath = context.assetPath(node.asset);
  var findOptions = {
    threshold: node.threshold != null ? node.threshold : DEFAULT_TAP_IMAGE_THRESHOLD
  };
  if (node.region) {
    findOptions.region = [
      Math.floor(node.region.rx * device.width),
      Math.floor(node.region.ry * device.height),
      Math.floor(node.region.rw * device.width),
      Math.floor(node.region.rh * device.height)
    ];
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
  var tapX = match.centerX;
  var tapY = match.centerY;
  if (node.offset) {
    tapX += Math.floor(node.offset.rx * device.width);
    tapY += Math.floor(node.offset.ry * device.height);
  }
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
