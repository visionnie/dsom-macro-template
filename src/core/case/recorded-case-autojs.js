// =====================================================================
// 通用能力：把录制会话变成可回放的 JSON 用例
// 设计约束：
//   - 纯数据换算，不碰 device / files / images，便于在 PC 上用 Node 验证
//   - 锚点由人在截图上框选，这里只负责把框换算成 tapImage 节点，不替人挑锚点
//   - 录制中途屏幕方向变过的会话拒绝生成：每步的归一化坐标是按各自当时的尺寸算的，
//     混进同一条用例、共用一个 baseline 会静默点偏
// =====================================================================

// 太小的框几乎必然框到的是几个像素的纹理，换个画面就对不上，直接拒绝。
var ANCHOR_MIN_EDGE = 16;
// 锚点图存在会话目录下的这个子目录里，用例以 assetBase: "case" 相对用例文件引用。
var ANCHOR_DIR = "anchors";

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// 画布上的拖拽框 -> 截图像素框。
// placement 是截图在画布上的摆放方式：{ scale, offsetX, offsetY }。
// 往外取整：宁可多框进一个像素，也不要把人框住的边缘裁掉。
function viewBoxToImageBox(viewBox, placement, imageWidth, imageHeight) {
  var left = Math.floor((Math.min(viewBox.x1, viewBox.x2) - placement.offsetX) / placement.scale);
  var top = Math.floor((Math.min(viewBox.y1, viewBox.y2) - placement.offsetY) / placement.scale);
  var right = Math.ceil((Math.max(viewBox.x1, viewBox.x2) - placement.offsetX) / placement.scale);
  var bottom = Math.ceil((Math.max(viewBox.y1, viewBox.y2) - placement.offsetY) / placement.scale);
  left = clamp(left, 0, imageWidth);
  top = clamp(top, 0, imageHeight);
  right = clamp(right, 0, imageWidth);
  bottom = clamp(bottom, 0, imageHeight);
  return { left: left, top: top, width: right - left, height: bottom - top };
}

function assertAnchorBox(box, shot) {
  if (box.width < ANCHOR_MIN_EDGE || box.height < ANCHOR_MIN_EDGE) {
    throw new Error(
      "锚点框太小: " + box.width + "x" + box.height +
        "，至少 " + ANCHOR_MIN_EDGE + "x" + ANCHOR_MIN_EDGE + " 像素"
    );
  }
  if (box.left < 0 || box.top < 0 ||
      box.left + box.width > shot.deviceWidth ||
      box.top + box.height > shot.deviceHeight) {
    throw new Error("锚点框超出截图范围");
  }
}

function anchorAssetPath(nodeId) {
  return ANCHOR_DIR + "/" + nodeId + ".png";
}

// tap 节点 -> tapImage 节点。
// 点下去的位置不必落在锚点框里：回放时找图定位到锚点中心，再按 offset 挪回当初真正点的位置。
// 中心算法必须与 screen.findTemplate 一致（左上角 + floor(宽/2)），否则回放差一两个像素。
function toTapImageNode(node, shot, box) {
  assertAnchorBox(box, shot);
  var centerX = box.left + Math.floor(box.width / 2);
  var centerY = box.top + Math.floor(box.height / 2);
  var upgraded = {
    id: node.id,
    name: node.name,
    type: "tapImage",
    asset: anchorAssetPath(node.id)
  };
  var dx = shot.x - centerX;
  var dy = shot.y - centerY;
  if (dx !== 0 || dy !== 0) {
    // 偏移按录制时的截图尺寸归一化；用例 baseline 取的也是这个尺寸，回放时再按内容区换算回像素。
    upgraded.offset = { rx: round4(dx / shot.deviceWidth), ry: round4(dy / shot.deviceHeight) };
  }
  if (node.postWaitMs != null) upgraded.postWaitMs = node.postWaitMs;
  return upgraded;
}

// 撤销升级：从截图记录里的原始像素坐标还原死坐标节点。
function toTapNode(node, shot) {
  var restored = {
    id: node.id,
    name: node.name,
    type: "tap",
    rx: round4(clamp(shot.x / shot.deviceWidth, 0, 1)),
    ry: round4(clamp(shot.y / shot.deviceHeight, 0, 1))
  };
  if (node.postWaitMs != null) restored.postWaitMs = node.postWaitMs;
  return restored;
}

function copyNode(node) {
  return JSON.parse(JSON.stringify(node));
}

// 会话 -> 用例。session 需要 id / nodes / shots，nodes 与 shots 按下标一一对应。
function buildCase(session) {
  if (!session.nodes || session.nodes.length === 0) {
    throw new Error("会话没有任何步骤，无法生成用例");
  }
  if (!session.shots || session.shots.length !== session.nodes.length) {
    throw new Error("会话的步骤与截图记录数量不一致，无法生成用例");
  }

  var first = session.shots[0];
  var mismatched = [];
  for (var i = 0; i < session.shots.length; i++) {
    var shot = session.shots[i];
    if (shot.deviceWidth !== first.deviceWidth || shot.deviceHeight !== first.deviceHeight) {
      mismatched.push(session.nodes[i].name + "（" + shot.deviceWidth + "x" + shot.deviceHeight + "）");
    }
  }
  if (mismatched.length > 0) {
    throw new Error(
      "录制中途屏幕方向变过，以下步骤与第一步（" + first.deviceWidth + "x" + first.deviceHeight +
        "）尺寸不同: " + mismatched.join("、") + "。请删掉这些步骤后再生成"
    );
  }

  return {
    schemaVersion: 1,
    id: "recorded-" + session.id,
    name: "录制用例 " + session.id,
    assetBase: "case",
    baseline: { width: first.deviceWidth, height: first.deviceHeight },
    nodes: session.nodes.map(copyNode)
  };
}

module.exports = {
  ANCHOR_MIN_EDGE: ANCHOR_MIN_EDGE,
  viewBoxToImageBox: viewBoxToImageBox,
  toTapImageNode: toTapImageNode,
  toTapNode: toTapNode,
  buildCase: buildCase
};
