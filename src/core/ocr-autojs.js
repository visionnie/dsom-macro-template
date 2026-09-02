// =====================================================================
// 通用能力：屏蔽 AutoJs6 中 Paddle OCR 与 ML Kit OCR 的调用差异
// 设计约束：只返回识别文本和原始结果，页面语义判断留给具体任务
// =====================================================================

function collectText(value, textParts) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (value) {
      textParts.push(value);
    }
    return;
  }
  if (Object.prototype.toString.call(value) === "[object Array]") {
    for (var index = 0; index < value.length; index++) {
      collectText(value[index], textParts);
    }
    return;
  }
  if (typeof value === "object") {
    var preferredKeys = ["text", "label", "value"];
    for (var keyIndex = 0; keyIndex < preferredKeys.length; keyIndex++) {
      var preferredKey = preferredKeys[keyIndex];
      if (typeof value[preferredKey] === "string") {
        collectText(value[preferredKey], textParts);
        return;
      }
    }
    for (var key in value) {
      if (value.hasOwnProperty(key)) {
        collectText(value[key], textParts);
      }
    }
  }
}

function create(options) {
  var logger = options.logger;

  function recognize(image, language) {
    var rawResult;
    var engineName;

    if (typeof paddle !== "undefined" && paddle.ocrText) {
      engineName = "paddle";
      rawResult = paddle.ocrText(image);
    } else if (typeof gmlkit !== "undefined" && gmlkit.ocr) {
      engineName = "gmlkit";
      rawResult = gmlkit.ocr(image, language || "zh");
    } else {
      throw new Error("当前 AutoJs6 未提供 paddle.ocrText 或 gmlkit.ocr");
    }

    var textParts = [];
    collectText(rawResult, textParts);
    var text = textParts.join("\n");
    logger.info("OCR 完成，引擎: " + engineName + "，文本长度: " + text.length);
    return {
      engine: engineName,
      text: text,
      raw: rawResult
    };
  }

  function containsText(image, expectedText, language) {
    return recognize(image, language).text.indexOf(expectedText) >= 0;
  }

  return {
    recognize: recognize,
    containsText: containsText
  };
}

module.exports = {
  create: create
};
