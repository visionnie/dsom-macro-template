// =====================================================================
// 操作场景：提交前检查 AutoJs6 源码、项目脚本、配置和任务登记
// 当前手动步骤：递归找 JS -> Node 语法检查 -> 校验配置 -> 校验任务 ID
// 输入参数：无
// 失败处理：任一检查失败立即退出 1
// 输出：控制台检查结果
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const projectRoot = path.resolve(__dirname, "..", "..");

function collectJavaScriptFiles(directoryPath) {
  const files = [];
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files;
}

function checkSyntax(filePath) {
  const result = childProcess.spawnSync(process.execPath, ["--check", filePath], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      "语法检查失败: " + path.relative(projectRoot, filePath) + "\n" + result.stderr
    );
  }
}

// 模块别名用在了没有 require 它的函数里 —— 这一类错 `node --check` 查不出来，
// 要等人点到那个界面才炸。
//
// 2026-10-01 真实事故：给 launcher 的两处加 `recordedCase.usesImage(...)` 时，
// 那两个函数（`collectUserTasks` / `renderRecordingReview`）自己没 require 过它，
// 于是**任务列表整页变成「打不开这条录制: "recordedCase" 未定义」**，
// 而 check / build / 五个纯数据探针全是绿的。
//
// 做法粗但正好卡住这一类：先收集本文件里所有 `var X = require(...)` 的别名，
// 再看每个 `X.` 的用法所在的顶层函数里（或模块级）有没有声明过它。
// 顶层函数的边界用 /^function 认——本项目所有文件都是这个写法；
// 嵌套函数继承外层声明，所以按"最近的顶层函数"算作用域是对的。
//
// **已知盲点**：声明写在嵌套函数（回调）里时，这里也会算成"外层有"，于是放过。
// 2026-10-01 那次事故的两处，它只报得出其中一处（另一处的 require 恰好写在某个
// 点击回调里）。要补得做真正的作用域分析，代价不值；**宁可少报也别乱报**——
// 一个天天喊狼来了的检查，最后谁都不看。
// 自验方式：把 launcher 顶上那行 `var recordedCase = require(...)` 临时删掉，
// `npm run check` 必须报 `collectUserTasks`。（2026-10-01 这么验过。）
function checkRequireScopes(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  const requirePattern = /\bvar\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/;
  const aliases = new Set();
  for (const line of lines) {
    const matched = requirePattern.exec(line);
    if (matched) aliases.add(matched[1]);
  }
  if (aliases.size === 0) return [];

  // 一个名字在别处是模块别名，在这个函数里完全可以是普通局部变量或参数
  // （本项目里 registry / entries / removed 都是这样）。所以作用域要连
  // **var 声明和函数参数**一起收，只收 require 的话会报一堆假阳性。
  function declaredNames(text) {
    const names = new Set();
    let matched;
    const varPattern = /\bvar\s+([A-Za-z_$][\w$]*)/g;
    while ((matched = varPattern.exec(text)) !== null) names.add(matched[1]);
    const namedFunctionPattern = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
    while ((matched = namedFunctionPattern.exec(text)) !== null) names.add(matched[1]);
    // 任意函数（含回调）的参数：回调参数同样能遮住外层的同名别名。
    const paramsPattern = /\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g;
    while ((matched = paramsPattern.exec(text)) !== null) {
      for (const raw of matched[1].split(",")) {
        const name = raw.trim();
        if (name) names.add(name);
      }
    }
    return names;
  }

  // 顶层函数的边界：从 /^function 到下一个 /^function（本项目所有文件都是这个写法）。
  const bounds = [];
  for (let index = 0; index < lines.length; index++) {
    if (/^function\s+([A-Za-z_$][\w$]*)/.test(lines[index])) {
      bounds.push({ start: index, name: /^function\s+([A-Za-z_$][\w$]*)/.exec(lines[index])[1] });
    }
  }
  const moduleText = bounds.length > 0
    ? lines.slice(0, bounds[0].start).join("\n")
    : source;
  const moduleScope = declaredNames(moduleText);

  const problems = [];
  for (let b = 0; b < bounds.length; b++) {
    const start = bounds[b].start;
    const end = b + 1 < bounds.length ? bounds[b + 1].start : lines.length;
    const bodyLines = lines.slice(start, end);
    const scope = declaredNames(bodyLines.join("\n"));
    for (let i = 0; i < bodyLines.length; i++) {
      const withoutComment = bodyLines[i].replace(/\/\/.*$/, "");
      for (const alias of aliases) {
        if (moduleScope.has(alias) || scope.has(alias)) continue;
        // 只认 `别名.` 这种成员访问，别把同名字符串和注释算进来。
        const usage = new RegExp("(^|[^\\w$.\"'])" + alias + "\\s*\\.");
        if (usage.test(withoutComment)) {
          problems.push(
            path.relative(projectRoot, filePath) + ":" + (start + i + 1) +
              " 用了 " + alias + "，但函数 " + bounds[b].name +
              " 内没有声明它（模块级也没有）——跑到这一行会报「" + alias + " 未定义」"
          );
        }
      }
    }
  }
  return problems;
}

