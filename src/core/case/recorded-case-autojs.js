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
// 找图的轮询间隔，与 case-runner 的 DEFAULT_TAP_IMAGE_POLL_MS 一致。
// 「找几次」就是拿它乘出来的等待上限——人关心的是"试几次"，
// 而回放器认的是"最多等多久"，换算只此一处。
var TAP_IMAGE_POLL_MS = 1500;
// 新升级成找图的步骤默认找几次、找不到怎么办。
// **默认是"继续下一步"而不是"停止"**（2026-09-27 用户要求）：
// 录制出来的流程里，找图多半用来点那些"有就点、没有就算了"的东西
// （弹窗关闭、领取奖励）。一找不到就把整条任务判死，比漏点一下糟得多。
var DEFAULT_TAP_IMAGE_TRIES = 2;
var DEFAULT_TAP_IMAGE_ON_FAIL = "@next";
// 锚点图存在会话目录下的这个子目录里，用例以 assetBase: "case" 相对用例文件引用。
var ANCHOR_DIR = "anchors";
// 默认步骤名：序号在前 + 动作名，人一眼能对上是第几步、那一步干什么。
// 改过名的步骤不再匹配这个式子，删步骤、重排时就不会被覆盖掉。
// 旧会话的「第 N 步」与「N 点击」都算默认名，一并认出来。
var DEFAULT_NAME_PATTERN = /^(?:第\s*)?(\d+)\s*(?:步)?\s*(?:点击|长按|滑动)$/;
var LEGACY_NAME_PATTERN = /^第\s*\d+\s*步$/;
// 节点类型 -> 默认名里的动作词。找图点击仍叫「点击」：它和死坐标点击
// 对人来说是同一个动作，区别只在怎么定位，那件事已经写在行尾的「找图定位」上了。
var ACTION_WORDS = {
  tap: "点击",
  tapImage: "点击",
  longTap: "长按",
  swipe: "滑动"
};
// 横跨屏幕方向的录制，转屏那一步要等游戏加载完才会转过来。
var CROSS_ORIENTATION_WAIT_MS = 90000;

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

function isLandscape(size) {
  return size.deviceWidth > size.deviceHeight;
}

// index 从 1 起。type 不给按点击算——旧调用方（以及只录点击的老路径）不用改。
function defaultNodeName(index, type) {
  return index + " " + (ACTION_WORDS[type] || ACTION_WORDS.tap);
}

function isDefaultNodeName(name) {
  var text = String(name == null ? "" : name).trim();
  return DEFAULT_NAME_PATTERN.test(text) || LEGACY_NAME_PATTERN.test(text);
}

// 删掉、插入、挪动某一步之后，后面所有默认名的序号就全错位了，而序号正是人用来
// 对照屏幕操作顺序的东西。这里只重排还叫默认名的那些，改过名的一律不动。
// 动作词也按节点当前的类型重新写：一步从点击改成滑动之后还叫「3 点击」，
// 列表上就是在骗人。
// 节点 id 不跟着改：锚点图是按 id 存的（anchors/step-03.png），改 id 会指丢素材。
function renumberDefaultNames(nodes) {
  var changed = 0;
  for (var i = 0; i < nodes.length; i++) {
    if (!isDefaultNodeName(nodes[i].name)) continue;
    var expected = defaultNodeName(i + 1, nodes[i].type);
    if (nodes[i].name !== expected) {
      nodes[i].name = expected;
      changed++;
    }
  }
  return changed;
}

// 新节点的 id。**不按"第几步"取**：插入和重排之后序号会变，而 id 一变就指丢锚点图。
// 取现有 id 里最大的数字再加一，删掉的号不回收——回收就会撞上还留在磁盘上的
// anchors/step-07.png（删除只摘节点，素材是留着的）。
function nextNodeId(nodes) {
  var max = 0;
  for (var i = 0; i < nodes.length; i++) {
    var matched = /^step-(\d+)$/.exec(String(nodes[i] && nodes[i].id));
    if (matched) {
      var value = parseInt(matched[1], 10);
      if (value > max) max = value;
    }
  }
  var next = String(max + 1);
  while (next.length < 2) next = "0" + next;
  return "step-" + next;
}

