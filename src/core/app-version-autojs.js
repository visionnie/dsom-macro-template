// =====================================================================
// 通用能力：回答「现在跑的是哪个包」，拼成一行人能读的字
// 设计约束：
//   - 版本号不写在本模块里。core/ 是从模板同步下来的，写在这儿每次同步都会被覆盖；
//     语义版本由项目自己的 config/version-autojs.js 提供，经 config.version 传进来
//   - 构建戳（提交号、打包时间）由 build-autojs-bundles.js 写在产物顶部的
//     全局 __BUILD_STAMP__ 里。本模块只读它，读不到就降级显示，绝不抛错——
//     一个只用来显示版本的模块把界面或任务带崩，那是本末倒置
// =====================================================================

// 未打包的源码直接在 AutoJs6 里跑时没有这个全局量。用 typeof 取，
// 直接引用未声明的标识符会抛 ReferenceError。
function readStamp() {
  try {
    if (typeof __BUILD_STAMP__ === "undefined" || !__BUILD_STAMP__) {
      return null;
    }
    return __BUILD_STAMP__;
  } catch (error) {
    return null;
  }
}

// 语义版本。config 里没有就明说「未标注」，不要伪造一个 0.0.0 出来——
// 看到「未标注」的人会去查配置，看到 0.0.0 的人会以为真有这么个版本。
function semantic(config) {
  var version = config && config.version;
  if (version && version.name) {
    return String(version.name);
  }
  return "未标注";
}

// 菜单标题下那行字。构建戳齐全时形如：
//   v0.6.0 · d1d72c0 · 09-26 15:04
// 打包时工作区有未提交改动会多一个 + 号（v0.6.0 · d1d72c0+ · ...）：
// 这种包对不回任何一个提交，出了问题别拿提交号去查。
function label(config) {
  var version = semantic(config);
  // 「未标注」前面不加 v，"v未标注" 看着像个版本号，反而不像出了问题。
  var text = version === "未标注" ? "版本未标注" : "v" + version;
  var stamp = readStamp();
  if (!stamp) {
    return text + " · 未打包（直接跑源码）";
  }
  if (stamp.commit) {
    text += " · " + stamp.commit + (stamp.dirty === true ? "+" : "");
  }
  if (stamp.builtAt) {
    // 年份对「是不是今天打的包」没有帮助，去掉，留出横向空间。
    text += " · " + String(stamp.builtAt).replace(/^\d{4}-/, "");
  }
  return text;
}

// 落进 result.json 的结构。每条运行记录都能回答「这条是哪个包跑出来的」，
// 事后翻日志时不用再去猜当时装的是哪版。
function info(config) {
  var stamp = readStamp();
  return {
    version: semantic(config),
    commit: stamp && stamp.commit ? stamp.commit : null,
    dirty: stamp ? stamp.dirty === true : null,
    builtAt: stamp && stamp.builtAt ? stamp.builtAt : null
  };
}

module.exports = {
  semantic: semantic,
  label: label,
  info: info
};
