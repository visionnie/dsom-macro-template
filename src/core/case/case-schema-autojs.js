// =====================================================================
// 通用能力：定义可回放用例（case）的数据结构，并提供与运行环境无关的校验
// 设计约束：本模块必须能同时在 Node（PC 录制器）和 AutoJs6（设备回放）中运行，
//           因此禁止引用 device、images、colors 等 AutoJs6 全局对象
// 安全边界：等待、重试和用例总时长必须落在 LIMITS 内，避免设备空转或长时间误点
// =====================================================================

// 结构版本。录制器写入、回放器校验；不兼容改动必须递增并在 CASE-SCHEMA.md 说明迁移方式。
var SCHEMA_VERSION = 1;

// 用例由机器自动执行，任何一项越界都可能让设备空转或反复误点，因此上限写在通用层。
var LIMITS = {
  maxSteps: 300,
  maxWaitMs: 60000,
  maxTimeoutMs: 120000,
  maxCaseDurationMs: 1800000,
  maxRetryCount: 5,
  minPollIntervalMs: 100,
  maxAnchorChildren: 8,
  maxAnchorDepth: 2,
  maxBaselineEdge: 8192
};

// 默认值集中在这里，录制器生成骨架和回放器补全缺省值时共用同一份。
var DEFAULTS = {
  scaleStrategy: "fit",
  templateThreshold: 0.85,
  textMatchMode: "contains",
  pixelTolerance: 16,
  conditionTimeoutMs: 10000,
  conditionPollIntervalMs: 500,
  actionWaitMs: 600,
  retryCount: 1,
  retryDelayMs: 1000
};

var SCALE_STRATEGIES = ["fit", "stretch"];
var ORIENTATIONS = ["portrait", "landscape"];
var ANCHOR_TYPES = ["template", "text", "pixel", "all", "any"];
var ACTION_TYPES = ["tap", "swipe", "wait", "key", "check"];
var TAP_TARGETS = ["anchor", "point"];
var KEY_NAMES = ["back", "home"];
var TEXT_MATCH_MODES = ["contains", "equals"];

// 回放结果取值。步骤级和用例级分开：broken 表示环境或前置问题，不能算业务缺陷。
var STEP_STATUSES = ["passed", "failed", "skipped"];
var CASE_STATUSES = ["passed", "failed", "broken"];

var CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
var STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