// tap 节点 -> tapImage 节点。
// 点下去的位置不必落在锚点框里：回放时找图定位到锚点中心，再按 offset 挪回当初真正点的位置。
// 中心算法必须与 screen.findTemplate 一致（左上角 + floor(宽/2)），否则回放差一两个像素。
// 「找几次」<-> 回放器认的等待上限。换算只此一处，两边各算一遍必然对不上。
function triesToWaitMs(tries) {
  var count = Math.max(1, Math.round(tries || DEFAULT_TAP_IMAGE_TRIES));
  return count * TAP_IMAGE_POLL_MS;
}

function waitMsToTries(waitMs) {
  if (waitMs == null) return DEFAULT_TAP_IMAGE_TRIES;
  return Math.max(1, Math.round(waitMs / TAP_IMAGE_POLL_MS));
}

// options: { region, onFail, tries }，都可选。
// 不给 onFail / tries 时按默认填上——**默认写进节点里而不是留空**：
// 留空等于"由回放器的默认值决定"，而那个默认是 @abort（找不到就整条失败），
// 与这里想要的行为正好相反，人却看不出来。
function toTapImageNode(node, shot, box, options) {
  assertAnchorBox(box, shot);
  var opts = options || {};
  var centerX = box.left + Math.floor(box.width / 2);
  var centerY = box.top + Math.floor(box.height / 2);
  var upgraded = {
    id: node.id,
    name: node.name,
    type: "tapImage",
    asset: anchorAssetPath(node.id),
    waitMs: triesToWaitMs(opts.tries),
    onFail: opts.onFail || DEFAULT_TAP_IMAGE_ON_FAIL
  };
  // 限制区域是可选的：不给就全屏找。给了就只在那一块里找——
  // 范围小不只是快，更是稳：同一个图案在别处也出现时，全屏找会命中错的那个。
  if (opts.region) {
    upgraded.region = opts.region;
  }
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

// 长按节点。按多久：节点上设过的优先，没设过用录制时真按了多久
// （shot.pressMs 是手指实际按住的毫秒数）。两个都没有就留空，回放按缺省值跑。
function toLongTapNode(node, shot) {
  var restored = {
    id: node.id,
    name: node.name,
    type: "longTap",
    rx: round4(clamp(shot.x / shot.deviceWidth, 0, 1)),
    ry: round4(clamp(shot.y / shot.deviceHeight, 0, 1))
  };
  var pressMs = node.pressMs != null ? node.pressMs : shot.pressMs;
  if (pressMs != null) restored.pressMs = Math.round(pressMs);
  if (node.postWaitMs != null) restored.postWaitMs = node.postWaitMs;
  return restored;
}

// 滑动节点。起点走 rx/ry（与点击同名，取点和红十字那几条路才不用各改一遍），
// 终点是 rx2/ry2，两端各按**这一步自己那一刻**的屏幕尺寸归一化。
// 终点缺失时不猜：没有终点的滑动等于一次点击，而节点写着"滑动"，
// 那正是这套东西最危险的失效——报绿却没做成事。
function toSwipeNode(node, shot) {
  if (shot.x2 == null || shot.y2 == null) {
    throw new Error("这一步没有滑动终点记录，先在游戏上取一次终点");
  }
  var restored = {
    id: node.id,
    name: node.name,
    type: "swipe",
    rx: round4(clamp(shot.x / shot.deviceWidth, 0, 1)),
    ry: round4(clamp(shot.y / shot.deviceHeight, 0, 1)),
    rx2: round4(clamp(shot.x2 / shot.deviceWidth, 0, 1)),
    ry2: round4(clamp(shot.y2 / shot.deviceHeight, 0, 1))
  };
  var durationMs = node.durationMs != null ? node.durationMs : shot.durationMs;
  if (durationMs != null) restored.durationMs = Math.round(durationMs);
  if (node.postWaitMs != null) restored.postWaitMs = node.postWaitMs;
  return restored;
}

// 按节点自己的手势类型从 shot 重建。找图节点不在这条路上——
// 它要的是"相对锚点中心的偏移"，见 rebuildNode。
function toGestureNode(node, shot) {
  if (node.type === "swipe") return toSwipeNode(node, shot);
  if (node.type === "longTap") return toLongTapNode(node, shot);
  return toTapNode(node, shot);
}

// 把一整道滑动平移到新的起点，返回平移后的四个像素坐标。
// **只挪起点会把人录好的方向和距离改掉**，所以终点跟着走同样的位移。
// 挪出屏幕时两端一起夹（先把位移夹住，再加上去）：只夹越界那一端，
// 等于悄悄把这道滑动改短了，而人看读数只会看到起点对了。
function shiftSwipeShot(shot, target) {
  if (shot.x2 == null || shot.y2 == null) {
    throw new Error("这一步没有滑动终点记录，挪不了整道滑动");
  }
  var maxX = shot.deviceWidth - 1;
  var maxY = shot.deviceHeight - 1;
  var dx = clamp(
    Math.round(target.x) - shot.x,
    -Math.min(shot.x, shot.x2),
    Math.min(maxX - shot.x, maxX - shot.x2)
  );
  var dy = clamp(
    Math.round(target.y) - shot.y,
    -Math.min(shot.y, shot.y2),
    Math.min(maxY - shot.y, maxY - shot.y2)
  );
  return {
    x: shot.x + dx,
    y: shot.y + dy,
    x2: shot.x2 + dx,
    y2: shot.y2 + dy
  };
}

// 屏幕像素矩形 -> 用例里的归一化区域。
// 与节点坐标同一套基准（各步自己那一刻的屏幕尺寸），回放时按内容区再换算回像素。
// **往里收一个像素都不收**：宁可区域大一点点，也别把人框住的边缘切掉，
// 切掉的那一列恰好是模板边缘时，找图就再也匹配不上了。
function boxToRegion(box, shot) {
  var rx = clamp(box.left / shot.deviceWidth, 0, 1);
  var ry = clamp(box.top / shot.deviceHeight, 0, 1);
  var rw = clamp(box.width / shot.deviceWidth, 0, 1 - rx);
  var rh = clamp(box.height / shot.deviceHeight, 0, 1 - ry);
  if (rw <= 0 || rh <= 0) {
    throw new Error("限制区域宽高为 0，重新框一次");
  }
  return { rx: round4(rx), ry: round4(ry), rw: round4(rw), rh: round4(rh) };
}

// 归一化区域 -> 当前屏幕像素，供界面回显"这块区域现在在哪儿"。
function regionToBox(region, shot) {
  return {
    left: Math.round(region.rx * shot.deviceWidth),
    top: Math.round(region.ry * shot.deviceHeight),
    width: Math.round(region.rw * shot.deviceWidth),
    height: Math.round(region.rh * shot.deviceHeight)
  };
}

// 人在复核页挪了点击点之后，按 shot 里的新像素坐标重算这个节点。
// 死坐标重算 rx/ry；找图节点重算相对锚点中心的偏移——锚点框不动，
// 动的是"找到锚点之后往哪儿挪"，所以拿会话里记着的那个框原样再算一次。
// 滑动是**整道一起挪**：调用方把 shot 的起点和终点同时移过去再进来，
// 这里只照着重算——只挪起点会把人录好的方向和距离改掉。
function rebuildNode(node, shot) {
  if (node.type !== "tapImage") {
    return toGestureNode(node, shot);
  }
  if (!shot.anchorBox) {
    throw new Error(
      "这一步是找图点击，但会话里没有锚点框记录，挪不了点击点。请重新框一次锚点"
    );
  }
  // 区域、找几次、找不到怎么办，都跟着节点走：挪一下点击点，
  // 不该把人设好的这些抹掉。
  return toTapImageNode(node, shot, shot.anchorBox, {
    region: node.region,
    onFail: node.onFail,
    tries: waitMsToTries(node.waitMs)
  });
}

function copyNode(node) {
  return JSON.parse(JSON.stringify(node));
}

// 会话 -> 用例。session 需要 id / nodes / shots，nodes 与 shots 按下标一一对应。
//
// **录制中途屏幕方向变过是正常情况，不是错误**：盒子里是竖屏，点「进入游戏」之后
// 才转横屏，而录登录流程必然横跨这一下（2026-09-17 用户实测：9 步里前 3 步 720x1280、
// 后 6 步 1280x720）。早先这里直接拒绝生成，等于把最该录的流程挡在门外。
//
// 之所以能支持：每一步的 rx/ry 本来就是按**它自己那一刻**的屏幕尺寸归一化的
// （见 recorder 的 toRatio）。所以只要把与第一步尺寸不同的那些步骤各自的尺寸
// 写进节点，回放时按节点自己的基线换算，坐标就仍然成立。
// 与第一步同尺寸的节点不写 baseline：用例保持干净，旧用例也一字不用改。
function buildCase(session) {
  if (!session.nodes || session.nodes.length === 0) {
    throw new Error("会话没有任何步骤，无法生成用例");
  }
  if (!session.shots || session.shots.length !== session.nodes.length) {
    throw new Error("会话的步骤与截图记录数量不一致，无法生成用例");
  }

  var first = session.shots[0];
  var nodes = [];
  var crossesOrientation = false;
  for (var i = 0; i < session.nodes.length; i++) {
    var node = copyNode(session.nodes[i]);
    var shot = session.shots[i];
    // **录制用例里没写 onFail 的找图步骤，按「继续下一步」跑。**
    // 回放器本身的默认是 @abort（找不到就整条失败），那对手写用例是对的——
    // 那些步骤每一步都是流程的骨架。但录出来的找图多半是「有就点、没有就算了」
    // （关弹窗、领奖励），一找不到就把整条任务判死，比漏点一下糟得多
    // （2026-09-27 用户实机：第 1 步找不到签到按钮，整条就停在那儿不动了）。
    //
    // 想让某一步找不到就停，在面板上点「停止任务」——那会显式写成 @abort，
    // 这里就不再覆盖。**显式的永远优先于默认的。**
    if (node.type === "tapImage" && node.onFail == null) {
      node.onFail = DEFAULT_TAP_IMAGE_ON_FAIL;
    }
    if (shot.deviceWidth !== first.deviceWidth || shot.deviceHeight !== first.deviceHeight) {
      node.baseline = { width: shot.deviceWidth, height: shot.deviceHeight };
      if (isLandscape(shot) !== isLandscape(first)) {
        crossesOrientation = true;
        // 长等待只给**转屏之后**的步骤：它们要等的是 H5 游戏加载完才会转过来。
        // 挂在整条用例上的话，第一步（还在盒子里、根本不涉及转屏）也要陪着等满，
        // 起点不对时白白烧掉 90 秒才报错（2026-09-17 用户实测）。
        node.orientationWaitMs = CROSS_ORIENTATION_WAIT_MS;
      }
    }
    nodes.push(node);
  }

  var caseData = {
    // 显式写出 model，让产物自带结构标识，不靠「有没有 nodes」去猜。
    model: "nodes",
    schemaVersion: 1,
    id: "recorded-" + session.id,
    // 人取的名字优先：日志、运行记录、常驻汇总里显示的都是它，
    // 没取名才退回会话号。名字存在 session.json 里，所以重新生成也不会丢。
    name: session.name || "录制用例 " + session.id,
    assetBase: "case",
    baseline: { width: first.deviceWidth, height: first.deviceHeight },
    nodes: nodes
  };
  // crossesOrientation 只用来决定要不要给转屏步骤挂长等待，本身不写进用例：
  // 等待时间现在是**逐步骤**的（见上），整条用例不再共用一个 90 秒。
  return caseData;
}

module.exports = {
  ANCHOR_MIN_EDGE: ANCHOR_MIN_EDGE,
  DEFAULT_TAP_IMAGE_TRIES: DEFAULT_TAP_IMAGE_TRIES,
  triesToWaitMs: triesToWaitMs,
  waitMsToTries: waitMsToTries,
  viewBoxToImageBox: viewBoxToImageBox,
  shiftSwipeShot: shiftSwipeShot,
  boxToRegion: boxToRegion,
  regionToBox: regionToBox,
  toTapImageNode: toTapImageNode,
  toTapNode: toTapNode,
  toLongTapNode: toLongTapNode,
  toSwipeNode: toSwipeNode,
  toGestureNode: toGestureNode,
  rebuildNode: rebuildNode,
  defaultNodeName: defaultNodeName,
  isDefaultNodeName: isDefaultNodeName,
  renumberDefaultNames: renumberDefaultNames,
  nextNodeId: nextNodeId,
  buildCase: buildCase
};
