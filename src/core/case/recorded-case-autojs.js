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
// 「连续点击」与「空等待」原先漏在这个式子外面：那两种类型的步骤改完类型之后
// 就不再被当成默认名，于是删一步、挪一步时它们的序号不再跟着重排，
// 运行条上也会把「4 连续点击」当成人取的名字显示出来。
var DEFAULT_NAME_PATTERN =
  /^(?:第\s*)?(\d+)\s*(?:步)?\s*(?:连续点击|点击文字|输入文字|点击|长按|滑动|空等待|等待)$/;
var LEGACY_NAME_PATTERN = /^第\s*\d+\s*步$/;
// 「＋ 添加节点」加出来的那一步叫「step-06 空等待」——名字里带的是节点 id。
// 它同样是自动起的名，不是人取的，所以一并认成默认名：
// 不认的话，列表上会显示一串磁盘目录名（用户 2026-10-08 的截图就是这个）。
var ADDED_NAME_PATTERN = /^step-\d+\s*(?:空等待|等待)$/;
// 连续点击的缺省三件套。与 case-runner 里那三个常量**必须一致**——
// 一边改了另一边没改，表现是"界面显示 80 毫秒，跑起来按的是别的数"。
var DEFAULT_MULTI_TAP_COUNT = 1;
var DEFAULT_MULTI_TAP_PRESS_MS = 80;
var DEFAULT_MULTI_TAP_INTERVAL_MS = 100;
// 节点类型 -> 默认名里的动作词。找图点击仍叫「点击」：它和死坐标点击
// 对人来说是同一个动作，区别只在怎么定位，那件事已经写在行尾的「找图定位」上了。
var ACTION_WORDS = {
  tap: "点击",
  tapImage: "点击",
  longTap: "长按",
  multiTap: "连续点击",
  swipe: "滑动",
  swipeImage: "滑动",
  noop: "等待",
  // 这两样与上面几种不同：它们定位靠的不是坐标也不是图，而是屏幕上的字。
  // 动作词里带上"文字"，列表上才看得出这一步为什么会"有时候找不到"。
  tapText: "点击文字",
  inputText: "输入文字",
  // 循环分组：它不是一个动作，是"把下面几步跑 N 遍"。
  group: "循环分组"
};

// ---- 循环分组 ----
// 2026-10-06 用户要的：选中连续的几步合成一组，整组跑 N 遍。
//
// **子节点平铺在 nodes 里，分组只存 id 引用**，不做成真嵌套。理由是这个项目
// 已有的三条约束：锚点图按节点 id 存（anchors/step-03.png）、entry 按 id 找节点、
// 回放器是按 id 跳转的状态机。改成嵌套这三样全要重写，老用例的迁移也会很难。
// 平铺 + 引用是纯增量：**不认识 group 的老用例一个字都不用改**。
//
// 排列：分组节点插在第一个子步骤前面，子步骤原地不动。于是 nodes 看起来是
//   [..., group, child1, child2, ..., 后面的]
// 回放器走到 group 时把子步骤跑 N 遍，再往下走；child1/child2 身上有 groupId，
// 主干遇到它们直接跳过——**没有这个标记它们会被跑两遍**。
var GROUP_TYPE = "group";
// 新建的分组默认跑几遍。**1 遍**（用户 2026-10-08 要求）：建组这一下本身
// 不该替人决定"这段要跑两遍"。次数在分组面板上调，那儿才看得见它含哪几步。
var DEFAULT_GROUP_REPEAT = 1;
// 循环次数的上限。**所有循环必须有界**（RULES.md），而且界面上要拦得住：
// 手滑多打一个 0 就是 20000 遍，一夜跑不完还在点游戏。
var MAX_GROUP_REPEAT = 999;

function isGroup(node) {
  return !!node && node.type === GROUP_TYPE;
}

// 分组的名字**必须由人填**（用户 2026-10-08 要求），所以这里只有一道校验，
// 没有"默认名"了。
//
// 原先默认叫「2次」，于是列表上一排分组全叫「2次」「2次」「3次」——
// 那是次数，不是名字，人根本认不出哪一组是干什么的。而改次数时它还会跟着变，
// 等于名字这一栏在替次数说话。
function checkGroupName(name) {
  var text = String(name == null ? "" : name).trim();
  if (!text) return "给这一组起个名字（比如「打一轮boss」）";
  if (text.length > 20) return "名字最多 20 个字";
  return "";
}

