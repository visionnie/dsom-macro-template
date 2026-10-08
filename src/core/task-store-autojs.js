// =====================================================================
// 通用能力：设备侧的任务登记增补层，让录制出来的用例进任务列表
// 设计约束：
//   - src/task-registry-autojs.js 是代码：任务在里面是一段 run(context)。
//     改它要回 PC 改、检查、打包、安装。而录制产物是设备上现生成的**数据**，
//     进不了那张表。所以任务列表 = 代码里的登记表 + 设备上的增补层，界面合并显示
//   - 增补层只记"哪条录制、什么时候加的"。**名字不存这里**，存在会话里
//     （session.json 的 name）——case.json 会被重新生成，名字必须活在
//     生成它的那份数据上，否则改完一次名字就丢
//   - 坏了不能掀翻界面：解析失败降级成空表并留下原因
//   - 本模块不含游戏语义
// =====================================================================

var OVERLAY_VERSION = 1;

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function overlayPathOf(config) {
  return config.outputRoot + "/tasks/overlay.json";
}

function emptyOverlay() {
  return { version: OVERLAY_VERSION, entries: [] };
}

function load(config) {
  var path = overlayPathOf(config);
  if (!files.exists(path)) {
    return emptyOverlay();
  }
  try {
    var raw = files.read(path);
    if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    var parsed = JSON.parse(raw);
    if (!isArray(parsed.entries)) {
      return { version: OVERLAY_VERSION, entries: [], recoveredFrom: "entries 不是数组" };
    }
    if (parsed.version !== OVERLAY_VERSION) {
      return {
        version: OVERLAY_VERSION,
        entries: [],
        recoveredFrom: "增补层版本不认识: " + parsed.version
      };
    }
    return parsed;
  } catch (error) {
    return { version: OVERLAY_VERSION, entries: [], recoveredFrom: String(error) };
  }
}

function save(config, overlay) {
  var path = overlayPathOf(config);
  files.ensureDir(config.outputRoot + "/tasks/");
  var payload = {
    version: OVERLAY_VERSION,
    updatedAt: new Date().toISOString(),
    entries: overlay.entries || [],
    // 任务列表的显示顺序（2026-10-04 用户要求可排序）。
    // 存的是行的 key（"group:<组合 id>" / "session:<会话 id>"），不是下标——
    // 下标会随增删整体错位，而 key 认的是那一行本身。
    // **组合任务与录制用例分别存在两个 store 里**，顺序必须有一份统一的表，
    // 否则"组合永远排在录制前面"这条死规矩就改不掉。
    order: isArray(overlay.order) ? overlay.order : []
  };
  files.write(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

// 读出来的顺序只是"建议"：表里没列到的行排在最后（新建的任务天然不在表里），
// 表里列了但已经不存在的行直接忽略（删掉的任务）。
// 这样顺序表永远不需要跟增删保持同步，也就不会出现"删了一条，后面全乱"。
function loadOrder(config) {
  var overlay = load(config);
  return isArray(overlay.order) ? overlay.order : [];
}

function saveOrder(config, keys) {
  var overlay = load(config);
  overlay.order = isArray(keys) ? keys : [];
  save(config, overlay);
  return overlay.order;
}

// 按顺序表给行排序。本函数不认识行里有什么，只认 key。
function applyOrder(rows, order) {
  if (!isArray(order) || order.length === 0) return rows;
  var rank = {};
  for (var i = 0; i < order.length; i++) {
    if (rank[order[i]] == null) rank[order[i]] = i;
  }
  var sorted = rows.slice();
  // 稳定排序：没排过的那些要保持它们原来的相对次序（按加入时间），
  // 否则每次进任务列表看到的顺序都不一样。
  for (var a = 0; a < sorted.length; a++) sorted[a].__pos = a;
  sorted.sort(function (x, y) {
    var rx = rank[x.key] == null ? order.length + x.__pos : rank[x.key];
    var ry = rank[y.key] == null ? order.length + y.__pos : rank[y.key];
    if (rx !== ry) return rx - ry;
    return x.__pos - y.__pos;
  });
  for (var b = 0; b < sorted.length; b++) delete sorted[b].__pos;
  return sorted;
}

function findIndex(entries, sessionId) {
  for (var i = 0; i < entries.length; i++) {
    if (String(entries[i].sessionId) === String(sessionId)) return i;
  }
  return -1;
}

function has(config, sessionId) {
  return findIndex(load(config).entries || [], sessionId) >= 0;
}

// 同一条录制重复加入不会多出一行，只更新时间：人第二次点「加入任务列表」
// 想的是"改个名字"，不是"再来一条一样的"。
function addEntry(config, sessionId) {
  var overlay = load(config);
  var entries = overlay.entries || [];
  var entry = { sessionId: String(sessionId), addedAt: new Date().toISOString() };
  var existing = findIndex(entries, sessionId);
  if (existing >= 0) {
    entry.addedAt = entries[existing].addedAt || entry.addedAt;
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  overlay.entries = entries;
  save(config, overlay);
  return overlay;
}

// 只从列表里摘掉，录制会话与已生成的 case.json 留在磁盘上：
// 误删还能从「打开已有录制」找回来再加一次。
function removeEntry(config, sessionId) {
  var overlay = load(config);
  var entries = overlay.entries || [];
  var index = findIndex(entries, sessionId);
  if (index < 0) {
    return { removed: false, overlay: overlay };
  }
  entries.splice(index, 1);
  overlay.entries = entries;
  save(config, overlay);
  return { removed: true, overlay: overlay };
}

module.exports = {
  OVERLAY_VERSION: OVERLAY_VERSION,
  overlayPathOf: overlayPathOf,
  emptyOverlay: emptyOverlay,
  load: load,
  save: save,
  has: has,
  addEntry: addEntry,
  removeEntry: removeEntry,
  loadOrder: loadOrder,
  saveOrder: saveOrder,
  applyOrder: applyOrder
};
