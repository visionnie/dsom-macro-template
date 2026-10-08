// =====================================================================
// 通用能力：读取 JSON 用例、验证、按节点图执行
// 设计约束：
//   - 用例数据是明文 JSON。用户是数据所有者：可读、可改、可 diff、可 git 管理
//   - 支持八种节点类型：noop / tap / tapImage / longTap / swipe / swipeImage /
//     tapText / inputText
//     （2026-10-02 加了 tapText 与 inputText：点击文字靠 OCR 认字再点框中心，
//      输入文字按"无障碍 -> 剪贴板粘贴 -> root input"三条路依次试。
//      游戏自己的美术字认不出来是常态，所以界面上要先认一遍、从认出来的词里挑）
//   - 节点可以 disabled：原样留在用例里但不执行（连它的动作前等待一起跳过），
//     人要临时跳过一步时不必先删了再重录
//     （2026-09-30 加了 longTap 与 swipe：录制器原先只录点击，那是人工录制表达力的硬上限。
//      2026-10-01 加了 swipeImage：用户要"匹配图片成功后按住拖动"，
//      于是"找图只配点击"这条边界作废——起点由找图定位，终点是屏幕上的固定位置）
//   - 节点跳转：@next 顺序、@end 结束成功、@abort 结束失败、或跳到具体节点 id
//   - 循环有明确访问上限：全局 maxNodeVisits 兜底，单节点可配 maxVisits + onExhausted
//   - 屏幕方向必须与 baseline 方向一致（有上限地等待），方向本身不做换算
//   - 分辨率通过 case-geometry 的 viewport 换算，baseline 与设备同尺寸时为恒等映射
// =====================================================================

var errors = require("../errors-autojs.js");
var control = require("../run-control-autojs.js");
var geometry = require("./case-geometry-autojs.js");
// 只借它一个把毫秒读给人听的函数。**等待的读法只有一处**，
// 否则同一个 1200000 会在日志、步骤列表、单步面板上显示成三种样子。
var recordedCase = require("./recorded-case-autojs.js");

// 用例文档的身份是 (model, schemaVersion) 这一对，不是单独的 schemaVersion。
// 仓库里有两套结构：本文件执行的 nodes 节点图，和 CASE-SCHEMA.md 设计的 steps 三段式。
// 它们字段完全不同，早期却都只写 schemaVersion: 1，照着设计稿写出来的用例喂进来
// 只会报一串看不懂的字段错误。加 model 判别后各自有独立的版本号空间，互相认得出对方。
// 缺省按 nodes 解释，所以此前所有用例 JSON 与录制器产物都不用改。
var CASE_MODEL = "nodes";
var SCHEMA_VERSION = 1;
var DEFAULT_MAX_NODE_VISITS = 500;
var DEFAULT_TAP_IMAGE_WAIT_MS = 15000;
var DEFAULT_TAP_IMAGE_POLL_MS = 1500;
var DEFAULT_TAP_IMAGE_THRESHOLD = 0.85;
var DEFAULT_TAP_IMAGE_PRE_TAP_MS = 400;
var DEFAULT_ORIENTATION_WAIT_MS = 20000;
var DEFAULT_ORIENTATION_POLL_MS = 1000;
// 长按与滑动的缺省时长，以及允许写进用例的范围。
// 下限不设 0：0 毫秒的 press 就是一次普通点击，而节点写着"长按"，
// 那种"报绿却没做成事"的失效是这套东西最危险的一类。
var DEFAULT_LONG_PRESS_MS = 800;
var MIN_LONG_PRESS_MS = 200;
var MAX_LONG_PRESS_MS = 10000;
// 连续点击（2026-10-04）。三个数的缺省取自参考产品的截图：按下 80 毫秒、
// 点 1 次、间隔 100 毫秒。
// 次数上限 2000：按最快的间隔也要跑好几分钟，再大就该用「循环」那种表达，
// 而不是把一个节点撑成一场马拉松——期间「终止」要等这一节点跑完才生效。
var DEFAULT_MULTI_TAP_COUNT = 1;
var DEFAULT_MULTI_TAP_PRESS_MS = 80;
var DEFAULT_MULTI_TAP_INTERVAL_MS = 100;
var MAX_MULTI_TAP_COUNT = 2000;
var MAX_MULTI_TAP_INTERVAL_MS = 60000;
var DEFAULT_SWIPE_DURATION_MS = 300;
var MIN_SWIPE_DURATION_MS = 60;
var MAX_SWIPE_DURATION_MS = 10000;
// 动作前等待的上限。给到 1 小时：游戏里「等体力回满」「等副本冷却」这类
// 就是十几二十分钟起步（用户 2026-09-30 举的例子是 1200000 毫秒 = 20 分钟）。
// 不设成无限：一个手滑输进去的天文数字会让无人值守的夜里整条链卡死，
// 而没人看得出它在等什么。
var MAX_PRE_WAIT_MS = 3600000;
// 点击文字：认一遍屏幕，找到那段字就点它的框中心。
// 等待与轮询沿用找图那一套——两者都是"界面还没出来就重试"，没理由各有一套读数。
// 引擎默认 mlkit（0.6 秒一次），认不出来时可以在这一步上单独切 rapid（3.2 秒，认得更全）。
var DEFAULT_TAP_TEXT_ENGINE = "mlkit";
// 输入文字默认覆盖：人要的多半是"把框里换成这个"，而不是"接在后面"。
// 参考产品的那个勾（开启覆盖输入）也是这个意思。
var DEFAULT_INPUT_OVERWRITE = true;

