// =====================================================================
// 通用能力：统一记录任务日志与结构化结果
// 设计约束：日志只写入当前任务目录，不包含账号、口令等敏感信息
// =====================================================================

function create(options) {
  var outputDir = options.outputDir;
  var lines = [];

  files.ensureDir(outputDir + "/");

  function write(level, message) {
    var line = new Date().toISOString() + " [" + level + "] " + String(message);
    lines.push(line);
    console.log(line);
  }

  function saveText(fileName, content) {
    var path = outputDir + "/" + fileName;
    files.write(path, String(content));
    return path;
  }

  function saveJson(fileName, value) {
    return saveText(fileName, JSON.stringify(value, null, 2) + "\n");
  }

  function flush(fileName) {
    return saveText(fileName || "latest.log", lines.join("\n") + "\n");
  }

  return {
    info: function (message) {
      write("INFO", message);
    },
    warn: function (message) {
      write("WARN", message);
    },
    error: function (message) {
      write("ERROR", message);
    },
    saveJson: saveJson,
    flush: flush,
    outputDir: outputDir
  };
}

module.exports = {
  create: create
};