function checkConfig() {
  const configPath = path.join(projectRoot, "src/config/game-config-autojs.js");
  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  if (!config.project || !/^[a-z0-9][a-z0-9-]*$/.test(config.project.id)) {
    throw new Error("项目配置中的 project.id 无效");
  }
  if (!config.game.packageName) {
    console.warn("警告: 尚未填写 game.packageName，游戏启动检查暂不可用");
  }
}

function checkTasks() {
  const config = require(path.join(projectRoot, "src/config/game-config-autojs.js"));
  const registryPath = path.join(projectRoot, "src/task-registry-autojs.js");
  delete require.cache[require.resolve(registryPath)];
  const registry = require(registryPath);
  const taskIds = registry.listIds();
  const uniqueTaskIds = new Set(taskIds);
  if (uniqueTaskIds.size !== taskIds.length) {
    throw new Error("任务登记存在重复 ID: " + taskIds.join(", "));
  }
  if (taskIds.length === 0) {
    throw new Error("至少需要登记一个任务");
  }
  for (const taskId of taskIds) {
    const task = registry.get(taskId);
    if (!task.name || typeof task.run !== "function") {
      throw new Error("任务缺少 name 或 run: " + taskId);
    }
  }
  registry.get(config.defaultTask);
}

// 调度表此前完全不进检查。它是无人值守链路的输入：taskId 拼错、时间窗写错，
// 要等开机自启、常驻起来才暴露，而那时没人在设备前——最坏情况是整夜什么都没跑。
// 校验规则复用设备侧同一份 validateSchedule，两边判定不会不一致。
function checkSchedule() {
  const schedulePath = path.join(projectRoot, "src/config/schedule-autojs.js");
  if (!fs.existsSync(schedulePath)) {
    return 0;
  }
  delete require.cache[require.resolve(schedulePath)];
  const schedule = require(schedulePath);
  const resident = require(path.join(projectRoot, "src/core/resident-autojs.js"));
  resident.validateSchedule(schedule);

  const recordedTask = require(path.join(projectRoot, "src/core/recorded-task-autojs.js"));
  const registry = require(path.join(projectRoot, "src/task-registry-autojs.js"));
  const knownTaskIds = new Set(registry.listIds());

  for (const entry of schedule.entries) {
    for (const taskId of [entry.taskId].concat(entry.requires || [])) {
      // recorded:<会话 id> 指向设备上的录制目录，PC 上查不了它存不存在。
      // 它本该由设备侧增补层提供，出现在仓库代码里多半是抄错了。
      if (recordedTask.isRecordedTaskId(taskId)) {
        console.warn(
          "警告: 调度项 [" + entry.id + "] 引用了录制任务 " + taskId +
            "，它只在设备上存在，PC 侧无法校验"
        );
        continue;
      }
      if (!knownTaskIds.has(taskId)) {
        throw new Error(
          "调度项 [" + entry.id + "] 引用了未登记的任务: " + taskId
        );
      }
    }
  }
  return schedule.entries.length;
}

