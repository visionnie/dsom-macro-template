// =====================================================================
// 通用能力：统一记录任务日志与结构化结果
// 设计约束：
//   - 日志只写入当前任务目录，不包含账号、口令等敏感信息
//   - **每一行当场落盘，不攒在内存里等结束**（2026-10-06 改）。
//     原先所有行攒在一个 lines 数组里，只有 flush() 才写文件；而后台定时调度
//     那一趟的 flush 排在 runtime.run 的 finally——也就是**整个常驻退出时**才到，
//     而后台的时长上限是 7 天。于是 latest.log 实际上永远不会出现，
//     App 一被回收整个数组跟着没，事后只能翻 logcat，而 logcat 会滚掉。
//     「后台定时跑的那一趟不落运行目录」这条 09-24 就挂着的欠账，根子在这儿。
//     顺带治掉第二个毛病：那个数组一跑七天不清，是个慢性内存增长。
//   - 文件有大小上限并轮转：常驻要跑几天，日志不能无限长。
//     超了就把当前这份挪成 .1（只留一代），新行从头写——**丢的永远是最老的**
//   - 落盘失败一律不往上抛：日志是为了排查，不能自己变成故障源。
//     坏了只在 console 上说一次（每行都说会把 logcat 冲垮）
// =====================================================================

var DEFAULT_LOG_NAME = "latest.log";

// 单份日志的字符上限，超了轮转一代，所以盘上最多两份。
// 正常量级远小于这个数：后台调度每拍只在"理由变了"时才写一行。
// 给上限是为了"反复失败、每拍都写"那种不正常的情况不把盘写满。
var MAX_LOG_CHARS = 400000;

// 一个落盘目标。主日志是一个，分支（见 beginBranch）是另一个，两者共用这套逻辑——
// 各写一套迟早出现"主日志轮转了、分支没轮转"这类对不上的事。
function createSink(dirPath, fileName) {
  var path = dirPath + "/" + fileName;
  var chars = 0;
  var broken = false;

  try {
    files.ensureDir(dirPath + "/");
    // 开头先清空：同一个目录重开一次任务不该把上一轮的行接在后面。
    // 原先靠 flush 整份覆写，天然就是"这一趟一份"；改成追加写之后要自己保证。
    files.write(path, "");
  } catch (error) {
    broken = true;
    console.error("日志文件建不出来，这一趟只进 logcat: " + path + " " + error);
  }

  return {
    path: path,
    write: function (line) {
      if (broken) return;
      try {
        if (chars > MAX_LOG_CHARS) {
          try {
            files.remove(path + ".1");
          } catch (removeError) {}
          files.move(path, path + ".1");
          files.write(path, "");
          chars = 0;
        }
        files.append(path, line + "\n");
        chars += line.length + 1;
      } catch (error) {
        broken = true;
        console.error("日志落盘失败，后面不再试: " + path + " " + error);
      }
    }
  };
}

function create(options) {
  var outputDir = options.outputDir;
  var logName = options.logFileName || DEFAULT_LOG_NAME;
  var main = createSink(outputDir, logName);
  // 分支：同一行再往另一个目录写一份。后台定时调度用它——到点跑的那一趟
  // 既要留在常驻自己的长日志里（看前后文：在等哪个点、为什么这一拍跑了），
  // 又要在这一趟自己的运行目录里独立成一份（看这一次：点了哪儿、哪一步断的）。
  // 做成分支而不是另造一个 logger，是为了不动 actions / screen 的实例——
  // 它们捏着的就是这个 logger，换实例等于把一套刚验收过的东西重新验一遍。
  var branch = null;

  function write(level, message) {
    var line = new Date().toISOString() + " [" + level + "] " + String(message);
    // console 先行：盘写不下去的时候，logcat 仍然是那条退路。
    console.log(line);
    main.write(line);
    if (branch) branch.write(line);
  }

  function saveText(fileName, content) {
    var path = outputDir + "/" + fileName;
    files.write(path, String(content));
    return path;
  }

  function saveJson(fileName, value) {
    return saveText(fileName, JSON.stringify(value, null, 2) + "\n");
  }

  // 行早就在盘上了（见文件头），所以这里只剩一件事：调用方要的是别的文件名时
  // 复制一份过去。保留这个方法是因为 runtime 与界面上几处都在调它，
  // 而"任务跑完 latest.log 就该在那儿"这个约定不变。
  function flush(fileName) {
    var name = fileName || DEFAULT_LOG_NAME;
    if (name === logName) return main.path;
    var target = outputDir + "/" + name;
    try {
      files.copy(main.path, target);
    } catch (error) {
      console.error("日志另存失败: " + target + " " + error);
    }
    return target;
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
    outputDir: outputDir,
    logPath: main.path,
    // 开一个分支，返回分支日志的路径。重复调用会先把上一个关掉——
    // 忘了关的表现是"后面所有行都往上一趟的目录里写"，而那一趟明明早结束了。
    beginBranch: function (dirPath, fileName) {
      branch = createSink(dirPath, fileName || DEFAULT_LOG_NAME);
      return branch.path;
    },
    endBranch: function () {
      branch = null;
    }
  };
}

module.exports = {
  create: create
};