// 分组的 id。和步骤 id 分开取号（group-01 / step-01），两套号互不干扰——
// 共用一套的话，删掉一个分组再加一个步骤就可能撞上还留在磁盘上的 anchors/step-07.png。
function nextGroupId(nodes) {
  var max = 0;
  for (var i = 0; i < nodes.length; i++) {
    var matched = /^group-(\d+)$/.exec(String(nodes[i] && nodes[i].id));
    if (matched) {
      var value = parseInt(matched[1], 10);
      if (value > max) max = value;
    }
  }
  var next = String(max + 1);
  while (next.length < 2) next = "0" + next;
  return "group-" + next;
}

// 这几步能不能合成一组。**不合法时说清楚为什么**，别只返回 false——
// 界面照着这句话提示人下一步做什么。
function checkGroupable(nodes, indexes) {
  if (!indexes || indexes.length < 2) {
    return "至少要选两步才能合成一组";
  }
  var sorted = indexes.slice().sort(function (a, b) { return a - b; });
  for (var i = 0; i < sorted.length; i++) {
    var node = nodes[sorted[i]];
    if (!node) return "选中的步骤不存在，退出去重进一次";
    // 组里不能再套组（第一版）。套起来之后"执行多少次"会变成乘法，
    // 而界面上很难让人一眼看懂自己到底设了几次。
    if (isGroup(node)) return "选中的里面有分组，分组暂时不能再套分组";
    if (node.groupId) return "选中的里面有已经在别的分组里的步骤，先把那一组解散";
    // 不连续的不合并。自动把它们挪到一起等于**背着人改了执行顺序**，
    // 而顺序一变，后面每一步的画面前提都变了，人还看不出来。
    if (i > 0 && sorted[i] !== sorted[i - 1] + 1) {
      return "只能合并挨在一起的几步。先用「调整顺序」把它们排到一起";
    }
  }
  return "";
}

// 合成一组。**就地改 nodes 与 shots**，返回新分组节点的下标。
// shots 要跟着插一条：buildCase 要求 nodes 与 shots 一一对应，
// 少一条的表现是「会话的步骤与截图记录数量不一致，无法生成用例」——
// 一句跟分组毫无关系的话。分组自己没有截图，拿第一个子步骤那张顶上，
// 这样它的 deviceWidth/Height 也是对的（buildCase 要据此写 baseline）。
function makeGroup(nodes, shots, indexes, options) {
  var opts = options || {};
  var reason = checkGroupable(nodes, indexes);
  if (reason) throw new Error(reason);
  // 名字必填。**在这一层拦**，不是只在界面上拦：界面只有一条路，
  // 而这个函数以后会被别的路调到，两边各判一次迟早只剩一次。
  var nameReason = checkGroupName(opts.name);
  if (nameReason) throw new Error(nameReason);

  var sorted = indexes.slice().sort(function (a, b) { return a - b; });
  var first = sorted[0];
  var repeat = clampGroupRepeat(opts.repeat == null ? DEFAULT_GROUP_REPEAT : opts.repeat);

  var childIds = [];
  for (var i = 0; i < sorted.length; i++) {
    var child = nodes[sorted[i]];
    childIds.push(child.id);
  }

  var group = {
    id: nextGroupId(nodes),
    name: String(opts.name).trim(),
    type: GROUP_TYPE,
    repeat: repeat,
    children: childIds
  };
  // 标记放在建好 group 之后：中途抛错时 nodes 还是干净的。
  for (var c = 0; c < sorted.length; c++) {
    nodes[sorted[c]].groupId = group.id;
  }
  nodes.splice(first, 0, group);
  shots.splice(first, 0, copyShotFor(shots[first]));
  return first;
}

// 解散：分组节点摘掉，子步骤原样留下（**一个都不删**）。
function ungroup(nodes, shots, groupIndex) {
  var group = nodes[groupIndex];
  if (!isGroup(group)) throw new Error("这一步不是分组");
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].groupId === group.id) delete nodes[i].groupId;
  }
  nodes.splice(groupIndex, 1);
  shots.splice(groupIndex, 1);
}

// 删除整组：分组节点连同它的子步骤一起摘掉。
// 与「解散」是两回事，界面上两个入口都要有——用户要的是
// "这一整段不要了"和"拆开但留着"两种，混成一个的后果是误删。
function removeGroup(nodes, shots, groupIndex) {
  var group = nodes[groupIndex];
  if (!isGroup(group)) throw new Error("这一步不是分组");
  var removed = 0;
  // 从后往前删：从前往后删会让后面的下标一路错位。
  for (var i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].groupId === group.id) {
      nodes.splice(i, 1);
      shots.splice(i, 1);
      removed++;
    }
  }
  var at = indexOfNodeId(nodes, group.id);
  if (at >= 0) {
    nodes.splice(at, 1);
    shots.splice(at, 1);
  }
  return removed;
}