// 归一化比例：所有坐标都以基线分辨率的比例存储，回放时再换算成设备像素。
function isRatio(value) {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

// 偏移允许为负，用于从锚点中心向左或向上取点。
function isOffsetRatio(value) {
  return isFiniteNumber(value) && value >= -1 && value <= 1;
}

function isIntegerInRange(value, minimum, maximum) {
  return (
    isFiniteNumber(value) &&
    Math.floor(value) === value &&
    value >= minimum &&
    value <= maximum
  );
}

function includes(list, value) {
  for (var index = 0; index < list.length; index++) {
    if (list[index] === value) {
      return true;
    }
  }
  return false;
}

function createCollector() {
  return {
    errors: [],
    warnings: [],
    error: function (path, message) {
      this.errors.push(path + " " + message);
    },
    warn: function (path, message) {
      this.warnings.push(path + " " + message);
    }
  };
}

// 归一化坐标点：rx / ry 相对基线分辨率，name 只用于日志和报告。
function validatePoint(point, path, collector) {
  if (!isPlainObject(point)) {
    collector.error(path, "必须是对象");
    return;
  }
  if (!isRatio(point.rx) || !isRatio(point.ry)) {
    collector.error(path, "rx 与 ry 必须是 0 到 1 之间的归一化比例");
  }
  if (point.name !== undefined && typeof point.name !== "string") {
    collector.error(path + ".name", "必须是字符串");
  }
}

function validateOffset(offset, path, collector) {
  if (!isPlainObject(offset)) {
    collector.error(path, "必须是对象");
    return;
  }
  if (!isOffsetRatio(offset.rx) || !isOffsetRatio(offset.ry)) {
    collector.error(path, "rx 与 ry 必须是 -1 到 1 之间的归一化比例");
  }
}

// 归一化矩形：限定找图和 OCR 的搜索范围，缩小范围能显著提升匹配稳定性。
function validateRegion(region, path, collector) {
  if (!isPlainObject(region)) {
    collector.error(path, "必须是对象");
    return;
  }
  if (!isRatio(region.rx) || !isRatio(region.ry)) {
    collector.error(path, "rx 与 ry 必须是 0 到 1 之间的归一化比例");
    return;
  }
  if (!isRatio(region.rw) || !isRatio(region.rh) || region.rw <= 0 || region.rh <= 0) {
    collector.error(path, "rw 与 rh 必须是大于 0 且不超过 1 的归一化比例");
    return;
  }
  if (region.rx + region.rw > 1 || region.ry + region.rh > 1) {
    collector.error(path, "区域超出基线画面范围");
  }
}

function validateTemplateAnchor(anchor, path, collector) {
  if (!isNonEmptyString(anchor.asset)) {
    collector.error(path + ".asset", "必须是相对 src/assets 的模板图片路径");
  } else if (anchor.asset.indexOf("..") >= 0 || anchor.asset.charAt(0) === "/") {
    collector.error(path + ".asset", "必须是不含 .. 的相对路径");
  }
  if (anchor.threshold !== undefined && !isRatio(anchor.threshold)) {
    collector.error(path + ".threshold", "必须是 0 到 1 之间的匹配阈值");
  }
}

function validateTextAnchor(anchor, path, collector) {
  if (!isNonEmptyString(anchor.text)) {
    collector.error(path + ".text", "必须是非空的期望文本");
  }
  if (anchor.mode !== undefined && !includes(TEXT_MATCH_MODES, anchor.mode)) {
    collector.error(path + ".mode", "只能是 " + TEXT_MATCH_MODES.join(" 或 "));
  }
  if (anchor.language !== undefined && !isNonEmptyString(anchor.language)) {
    collector.error(path + ".language", "必须是非空的语言代码");
  }
}

function validatePixelAnchor(anchor, path, collector) {
  validatePoint(anchor.point, path + ".point", collector);
  if (!isArray(anchor.rgb) || anchor.rgb.length !== 3) {
    collector.error(path + ".rgb", "必须是长度为 3 的颜色数组");
  } else {
    for (var index = 0; index < 3; index++) {
      if (!isIntegerInRange(anchor.rgb[index], 0, 255)) {
        collector.error(path + ".rgb[" + index + "]", "必须是 0 到 255 的整数");
      }
    }
  }
  if (
    anchor.tolerance !== undefined &&
    !isIntegerInRange(anchor.tolerance, 0, 255)
  ) {
    collector.error(path + ".tolerance", "必须是 0 到 255 的整数");
  }
}

// 组合锚点：游戏页面常常需要同时满足两个特征才能确认，因此支持 all / any。
function validateCompositeAnchor(anchor, path, collector, depth) {
  if (depth >= LIMITS.maxAnchorDepth) {
    collector.error(path, "组合锚点嵌套超过 " + LIMITS.maxAnchorDepth + " 层");
    return;
  }
  if (!isArray(anchor.anchors) || anchor.anchors.length === 0) {
    collector.error(path + ".anchors", "必须是非空数组");
    return;
  }
  if (anchor.anchors.length > LIMITS.maxAnchorChildren) {
    collector.error(
      path + ".anchors",
      "子锚点不能超过 " + LIMITS.maxAnchorChildren + " 个"
    );
    return;
  }
  for (var index = 0; index < anchor.anchors.length; index++) {
    validateAnchor(
      anchor.anchors[index],
      path + ".anchors[" + index + "]",
      collector,
      depth + 1
    );
  }
}

function validateAnchor(anchor, path, collector, depth) {
  if (!isPlainObject(anchor)) {
    collector.error(path, "必须是对象");
    return;
  }
  if (!includes(ANCHOR_TYPES, anchor.type)) {
    collector.error(path + ".type", "只能是 " + ANCHOR_TYPES.join(" / "));
    return;
  }
  if (anchor.region !== undefined) {
    validateRegion(anchor.region, path + ".region", collector);
  }

  if (anchor.type === "template") {
    validateTemplateAnchor(anchor, path, collector);
  } else if (anchor.type === "text") {
    validateTextAnchor(anchor, path, collector);
  } else if (anchor.type === "pixel") {
    validatePixelAnchor(anchor, path, collector);
  } else {
    validateCompositeAnchor(anchor, path, collector, depth);
  }
}

// 条件：动作前的进入状态（expect）和动作后的目标状态（verify）共用同一结构。
function validateCondition(condition, path, collector) {
  if (!isPlainObject(condition)) {
    collector.error(path, "必须是对象");
    return;
  }
  validateAnchor(condition.anchor, path + ".anchor", collector, 0);
  if (
    condition.timeoutMs !== undefined &&
    !isIntegerInRange(condition.timeoutMs, 0, LIMITS.maxTimeoutMs)
  ) {
    collector.error(
      path + ".timeoutMs",
      "必须是 0 到 " + LIMITS.maxTimeoutMs + " 之间的整数"
    );
  }
  if (
    condition.pollIntervalMs !== undefined &&
    !isIntegerInRange(condition.pollIntervalMs, LIMITS.minPollIntervalMs, LIMITS.maxTimeoutMs)
  ) {
    collector.error(
      path + ".pollIntervalMs",
      "必须是不小于 " + LIMITS.minPollIntervalMs + " 的整数"
    );
  }
}

function validateTapAction(action, path, collector) {
  var target = action.target === undefined ? "anchor" : action.target;
  if (!includes(TAP_TARGETS, target)) {
    collector.error(path + ".target", "只能是 " + TAP_TARGETS.join(" 或 "));
    return;
  }
  if (target === "point") {
    validatePoint(action.point, path + ".point", collector);
  }
  if (action.offset !== undefined) {
    validateOffset(action.offset, path + ".offset", collector);
  }
}

function validateSwipeAction(action, path, collector) {
  validatePoint(action.from, path + ".from", collector);
  validatePoint(action.to, path + ".to", collector);
  if (!isIntegerInRange(action.durationMs, 50, LIMITS.maxWaitMs)) {
    collector.error(
      path + ".durationMs",
      "必须是 50 到 " + LIMITS.maxWaitMs + " 之间的整数"
    );
  }
}

function validateAction(action, path, collector) {
  if (!isPlainObject(action)) {
    collector.error(path, "必须是对象");
    return;
  }
  if (!includes(ACTION_TYPES, action.type)) {
    collector.error(path + ".type", "只能是 " + ACTION_TYPES.join(" / "));
    return;
  }

  if (action.type === "tap") {
    validateTapAction(action, path, collector);
  } else if (action.type === "swipe") {
    validateSwipeAction(action, path, collector);
  } else if (action.type === "wait") {
    if (!isIntegerInRange(action.durationMs, 1, LIMITS.maxWaitMs)) {
      collector.error(
        path + ".durationMs",
        "必须是 1 到 " + LIMITS.maxWaitMs + " 之间的整数"
      );
    }
  } else if (action.type === "key") {
    if (!includes(KEY_NAMES, action.name)) {
      collector.error(path + ".name", "只能是 " + KEY_NAMES.join(" 或 "));
    }
  }

  if (
    action.waitMs !== undefined &&
    !isIntegerInRange(action.waitMs, 0, LIMITS.maxWaitMs)
  ) {
    collector.error(
      path + ".waitMs",
      "必须是 0 到 " + LIMITS.maxWaitMs + " 之间的整数"
    );
  }
}

function validateStep(step, path, collector) {
  if (!isPlainObject(step)) {
    collector.error(path, "必须是对象");
    return;
  }
  if (!isNonEmptyString(step.id) || !STEP_ID_PATTERN.test(step.id)) {
    collector.error(path + ".id", "只能包含小写字母、数字和连字符");
  }
  if (!isNonEmptyString(step.name)) {
    collector.error(path + ".name", "必须是非空的步骤名称");
  }
  if (step.expect !== undefined) {
    validateCondition(step.expect, path + ".expect", collector);
  }
  validateAction(step.action, path + ".action", collector);
  if (step.verify !== undefined) {
    validateCondition(step.verify, path + ".verify", collector);
  }
  if (
    step.retryCount !== undefined &&
    !isIntegerInRange(step.retryCount, 0, LIMITS.maxRetryCount)
  ) {
    collector.error(
      path + ".retryCount",
      "必须是 0 到 " + LIMITS.maxRetryCount + " 之间的整数"
    );
  }
  if (
    step.retryDelayMs !== undefined &&
    !isIntegerInRange(step.retryDelayMs, 0, LIMITS.maxWaitMs)
  ) {
    collector.error(
      path + ".retryDelayMs",
      "必须是 0 到 " + LIMITS.maxWaitMs + " 之间的整数"
    );
  }
  if (step.optional !== undefined && typeof step.optional !== "boolean") {
    collector.error(path + ".optional", "必须是布尔值");
  }

  if (!isPlainObject(step.action)) {
    return;
  }

  // 以下两条是回放稳定性的主要风险来源，只告警不拦截，由录制器和报告提示人工确认。
  if (step.action.type === "tap" && step.action.target === "point" && !step.expect) {
    collector.warn(
      path,
      "纯坐标点击且没有 expect 锚点，换分辨率或换机型后大概率失效"
    );
  }
  if (
    (step.action.type === "tap" || step.action.type === "swipe") &&
    !step.verify
  ) {
    collector.warn(path, "动作后没有 verify，失败时无法判断是这一步还是后续步骤出错");
  }
}

function validateBaseline(baseline, collector) {
  var path = "baseline";
  if (!isPlainObject(baseline)) {
    collector.error(path, "必须是对象，用于记录录制时的分辨率");
    return;
  }
  if (!isIntegerInRange(baseline.width, 1, LIMITS.maxBaselineEdge)) {
    collector.error(path + ".width", "必须是正整数像素宽度");
  }
  if (!isIntegerInRange(baseline.height, 1, LIMITS.maxBaselineEdge)) {
    collector.error(path + ".height", "必须是正整数像素高度");
  }
  if (
    baseline.orientation !== undefined &&
    !includes(ORIENTATIONS, baseline.orientation)
  ) {
    collector.error(path + ".orientation", "只能是 " + ORIENTATIONS.join(" 或 "));
  }
  if (
    baseline.scaleStrategy !== undefined &&
    !includes(SCALE_STRATEGIES, baseline.scaleStrategy)
  ) {
    collector.error(
      path + ".scaleStrategy",
      "只能是 " + SCALE_STRATEGIES.join(" 或 ")
    );
  }
}

function validateRequirements(requirements, collector) {
  var path = "requirements";
  if (!isPlainObject(requirements)) {
    collector.error(path, "必须是对象");
    return;
  }
  if (requirements.launchGame !== false && !isNonEmptyString(requirements.packageName)) {
    collector.error(path + ".packageName", "需要启动游戏时必须填写包名");
  }
  if (!isIntegerInRange(requirements.maxDurationMs, 1000, LIMITS.maxCaseDurationMs)) {
    collector.error(
      path + ".maxDurationMs",
      "必须是 1000 到 " + LIMITS.maxCaseDurationMs + " 之间的整数，用例必须有总时长上限"
    );
  }
}

function validateSteps(steps, collector) {
  if (!isArray(steps) || steps.length === 0) {
    collector.error("steps", "必须是非空数组");
    return;
  }
  if (steps.length > LIMITS.maxSteps) {
    collector.error("steps", "步骤数不能超过 " + LIMITS.maxSteps);
    return;
  }

  var seenIds = {};
  for (var index = 0; index < steps.length; index++) {
    var path = "steps[" + index + "]";
    validateStep(steps[index], path, collector);
    var stepId = isPlainObject(steps[index]) ? steps[index].id : null;
    if (isNonEmptyString(stepId)) {
      if (seenIds[stepId]) {
        collector.error(path + ".id", "步骤 ID 重复: " + stepId);
      }
      seenIds[stepId] = true;
    }
  }
}

// 校验不抛异常，返回全部问题，便于录制器一次性提示人工修正。
function validate(caseDocument) {
  var collector = createCollector();

  if (!isPlainObject(caseDocument)) {
    collector.error("case", "必须是对象");
    return { valid: false, errors: collector.errors, warnings: collector.warnings };
  }

  if (caseDocument.schemaVersion !== SCHEMA_VERSION) {
    collector.error(
      "schemaVersion",
      "期望 " + SCHEMA_VERSION + "，实际 " + caseDocument.schemaVersion
    );
  }
  if (!isNonEmptyString(caseDocument.id) || !CASE_ID_PATTERN.test(caseDocument.id)) {
    collector.error("id", "只能包含小写字母、数字和连字符");
  }
  if (!isNonEmptyString(caseDocument.name)) {
    collector.error("name", "必须是非空的用例名称");
  }
  if (caseDocument.tags !== undefined) {
    if (!isArray(caseDocument.tags)) {
      collector.error("tags", "必须是字符串数组");
    } else {
      for (var tagIndex = 0; tagIndex < caseDocument.tags.length; tagIndex++) {
        if (!isNonEmptyString(caseDocument.tags[tagIndex])) {
          collector.error("tags[" + tagIndex + "]", "必须是非空字符串");
        }
      }
    }
  }

  validateBaseline(caseDocument.baseline, collector);
  validateRequirements(caseDocument.requirements, collector);
  validateSteps(caseDocument.steps, collector);

  if (caseDocument.recording !== undefined && !isPlainObject(caseDocument.recording)) {
    collector.error("recording", "必须是对象");
  }
  if (!caseDocument.recording) {
    collector.warn("recording", "缺少录制来源信息，回放失败时无法追溯录制环境");
  }

  return {
    valid: collector.errors.length === 0,
    errors: collector.errors,
    warnings: collector.warnings
  };
}

function assertValid(caseDocument) {
  var result = validate(caseDocument);
  if (!result.valid) {
    throw new Error(
      "用例结构非法（" + result.errors.length + " 项）:\n" + result.errors.join("\n")
    );
  }
  return result;
}

// 录制器生成新用例时的空骨架，保证默认值只有一个来源。
function createSkeleton(options) {
  var skeletonOptions = options || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    id: skeletonOptions.id || "replace-me",
    name: skeletonOptions.name || "待命名用例",
    tags: [],
    baseline: {
      width: skeletonOptions.width || 0,
      height: skeletonOptions.height || 0,
      orientation: skeletonOptions.orientation || "portrait",
      scaleStrategy: DEFAULTS.scaleStrategy
    },
    recording: {
      recordedAt: skeletonOptions.recordedAt || "",
      recorderVersion: skeletonOptions.recorderVersion || "",
      device: skeletonOptions.device || {},
      appVersion: skeletonOptions.appVersion || ""
    },
    requirements: {
      packageName: skeletonOptions.packageName || "",
      launchGame: true,
      requiresCapture: true,
      maxDurationMs: skeletonOptions.maxDurationMs || 300000
    },
    steps: []
  };
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  LIMITS: LIMITS,
  DEFAULTS: DEFAULTS,
  SCALE_STRATEGIES: SCALE_STRATEGIES,
  ORIENTATIONS: ORIENTATIONS,
  ANCHOR_TYPES: ANCHOR_TYPES,
  ACTION_TYPES: ACTION_TYPES,
  TAP_TARGETS: TAP_TARGETS,
  KEY_NAMES: KEY_NAMES,
  TEXT_MATCH_MODES: TEXT_MATCH_MODES,
  STEP_STATUSES: STEP_STATUSES,
  CASE_STATUSES: CASE_STATUSES,
  validate: validate,
  assertValid: assertValid,
  createSkeleton: createSkeleton
};
