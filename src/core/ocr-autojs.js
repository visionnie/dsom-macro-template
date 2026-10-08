// =====================================================================
// 通用能力：文字识别（OCR）——认出屏幕上有哪些字，各自在哪个框里
//
// 2026-10-02 实机探针（AutoJs6 6.7.0 / SDK 29 / 云机 1280x720，对着真实游戏画面）：
//
//   ocr.summary() -> Current mode: mlkit    Available modes: [ mlkit, paddle, rapid ]
//   ocr.detect(image)        36 条，630 毫秒     ← 走当前模式（mlkit）
//   ocr.rapid.detect(image)  68 条，3167 毫秒    ← 认得更全，慢五倍
//   ocr.paddle.detect(image) 抛错「未找到可用的 Paddle OCR 插件」 ← 这台机器没有
//
// 每条结果带 text / label / confidence / bounds(Rect)，**bounds 是设备像素**，
// 框中心直接就能点——「点击文字」这条路因此成立。
//
// **这个模块以前是坏的**：它只找 `paddle.ocrText` 与 `gmlkit.ocr`，而本机两个全不存在，
// 真有任务调它必然抛「当前 AutoJs6 未提供…」。没人发现是因为一直没有任务用到 OCR。
//
// 必须记住的一条：**游戏自己的美术字认不出来**。实测主城界面上
// 背包 / 设置 / 角色 / 商城 / 自动 这些描金图标字，mlkit 与 rapid 都认不出；
// 而普通 UI 文字（怪物攻城、复活徽记、运行、结束）认得准。
// 所以界面上必须让人**先认一遍、从认出来的词里挑**，而不是让人对着屏幕手打——
// 手打一个认不出来的词，表现是回放时每次都找不到，日志里只有一句"没找到"。
// =====================================================================

var DEFAULT_ENGINE = "mlkit";
var ENGINES = { mlkit: true, rapid: true, paddle: true };

function normalize(value) {
  // 全角空格、普通空格一律去掉再比：OCR 常在汉字之间塞空格，
  // 人在界面上挑的词却是连着的，不去掉的话「怪物 攻城」就匹配不上「怪物攻城」。
  return String(value == null ? "" : value).replace(/\s+/g, "");
}

// 按引擎取一份检测器。mlkit 走 ocr.detect（当前模式，实测可用），
// 其余走 ocr.<engine>.detect。引擎缺失时抛错由调用方处理——
// 这种错必须说出来，静默退回另一个引擎等于悄悄换了识别结果。
function detectWith(image, engine) {
  var name = engine || DEFAULT_ENGINE;
  if (!ENGINES[name]) throw new Error("不认识的 OCR 引擎: " + name);
  if (name === DEFAULT_ENGINE) return ocr.detect(image);
  return ocr[name].detect(image);
}

function create(options) {
  var logger = (options || {}).logger;

  function info(text) {
    if (logger && logger.info) logger.info("OCR: " + text);
  }

  // 认一遍这张图，返回 [{ text, confidence, left, top, right, bottom, centerX, centerY }]
  // region 是设备像素的矩形 { left, top, right, bottom }，只保留中心落在里面的结果。
  function detect(image, detectOptions) {
    var opts = detectOptions || {};
    var startedAt = Date.now();
    var raw = detectWith(image, opts.engine);
    var list = [];
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      var bounds = item.bounds;
      if (!bounds) continue;
      var centerX = Math.round((bounds.left + bounds.right) / 2);
      var centerY = Math.round((bounds.top + bounds.bottom) / 2);
      if (opts.region) {
        var r = opts.region;
        if (centerX < r.left || centerX > r.right || centerY < r.top || centerY > r.bottom) continue;
      }
      list.push({
        text: String(item.text == null ? "" : item.text),
        confidence: typeof item.confidence === "number" ? item.confidence : 0,
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        centerX: centerX,
        centerY: centerY
      });
    }
    info(
      "认出 " + list.length + " 条（引擎 " + (opts.engine || DEFAULT_ENGINE) +
        "，" + (Date.now() - startedAt) + " 毫秒）"
    );
    return list;
  }

  // 在识别结果里找这段文字。包含即算命中（OCR 常把图标和文字连在一起认成
  // 「▶运行」这种），多条命中取置信度最高的那条。
  function pick(list, wanted) {
    var target = normalize(wanted);
    if (!target) return null;
    var best = null;
    for (var i = 0; i < list.length; i++) {
      if (normalize(list[i].text).indexOf(target) < 0) continue;
      if (!best || list[i].confidence > best.confidence) best = list[i];
    }
    return best;
  }

  return {
    DEFAULT_ENGINE: DEFAULT_ENGINE,
    detect: detect,
    pick: pick,
    // 一步到位：认一遍再挑。找不到返回 null。
    find: function (image, wanted, detectOptions) {
      return pick(detect(image, detectOptions), wanted);
    }
  };
}

module.exports = {
  DEFAULT_ENGINE: DEFAULT_ENGINE,
  ENGINES: ENGINES,
  normalize: normalize,
  create: create
};