// 删掉一步（分组走 removeGroup，不是这个）。
//
// **摘掉节点的同时必须把它从所在分组的 children 里删掉。** 留一个指不到的 id，
// 回放器走到那一组时整条任务当场抛「分组里的步骤不存在」（case-runner 的 runGroup），
// 而人看到的是一条昨天还好好的任务今天起跑就死，日志里那句话跟他刚才的操作对不上。
//
// 2026-10-08 之前这条路实际走不到（组内步骤没有删除入口，列表上也点不到），
// 现在组内列表里就能逐个删，于是它从"潜在的"变成"一点就中"。
//
// 删到一个子步骤都不剩时**把空分组一并删掉**：留一个空壳在列表上，人看到的是
// "还有一组在那儿"，而它跑起来只是一句 skipped——界面与实际行为又对不上。
function removeNodeAt(nodes, shots, index) {
  var node = nodes[index];
  if (!node) throw new Error("这一步不存在，退出去重进一次");
  if (isGroup(node)) throw new Error("这是一个分组，删整组要走「删除分组」");

  var hostId = node.groupId || "";
  nodes.splice(index, 1);
  shots.splice(index, 1);

  var emptiedGroupName = "";
  if (hostId) {
    var at = indexOfNodeId(nodes, hostId);
    if (at >= 0) {
      var host = nodes[at];
      var kept = [];
      var children = host.children || [];
      for (var i = 0; i < children.length; i++) {
        if (children[i] !== node.id) kept.push(children[i]);
      }
      host.children = kept;
      if (kept.length === 0) {
        emptiedGroupName = host.name;
        nodes.splice(at, 1);
        shots.splice(at, 1);
      }
    }
  }
  return { name: node.name, emptiedGroupName: emptiedGroupName };
}

// 把刚插进来的一步并进"它前一步所在的那个分组"（补录、插一步都要走这个）。
//
// 不并的话，新那一步**物理上躺在分组的几步中间、却不属于这一组**：
// 组内那一页上看不见它（它没有 groupId），根节点那一页又把它夹在分组行后面，
// 而回放时整组跑完之后它才单独跑一次——三处说法互相矛盾，人根本对不上。
//
// 前一步不在任何分组里就什么都不做，返回空串。并进去了就返回分组的名字，
// 让界面说一句"已并进分组 X"——不说的话，人只看到列表上多了一行。
function joinGroupOf(nodes, nodeId, anchorId) {
  var anchorAt = indexOfNodeId(nodes, anchorId);
  if (anchorAt < 0) return "";
  var anchor = nodes[anchorAt];
  var hostId = anchor.groupId || "";
  if (!hostId) return "";
  var hostAt = indexOfNodeId(nodes, hostId);
  if (hostAt < 0) return "";
  var nodeAt = indexOfNodeId(nodes, nodeId);
  if (nodeAt < 0) return "";

  var host = nodes[hostAt];
  nodes[nodeAt].groupId = hostId;
  var list = (host.children || []).slice();
  var anchorIn = -1;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === anchorId) { anchorIn = i; break; }
  }
  // children 的顺序就是组内的执行顺序：追加到末尾的话，人看到的是
  // "插在这一步后面"，跑起来却是整组的最后一步。
  var at = anchorIn < 0 ? list.length : anchorIn + 1;
  host.children = list.slice(0, at).concat([nodeId]).concat(list.slice(at));
  return host.name || hostId;
}

// ---- 剪贴板式的复制 / 粘贴（2026-10-08）----
//
// 用户 2026-10-08 要的形态（参照自动按键精灵）：长按「分组1」→ 复制分组，
// 再长按「节点2」→ 黏贴到节点(后)，结果是副本落在节点 2 后面。
//
// **这和原先那个 cloneGroup 不是一回事**，所以它整个被换掉了：那一个是就地插在
// 原组正后面、落点不可选，做不出"原组、节点2、副本"这种排法。换 id 那套逻辑原样搬过来。
//
// 剪贴板本身**不在这一层**：这一层只认"快照"这个纯数据，谁拿着它、活多久由界面决定
// （界面那头定的是浮层关掉就清空，见 step-overlay）。