// 用例 JSON 此前完全不进检查：写错字段、节点 id 重复、跳转目标拼错、素材文件名写错，
// 都要等推到设备上跑到那一步才暴露，一次往返好几分钟。这里在 PC 上一次性查掉。
// case-runner 的顶层只有 require 和函数定义，不碰 files / device，可以在 Node 里直接用。
function checkCases() {
  const casesDir = path.join(projectRoot, "src/cases");
  if (!fs.existsSync(casesDir)) {
    return 0;
  }
  const runnerPath = path.join(projectRoot, "src/core/case/case-runner-autojs.js");
  if (!fs.existsSync(runnerPath)) {
    throw new Error("存在 src/cases/ 但缺少 case-runner，无法校验用例");
  }
  const runner = require(runnerPath);
  const registry = require(path.join(projectRoot, "src/task-registry-autojs.js"));
  const knownTaskIds = new Set(registry.listIds());

  const caseFiles = fs
    .readdirSync(casesDir)
    .filter((name) => name.toLowerCase().endsWith(".json"));

  for (const fileName of caseFiles) {
    const casePath = path.join(casesDir, fileName);
    const relative = path.relative(projectRoot, casePath);
    let data;
    try {
      // Windows 编辑器常写入 UTF-8 BOM，肉眼看不出来但 JSON.parse 直接抛。
      // 设备侧 case-runner 也做同样的容错。
      data = JSON.parse(fs.readFileSync(casePath, "utf8").replace(/^﻿/, ""));
    } catch (parseError) {
      throw new Error("用例 JSON 解析失败: " + relative + "\n" + parseError.message);
    }

    try {
      runner.validateCase(data);
    } catch (validationError) {
      throw new Error("用例校验失败: " + relative + "\n" + validationError.message);
    }

    // 以下三项运行时查不了或故意放过，只能静态查：
    const nodeIds = new Set(data.nodes.map((node) => node.id));
    const terminals = new Set(["@next", "@end", "@abort"]);

    // 1. 跳转目标存在性。validateCase 刻意放行未知字符串（允许向前跳），
    //    于是拼错一个 id 要跑到那一步才炸。
    for (const node of data.nodes) {
      for (const field of ["onSuccess", "onFail", "onExhausted"]) {
        const target = node[field];
        if (target == null || terminals.has(target)) continue;
        if (!nodeIds.has(target)) {
          throw new Error(
            "用例跳转目标不存在: " + relative +
              " 节点 [" + node.id + "] 的 " + field + " -> " + target
          );
        }
      }
    }
    if (data.entry && !nodeIds.has(data.entry)) {
      throw new Error("用例 entry 不存在: " + relative + " -> " + data.entry);
    }

    // 2. 素材文件存在性。素材缺失在设备上是 broken，但完全可以在这里拦住。
    //    assetBase 为 case 时素材相对用例文件所在目录，与设备侧 case-runner 的解析规则一致。
    const assetRoot = data.assetBase === "case"
      ? path.dirname(casePath)
      : path.join(projectRoot, "src/assets");
    for (const node of data.nodes) {
      if ((node.type !== "tapImage" && node.type !== "swipeImage") || !node.asset) continue;
      const assetPath = path.join(assetRoot, node.asset);
      if (!fs.existsSync(assetPath)) {
        throw new Error(
          "用例引用的素材不存在: " + relative +
            " 节点 [" + node.id + "] -> " + path.relative(projectRoot, assetPath)
        );
      }
    }

    // 3. 前置依赖必须是已登记的任务，否则常驻调度器到点才发现补不上。
    for (const required of data.requires || []) {
      if (!knownTaskIds.has(required)) {
        throw new Error(
          "用例 requires 指向未登记的任务: " + relative + " -> " + required
        );
      }
    }
  }
  return caseFiles.length;
}

