// =====================================================================
// 通用能力：组合任务——把几条录制按顺序串成一个能跑的任务
// 设计约束：
//   - 典型用法是「登录 → 挂机」：后一段依赖前一段挣来的状态。所以组合**只做一次
//     启动前置**（按第一段的要求），然后顺序跑完各段。若每段都各走一遍完整前置，
//     第二段的 launch 会把第一段的状态踢掉（2026-09-18 定的，理由见 task-group）
//   - 组合只存**引用**，不复制录制内容：改了某条录制，用到它的组合下次跑就是新的
//   - 成员写成对象 `{ sessionId }` 而不是裸字符串：以后要加「这一段失败也继续」
//     之类的开关时不用迁移数据
//   - 不支持组合套组合：MVP 不需要，而且要处理环，代价不成比例
//   - 坏了不能掀翻界面：解析失败降级成空表并留下原因
//   - 本模块不含游戏语义
// =====================================================================

var STORE_VERSION = 1;

function isArray(value) {
  return Object.prototype.toString.call(value) === "[object Array]";
}

function storePathOf(config) {
  return config.outputRoot + "/tasks/groups.json";
}

function emptyStore() {
  return { version: STORE_VERSION, groups: [] };
}

function load(config) {
  var path = storePathOf(config);
  if (!files.exists(path)) {
    return emptyStore();
  }
  try {
    var raw = files.read(path);
    if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    var parsed = JSON.parse(raw);
    if (!isArray(parsed.groups)) {
      return { version: STORE_VERSION, groups: [], recoveredFrom: "groups 不是数组" };
    }
    if (parsed.version !== STORE_VERSION) {
      return {
        version: STORE_VERSION,
        groups: [],
        recoveredFrom: "组合任务表版本不认识: " + parsed.version
      };
    }
    return parsed;
  } catch (error) {
    return { version: STORE_VERSION, groups: [], recoveredFrom: String(error) };
  }
}

function save(config, store) {
  var path = storePathOf(config);
  files.ensureDir(config.outputRoot + "/tasks/");
  var payload = {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    groups: store.groups || []
  };
  files.write(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}

function findIndex(groups, groupId) {
  for (var i = 0; i < groups.length; i++) {
    if (String(groups[i].id) === String(groupId)) return i;
  }
  return -1;
}

function get(config, groupId) {
  var store = load(config);
  var index = findIndex(store.groups || [], groupId);
  return index >= 0 ? store.groups[index] : null;
}

function newId() {
  return "group-" + Date.now();
}

// 新建或覆盖。同 id 直接替换：人在编辑页改完点保存，期望的是改掉这一条。
function put(config, group) {
  var store = load(config);
  var groups = store.groups || [];
  var index = findIndex(groups, group.id);
  var saved = {
    id: group.id,
    name: group.name,
    members: group.members || [],
    createdAt: group.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (index >= 0) {
    saved.createdAt = groups[index].createdAt || saved.createdAt;
    groups[index] = saved;
  } else {
    groups.push(saved);
  }
  store.groups = groups;
  save(config, store);
  return saved;
}

function remove(config, groupId) {
  var store = load(config);
  var groups = store.groups || [];
  var index = findIndex(groups, groupId);
  if (index < 0) {
    return { removed: false, store: store };
  }
  groups.splice(index, 1);
  store.groups = groups;
  save(config, store);
  return { removed: true, store: store };
}

// 某条录制被哪些组合引用着。删录制前要问一句——组合里留着一个指向
// 已删录制的引用，下次跑到那一段才报错，而那时前面几段已经把游戏操作过一半了。
function groupsUsing(config, sessionId) {
  var store = load(config);
  var groups = store.groups || [];
  var used = [];
  for (var i = 0; i < groups.length; i++) {
    var members = groups[i].members || [];
    for (var m = 0; m < members.length; m++) {
      if (String(members[m].sessionId) === String(sessionId)) {
        used.push(groups[i]);
        break;
      }
    }
  }
  return used;
}

// 把某条录制从所有组合里摘掉，返回受影响的组合名。删录制时连带调用。
function removeMemberEverywhere(config, sessionId) {
  var store = load(config);
  var groups = store.groups || [];
  var touched = [];
  for (var i = 0; i < groups.length; i++) {
    var members = groups[i].members || [];
    var kept = [];
    for (var m = 0; m < members.length; m++) {
      if (String(members[m].sessionId) === String(sessionId)) continue;
      kept.push(members[m]);
    }
    if (kept.length !== members.length) {
      groups[i].members = kept;
      groups[i].updatedAt = new Date().toISOString();
      touched.push(groups[i].name || groups[i].id);
    }
  }
  if (touched.length > 0) {
    store.groups = groups;
    save(config, store);
  }
  return touched;
}

module.exports = {
  STORE_VERSION: STORE_VERSION,
  storePathOf: storePathOf,
  emptyStore: emptyStore,
  load: load,
  save: save,
  get: get,
  newId: newId,
  put: put,
  remove: remove,
  groupsUsing: groupsUsing,
  removeMemberEverywhere: removeMemberEverywhere
};