// 把一步或一整组拍成快照。分组连它的子步骤一起拍，顺序就是 nodes 里的顺序。
// shots 一起拍：少一条的表现是粘完生成用例时报「步骤与截图记录数量不一致」，
// 一句跟复制粘贴毫无关系的话。
function snapshotNodes(nodes, shots, index) {
  var node = nodes[index];
  if (!node) throw new Error("这一步不存在，退出去重进一次");
  var picked = [index];
  if (isGroup(node)) {
    for (var i = index + 1; i < nodes.length; i++) {
      if (nodes[i].groupId !== node.id) break;
      picked.push(i);
    }
  }
  var snapshotNodeList = [];
  var snapshotShotList = [];
  for (var p = 0; p < picked.length; p++) {
    snapshotNodeList.push(JSON.parse(JSON.stringify(nodes[picked[p]])));
    snapshotShotList.push(copyShotFor(shots[picked[p]]));
  }
  return {
    kind: isGroup(node) ? GROUP_TYPE : "node",
    name: node.name,
    count: picked.length,
    nodes: snapshotNodeList,
    shots: snapshotShotList
  };
}

// 能不能粘到这儿。**说清楚为什么**，界面照这句话提示人下一步做什么。
function checkPasteable(nodes, snapshot, targetIndex, where) {
  if (!snapshot || !snapshot.nodes || snapshot.nodes.length === 0) {
    return "剪贴板是空的。先长按一个节点，选「复制」";
  }
  var target = nodes[targetIndex];
  if (!target) return "要粘到的那一步不存在，退出去重进一次";
  if (where !== "before" && where !== "after") return "粘到前面还是后面没说清楚";
  // 组里不能再套组（第一版的规矩，见文件头）。落点在某个分组里面时，
  // 粘一整组进去就是嵌套，次数会变成乘法，而界面上没法让人一眼看懂自己设了几次。
  if (snapshot.kind === GROUP_TYPE && target.groupId) {
    return "分组不能粘进分组里。先退回根节点再粘，或者把那一组解散";
  }
  return "";
}

// 粘贴。**就地改 nodes 与 shots**，返回粘进来的第一个节点的下标。
//
// 落点落在某个分组里面时，粘进来的普通步骤**跟着入组**（写 groupId，并插进那一组的
// children 对应位置）——人是在组内列表里点的"粘到这一步后面"，粘出来的东西却不属于
// 这一组的话，它在组内列表上根本不显示，等于粘丢了。
//
// id 全部换新。**锚点图不跟着复制，副本与原件共用同一张**：那张图是只读地拿去匹配的，
// 共用跑起来完全正确；哪天在副本上重新框一次，它就会写进自己 id 那张、自动分家。
function pasteSnapshot(nodes, shots, snapshot, targetIndex, where) {
  var reason = checkPasteable(nodes, snapshot, targetIndex, where);
  if (reason) throw new Error(reason);

  var target = nodes[targetIndex];
  var at;
  if (where === "before") {
    at = targetIndex;
  } else {
    at = targetIndex + 1;
    // 粘到一个分组"后面"，要跨过它的子步骤，否则副本会插进那一组里。
    if (isGroup(target)) {
      while (at < nodes.length && nodes[at].groupId === target.id) at++;
    }
  }

  // 落点所在的分组。分组节点自己没有 groupId，所以粘在分组行前后都算根层。
  var hostId = target.groupId || "";

  // 取号边取边记：两步连着取号时不先把前一个记下来，两份会撞上同一个 id。
  var working = nodes.slice();
  var idMap = {};
  var copies = [];
  for (var i = 0; i < snapshot.nodes.length; i++) {
    var copy = JSON.parse(JSON.stringify(snapshot.nodes[i]));
    var oldId = copy.id;
    copy.id = isGroup(copy) ? nextGroupId(working) : nextNodeId(working);
    idMap[oldId] = copy.id;
    working.push(copy);
    copies.push(copy);
  }
  // 引用关系按新号重连。分组快照里，第一个必是那个分组节点。
  for (var c = 0; c < copies.length; c++) {
    var one = copies[c];
    if (isGroup(one)) {
      var rebuilt = [];
      var children = one.children || [];
      for (var k = 0; k < children.length; k++) {
        if (idMap[children[k]]) rebuilt.push(idMap[children[k]]);
      }
      one.children = rebuilt;
      // 分组只会粘在根层（上面已经拦住了粘进组里），所以它自己不属于任何组。
      delete one.groupId;
    } else if (one.groupId && idMap[one.groupId]) {
      // 整组复制过来的子步骤：跟着新分组走。
      one.groupId = idMap[one.groupId];
    } else if (hostId) {
      // 单独一步粘进某个分组里：入组。
      one.groupId = hostId;
    } else {
      delete one.groupId;
    }
  }

  for (var s = 0; s < copies.length; s++) {
    nodes.splice(at + s, 0, copies[s]);
    shots.splice(at + s, 0, copyShotFor(snapshot.shots[s]));
  }

  // 入组的那几步要写进宿主分组的 children，位置跟着落点走——
  // children 的顺序就是组内的执行顺序，追加到末尾的话，人看到的是"粘在这一步后面"，
  // 跑起来却是最后才跑。
  if (hostId && snapshot.kind !== GROUP_TYPE) {
    var hostAt = indexOfNodeId(nodes, hostId);
    if (hostAt >= 0) {
      var host = nodes[hostAt];
      var list = (host.children || []).slice();
      var anchorAt = -1;
      for (var h = 0; h < list.length; h++) {
        if (list[h] === target.id) { anchorAt = h; break; }
      }
      var insertAt = anchorAt < 0 ? list.length : (where === "before" ? anchorAt : anchorAt + 1);
      var newIds = [];
      for (var n = 0; n < copies.length; n++) newIds.push(copies[n].id);
      host.children = list.slice(0, insertAt).concat(newIds).concat(list.slice(insertAt));
    }
  }

  return at;
}