// 悬浮层里 findView 的每个 id，布局里必须真有。
//
// 为什么值得单独做一道闸：这些文件都有一段「views 里任何一个是 null 就抛
// 控件未找到」的护栏，而那个抛出来之后整层建不起来，调用方只拿到一个 null，
// 表现是"点了没反应"或者"被甩回 App"——2026-10-04 用户点「编辑」被甩回 App，
// 页面上还写着「悬浮窗权限缺失」，而权限明明是好的，查了半天。
// 这种错纯粹是拼写/漏加，完全能在 PC 上静态查出来，不该等到真机。
//
// 只看同一个文件里的字面量：id 与 findView 都写成常量字符串是这几个文件的惯例，
// 拼接出来的（"row" + i 这种）本来就查不了，跳过。
function checkOverlayViewIds(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  if (source.indexOf("findView(") < 0) return [];

  // 注：**没有做"同一个 id 出现两次"这道闸**。试过，误报太多——
  // recorder / point-picker / region-picker 各自画两个窗口，两个 id="root" 是合法的，
  // 而静态分不出"这两个 id 在不在同一个布局里"。一道会乱叫的闸比没有闸更糟：
  // 人很快就学会无视它，真出事那次也一起无视了。
  // 重复 id 的后果（findView 只认得到第一个，第二个成了点不动的死控件）
  // 记在这儿提醒看代码的人，挪控件时记得删旧的那组。
  const declared = new Set();
  const idPattern = /\bid="([A-Za-z0-9_]+)"/g;
  let matched;
  while ((matched = idPattern.exec(source)) !== null) {
    declared.add(matched[1]);
  }

  const problems = [];
  const seen = new Set();
  const lookupPattern = /findView\(\s*"([A-Za-z0-9_]+)"\s*\)/g;
  while ((matched = lookupPattern.exec(source)) !== null) {
    const id = matched[1];
    if (declared.has(id) || seen.has(id)) continue;
    seen.add(id);
    problems.push(path.relative(projectRoot, filePath) + " 找 " + id + "，布局里没有这个 id");
  }

  // 第二道：用了 views.X，却从没把 X 放进 views。
  //
  // **这才是真正咬人的那一类。** 2026-10-04：加「连续点击」按钮时 XML 里加了、
  // 代码里用了，唯独忘了在 views 里把它取出来那一行。
  // 于是 views 上那个键是 undefined，接线时 TypeError，整层建不起来——
  // 而那段「控件未找到」的护栏只遍历 views 里**已有的键**，漏加的它根本看不见。
  // 第一道闸也查不出来：布局里那个 id 明明是在的。
  //
  // 取"赋值过的键"用 `名字: ` 这种写法：findView 取的、空数组占位的都算。
  const assigned = new Set();
  const assignPattern = /^\s*([A-Za-z0-9_]+)\s*:\s*(?:window\.findView\(|\[\s*\]|\{\s*\})/gm;
  while ((matched = assignPattern.exec(source)) !== null) {
    assigned.add(matched[1]);
  }
  if (assigned.size > 0) {
    const usedSeen = new Set();
    const usePattern = /\bviews\.([A-Za-z0-9_]+)/g;
    while ((matched = usePattern.exec(source)) !== null) {
      const key = matched[1];
      if (assigned.has(key) || usedSeen.has(key)) continue;
      usedSeen.add(key);
      problems.push(
        path.relative(projectRoot, filePath) + " 用了 views." + key + "，但从没把它放进 views"
      );
    }
  }
  return problems;
}

// 行数据的字段清单：launcher 的 rowOf 产出的每个字段，都必须在 step-overlay 的
// ROW_KEYS 里（或在下面这张白名单里，带理由）。
//
// **这张清单已经漏过两次，两次都是同一个形状。** adoptRow 保存后只按 ROW_KEYS
// 把新值抄回本地那份 step，漏掉的字段写盘是对的、本地那份停在旧值，于是：
//   2026-10-04 加「连续点击」漏了 multiCount —— 用户报"填 2 确定后变回 1"，
//     修了一轮没治住，再报"外面是 3、点进去还是 2"，两轮才看清形状
//   2026-10-06 加「循环分组」漏了 repeat —— 用户 2026-10-08 报"默认执行 1 次，
//     这个 2 次没办法修"：-/+ 每次都拿旧值算，从 1 按「+」得 2，再按还是 2
//
// 这一类 `node --check` 查不出来，纯数据探针也碰不到（它在界面回填的那一步），
// 只有人点到那个按钮才会发现。所以用一道静态闸守着。
//
// 做法粗但正好卡住这一类：rowOf 返回的是一个对象字面量，键固定缩进 6 格。
// 嵌套在里面的 IIFE 没有对象字面量，所以不会误伤。
//
// **这道闸守的是"一对"：step-overlay 的 ROW_KEYS 与它的调用方 launcher.rowOf。**
// 只有一边在（模板里就是这样：浮层已经回流，而配套的 launcher 还是老的、
// 没有 rowOf）时不该报错——那时根本没有"调用方产出的字段"这回事，
// 报出来就是乱叫，而**一道会乱叫的闸比没有闸更糟**（本文件上面那条注释原话）。
// 跳过时打一行字说清楚，别让它悄悄失效：真在 rxfs 里把 rowOf 改名了，
// 那行字就会出现在 check 的输出里。
function checkRowKeys() {
  const overlayPath = path.join(projectRoot, "src/core/step-overlay-autojs.js");
  const launcherPath = path.join(projectRoot, "src/core/launcher-autojs.js");
  if (!fs.existsSync(overlayPath) || !fs.existsSync(launcherPath)) return [];

  // 不用抄回去也成立的字段，每个都要有理由。
  const exempt = new Map([
    ["nodeId", "结构字段，只能靠关层重开变，不存在就地改"],
    ["groupId", "同上：进出分组是重开一次层，不是改一行"]
  ]);

  const overlaySource = fs.readFileSync(overlayPath, "utf8");
  const rowKeysBlock = /var\s+ROW_KEYS\s*=\s*\[([\s\S]*?)\]\s*;/.exec(overlaySource);
  if (!rowKeysBlock) {
    console.log("提示: step-overlay 里没有 ROW_KEYS，行字段闸这一轮跳过");
    return [];
  }
  const rowKeys = new Set();
  const keyPattern = /"([A-Za-z0-9_$]+)"/g;
  let matched;
  while ((matched = keyPattern.exec(rowKeysBlock[1])) !== null) rowKeys.add(matched[1]);

  const launcherLines = fs.readFileSync(launcherPath, "utf8").split("\n");
  let start = -1;
  for (let i = 0; i < launcherLines.length; i++) {
    if (/^\s*function\s+rowOf\s*\(/.test(launcherLines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    // 浮层还没有调用方（模板就是这个状态）。不是错，但要说一声。
    console.log("提示: launcher 里没有 rowOf，步骤编辑层还没有调用方，行字段闸这一轮跳过");
    return [];
  }
  const problems = [];
  const produced = new Set();
  for (let i = start; i < launcherLines.length; i++) {
    // 下一个顶层函数就是 rowOf 的尽头。
    if (i > start && /^function\s/.test(launcherLines[i])) break;
    const field = /^ {6}([A-Za-z0-9_$]+)\s*:/.exec(launcherLines[i].replace(/\/\/.*$/, ""));
    if (field) produced.add(field[1]);
  }
  produced.forEach(function (key) {
    if (rowKeys.has(key) || exempt.has(key)) return;
    problems.push(
      "rowOf 产出了 " + key + "，但它不在 step-overlay 的 ROW_KEYS 里——" +
        "改完之后盘上是新值、界面停在旧值（multiCount 和 repeat 都是这么漏的）"
    );
  });
  return problems;
}

const sourceFiles = collectJavaScriptFiles(path.join(projectRoot, "src"));
const scriptFiles = collectJavaScriptFiles(path.join(projectRoot, ".docs/script"));
const scopeProblems = [];
const viewProblems = [];
for (const filePath of sourceFiles.concat(scriptFiles)) {
  checkSyntax(filePath);
  scopeProblems.push(...checkRequireScopes(filePath));
  viewProblems.push(...checkOverlayViewIds(filePath));
}
const rowKeyProblems = checkRowKeys();
if (rowKeyProblems.length > 0) {
  throw new Error(
    "有 " + rowKeyProblems.length + " 个行字段没进 ROW_KEYS" +
      "（表现成「改完界面不变」或「调不动」，而写盘其实是对的）:\n  " +
      rowKeyProblems.join("\n  ")
  );
}
if (viewProblems.length > 0) {
  throw new Error(
    "有 " + viewProblems.length + " 处悬浮层控件对不上" +
      "（整层会建不起来，表现成「点了没反应」或被甩回 App）:\n  " +
      viewProblems.join("\n  ")
  );
}
if (scopeProblems.length > 0) {
  throw new Error(
    "有 " + scopeProblems.length + " 处模块别名用在了没 require 它的地方" +
      "（跑到那一行才会炸，界面上表现成「xxx 未定义」）:\n  " +
      scopeProblems.join("\n  ")
  );
}
checkConfig();
checkTasks();
const scheduleCount = checkSchedule();
const caseCount = checkCases();

console.log(
  "检查通过: " + sourceFiles.length + " 个源码文件" +
    (caseCount > 0 ? "，" + caseCount + " 个用例" : "") +
    (scheduleCount > 0 ? "，" + scheduleCount + " 条调度项" : "")
);
console.log(
  "已登记任务: " +
    require(path.join(projectRoot, "src/task-registry-autojs.js")).listIds().join(", ")
);