var VALID_TYPES = {
  noop: true,
  tap: true,
  tapImage: true,
  longTap: true,
  multiTap: true,
  swipe: true,
  swipeImage: true,
  tapText: true,
  inputText: true
};
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

// 先认结构、再校字段。照 CASE-SCHEMA.md 的 steps 结构写出来的用例，
// 逐字段校验只会报「缺少 nodes」之类看不出根因的错，人会以为是自己哪里写漏了。
// 这里一句话说清它是哪套结构、该看哪份文档。
function assertNodesModel(data) {
  if (data.model != null && data.model !== CASE_MODEL) {
    throw new Error(
      "用例 model 是 " + data.model + "，case-runner 只执行 " + CASE_MODEL +
        " 节点图模型；写法见 .docs/CASE-MVP.md"
    );
  }
  if (data.model == null && data.nodes == null && data.steps != null) {
    throw new Error(
      "这条用例是 CASE-SCHEMA.md 的 steps 三段式结构（steps / expect / verify），" +
        "它只有校验器没有执行器，喂给 case-runner 跑不了。" +
        "请改写成 CASE-MVP.md 的 nodes 节点图"
    );
  }
}

function validateCase(data) {
  if (!data || typeof data !== "object") {
    throw new Error("用例根必须是对象");
  }
  assertNodesModel(data);
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      "用例 schemaVersion 不匹配，期望 " + CASE_MODEL + " 模型的 " +
        SCHEMA_VERSION + "，实际 " + data.schemaVersion
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
  // 素材相对谁解析："assets"（默认）走项目的 assetsRoot；"case" 相对用例文件所在目录。
  // 录制出来的用例必须用 "case"：锚点图是在设备上现框的，而打包后的 assets 是只读的。
  if (data.assetBase != null && data.assetBase !== "assets" && data.assetBase !== "case") {
    throw new Error("assetBase 只能是 assets 或 case，实际 " + data.assetBase);
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
  // 节点级 baseline：这一步录制时屏幕是多大。录制横跨屏幕方向时才会出现
  // （盒子竖屏点进游戏 -> 游戏横屏），只写在与用例 baseline 不同的那些步骤上。
  if (node.baseline != null) {
    if (!isNumber(node.baseline.width) || !isNumber(node.baseline.height)) {
      throw new Error("节点 [" + node.id + "] 的 baseline 必须包含 width 与 height");
    }
  }
  // 这一步等方向的上限。只给转屏那些步骤挂长等待，别的步骤用默认值。
  if (node.orientationWaitMs != null && !isNumber(node.orientationWaitMs)) {
    throw new Error("节点 [" + node.id + "] 的 orientationWaitMs 必须是数字");
  }
  // 动作**之前**等多久。录制器记的「上一步做完到这一步之间人等了多久」就写在这儿。
  // 与 postWaitMs（动作之后等多久）是两个字段、两种语义，各管各的，见 CASE-MVP.md。
  if (node.preWaitMs != null &&
      (!isNumber(node.preWaitMs) || node.preWaitMs < 0 || node.preWaitMs > MAX_PRE_WAIT_MS)) {
    throw new Error(
      "节点 [" + node.id + "] 的 preWaitMs 必须是 0 到 " + MAX_PRE_WAIT_MS +
        " 之间的毫秒数（上限 1 小时）"
    );
  }
  if (node.type === "tap") {
    if (!isRatio(node.rx) || !isRatio(node.ry)) {
      throw new Error("tap 节点 [" + node.id + "] 缺少或非法 rx/ry（0 到 1）");
    }
    return;
  }
  if (node.type === "longTap") {
    if (!isRatio(node.rx) || !isRatio(node.ry)) {
      throw new Error("longTap 节点 [" + node.id + "] 缺少或非法 rx/ry（0 到 1）");
    }
    if (node.pressMs != null &&
        (!isNumber(node.pressMs) ||
          node.pressMs < MIN_LONG_PRESS_MS ||
          node.pressMs > MAX_LONG_PRESS_MS)) {
      throw new Error(
        "longTap 节点 [" + node.id + "] 的 pressMs 必须是 " +
          MIN_LONG_PRESS_MS + " 到 " + MAX_LONG_PRESS_MS + " 之间的毫秒数"
      );
    }
    return;
  }
  // 连续点击：位置与 tap 同一套 rx/ry，另外三个数都有上限。
  // **上限必须在这里就挡住**：次数写成 100000 的那一步，回放时会按住屏幕连点十几分钟，
  // 期间「终止」只能等它跑完这一节点——界面上看就是卡死了。
  if (node.type === "multiTap") {
    if (!isRatio(node.rx) || !isRatio(node.ry)) {
      throw new Error("multiTap 节点 [" + node.id + "] 缺少或非法 rx/ry（0 到 1）");
    }
    if (node.count != null &&
        (!isNumber(node.count) || node.count < 1 || node.count > MAX_MULTI_TAP_COUNT)) {
      throw new Error(
        "multiTap 节点 [" + node.id + "] 的 count 必须是 1 到 " + MAX_MULTI_TAP_COUNT + " 之间的整数"
      );
    }
    if (node.pressMs != null &&
        (!isNumber(node.pressMs) || node.pressMs < 1 || node.pressMs > MAX_LONG_PRESS_MS)) {
      throw new Error(
        "multiTap 节点 [" + node.id + "] 的 pressMs 必须是 1 到 " + MAX_LONG_PRESS_MS + " 之间的毫秒数"
      );
    }
    if (node.intervalMs != null &&
        (!isNumber(node.intervalMs) ||
          node.intervalMs < 0 ||
          node.intervalMs > MAX_MULTI_TAP_INTERVAL_MS)) {
      throw new Error(
        "multiTap 节点 [" + node.id + "] 的 intervalMs 必须是 0 到 " +
          MAX_MULTI_TAP_INTERVAL_MS + " 之间的毫秒数"
      );
    }
    return;
  }
  if (node.type === "swipe") {
    // 起点沿用 rx/ry，终点是 rx2/ry2。起点同名不是偷懒：取点、红十字、
    // 坐标空间换算那几条路都按 rx/ry 取"这一步落在哪儿"，换个名字就得各改一遍。
    if (!isRatio(node.rx) || !isRatio(node.ry)) {
      throw new Error("swipe 节点 [" + node.id + "] 缺少或非法起点 rx/ry（0 到 1）");
    }
    if (!isRatio(node.rx2) || !isRatio(node.ry2)) {
      throw new Error("swipe 节点 [" + node.id + "] 缺少或非法终点 rx2/ry2（0 到 1）");
    }
    if (node.durationMs != null &&
        (!isNumber(node.durationMs) ||
          node.durationMs < MIN_SWIPE_DURATION_MS ||
          node.durationMs > MAX_SWIPE_DURATION_MS)) {
      throw new Error(
        "swipe 节点 [" + node.id + "] 的 durationMs 必须是 " +
          MIN_SWIPE_DURATION_MS + " 到 " + MAX_SWIPE_DURATION_MS + " 之间的毫秒数"
      );
    }
    return;
  }
  // 点击文字：要找的那段字必须有，而且不能是空白。
  // **不校验"这段字认不认得出来"**——那要截图才知道，是界面上「认一下」那一步的事；
  // 这里只拦明显写错的（空字符串、非字符串）。
  if (node.type === "tapText") {
    if (!node.text || typeof node.text !== "string" || !node.text.replace(/\s+/g, "")) {
      throw new Error("tapText 节点 [" + node.id + "] 缺少要找的文字");
    }
    if (node.engine != null && node.engine !== "mlkit" && node.engine !== "rapid") {
      throw new Error(
        "tapText 节点 [" + node.id + "] 的 engine 只能是 mlkit 或 rapid，实际: " + node.engine
      );
    }
    if (node.region) {
      var tr = node.region;
      if (!isRatio(tr.rx) || !isRatio(tr.ry) || !isRatio(tr.rw) || !isRatio(tr.rh)) {
        throw new Error("tapText 节点 [" + node.id + "] 的 region 非法");
      }
      if (tr.rx + tr.rw > 1 || tr.ry + tr.rh > 1) {
        throw new Error("tapText 节点 [" + node.id + "] 的 region 越界");
      }
    }
    return;
  }
  // 输入文字：内容必填（空内容的"输入"是个什么都不做却报绿的步骤）。
  // rx/ry 可选——给了就先点一下那儿把输入框聚焦，不给就认为焦点已经在该在的地方
  // （例如上一步刚点过那个框）。
  if (node.type === "inputText") {
    if (typeof node.text !== "string" || node.text === "") {
      throw new Error("inputText 节点 [" + node.id + "] 缺少要输入的内容");
    }
    if (node.rx != null || node.ry != null) {
      if (!isRatio(node.rx) || !isRatio(node.ry)) {
        throw new Error("inputText 节点 [" + node.id + "] 的 rx/ry 非法（0 到 1）");
      }
    }
    return;
  }
  // 两种找图节点（点一下 / 拖一道）在素材、阈值、限制区域上完全一样，共用这一段。
  if (node.type === "tapImage" || node.type === "swipeImage") {
    if (!node.asset || typeof node.asset !== "string") {
      throw new Error(node.type + " 节点 [" + node.id + "] 缺少 asset");
    }
    if (node.threshold != null && !isRatio(node.threshold)) {
      throw new Error(node.type + " 节点 [" + node.id + "] 的 threshold 非法");
    }
    if (node.region) {
      var r = node.region;
      if (!isRatio(r.rx) || !isRatio(r.ry) || !isRatio(r.rw) || !isRatio(r.rh)) {
        throw new Error(node.type + " 节点 [" + node.id + "] 的 region 非法");
      }
      if (r.rx + r.rw > 1 || r.ry + r.rh > 1) {
        throw new Error(node.type + " 节点 [" + node.id + "] 的 region 越界");
      }
    }
    // 找图拖动还要有终点与时长。**终点缺了不猜**：没有终点的拖动就是一次点击，
    // 而节点写着拖动，正是"报绿却没做成事"那类失效。
    if (node.type === "swipeImage") {
      if (!isRatio(node.rx2) || !isRatio(node.ry2)) {
        throw new Error("swipeImage 节点 [" + node.id + "] 缺少或非法终点 rx2/ry2（0 到 1）");
      }
      if (node.durationMs != null &&
          (!isNumber(node.durationMs) ||
            node.durationMs < MIN_SWIPE_DURATION_MS ||
            node.durationMs > MAX_SWIPE_DURATION_MS)) {
        throw new Error(
          "swipeImage 节点 [" + node.id + "] 的 durationMs 必须是 " +
            MIN_SWIPE_DURATION_MS + " 到 " + MAX_SWIPE_DURATION_MS + " 之间的毫秒数"
        );
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

// assetBase 为 case 时，把上下文的素材解析换成「相对用例文件所在目录」。
// 换的是一份浅拷贝，调用方的 context 不受影响。
function withCaseAssets(context, caseData, options) {
  if (caseData.assetBase !== "case") return context;
  var caseDir = options && options.caseDir;
  if (!caseDir) {
    throw new Error("用例 assetBase 为 case，但调用方没有传入 caseDir");
  }
  var scoped = {};
  for (var key in context) scoped[key] = context[key];
  scoped.assetPath = function (relativePath) {
    return caseDir + "/" + relativePath;
  };
  return scoped;
}

// options.caseDir：用例文件所在目录，assetBase 为 case 时必填。
function runCase(context, caseData, options) {
  context = withCaseAssets(context, caseData, options);
  var nodes = caseData.nodes;
  var idToIndex = {};
  for (var i = 0; i < nodes.length; i++) idToIndex[nodes[i].id] = i;

  // 方向断言与坐标换算都**按节点做**，不是整条用例做一次。
  // 因为一条用例可以横跨屏幕方向：盒子里是竖屏，点「进入游戏」之后才转横屏，
  // 而录登录流程必然横跨这一下。每一步的 rx/ry 都是按它自己那一刻的屏幕尺寸
  // 归一化的，所以换算也必须按步来。没写节点 baseline 的步骤退回用例 baseline，
  // 于是单一方向的老用例行为完全不变——只是那一次检查从"开跑前一次"
  // 变成了"每一步一次"，中途被转屏了也能立刻拦住，而不是静默点偏。
  var viewportCache = {};

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

    // 分组里的子步骤**不在主干上走**：它们只经由自己的分组被执行
    // （见 runGroup）。这一跳必须排在禁用检查之前——子步骤自己禁没禁用
    // 由 runGroup 判，在这里判等于判两遍，而且会多出一条"跳过"的记录。
    if (node.groupId) {
      currentIndex++;
      if (currentIndex >= nodes.length) return results;
      continue;
    }

    // 节点边界的暂停/终止检查点。轮询里还有一层（actions.waitUntil），
    // 那层负责让长时间找图也能及时响应。
    control.checkpoint(context.logger);

    // 禁用的步骤：原样留在用例里，这一轮不执行。人要临时跳过某一步时
    // 不该先删了再重录——删一步会连着把它的截图与锚点一起弄没。
    // **等待也一起跳过**：那段等待属于这一步，这一步都不做了，没理由还等它。
    // 走 @next 而不是 onSuccess：禁用的语义是"当它不存在"，
    // 而 onSuccess 是"这一步做成了之后去哪儿"，两者不是一回事。
    // **禁用一个分组 = 整组连同里面的子步骤都不跑**，不用逐个去禁。
    if (node.disabled) {
      context.logger.info("节点 [" + node.id + "] " + node.name + " 已禁用，跳过");
      results.push({
        id: node.id,
        name: node.name,
        type: node.type,
        status: "skipped",
        durationMs: 0
      });
      currentIndex++;
      if (currentIndex >= nodes.length) return results;
      continue;
    }

    var target;
    if (node.type === "group") {
      target = runGroup(context, caseData, node, idToIndex, nodes, viewportCache, results);
    } else {
      target = runOneNode(context, caseData, node, viewportCache, results, nodes.length);
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

// 跑一个普通节点：等待 → 方向 → 换算 → 动作 → 按 onSuccess / onFail 决定去哪儿。
// 返回跳转目标（"@next" / "@end" / 某个节点 id）；判成 @abort 时原样抛。
//
// **主干和分组里共用这一个**（2026-10-06 抽出来）。各写一份的结果必然是
// 两条路的方向断言、坐标换算、等待语义各走各的，而那种不一致是静默的：
// 组里跑出来的结果和组外不一样，日志上看不出任何异常。
function runOneNode(context, caseData, node, viewportCache, results, totalNodes) {
  context.logger.info(
    "节点 [" + node.id + "] " + node.name + " (" + node.type + ")"
  );
  // 进度上报给界面：跑到第几步、这一步叫什么。没有界面时是个空实现。
  // 要等很久的步骤把等待也报出去——不报的话，界面上就是「第 3/9 步」挂着
  // 二十分钟一动不动，人只会以为脚本死了（而它正按录制时的节奏等）。
  if (context.progress) {
    context.progress.report({
      index: results.length + 1,
      total: totalNodes,
      id: node.id,
      name: node.name,
      type: node.type,
      // 给界面的两样东西：这一步显示成什么（有名字显示名字，没取名显示动作），
      // 以及**它还有多久才动**——界面拿它倒计时。
      label: recordedCase.displayLabel(node),
      preWaitMs: node.preWaitMs || 0
    });
  }

  // **动作前等待**。必须排在方向断言与坐标换算之前：等的这段时间里屏幕可能转向，
  // 先算好的 viewport 到时候就是错的。
  // 必须可中断：20 分钟的裸 sleep 期间按「终止」毫无反应，只能 kill App
  // （2026-09-18 常驻那个 sleep(60000) 就是这么撞上的）。
  waitBeforeNode(context, node);

  // 方向等待放在 try 外面：等不到是环境问题（游戏没起来、没转屏），
  // 必须原样抛成 broken。放进 try 里会被 onFail 当成业务失败改道，
  // 而 onFail 的语义是"这一步没找到东西"，不是"设备不对劲"。
  // 先等方向、再建 viewport：device 的宽高随转屏一起变，
  // 顺序反了就会拿转屏前的尺寸去换算，每一步都点偏。
  var nodeBaseline = node.baseline || caseData.baseline;
  if (nodeBaseline) {
    waitForOrientation(context, caseData, nodeBaseline, node);
  }
  var nodeViewport = viewportFor(context, caseData, nodeBaseline, viewportCache);

  var startedAt = Date.now();
  var stepResult = {
    id: node.id,
    name: node.name,
    type: node.type
  };
  try {
    executeNode(context, node, nodeViewport);
    stepResult.status = "passed";
    stepResult.durationMs = Date.now() - startedAt;
    results.push(stepResult);
    return node.onSuccess || "@next";
  } catch (error) {
    var detail = error && error.message ? String(error.message) : String(error);
    stepResult.status = "failed";
    stepResult.durationMs = Date.now() - startedAt;
    stepResult.error = detail;
    results.push(stepResult);
    context.logger.warn("节点失败 [" + node.id + "]: " + detail);
    var target = node.onFail || "@abort";
    if (target === "@abort") {
      // 直接抛给上层 runtime：会走它的失败截图、result.json 保留原始错误的完整流程
      throw error;
    }
    return target;
  }
}

// ---- 循环分组 ----
// 把选中的几步合成一个节点，整组跑 repeat 遍（2026-10-06 用户要的）。
//
// **子节点平铺在 nodes 里，分组只存 id 引用**，不做成真嵌套。理由是这个项目
// 已有的三条约束：截图按节点 id 存（anchors/step-03.png）、entry 按 id 找节点、
// 主循环是按 id 跳转的状态机。改成嵌套的话这三样全要重写，而老用例的迁移也会很难。
// 平铺 + 引用是纯增量：不认识 group 的老用例一个字都不用改。
// 子节点身上写 groupId，主干据此跳过它们——否则它们会被跑两遍。
//
// 跳转的约定（第一版，够录制用例用）：
//   组内某一步判到 @next   -> 组里的下一个子步骤
//   组内某一步判到 @end    -> 整条用例结束（不是只结束这一组）
//   组内某一步判到 @abort  -> 原样抛，和组外一样
//   组内某一步指到具体 id  -> **不支持**，当场报错而不是悄悄跑偏。
//     录制用例只会生成 @next / @abort，所以实际碰不到；真要跳就别放进组里。
//
// 组里不能再套组（第一版）：套起来之后"执行多少次"会变成乘法，
// 而界面上很难让人一眼看懂自己到底设了几次。
function runGroup(context, caseData, group, idToIndex, nodes, viewportCache, results) {
  var childIds = group.children || [];
  var repeat = group.repeat == null ? 1 : Math.floor(group.repeat);
  if (!(repeat >= 1)) {
    throw new Error("分组 [" + group.id + "] 的循环次数不合法: " + group.repeat);
  }
  if (childIds.length === 0) {
    context.logger.info("分组 [" + group.id + "] " + group.name + " 里没有步骤，跳过");
    results.push({
      id: group.id, name: group.name, type: "group", status: "skipped", durationMs: 0
    });
    return "@next";
  }

  context.logger.info(
    "分组 [" + group.id + "] " + group.name + " 开始：" +
      childIds.length + " 步 × " + repeat + " 次"
  );
  var startedAt = Date.now();

  for (var round = 1; round <= repeat; round++) {
    context.logger.info("分组 [" + group.id + "] 第 " + round + "/" + repeat + " 遍");
    for (var c = 0; c < childIds.length; c++) {
      // 每个子步骤之前过一次检查点：一组跑 50 遍时，按「终止」必须当场停得下来，
      // 不能等整组跑完（常驻那个裸 sleep 就是这么撞上的）。
      control.checkpoint(context.logger);

      var childIndex = idToIndex[childIds[c]];
      if (childIndex === undefined) {
        throw new Error(
          "分组 [" + group.id + "] 里的步骤不存在: " + childIds[c] + "（用例坏了，重新生成一次）"
        );
      }
      var child = nodes[childIndex];
      if (child.disabled) {
        context.logger.info("节点 [" + child.id + "] " + child.name + " 已禁用，跳过");
        results.push({
          id: child.id, name: child.name, type: child.type, status: "skipped", durationMs: 0
        });
        continue;
      }
      var childTarget = runOneNode(context, caseData, child, viewportCache, results, nodes.length);
      if (childTarget === "@end") {
        context.logger.info("分组 [" + group.id + "] 里判到 @end，整条用例结束");
        return "@end";
      }
      if (childTarget !== "@next") {
        throw new Error(
          "分组 [" + group.id + "] 里的节点 [" + child.id + "] 要跳到 " + childTarget +
            "，而组内只支持 @next / @end / @abort。要跳转就把这一步移出分组"
        );
      }
    }
  }

  results.push({
    id: group.id,
    name: group.name,
    type: "group",
    status: "passed",
    repeat: repeat,
    durationMs: Date.now() - startedAt
  });
  context.logger.info(
    "分组 [" + group.id + "] " + group.name + " 跑完 " + repeat + " 遍"
  );
  return group.onSuccess || "@next";
}

// 动作之前的等待。录制时人在这一步之前停了多久，回放就先停多久，再做动作。
//
// **为什么等待挂在「下一个动作」身上**：人点完第 1 步、盯着加载转了五分钟、
// 才做第 2 个动作——这五分钟是第 2 步的前提，不是第 1 步的尾巴。
// 2026-09-30 之前录的是"这一步之前的停顿"、写的却是 postWaitMs（动作之后等多久），
// 整条链错一位：第 1 步点完立刻打第 2 步，而第 2 步该等的被挪到它自己后面去了。
// 老用例身上的 postWaitMs 保持原样解释，不动它们的行为。
function waitBeforeNode(context, node) {
  var waitMs = node.preWaitMs;
  if (waitMs == null || waitMs <= 0) return;
  context.logger.info(
    "节点 [" + node.id + "] " + node.name + " 动作前等待 " +
      recordedCase.formatWaitMs(waitMs) + "（" + waitMs + " 毫秒）"
  );
  control.sleepInterruptibly(waitMs, context.logger);
}

// 只执行一个节点，供单步调试用（STEP-DEBUG.md）。
// 与整条跑共用同一套方向断言和坐标换算——调试时的行为必须和真跑一模一样，
// 否则"单步验过了、整条还是错"，调试就失去意义。
// **唯一的例外是 preWaitMs：单步调试不等它。** 人就站在设备前按了「只跑这一步」，
// 让他对着屏幕干等二十分钟没有任何意义，而要验的是这一步的动作本身。
// **不产出 result.json、不进运行记录**：这是调试动作，不是一次任务运行。
// options.caseDir：assetBase 为 case 时必填；options.orientationWaitMs：方向等待上限。
function runSingleNode(context, caseData, node, options) {
  var opts = options || {};
  var scoped = withCaseAssets(context, caseData, opts);
  var baseline = node.baseline || caseData.baseline;
  if (baseline) {
    // 调试时方向不对要立刻说，不要像正式跑那样等 90 秒——人就在设备前面看着。
    var probe = {
      orientationWaitMs: opts.orientationWaitMs != null ? opts.orientationWaitMs : 3000,
      orientationPollMs: 500
    };
    waitForOrientation(scoped, probe, baseline, node);
  }
  var viewport = viewportFor(scoped, caseData, baseline, {});
  executeNode(scoped, node, viewport);
}

// device.width / device.height 是实时的：它们随前台应用的屏幕方向变化。
// 依据是 screen-autojs.js 的硬断言——截图尺寸与 device 尺寸不一致就抛错，
// 而横屏游戏里的用例能连续跑通，说明两者是一起变的。所以轮询它们有效。
//
// baseline 是**这一步**的基线（节点自己的，或退回用例的）；node 只用于报错时
// 说清是卡在哪一步，转屏发生在第几步一眼能看出来。
function waitForOrientation(context, caseData, baseline, node) {
  var baselineIsLandscape = baseline.width > baseline.height;
  var where = node ? "节点 [" + node.id + "] " + node.name : "用例";
  // 等待上限逐步骤给：转屏那一步要等游戏加载完（录制器给它挂 90 秒），
  // 而别的步骤没理由陪着等那么久——起点不对时要尽快报出来。
  var waitMs =
    node && node.orientationWaitMs != null
      ? node.orientationWaitMs
      : caseData.orientationWaitMs != null
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
    where +
      " 等待屏幕转到 " +
      (baselineIsLandscape ? "横屏" : "竖屏") +
      "（基线 " +
      baseline.width +
      "x" +
      baseline.height +
      "），当前 " +
      describe() +
      "，上限 " +
      waitMs +
      " 毫秒"
  );

  var deadline = Date.now() + waitMs;
  while (!matched()) {
    // 方向等待默认 20 秒。没有检查点的话，这段时间里按暂停/终止完全没反应，
    // 而它恰好是最容易让人想中止的一段（游戏没起来时就卡在这儿）。
    control.checkpoint(context.logger);
    if (Date.now() >= deadline) {
      // 方向不对是环境/时序问题（游戏没起来或没转屏），不是用例写错，算 broken。
      throw errors.broken(
        where +
          "：等待 " +
          waitMs +
          " 毫秒后屏幕方向仍与基线不一致，基线 " +
          baseline.width +
          "x" +
          baseline.height +
          "，设备 " +
          describe() +
          "。方向本身不做换算，请确认目标应用已进入并完成旋转"
      );
    }
    sleep(pollMs);
  }
  context.logger.info(where + " 的屏幕方向已就位: " + describe());
}

// 取这一步要用的 viewport，按「基线尺寸 @ 当前设备尺寸」缓存。
// 必须带上设备尺寸做键：转屏之后设备宽高换了个个儿，同一个基线也要换一份换算。
function viewportFor(context, caseData, baseline, cache) {
  var effective = baseline || { width: device.width, height: device.height };
  var key = effective.width + "x" + effective.height + "@" + device.width + "x" + device.height;
  if (!cache[key]) {
    cache[key] = createCaseViewport(context, caseData, effective);
  }
  return cache[key];
}

// baseline 缺省时用设备自身当基线，得到恒等映射——没写 baseline 的用例行为不变。
function createCaseViewport(context, caseData, sourceBaseline) {
  var from = sourceBaseline || caseData.baseline;
  var baseline = from
    ? { width: from.width, height: from.height,
        // scaleStrategy 只在用例级 baseline 上给，节点级 baseline 只带尺寸。
        scaleStrategy: from.scaleStrategy ||
          (caseData.baseline ? caseData.baseline.scaleStrategy : undefined) }
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
  if (node.type === "longTap") return executeLongTap(context, node, viewport);
  if (node.type === "multiTap") return executeMultiTap(context, node, viewport);
  if (node.type === "swipe") return executeSwipe(context, node, viewport);
  if (node.type === "swipeImage") return executeSwipeImage(context, node, viewport);
  if (node.type === "tapText") return executeTapText(context, node, viewport);
  if (node.type === "inputText") return executeInputText(context, node, viewport);
  throw new Error("未知节点类型: " + node.type);
}

function executeTap(context, node, viewport) {
  var point = geometry.resolvePoint(
    { rx: node.rx, ry: node.ry, name: node.name || node.rx + "," + node.ry },
    viewport
  );
  context.actions.tap(point, node.postWaitMs);
}

function executeLongTap(context, node, viewport) {
  var point = geometry.resolvePoint(
    { rx: node.rx, ry: node.ry, name: node.name || node.rx + "," + node.ry },
    viewport
  );
  context.actions.longPress(
    point,
    node.pressMs != null ? node.pressMs : DEFAULT_LONG_PRESS_MS,
    node.postWaitMs
  );
}

function executeMultiTap(context, node, viewport) {
  var point = geometry.resolvePoint(
    { rx: node.rx, ry: node.ry, name: node.name || node.rx + "," + node.ry },
    viewport
  );
  context.actions.multiTap(point, {
    count: node.count != null ? node.count : DEFAULT_MULTI_TAP_COUNT,
    pressMs: node.pressMs != null ? node.pressMs : DEFAULT_MULTI_TAP_PRESS_MS,
    intervalMs: node.intervalMs != null ? node.intervalMs : DEFAULT_MULTI_TAP_INTERVAL_MS,
    waitMs: node.postWaitMs
  });
}

// 起点与终点各自换算：两端都要落在设备内，越界由 resolvePoint 当场抛，
// 绝不静默夹到屏幕边上——夹出来的那一道滑动方向对了距离不对，看着像做成了。
function executeSwipe(context, node, viewport) {
  var name = node.name || "滑动";
  var from = geometry.resolvePoint({ rx: node.rx, ry: node.ry, name: name + "起点" }, viewport);
  var to = geometry.resolvePoint({ rx: node.rx2, ry: node.ry2, name: name + "终点" }, viewport);
  context.actions.drag(
    {
      name: name,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      durationMs: node.durationMs != null ? node.durationMs : DEFAULT_SWIPE_DURATION_MS
    },
    node.postWaitMs
  );
}

// 等到这张图出现为止，返回匹配中心（设备像素）。
// **两种找图节点共用这一段**：找的过程、阈值、限制区域、等多久完全一样，
// 区别只在找到之后干什么——点一下，还是从这儿拖一道。
function waitForImage(context, node, viewport) {
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
  return match;
}

// 找图后按住拖动：起点由找图定位（匹配中心 + 偏移），终点是屏幕上的固定位置。
// 终点仍然要落在设备内，越界当场抛——绝不夹到边上，夹出来的那一道方向对距离不对。
function executeSwipeImage(context, node, viewport) {
  var name = node.name || node.asset;
  var match = waitForImage(context, node, viewport);
  sleep(node.preTapMs != null ? node.preTapMs : DEFAULT_TAP_IMAGE_PRE_TAP_MS);
  var from = geometry.applyOffset(
    { x: match.centerX, y: match.centerY },
    node.offset,
    viewport,
    name + "起点"
  );
  var to = geometry.resolvePoint({ rx: node.rx2, ry: node.ry2, name: name + "终点" }, viewport);
  context.actions.drag(
    {
      name: name,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      durationMs: node.durationMs != null ? node.durationMs : DEFAULT_SWIPE_DURATION_MS
    },
    node.postWaitMs
  );
}

// 点击文字：认一遍屏幕找那段字，找到就点它的框中心。
// 与找图共用「找几次 / 找不到怎么办」那一套语义（waitMs / pollMs / onFail），
// 人在面板上看到的也是同一行字，不该因为换了识别方式就换一套说法。
//
// **认不出来是常态**：游戏自己的美术字（描金图标那种）mlkit 与 rapid 都认不出，
// 所以界面上要先「认一下」、从认出来的词里挑（见 ocr-autojs.js 文件头）。
function waitForText(context, node, viewport) {
  var findOptions = { engine: node.engine || DEFAULT_TAP_TEXT_ENGINE };
  if (node.region) {
    // 限制区域与找图同一套归一化写法，换算成设备像素的矩形。
    var box = geometry.toFindImageRegion(node.region, viewport);
    findOptions.region = {
      left: box[0],
      top: box[1],
      right: box[0] + box[2],
      bottom: box[1] + box[3]
    };
  }
  var waitMs = node.waitMs != null ? node.waitMs : DEFAULT_TAP_IMAGE_WAIT_MS;
  var pollMs = node.pollMs != null ? node.pollMs : DEFAULT_TAP_IMAGE_POLL_MS;

  var hit = null;
  context.actions.waitUntil(
    node.name || ("文字「" + node.text + "」"),
    function () {
      hit = context.screen.findText(node.text, findOptions);
      return hit !== null;
    },
    waitMs,
    pollMs
  );
  return hit;
}

function executeTapText(context, node, viewport) {
  var hit = waitForText(context, node, viewport);
  context.logger.info(
    "认到文字「" + hit.text + "」（要找的是「" + node.text + "」），框中心 (" +
      hit.centerX + "," + hit.centerY + "）"
  );
  if (node.click === false) return;
  sleep(node.preTapMs != null ? node.preTapMs : DEFAULT_TAP_IMAGE_PRE_TAP_MS);
  // 偏移与找图同一套：认到的中心是设备像素，偏移量是归一化的。
  var tapPoint = geometry.applyOffset(
    { x: hit.centerX, y: hit.centerY },
    node.offset,
    viewport,
    node.name || node.text
  );
  context.actions.tap(
    { x: tapPoint.x, y: tapPoint.y, name: node.name || node.text },
    node.postWaitMs
  );
}

// 输入文字：先把输入框点出焦点（给了 rx/ry 才点），再把内容打进去。
// **写不进去要报失败**，不能静默跳过——"报绿却没做成事"是这套东西最危险的失效，
// 一个没输入成功的账号框会让后面每一步都在错的页面上点。
function executeInputText(context, node, viewport) {
  var name = node.name || ("输入「" + node.text + "」");
  if (node.rx != null && node.ry != null) {
    var point = geometry.resolvePoint({ rx: node.rx, ry: node.ry, name: name + "的输入框" }, viewport);
    context.actions.tap({ x: point.x, y: point.y, name: name + "的输入框" }, null);
    // 点完要给输入法一点时间接上，否则紧跟着的写入落在还没聚焦的框上。
    sleep(node.focusWaitMs != null ? node.focusWaitMs : DEFAULT_TAP_IMAGE_PRE_TAP_MS);
  }
  var typist = require("../text-input-autojs.js").create({ logger: context.logger });
  var result = typist.type(node.text, {
    overwrite: node.overwrite != null ? !!node.overwrite : DEFAULT_INPUT_OVERWRITE
  });
  if (!result.ok) {
    throw new Error(
      "没能把文字写进输入框: 「" + node.text + "」。" +
        "三条路（无障碍 / 剪贴板粘贴 / root input）都没成功，多半是焦点没落在输入框上"
    );
  }
  if (node.postWaitMs) sleep(node.postWaitMs);
}

function executeTapImage(context, node, viewport) {
  var match = waitForImage(context, node, viewport);

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
  CASE_MODEL: CASE_MODEL,
  SCHEMA_VERSION: SCHEMA_VERSION,
  // 长按时长与滑动时长的缺省值和边界。**校验器是唯一权威**，编辑器按它夹，
  // 两边各写一份的话，界面允许的值会有一天被校验器拒绝，而人只看得到"保存失败"。
  // 动作前等待的上限。编辑器按它夹，校验器按它拦，只有这一处。
  MAX_PRE_WAIT_MS: MAX_PRE_WAIT_MS,
  GESTURE: {
    defaultPressMs: DEFAULT_LONG_PRESS_MS,
    minPressMs: MIN_LONG_PRESS_MS,
    maxPressMs: MAX_LONG_PRESS_MS,
    defaultSwipeMs: DEFAULT_SWIPE_DURATION_MS,
    minSwipeMs: MIN_SWIPE_DURATION_MS,
    maxSwipeMs: MAX_SWIPE_DURATION_MS
  },
  // 连续点击的缺省与上限。与 GESTURE 同一个道理：**校验器是唯一权威**，
  // 编辑器按它夹，两边各写一份的话，界面允许的值有一天会被校验器拒绝，
  // 而人只看得到一句"保存失败"。
  MULTI_TAP: {
    defaultCount: DEFAULT_MULTI_TAP_COUNT,
    defaultPressMs: DEFAULT_MULTI_TAP_PRESS_MS,
    defaultIntervalMs: DEFAULT_MULTI_TAP_INTERVAL_MS,
    maxCount: MAX_MULTI_TAP_COUNT,
    maxIntervalMs: MAX_MULTI_TAP_INTERVAL_MS
  },
  loadCase: loadCase,
  validateCase: validateCase,
  runCase: runCase,
  runSingleNode: runSingleNode
};