function clampGroupRepeat(value) {
  var n = Math.floor(Number(value));
  if (!(n >= 1)) return 1;
  return n > MAX_GROUP_REPEAT ? MAX_GROUP_REPEAT : n;
}

function indexOfNodeId(nodes, id) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i] && nodes[i].id === id) return i;
  }
  return -1;
}

// 分组自己没有截图。拿一张现成的复制出来只为两件事：
// 让 nodes 与 shots 数量对得上，以及让 buildCase 读得到 deviceWidth/Height。
function copyShotFor(shot) {
  if (!shot) return { deviceWidth: 0, deviceHeight: 0 };
  return JSON.parse(JSON.stringify(shot));
}

// 这一步靠找图定位吗。两种找图节点（点一下 / 拖一道）在素材、限制区域、
// 找几次、找不到怎么办这些事上**完全一样**，各处判断只认这一个函数，
// 别再写 `type === "tapImage"` ——漏掉 swipeImage 的地方会表现成
// 「截图权限不申请」「素材不校验」这类看不出根因的毛病。
// 这一步靠屏幕上的文字定位吗。与 usesImage 同一个道理：**各处只认这一个函数**。
// 两种认字节点（点它 / 往里打字）在"要有一段文字""要申请截图权限"
// （点击文字要截屏去认）这些事上一致，漏判一处就是"截图没申请、永远认不出"。
function usesText(node) {
  return !!node && (node.type === "tapText" || node.type === "inputText");
}

function usesImage(node) {
  return !!node && (node.type === "tapImage" || node.type === "swipeImage");
}

// 一个等待读给人听是多长。**只有这一处**：日志、步骤列表、单步面板都用它，
// 各写一份的话，同一个 1200000 会在三个地方显示成三种样子。
function formatWaitMs(waitMs) {
  var ms = Math.max(0, Math.round(waitMs || 0));
  if (ms === 0) return "不等";
  if (ms < 1000) return ms + " 毫秒";
  if (ms < 60000) {
    var seconds = Math.round(ms / 100) / 10;
    return seconds + " 秒";
  }
  var totalSeconds = Math.round(ms / 1000);
  var minutes = Math.floor(totalSeconds / 60);
  var restSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return restSeconds === 0 ? minutes + " 分" : minutes + " 分 " + restSeconds + " 秒";
  }
  var hours = Math.floor(minutes / 60);
  var restMinutes = minutes % 60;
  return restMinutes === 0 ? hours + " 小时" : hours + " 小时 " + restMinutes + " 分";
}
// 横跨屏幕方向的录制，转屏那一步要等游戏加载完才会转过来。
var CROSS_ORIENTATION_WAIT_MS = 90000;

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

// 等待跟着节点走。**两个字段各管各的**：
//   preWaitMs   这一步的动作**之前**等多久——录制器从 2026-09-30 起记的是它
//   postWaitMs  动作**之后**等多久——2026-09-30 之前的老录制身上带的是它
// 换动作类型、挪坐标、重建节点，都不该把人调好的等待弄丢，所以每个 to*Node 都过这一遍。
function carryWaits(target, node) {
  if (node.preWaitMs != null) target.preWaitMs = node.preWaitMs;
  if (node.postWaitMs != null) target.postWaitMs = node.postWaitMs;
  return target;
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
  return DEFAULT_NAME_PATTERN.test(text) ||
    LEGACY_NAME_PATTERN.test(text) ||
    ADDED_NAME_PATTERN.test(text);
}

