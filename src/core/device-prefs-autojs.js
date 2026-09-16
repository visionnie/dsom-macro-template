// =====================================================================
// 通用能力：设备侧的用户偏好，人在设备上改、改完就生效、重启后还在
// 设计约束：
//   - 与 game-config 的分工：config 是**代码**，改它要回 PC 改、检查、打包、安装；
//     本模块是**数据**，人站在设备前就能改。凡是「这台设备上想怎么跑」的选择
//     都该落在这里，而不是逼人重新打包
//   - 坏了不能让菜单起不来：解析失败一律退回默认值
//   - 本模块不含游戏语义
// =====================================================================

var PREFS_VERSION = 1;

function prefsPathOf(config) {
  return config.outputRoot + "/prefs.json";
}

function load(config) {
  var path = prefsPathOf(config);
  if (!files.exists(path)) {
    return { version: PREFS_VERSION };
  }
  try {
    var raw = files.read(path);
    if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    var parsed = JSON.parse(raw);
    if (parsed.version !== PREFS_VERSION) {
      return { version: PREFS_VERSION };
    }
    return parsed;
  } catch (error) {
    return { version: PREFS_VERSION, recoveredFrom: String(error) };
  }
}

function save(config, prefs) {
  var payload = {};
  for (var key in prefs) {
    if (Object.prototype.hasOwnProperty.call(prefs, key)) {
      payload[key] = prefs[key];
    }
  }
  payload.version = PREFS_VERSION;
  payload.updatedAt = new Date().toISOString();
  files.ensureDir(config.outputRoot + "/");
  files.write(prefsPathOf(config), JSON.stringify(payload, null, 2) + "\n");
  return prefsPathOf(config);
}

function get(config, key, fallback) {
  var prefs = load(config);
  return prefs[key] === undefined ? fallback : prefs[key];
}

function set(config, key, value) {
  var prefs = load(config);
  prefs[key] = value;
  save(config, prefs);
  return prefs;
}

module.exports = {
  PREFS_VERSION: PREFS_VERSION,
  prefsPathOf: prefsPathOf,
  load: load,
  save: save,
  get: get,
  set: set
};
