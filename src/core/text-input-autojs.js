// =====================================================================
// 通用能力：把一段文字打进当前聚焦的输入框
//
// 为什么要一条链而不是一句 setText：输入这件事在不同宿主上成功率完全不同。
// 本项目的目标应用是**盒子里的 H5 游戏**（WebView），无障碍未必能把 WebView 里的
// 输入框识别成可编辑节点；而 root 的 `input text` 只能打 ASCII，中文打不进去
// （这条 2026-09-30 就记在 HANDOFF 的「文本输入」那一节里）。
// 所以这里按"成功率从高到低"依次试，并且**把走通的那一路记进日志**——
// 下次换一台机器、换一个输入框时，这行日志就是唯一的线索。
//
// 调用前提：输入框已经聚焦（录制时人点过它，回放时节点自己先点一下）。
// 本模块不负责点，也不负责判断"聚焦的是不是你要的那个框"。
//
// 三条路：
//   1. 无障碍 setText / input：最干净，WebView 里不一定行
//   2. 剪贴板 + 粘贴：把文字放进剪贴板，再对聚焦控件执行粘贴动作。
//      中文友好，WebView 的输入框多数认粘贴
//   3. root 的 `input text`：只剩 ASCII 能打，兜底用；中文会静默变成空
// =====================================================================

var ASCII_ONLY = /^[\x20-\x7e]*$/;

function create(options) {
  var opts = options || {};
  var logger = opts.logger;

  function info(text) {
    if (logger && logger.info) logger.info("文字输入: " + text);
  }
  function warn(text) {
    if (logger && logger.warn) logger.warn("文字输入: " + text);
  }

  // 聚焦中的可编辑控件。拿不到就返回 null——拿不到不代表不能输入，
  // 剪贴板那一路还可以靠按键粘贴。
  function focusedEditable() {
    try {
      var node = className("EditText").focused(true).findOnce();
      if (node) return node;
    } catch (error) {}
    try {
      return focus();
    } catch (error) {}
    return null;
  }

  // 第 1 路：无障碍直接改文本。
  function viaAccessibility(text, overwrite) {
    try {
      if (overwrite) {
        if (typeof setText === "function" && setText(text)) return true;
      } else {
        if (typeof input === "function" && input(text)) return true;
      }
    } catch (error) {
      warn("无障碍写入抛错: " + error);
    }
    return false;
  }

  // 第 2 路：剪贴板 + 粘贴。覆盖输入时先把原内容全选掉再粘，
  // 否则粘出来的是"旧内容 + 新内容"，而界面上看着像是没生效。
  function viaClipboard(text, overwrite) {
    try {
      setClip(text);
    } catch (error) {
      warn("写剪贴板失败: " + error);
      return false;
    }
    var node = focusedEditable();
    if (node) {
      try {
        if (overwrite) {
          try { node.setSelection(0, String(node.text() || "").length); } catch (selectError) {}
        }
        if (node.paste()) return true;
      } catch (error) {
        warn("控件粘贴抛错: " + error);
      }
    }
    // 控件拿不到就发按键：先全选（overwrite 时）再粘贴。
    try {
      if (overwrite) shell("input keyevent KEYCODE_MOVE_END", true);
      shell("input keyevent 279", true); // KEYCODE_PASTE
      return true;
    } catch (error) {
      warn("按键粘贴失败: " + error);
    }
    return false;
  }

  // 第 3 路：root 的 input text。**只能 ASCII**，中文会静默丢掉，
  // 所以非 ASCII 直接不走这一路，宁可报失败也不要"报成功但框里是空的"。
  function viaShell(text) {
    if (!ASCII_ONLY.test(text)) {
      warn("含非 ASCII 字符，不走 root input text（它打不进中文）");
      return false;
    }
    try {
      var escaped = text.replace(/(["$`\\])/g, "\\$1").replace(/ /g, "%s");
      var result = shell('input text "' + escaped + '"', true);
      return !!result && result.code === 0;
    } catch (error) {
      warn("root 输入失败: " + error);
      return false;
    }
  }

  // text：要输入的内容；overwrite：true 覆盖、false 追加。
  // 返回 { ok, via }。**失败不抛**：由调用方按节点的 onFail 决定是停还是继续。
  function type(text, typeOptions) {
    var value = String(text == null ? "" : text);
    var tOpts = typeOptions || {};
    var overwrite = tOpts.overwrite !== false;
    var routes = [
      { name: "无障碍", run: function () { return viaAccessibility(value, overwrite); } },
      { name: "剪贴板粘贴", run: function () { return viaClipboard(value, overwrite); } },
      { name: "root input", run: function () { return viaShell(value); } }
    ];
    for (var i = 0; i < routes.length; i++) {
      if (routes[i].run()) {
        info("走「" + routes[i].name + "」写入成功: 「" + value + "」");
        return { ok: true, via: routes[i].name };
      }
      info("「" + routes[i].name + "」没写进去，换下一条路");
    }
    warn("三条路都没写进去: 「" + value + "」");
    return { ok: false, via: "" };
  }

  return {
    type: type,
    focusedEditable: focusedEditable
  };
}

module.exports = {
  create: create
};