// 给人看、给人改的那个名字**本身**，不含序号（2026-10-08）。
//
// 默认名历来是「3 点击」这种"序号 + 动作"，序号就腌在名字里。于是改名时
// 那个序号也躺在输入框里，人一改就把它弄没了——用户 2026-10-08 原话：
// 「默认有一个序号，是自动维护的……这个在修改名称的时候，不应该可以直接修改」。
// 现在序号由界面按"当前这一页的第几行"自己写，名字这头只留动作词。
//
// **盘上的数据一个字不用动**：老录制里仍然存着「3 点击」，这里认出它是默认名
// 就把序号摘掉再交给界面。人取过的名字原样返回——哪怕他起的名字里真的带数字。
function bareName(node) {
  var text = String((node && node.name) || "").trim();
  var word = ACTION_WORDS[node && node.type] || ACTION_WORDS.tap;
  if (!text) return word;
  return isDefaultNodeName(text) ? word : text;
}

// 运行时显示给人看的一句话：**有名字就显示名字，没取过名就显示它在做什么动作**。
// 默认名（「5 点击」）算"没取过名"——跑起来的那一条已经写着「第[5]步」了，
// 再跟一个「5 点击」等于把序号说两遍，而真正有用的是"这一步是干嘛的"
// （用户 2026-10-01 的要求：>> 后面是节点名字，不是行为；没设名字才退回动作）。
//
// 手写用例里的名字（「关公告」「等主城加载」）天生就不是默认名，照原样显示。
function displayLabel(node) {
  if (node && node.name && !isDefaultNodeName(node.name)) {
    return String(node.name);
  }
  return ACTION_WORDS[node && node.type] || "动作";
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
  carryWaits(upgraded, node);
  return upgraded;
}

// 找图后拖动：**起点由找图定位**（匹配中心 + 偏移，与 tapImage 同一套），
// **终点是屏幕上的固定位置**（rx2/ry2，与 swipe 同一套）。
//
// 终点为什么不跟着匹配点走：拖拽的落点通常是屏幕上某个固定的格子或区域
// （背包格、快捷栏、垃圾桶），它不随被拖的东西移动。人要的是"把它拖到那儿"。
// 真遇到"终点也要跟着图走"的场景，再加一种表达，别把这一种改成两用。
function toSwipeImageNode(node, shot, box, options) {
  if (shot.x2 == null || shot.y2 == null) {
    throw new Error("这一步没有拖动终点记录，先在游戏上取一次终点");
  }
  // 锚点、偏移、找几次、找不到怎么办全部复用——两种找图节点在这些事上没有区别。
  var upgraded = toTapImageNode(node, shot, box, options);
  upgraded.type = "swipeImage";
  upgraded.rx2 = round4(clamp(shot.x2 / shot.deviceWidth, 0, 1));
  upgraded.ry2 = round4(clamp(shot.y2 / shot.deviceHeight, 0, 1));
  var durationMs = node.durationMs != null ? node.durationMs : shot.durationMs;
  if (durationMs != null) upgraded.durationMs = Math.round(durationMs);
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
  carryWaits(restored, node);
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
  carryWaits(restored, node);
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
  carryWaits(restored, node);
  return restored;
}

// 空等待节点：只等时间，不碰屏幕。回放器的 noop 从第一版就在（执行时直接跳过），
// 这一轮只是把它接到界面上——配上 preWaitMs 就是「只等不做」。
// **坐标不写进节点，但 shot 原样留着**：改回点击 / 滑动时还要拿它重建。
// 连续点击节点：位置与点击同一套 rx/ry，另外三个数是"怎么连点"。
// 三个数都**写进节点**，不留给回放器的缺省——界面上要显示"现在是几次、多快"，
// 显示成空的话人只会以为没设过，而回放时它其实在按缺省跑。
// options: { count, pressMs, intervalMs }，不给就沿用节点上已有的，再不行用默认。
function toMultiTapNode(node, shot, options) {
  var opts = options || {};
  var restored = {
    id: node.id,
    name: node.name,
    type: "multiTap",
    rx: round4(clamp(shot.x / shot.deviceWidth, 0, 1)),
    ry: round4(clamp(shot.y / shot.deviceHeight, 0, 1)),
    count: Math.max(1, Math.round(
      opts.count != null ? opts.count : (node.count != null ? node.count : DEFAULT_MULTI_TAP_COUNT)
    )),
    pressMs: Math.max(1, Math.round(
      opts.pressMs != null ? opts.pressMs : (node.pressMs != null ? node.pressMs : DEFAULT_MULTI_TAP_PRESS_MS)
    )),
    intervalMs: Math.max(0, Math.round(
      opts.intervalMs != null
        ? opts.intervalMs
        : (node.intervalMs != null ? node.intervalMs : DEFAULT_MULTI_TAP_INTERVAL_MS)
    ))
  };
  carryWaits(restored, node);
  return restored;
}

