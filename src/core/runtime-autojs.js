// =====================================================================
// 通用能力：建立任务上下文，统一处理启动、权限、结果、日志和失败截图
// 设计约束：运行时不包含任何具体游戏页面判断
// =====================================================================

var loggerModule = require("./logger-autojs.js");
var screenModule = require("./screen-autojs.js");
var actionsModule = require("./actions-autojs.js");
var ocrModule = require("./ocr-autojs.js");
var workflow = require("./workflow-autojs.js");
var errors = require("./errors-autojs.js");
var control = require("./run-control-autojs.js");
var appVersion = require("./app-version-autojs.js");

function validateConfig(config) {
  if (!config.project || !config.project.id || !config.project.name) {
    throw new Error("项目配置缺少 project.id 或 project.name");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.project.id)) {
    throw new Error("project.id 只能包含小写字母、数字和连字符");
  }
  if (!config.outputRoot) {
    throw new Error("项目配置缺少 outputRoot");
  }
}

// 素材定位有两种形态，任务不应该关心当前是哪一种：
// 开发时素材单独推到设备的绝对路径（如 /sdcard/<项目目录>/assets）；
// 打包成 APK 后素材随脚本一起进包，只能用相对当前脚本的路径。
// 约定：assetsRoot 以 . 开头即为相对模式，交给 files.path 解析。
function createAssetResolver(config) {
  var assetsRoot = config.assetsRoot || "";
  var isRelative = assetsRoot.charAt(0) === ".";

  return function (relativePath) {
    if (!assetsRoot) {
      throw new Error("项目配置缺少 assetsRoot，无法定位找图素材");
    }
    var fullPath = assetsRoot + "/" + relativePath;
    return isRelative ? files.path(fullPath) : fullPath;
  };
}

// 把脚本自身切回前台。仅用于申请截图权限之前。
// 日志保留宿主包名：org.autojs.autojs6 是开发路径，打包 APK 是自己的包名，排查两个宿主抢
// MediaProjection 时靠这一行区分。切回的具体途径见 foreground-autojs.js。
function bringSelfToForeground(logger, config) {
  try {
    var foreground = require("./foreground-autojs.js");
    var selfPackage = context.getPackageName();
    var via = foreground.bringScriptToFront();
    logger.info("将脚本自身切回前台以申请截图权限: " + selfPackage + "（" + via + "）");
    sleep(config.runtime.foregroundSettleMs || 3000);
  } catch (error) {
    // 切不回去也继续尝试申请，失败时由 requestPermission 报出明确原因。
    logger.warn("切回前台失败，仍尝试申请截图权限: " + error);
  }
}

// AutoJs6 内部对「拉起截图授权窗口」有 5 秒硬超时，本机实测拉起耗时正好卡在这条线上，
// 表现为超时抛错、而弹窗随后才显示出来。切前台后多等一会，并允许重试几次。
function requestCaptureAfterLaunch(screen, logger, config) {
  var maxAttempts = config.runtime.capturePermissionAttempts || 3;

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    bringSelfToForeground(logger, config);
    try {
      screen.requestPermission();
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      logger.warn(
        "第 " + attempt + " 次申请截图权限失败，重试: " + (error.message || error)
      );
      sleep(2000);
    }
  }
}

// 前台是不是我们自己。是的话再给一次机会把目标应用拉回来，还不行就判 broken——
// 宁可这一趟不跑，也不能对着自己的界面乱点。
// 读不到前台包名（部分 ROM 屏蔽）就放行：不能因为查不出来就什么都不跑。
// 参数叫 taskContext，别遮住全局的 context——自己的包名要从那个全局的安卓 Context 上取。
function assertNotOurOwnUi(taskContext, config) {
  var logger = taskContext.logger;
  var actions = taskContext.actions;
  var selfPackage;
  try {
    selfPackage = context.getPackageName();
  } catch (error) {
    return;
  }

  for (var attempt = 1; attempt <= 2; attempt++) {
    var front = actions.foregroundPackage();
    if (front === null) {
      // 读不到就放行：不能因为查不出来就什么都不跑。
      logger.info("读不到前台包名，跳过「别点到自己」检查");
      return;
    }
    if (front !== selfPackage) return;
    logger.warn("前台仍是脚本自己（" + front + "），再把目标应用拉一次");
    if (config.game && config.game.packageName) {
      if (config.game.homeActivity) {
        actions.launchHome(config.game.packageName, config.game.homeActivity);
      } else {
        actions.launchPackage(config.game.packageName);
      }
    }
    sleepInterruptibly(config.runtime.foregroundSettleMs || 3000, logger);
  }

  throw errors.broken(
    "目标应用没能切到前台，前台仍是脚本自己（" + selfPackage +
      "）。继续跑只会对着脚本自己的界面乱点（实测点到过自己的「终止」），已中止"
  );
}

