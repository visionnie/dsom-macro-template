// =====================================================================
// 通用能力：设备侧的调度表增补层，让设备上新增的用例不重新打包也能进常驻
// 设计约束：
//   - src/config/schedule-autojs.js 是代码，改它要回 PC 改、检查、打包、安装。
//     而录制器的产物是设备上现生成的，人在设备前录完就想让它到点自己跑。
//     所以调度表 = 代码里的基表 + 设备上的增补层，运行时合并
//   - 增补层是纯数据，坏了不能掀翻常驻：解析失败就当空的并留下原因
//   - 合并后仍然交给 resident.validateSchedule 校验，上限和字段规则只有一套
//   - 同 id 时增补层覆盖基表项，这样不重新打包也能临时改次数和时间窗
//   - 本模块不含游戏语义
// =====================================================================

var OVERLAY_VERSION = 1;

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function overlayPathOf(config) {
  return config.outputRoot + "/schedule/overlay.json";
}

function emptyOverlay() {
  return { version: OVERLAY_VERSION, entries: [] };
}

// 读增补层。任何异常都降级成空增补层并带上 recoveredFrom——
// 常驻是无人值守的入口，一个写坏的 JSON 不该让整夜什么都不跑。
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
  files.ensureDir(config.outputRoot + "/schedule/");
  var payload = {
    version: OVERLAY_VERSION,
    updatedAt: new Date().toISOString(),
    entries: overlay.entries || []
  };
  files.write(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

function shallowCopy(source) {
  var copy = {};
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      copy[key] = source[key];
    }
  }
  return copy;
}

// 合并出运行时真正用的调度表。基表来自代码、不可变，所以逐项浅拷贝后再打 source 标记，
// 界面据此区分「内置」与「设备上加的」——只有后者能在设备上删掉。
function merge(baseSchedule, overlay) {
  var merged = shallowCopy(baseSchedule || {});
  var entries = [];
  var indexById = {};
  var baseEntries = (baseSchedule && baseSchedule.entries) || [];

  for (var i = 0; i < baseEntries.length; i++) {
    var baseEntry = shallowCopy(baseEntries[i]);
    baseEntry.source = "config";
    indexById[baseEntry.id] = entries.length;
    entries.push(baseEntry);
  }

  var overlayEntries = (overlay && overlay.entries) || [];
  for (var j = 0; j < overlayEntries.length; j++) {
    var overlayEntry = shallowCopy(overlayEntries[j]);
    overlayEntry.source = "overlay";
    if (indexById[overlayEntry.id] != null) {
      entries[indexById[overlayEntry.id]] = overlayEntry;
    } else {
      indexById[overlayEntry.id] = entries.length;
      entries.push(overlayEntry);
    }
  }

  merged.entries = entries;
  return merged;
}

function findIndex(entries, entryId) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].id === entryId) return i;
  }
  return -1;
}

// 新增或替换一条增补项。同 id 直接覆盖：人在设备上改次数时，
// 期望的是"改掉这一条"，而不是多出一条同名的来。
function addEntry(config, entry) {
  var overlay = load(config);
  var entries = overlay.entries || [];
  var existing = findIndex(entries, entry.id);
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  overlay.entries = entries;
  save(config, overlay);
  return overlay;
}

function removeEntry(config, entryId) {
  var overlay = load(config);
  var entries = overlay.entries || [];
  var index = findIndex(entries, entryId);
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
  merge: merge,
  addEntry: addEntry,
  removeEntry: removeEntry
};