function toNoopNode(node) {
  var restored = {
    id: node.id,
    name: node.name,
    type: "noop"
  };
  carryWaits(restored, node);
  return restored;
}

// 点击文字节点：定位靠屏幕上的字，不靠坐标也不靠图。
// **坐标不写进节点，但 shot 原样留着**（与 noop 同一条规矩）：改回点击时还要拿它重建。
// options: { engine, region, onFail, tries }，都可选；与找图一样，默认值**写进节点**
// 而不是留空——留空等于交给回放器的缺省（找不到就整条失败），与这里想要的相反。
function toTapTextNode(node, shot, text, options) {
  var opts = options || {};
  var wanted = String(text == null ? "" : text).trim();
  if (!wanted) throw new Error("点击文字要先给出要找的那段字");
  var restored = {
    id: node.id,
    name: node.name,
    type: "tapText",
    text: wanted,
    waitMs: triesToWaitMs(opts.tries != null ? opts.tries : waitMsToTries(node.waitMs)),
    onFail: opts.onFail || node.onFail || DEFAULT_TAP_IMAGE_ON_FAIL
  };
  // 引擎只在"不是默认"时写进去：默认值写进每个节点，日后换默认就改不动老用例了。
  var engine = opts.engine || node.engine;
  if (engine && engine !== "mlkit") restored.engine = engine;
  var region = opts.region !== undefined ? opts.region : node.region;
  if (region) restored.region = region;
  carryWaits(restored, node);
  return restored;
}

// 输入文字节点：把一段文字打进输入框。
// rx/ry 留着——回放时先点这儿把输入框聚焦，再打字。录制时点的就是那个框，
// 所以默认把原来的落点带上；人要改成"焦点已经在了"可以把它清掉。
function toInputTextNode(node, shot, text, options) {
  var opts = options || {};
  var value = String(text == null ? "" : text);
  if (!value) throw new Error("输入文字要先给出要输入的内容");
  var restored = {
    id: node.id,
    name: node.name,
    type: "inputText",
    text: value,
    overwrite: opts.overwrite != null ? !!opts.overwrite : (node.overwrite != null ? !!node.overwrite : true)
  };
  if (shot && shot.x != null && shot.y != null && opts.useFocusPoint !== false) {
    restored.rx = round4(clamp(shot.x / shot.deviceWidth, 0, 1));
    restored.ry = round4(clamp(shot.y / shot.deviceHeight, 0, 1));
  }
  carryWaits(restored, node);
  return restored;
}

// 按节点自己的手势类型从 shot 重建。找图节点不在这条路上——
// 它要的是"相对锚点中心的偏移"，见 rebuildNode。
function toGestureNode(node, shot) {
  if (node.type === "noop") return toNoopNode(node);
  // 认字的两种按原样重建：它们的定位不来自 shot 的坐标，
  // 拿坐标重建会把人设好的文字内容抹掉。
  if (node.type === "tapText") return toTapTextNode(node, shot, node.text, {});
  if (node.type === "inputText") return toInputTextNode(node, shot, node.text, {});
  if (node.type === "swipe") return toSwipeNode(node, shot);
  if (node.type === "longTap") return toLongTapNode(node, shot);
  if (node.type === "multiTap") return toMultiTapNode(node, shot);
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
  if (!usesImage(node)) {
    return toGestureNode(node, shot);
  }
  if (!shot.anchorBox) {
    throw new Error(
      "这一步靠找图定位，但会话里没有锚点框记录，挪不了落点。请重新框一次锚点"
    );
  }
  // 区域、找几次、找不到怎么办，都跟着节点走：挪一下落点，
  // 不该把人设好的这些抹掉。
  var options = {
    region: node.region,
    onFail: node.onFail,
    tries: waitMsToTries(node.waitMs)
  };
  if (node.type === "swipeImage") {
    return toSwipeImageNode(node, shot, shot.anchorBox, options);
  }
  return toTapImageNode(node, shot, shot.anchorBox, options);
}