function getErrorDetail(error) {
  if (!error) {
    return "未知错误";
  }
  // AutoJs6 的 Rhino 引擎里 error.stack 只有调用栈、不含消息本身，
  // 只取 stack 会把"为什么失败"整句丢掉，报告里只剩一串行号。
  var message = error.message ? String(error.message) : String(error);
  var stack = error.stack ? String(error.stack) : "";
  return stack ? message + "\n" + stack : message;
}

// 任务 id 会被当成目录名用。登记表里的 id 都是小写字母数字连字符，本来无所谓，
// 但现造的任务不一定——录制用例是 recorded:<会话 id>，冒号在 Windows 上根本
// 建不了文件，run-task.ps1 的 adb pull 会取不回结果，而设备侧不会报任何错。
// 只清洗路径这一段，任务 id 本身保持原样，日志和 result.json 里仍是它真实的 id。
function toPathSegment(taskId) {
  return String(taskId).replace(/[^A-Za-z0-9._-]/g, "_");
}

// 可被暂停/终止打断的等待现在住在 run-control 里，与 checkpoint 同处一屋——
// 那才是它的归属，而且常驻等非 runtime 的调用方也用得上（2026-09-18 搬的）。
var sleepInterruptibly = control.sleepInterruptibly;

// 建一份任务上下文。run() 用它，单步调试（STEP-DEBUG.md）也用它——
// 调试时拿到的 screen / actions 必须和真跑时是同一套，否则调试通过不代表真跑通过。
// options.onProgress 见下方 run() 的说明。
function createContext(config, outputDir, options) {
  var runOptions = options || {};
  var logger = loggerModule.create({ outputDir: outputDir });
  var screen = screenModule.create({
    logger: logger,
    outputDir: outputDir,
    capture: config.capture
  });
  var actions = actionsModule.create({
    logger: logger,
    runtime: config.runtime
  });
  var ocr = ocrModule.create({ logger: logger });
  return {
    config: config,
    logger: logger,
    screen: screen,
    actions: actions,
    ocr: ocr,
    workflow: workflow,
    outputDir: outputDir,
    assetPath: createAssetResolver(config),
    control: control,
    // 这一趟是不是后台定时调度器。只有常驻调度那个任务看它：
    // 后台跑的时候它的循环要用自己的停止开关，并且一条一抢执行锁
    // （睡着的时候不占锁，人照样能手点任务跑）。
    backgroundScheduler: runOptions.backgroundScheduler === true,
    progress: {
      report: function (step) {
        if (!runOptions.onProgress) return;
        try {
          runOptions.onProgress(step);
        } catch (error) {
          logger.warn("进度回调出错，已忽略: " + error);
        }
      }
    }
  };
}

// options.onProgress：任务跑到第几步时回调，界面用它就地刷新。
//   回调在**工作线程**里触发，实现方要自己 ui.run 回到 UI 线程再改界面。
//   回调里抛错不能掀翻任务，所以统一吞掉并记一条日志。
// options.onStage：换阶段时回调一句人话（目前只有前置任务用）。同样在工作线程里触发。
// options.prerequisites：主任务之前要先跑的任务对象数组，跑在同一个会话里。
//   本模块不关心它们是什么——「先确保游戏能操作再干活」这类语义由调用方决定。
//   任一前置失败就整趟失败，主任务不执行：前置不成立时主任务只会对着错画面乱点。
function run(config, task, options) {
  validateConfig(config);

  var runOptions = options || {};
  // 每次启动任务都清掉上一轮遗留的暂停/终止标志，否则上次点过暂停没继续，
  // 这次一起步就卡住，而且看不出原因。
  control.reset();

  var startedAt = new Date();
  var runId = startedAt.getTime();
  var outputDir = config.outputRoot + "/" + toPathSegment(task.id) + "/" + runId;
  var context = createContext(config, outputDir, runOptions);
  var logger = context.logger;
  var screen = context.screen;
  var actions = context.actions;
  var result = {
    projectId: config.project.id,
    taskId: task.id,
    taskName: task.name,
    status: "running",
    startedAt: startedAt.toISOString(),
    // 这条记录是哪个包跑出来的。事后翻 result.json 查一个失败时，
    // 第一个要排除的就是「当时设备上装的根本不是我改过的那版」。
    build: appVersion.info(config),
    device: {
      width: device.width,
      height: device.height,
      sdkInt: device.sdkInt,
      brand: device.brand,
      model: device.model
    }
  };

  try {
    logger.info("开始任务: " + task.name + " [" + task.id + "]");
    // 排查基本都从 logcat 或 latest.log 开始，所以版本要在日志的最前面。
    // 排查常驻时更需要它——那时候没人在设备前，界面上的版本谁也看不见。
    logger.info("构建版本: " + appVersion.label(config));

    if (config.screen && config.screen.strict) {
      if (
        device.width !== config.screen.width ||
        device.height !== config.screen.height
      ) {
        throw errors.broken(
          "屏幕尺寸不匹配，期望 " +
            config.screen.width +
            "x" +
            config.screen.height +
            "，实际 " +
            device.width +
            "x" +
            device.height
        );
      }
    }

    // 有的应用会在启动那一刻检测是否有录屏，发现就自行退出（已在囧游村盒子上实测复现）。
    // 这类任务必须先启动应用、后申请截图权限，顺序反了应用起不来。
    var captureAfterLaunch = task.captureAfterLaunch === true;
    // 后台定时调度器**启动时一个权限都不要**。
    //
    // 2026-10-04 实测（我自己在云机上跑的）：调度器起来后卡在
    // 「申请 MediaProjection 截图权限」整整七分钟一动不动——requestScreenCapture()
    // 是阻塞的，没人点那个系统弹窗它就一直等。而外面完全看不出来：
    // scheduler.lock 的心跳是独立线程写的，照跳；界面上定时也写得好好的。
    // 表现就是"一切正常，就是不跑"。
    //
    // 授权改成到点要跑某一条时再要，由调度器自己管，并且有上限（见 resident）。
    // 代价说清楚：夜里系统不让后台弹窗时那一条跑不成，日志里会写明。
    // 但那总好过整个调度器无声无息地吊死。
    var skipStartupSetup = runOptions.backgroundScheduler === true;
    var needsCapture = task.requiresCapture !== false && !skipStartupSetup;

    // 前置任务：在**同一个运行会话里**、主任务之前跑。同一个会话是关键——
    // 截图授权按会话算（一次会话只弹一次），日志也落同一份，
    // 另起一趟 runtime.run 会再弹一次窗、再等一遍启动。
    //
    // 纯死坐标的录制本来不申请截图权限，但前置多半要靠画面判断当前在哪，
    // 所以这里按「主任务或任一前置需要」取并集。漏掉的话前置一上来就没画面可看。
    var prerequisites = runOptions.prerequisites || [];
    for (var pre = 0; pre < prerequisites.length; pre++) {
      if (prerequisites[pre].requiresCapture !== false) {
        needsCapture = true;
      }
    }

    // 后台定时调度器**不在启动时拉游戏**（2026-10-04 用户反馈：
    // 「安装好，上来就错误日志」那一屏里还有一行「启动游戏」——人只是打开 App，
    // 却被拽进了游戏）。它绝大多数时间在睡觉，真到点要跑了才需要游戏在前台，
    // 那一下由调度器自己在跑每条调度项之前做。
    //
    // **截图授权仍然在启动时要**：MediaProjection 只能由前台的界面发起，
    // 而到点触发多半是夜里、前台是游戏，那时再要必然要不到——
    // 无人值守就是从这一步开始失效的。一个弹窗换一整夜能跑，划算。
    var wantsLaunch = task.launchGame !== false && !skipStartupSetup;

    // 目标应用是不是已经在跑。这一个判断决定两件事：等多久、以及要不要来回切前台。
    var gameAlreadyRunning =
      wantsLaunch && config.game && config.game.packageName
        ? actions.isPackageRunning(config.game.packageName)
        : null;

    // 先申请、还是先启动？取决于目标应用会不会在**启动那一刻**检测录屏。
    // 会检测的（本机的盒子就是）必须先启动、等它过了检测再申请，这就是 captureAfterLaunch。
    // 但**进程已经在跑**时那道检测早过了，先申请反而干净：此时脚本还在前台，
    // 弹窗直接就能弹，省掉"拉起游戏 → 切回脚本 → 再拉起游戏"这趟来回
    // （2026-09-17 用户实测：点运行之后画面在 App 和游戏之间跳了三次，正是这趟）。
    var requestBeforeLaunch =
      needsCapture && (!captureAfterLaunch || gameAlreadyRunning === true);
    if (requestBeforeLaunch) {
      screen.requestPermission();
    }

    if (wantsLaunch) {
      if (!config.game || !config.game.packageName) {
        throw new Error("当前任务需要启动游戏，请先配置 game.packageName");
      }
      if (captureAfterLaunch) {
        // 此时还没有截图权限，无法用画面判断前台，只能等固定时间，
        // 再由任务的第一个步骤自行校验落在了预期页面。
        //
        // 但那段长等待是为**冷启动**设的：盒子在启动那一刻会检测录屏，发现就自己退出，
        // 所以必须等它过了检测。进程已经在跑就说明检测早过了，只需要等窗口切过来。
        // 查不出来（null）一律按冷启动等满——宁可白等，也不要在应用还没就绪时就开点。
        var alreadyRunning = gameAlreadyRunning;
        // 从首页起跑的任务要的是首页本身。launchPackage 只会把应用恢复到
        // 上次停在的那一页，对这类任务等于起点就错了。
        if (task.startFromHome === true && config.game.homeActivity) {
          actions.launchHome(config.game.packageName, config.game.homeActivity);
        } else {
          actions.launchPackage(config.game.packageName);
        }
        var settleMs = alreadyRunning === true
          ? (config.runtime.warmLaunchSettleMs || 3000)
          : (config.runtime.launchSettleMs || 15000);
        logger.info(
          alreadyRunning === true
            ? "目标应用进程已在，只等 " + settleMs + " 毫秒让它切到前台"
            : "等待应用启动 " + settleMs + " 毫秒" +
              (needsCapture ? "后再申请截图权限" : "") +
              (alreadyRunning === null ? "（查不到进程状态，按冷启动等满）" : "")
        );
        // 整段 sleep 掉的话，这期间按暂停/终止毫无反应，
        // 而这正好是任务最开始、人最容易发现点错了想撤回的时候。切成小段带检查点。
        sleepInterruptibly(settleMs, logger);

      } else {
        actions.launchPackageAndWait(
          config.game.packageName,
          config.runtime.launchTimeoutMs,
          {
            // 任务可选地提供画面判断，用于包名查询被 ROM 屏蔽的设备。
            confirmForeground: task.confirmForeground
              ? function () {
                  return task.confirmForeground(context);
                }
              : null
          }
        );
      }
    }

    if (needsCapture && !requestBeforeLaunch) {
      if (screen.hasPermission()) {
        // 本次脚本会话已经授权过了。再走一遍"切回前台申请"只会让画面在
        // App 和游戏之间白跳一趟，而且什么也不会弹。
        logger.info("截图授权本次会话已有，跳过切回前台申请");
      } else {
        // 目标应用已经抢到前台，脚本自身退到了后台，而 Android 不允许后台应用拉起权限弹窗。
        // 这里负责把自己切回前台后再申请，并处理拉起窗口偏慢导致的超时。
        requestCaptureAfterLaunch(screen, logger, config);
        // 授权过程把目标应用挤到了后台，重新拉回前台。
        // 进程还在，只是切换窗口，不会再触发它的启动期检测。
        // **后台调度器这一趟不碰游戏**：它根本没拉过游戏，这里再拉一次
        // 就等于"打开 App 顺手把人扔进游戏"，正是要治的那件事。
        if (wantsLaunch) {
          actions.launchPackage(config.game.packageName);
          sleep(config.runtime.foregroundSettleMs || 3000);
        }
      }
    }

    // 开点之前必须确认前台不是我们自己。
    // 2026-09-17 实机血的教训：首页没真的拉起来（日志说拉了、画面没动），
    // 于是用例第一步的点击落在了脚本自己的任务列表页上，(638,1236) 正好是「终止」——
    // **脚本点了自己的终止**，日志里显示"任务已被手动终止"，查了很久。
    // 这种情况下继续点只会乱点自己的界面，必须当场拦住。
    // 后台调度器这一趟不走这道闸：它起来的时候前台**正是我们自己**（人刚打开 App），
    // 而它接下来并不点屏幕，只是进循环看表。真要跑调度项时游戏会被拉到前台，
    // 那一刻的护栏由调度器自己在跑每条之前做。
    if (wantsLaunch) {
      assertNotOurOwnUi(context, config);
    }

    // 前置跑在开点护栏之后：它自己也要点东西（关弹窗、走登录），
    // 前台要是我们自己，它一样会乱点。
    //
    // 前置的步骤并进结果里，不藏起来——「这一趟到底有没有重新登录」
    // 是看运行记录时第一个想知道的事。
    var prerequisiteSteps = [];
    for (var index = 0; index < prerequisites.length; index++) {
      var prerequisite = prerequisites[index];
      logger.info("前置任务: " + prerequisite.name + " [" + prerequisite.id + "]");
      if (runOptions.onStage) {
        // 前置真要登录时能跑一分多钟，界面上不说一声，看起来就是卡在「正在启动…」。
        try {
          runOptions.onStage("前置: " + prerequisite.name);
        } catch (stageError) {
          logger.warn("前置进度回调抛错，已忽略: " + stageError);
        }
      }
      var got;
      try {
        got = prerequisite.run(context) || [];
      } catch (prerequisiteError) {
        // 原样抛，别包一层：包了就丢掉 broken / cancelled 的区分，
        // 而那正是统计通过率时最不能丢的东西。日志里已经说清是哪一条前置了。
        logger.error("前置任务失败，主任务不再执行: " + prerequisite.name);
        throw prerequisiteError;
      }
      for (var s = 0; s < got.length; s++) {
        prerequisiteSteps.push(got[s]);
      }
    }

    result.steps = prerequisiteSteps.concat(task.run(context) || []);
    result.status = "passed";
    logger.info("任务完成: " + task.name);
  } catch (error) {
    // broken = 环境或前置条件不成立（权限、启动、素材、屏幕），failed = 用例真没通过，
    // cancelled = 人自己按了终止。三者必须分开统计，否则通过率会失去意义。
    result.status = errors.statusOf(error);
    result.error = getErrorDetail(error);
    if (result.status === "cancelled") {
      logger.info("任务已被手动终止: " + result.error);
    } else {
      logger.error(
        (result.status === "broken" ? "任务中断（环境问题）: " : "任务失败: ") + result.error
      );
    }
    // 人主动终止不留失败截图：那不是故障现场，存了只会让 output 目录越堆越大。
    if (result.status !== "cancelled" && screen.hasPermission()) {
      try {
        result.failureScreenshot = screen.saveStage("task-failed");
      } catch (captureError) {
        logger.warn("任务失败截图保存失败: " + captureError);
      }
    }
    throw error;
  } finally {
    // 点击标记的悬浮窗跟着任务收掉。收不掉不能影响结果落盘。
    try {
      actions.dispose();
    } catch (disposeError) {
      logger.warn("收起点击标记失败，已忽略: " + disposeError);
    }
    var finishedAt = new Date();
    result.finishedAt = finishedAt.toISOString();
    result.durationMs = finishedAt.getTime() - startedAt.getTime();
    logger.saveJson("result.json", result);
    logger.flush("latest.log");
  }
}

module.exports = {
  createContext: createContext,
  run: run,
  // 导出给 resident：后台到点跑的那一趟要落在**同一个形状**的目录里
  // （<outputRoot>/<taskId>/<runId>/），「运行记录」那一页才认得出它。
  // 两处各拼一遍路径迟早拼出两个不同的目录名，而那种错是静默的——
  // 盘上有东西，界面上就是找不到（launcher 的调度项 id 已经踩过同一个坑）。
  toPathSegment: toPathSegment
};