// 把老录制的等待按新规则挪一遍（一键迁移，由人显式触发）。
//
// 2026-09-30 之前录的东西身上带的是 `postWaitMs`，而**那个值的语义本来就是
// 「这一步动作之前人停了多久」**——录的是动作前的停顿、写的却是动作后的等待，
// 这就是当时那个错位。所以迁移不是"挪到上一步/下一步"，而是**原地换个字段名**。
//
// **不自动做**：老录制是验证过能跑的，时序一改就得重新验。给人一个按钮，
// 点了才动，并且只动那些"有 postWaitMs 而没有 preWaitMs"的节点。
function migrateWaitsToPre(session) {
  var nodes = (session && session.nodes) || [];
  var changed = 0;
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.postWaitMs == null) continue;
    // 已经有动作前等待的不碰：那是人后来在编辑页设过的，比老字段更可信。
    if (node.preWaitMs != null) continue;
    node.preWaitMs = node.postWaitMs;
    delete node.postWaitMs;
    changed++;
  }
  return { changed: changed, total: nodes.length };
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
    if (usesImage(node) && node.onFail == null) {
      node.onFail = DEFAULT_TAP_IMAGE_ON_FAIL;
    }
    // 没有屏幕尺寸的 shot 按"和第一步一样"处理。
    //
    // 这类 shot 来自 2026-10-04 第一版的「＋ 添加节点」：它只写了 { nodeId, path }。
    // 不兜的话这里会写出 baseline: { width: undefined, height: undefined }，
    // 校验器当场拒绝，**整条用例生成不了，连带定时都存不上**——
    // 而用户看到的是「定时没存上: 节点 [step-06] 的 baseline 必须包含 width 与 height」，
    // 一句跟定时毫无关系的话。新加的那一版已经写全了，这里是给已经存在设备上的那些兜底。
    var shotWidth = shot.deviceWidth || first.deviceWidth;
    var shotHeight = shot.deviceHeight || first.deviceHeight;
    if (shotWidth !== first.deviceWidth || shotHeight !== first.deviceHeight) {
      node.baseline = { width: shotWidth, height: shotHeight };
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
  usesImage: usesImage,
  toTapImageNode: toTapImageNode,
  toSwipeImageNode: toSwipeImageNode,
  migrateWaitsToPre: migrateWaitsToPre,
  toTapNode: toTapNode,
  toLongTapNode: toLongTapNode,
  DEFAULT_MULTI_TAP_COUNT: DEFAULT_MULTI_TAP_COUNT,
  DEFAULT_MULTI_TAP_PRESS_MS: DEFAULT_MULTI_TAP_PRESS_MS,
  DEFAULT_MULTI_TAP_INTERVAL_MS: DEFAULT_MULTI_TAP_INTERVAL_MS,
  toMultiTapNode: toMultiTapNode,
  toSwipeNode: toSwipeNode,
  toNoopNode: toNoopNode,
  toTapTextNode: toTapTextNode,
  toInputTextNode: toInputTextNode,
  // 循环分组（2026-10-06）。这几样是**纯数据操作**，PC 上喂假会话就能验，
  // 不用等真机——分组最容易出的错是下标错位和 shots 对不上，而那些都是数据错。
  GROUP_TYPE: GROUP_TYPE,
  DEFAULT_GROUP_REPEAT: DEFAULT_GROUP_REPEAT,
  MAX_GROUP_REPEAT: MAX_GROUP_REPEAT,
  isGroup: isGroup,
  checkGroupName: checkGroupName,
  clampGroupRepeat: clampGroupRepeat,
  checkGroupable: checkGroupable,
  makeGroup: makeGroup,
  ungroup: ungroup,
  removeGroup: removeGroup,
  // 删一步 + 剪贴板式复制粘贴（2026-10-08）。同样是纯数据操作，PC 上验得了。
  removeNodeAt: removeNodeAt,
  joinGroupOf: joinGroupOf,
  snapshotNodes: snapshotNodes,
  checkPasteable: checkPasteable,
  pasteSnapshot: pasteSnapshot,
  usesText: usesText,
  toGestureNode: toGestureNode,
  formatWaitMs: formatWaitMs,
  rebuildNode: rebuildNode,
  defaultNodeName: defaultNodeName,
  isDefaultNodeName: isDefaultNodeName,
  bareName: bareName,
  displayLabel: displayLabel,
  renumberDefaultNames: renumberDefaultNames,
  nextNodeId: nextNodeId,
  buildCase: buildCase
};
