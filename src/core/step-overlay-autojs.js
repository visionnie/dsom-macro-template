// =====================================================================
// 通用能力：浮在游戏上的流程编辑层（步骤列表 + 单步面板）
// 设计约束：
//   - **编辑不能把人甩出游戏**。2026-09-26 用户实机反馈：点「编辑主流程」会把 App
//     切回前台，游戏被顶到后面——而人要改的恰恰是「刚才在游戏里点歪的那一下」，
//     跳出去之后眼前就没有参照物了，回来还得自己把游戏再拉起来。
//     参照自动按键精灵：它的流程编辑就浮在游戏上，改完当场就能试
//   - **打字也留在这一层**。2026-10-02 之前这里写的是「不弹键盘」：floaty 默认
//     NOT_FOCUSABLE、拿不到键盘焦点，所以改名与精确等待值都切回 App 页面去打。
//     那条结论只对了一半——**窗口确实默认拿不到焦点，但它能要**。实机探针验明
//     rawWindow 身上就有 requestFocus，且拿焦点后 NOT_TOUCH_MODAL 仍在、游戏照样点得动。
//     细节与踩法见 `overlay-keyboard-autojs.js` 文件头；本层只管什么时候要、什么时候还
//   - **本模块不碰会话数据**：它只画行、收集意图，存盘、坐标换算、跑一步全交回调用方。
//     取到的坐标在这里是个**不透明值**，只负责从 onPick 原样递到 onApply，
//     绝不自己解释它——那是 recorded-case 的事，两处各算一遍必然算出两个结果
//   - **必须登记进 screen-overlays**：「只跑这一步」会截图找图，不让开就会挡住锚点，
//     表现是稳定失败且看不出根因（run-overlay 踩过这个坑）
//   - **不可全屏、不吃全屏触摸**：只占自己那一块。全屏可触摸的图层会把设备点废
//     （见 point-picker 的看门狗那段教训）
//   - 内容超出 setSize 会被**直接裁掉、不会把窗口撑开**：尺寸一律按像素给，宁可留白
// =====================================================================

var uiThread = require("./ui-thread-autojs.js");
var overlayKeyboard = require("./overlay-keyboard-autojs.js");

// 面板宽度按像素给。640 在竖屏 720 宽上留了窄边，在横屏 1280 宽上占一半——
// 编辑时人要能看见底下的游戏画面，占满就失去了「浮在游戏上」的意义。
var PANEL_WIDTH = 640;
// 列表态的高度上限。**游戏多半是横屏 720 高**，所以不能写死一个竖屏才放得下的数，
// 每次按当前屏幕算，并给上下各留一截边。
var PANEL_MAX_HEIGHT = 900;
var PANEL_VERTICAL_MARGIN = 120;
// 单步面板的高度。**520 不够**：2026-09-26 装机一看，最底下那行「返回列表 / 确定」
// 整个被裁掉了——又是那个「内容超出 setSize 会被直接裁掉、不会把窗口撑开」的坑，
// 这个项目里第三次踩。按七行内容加两行提示的余量给，宁可留白。
// 横屏只有 720 高，所以还要再按屏幕夹一次（见 sizeOfMode）。
var EDIT_HEIGHT = 700;
// 夹到屏幕里时上下各留这么多，别让面板顶到屏幕边缘。
var EDIT_SCREEN_MARGIN = 60;

// 藏起来只剩一个小红标，与运行控制条同一个规矩（2026-09-26 用户要求）。
var HANDLE_WIDTH = 60;
var HANDLE_HEIGHT = 60;

// 列表最多画这么多行。行是在 XML 里预先生成的（floaty 里没有列表控件可用），
// 步骤太多时窗口会被塞爆，而录到上百步的流程本来就该回 App 页面整理。
var MAX_ROWS = 60;

// 上一次 open() 失败的原因。模块级：open 返回 null 时调用方拿它说人话。
var lastErrorText = "";

// 等待步进。四档细调 + 四档粗调：微调一步的时序常常只差一两百毫秒，
// 而「等体力回满」这类是十几二十分钟，靠 +500 按到天亮也按不出来。
var WAIT_STEPS = [-500, -100, 100, 500, -300000, -60000, 60000, 300000];
var DEFAULT_MAX_WAIT_MS = 3600000;

var READY_WAIT_MS = 2000;
var UI_CALL_WAIT_MS = 1500;
var POLL_MS = 30;
var TAP_SLOP_PX = 12;
var DEFAULT_LEFT = 24;
var DEFAULT_TOP_GAP = 24;

var VISIBLE = 0;
var GONE = 8;

// 步骤名是人自己起的，里面出现一个引号就会把整个布局解析坏、界面直接白屏。
// 凡是把数据塞进属性值的地方都要过这一遍（launcher 里同一份教训）。
function escapeXml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function statusBarHeight() {
  try {
    var resources = context.getResources();
    var id = resources.getIdentifier("status_bar_height", "dimen", "android");
    if (id > 0) return resources.getDimensionPixelSize(id);
  } catch (error) {}
  return 48;
}

// 动作类型的中文名。**和那九个按钮上的字必须一模一样**——
// 收起来的时候这行摘要是"现在是哪一种"的唯一说明，和按钮上写的不一致的话，
// 人展开之后会以为自己点错了（2026-10-06 改版）。
function typeNameOf(step) {
  var type = step && step.type;
  if (type === "tapImage") return "点击图片";
  if (type === "swipeImage") return "拖动图片";
  if (type === "swipe") return "滑动";
  if (type === "longTap") return "长按";
  if (type === "noop") return "空等待";
  if (type === "multiTap") return "连续点击";
  if (type === "tapText") return "点击文字";
  if (type === "inputText") return "输入文字";
  return "点击";
}

// 行在 XML 里一次性生成：floaty 窗口里只有 findView 能拿控件，
// 没有数据源绑定那一套，所以有几步就先画几行，之后只 setText 不动结构。
function buildRowsXml(steps) {
  var lines = [];
  for (var i = 0; i < steps.length && i < MAX_ROWS; i++) {
    // **行的结构一个字都不要改。**
    // 2026-10-04 为了放勾选框，我把它从 vertical 改成 horizontal + 带权重的内层
    // vertical，结果进批量模式后整个列表区被压成 0 高——六步一行都看不见，
    // 而批量条、页脚、提示全都在（用户实机截图）。这个窗口的高度是 setSize 定死的，
    // 行一旦换种排法，权重怎么分就不是原来那回事了。
    //
    // 勾选标记改用 pick-overlay 那套**已经在真机上跑过**的办法：等宽字符加在标题前，
    // 选中 ☑、没选 ☐，两个一样宽，所以标题不会左右跳。
    lines.push(
      '        <vertical id="row' + i + '" bg="#1affffff" padding="10 8" marginTop="4">'
    );
    lines.push(
      '          <text id="rowTitle' + i + '" text="' + escapeXml(steps[i].title) +
        '" textColor="#ffffff" textSize="13sp"/>'
    );
    lines.push(
      '          <text id="rowSub' + i + '" text="' + escapeXml(steps[i].subtitle) +
        '" textColor="#b0bec5" textSize="11sp" marginTop="2"/>'
    );
    lines.push("        </vertical>");
  }
  return lines;
}

function buildLayout(steps) {
  return []
    .concat([
      // 底色挪到 panel 与 handle 各自身上，根节点透明：藏成小红标时，
      // 根节点若还带着底色，那一小块看着就比实际大一圈。
      '<vertical id="root" bg="#00000000">',
      '  <text id="handle" text="✎" bg="#e0d32f2f" textColor="#ffffff" textSize="13sp" gravity="center" padding="2"/>',
      '  <vertical id="panel" bg="#f2101418" h="*">',
      // 抓手单独给一个控件：触摸事件会被子控件先吃掉，把监听挂在根节点上的话，
      // 真正能拖的只剩 padding 那几像素（run-overlay 已经踩过）。
      '    <horizontal id="header" bg="#f21b262e" gravity="center_vertical" padding="8 6">',
      '      <text id="dragGrip" text=" ⠿ " textColor="#9e9e9e" textSize="16sp" padding="6 2"/>',
      '      <text id="title" text="" textColor="#ffffff" textSize="14sp" layout_weight="1"/>',
      '      <text id="hideBtn" text=" — " textColor="#90caf9" textSize="16sp" padding="10 2"/>',
      '      <text id="closeBtn" text=" × " textColor="#ff8a80" textSize="16sp" padding="10 2"/>',
      "    </horizontal>",
      '    <vertical id="listBox" layout_weight="1">',
      // ---- 页签：根节点 / 某一个分组（2026-10-08 用户要的，参照自动按键精灵）----
      // 分组里的几步**从根列表上消失**，点分组行才进得去（用户 2026-10-08 原话：
      // "一旦创建分组，任务列表就剩下 节点1、分组1，解散分组才回到任务列表"）。
      // 原先是平铺着加一个「↳ 组内」标记，于是一组 10 步就把根列表撑满，
      // 而那一组本来只该占一行。
      //
      // **页签条常驻，不是进了组才出现**：它只占一行，而一个会随进出忽隐忽现的
      // 控件会让下面所有东西跟着上下跳一格，人以为自己点错了地方。
      // 在根节点时右边那两个（组名、编辑这一组）是空的、点不动。
      '      <horizontal id="tabBar" bg="#f21b262e" gravity="center_vertical" padding="8 4">',
      '        <text id="tabRootBtn" text=" 根节点 " textColor="#ffffff" textSize="13sp" padding="10 4"/>',
      '        <text id="tabGroupBtn" text="" textColor="#78909c" textSize="13sp" padding="10 4" layout_weight="1"/>',
      '        <text id="tabGroupEditBtn" text="" textColor="#ffd54f" textSize="13sp" padding="10 4"/>',
      "      </horizontal>",
      '      <text id="listHint" text="" textColor="#b0bec5" textSize="11sp" padding="10 6"/>',
      '      <ScrollView id="listScroll" layout_weight="1">',
      '        <vertical id="rowBox" padding="8 0">'
    ])
    .concat(buildRowsXml(steps))
    .concat([
      // 「＋ 添加节点」跟在最后一步后面，位置就是人想加一步的地方
      // （2026-10-04 用户要求，参照自动按键精灵的「添加节点」虚线框）。
      // 它加出来的是一个**空等待**：不录也能加的只有"不碰屏幕"这一种，
      // 其余类型都要么要坐标、要么要模板图，加完还得再去取一次，不如让人在单步面板上改。
      '          <text id="addNodeBtn" text="＋ 添加节点" textColor="#69f0ae" textSize="13sp" gravity="center" bg="#1affffff" padding="10 10" marginTop="6"/>',
      "        </vertical>",
      "      </ScrollView>",
      // ---- 批量：两步走（2026-10-07 改版）----
      // 用户实机截图：五行的批量条把整层吃掉了，**七步只看得见一步**，
      // 原话是「几点都没办法选择……什么都放一个界面太拥挤了」。
      // 参照他给的那个产品：**先选要做什么，再选对哪几步做**。
      //
      // 第一步（menuBox）：一列操作，一次只问一件事。
      // 第二步（pickBox）：行变成可勾选，底下只剩"选了几步 + 这一步的参数 + 取消/确定"，
      // 从五行压到两行，列表那块就有地方显示了。
      '      <vertical id="bulkMenuBox" bg="#f21b262e" padding="8 6">',
      '        <text text="要对这些步骤做什么？" textColor="#b0bec5" textSize="12sp" padding="4 2"/>',
      '        <text id="menuDisableBtn" text=" 禁用 " textColor="#ffd54f" textSize="15sp" bg="#1affffff" padding="14 10" marginTop="4" gravity="center"/>',
      '        <text id="menuEnableBtn" text=" 启用 " textColor="#69f0ae" textSize="15sp" bg="#1affffff" padding="14 10" marginTop="4" gravity="center"/>',
      '        <text id="menuWaitBtn" text=" 统一等待 " textColor="#90caf9" textSize="15sp" bg="#1affffff" padding="14 10" marginTop="4" gravity="center"/>',
      '        <text id="menuGroupBtn" text=" 合并成循环组 " textColor="#69f0ae" textSize="15sp" bg="#1affffff" padding="14 10" marginTop="4" gravity="center"/>',
      '        <text id="menuDeleteBtn" text=" 删除 " textColor="#ff8a80" textSize="15sp" bg="#1affffff" padding="14 10" marginTop="4" gravity="center"/>',
      '        <text id="menuCancelBtn" text=" 取消 " textColor="#b0bec5" textSize="14sp" padding="14 8" marginTop="4" gravity="center"/>',
      "      </vertical>",
      // 第二步的底栏。参数行只在需要的那两种操作下出现（统一等待 / 合并成循环组），
      // 其余三种一行都不占——这正是原先那五行里最冤的部分。
      '      <vertical id="bulkPickBox" bg="#f21b262e" padding="8 6">',
      '        <horizontal id="bulkParamRow" gravity="center_vertical">',
      '          <text id="bulkParamLabel" text="" textColor="#b0bec5" textSize="12sp"/>',
      '          <input id="bulkParamInput" text="" textSize="14sp" layout_weight="1" singleLine="true" marginLeft="6"/>',
      '          <text id="bulkParamUnit" text="" textColor="#b0bec5" textSize="12sp" marginLeft="4"/>',
      "        </horizontal>",
      '        <horizontal gravity="center_vertical" marginTop="4">',
      '          <text id="bulkCountText" text="" textColor="#ffffff" textSize="12sp" layout_weight="1"/>',
      '          <text id="bulkAllBtn" text=" 全选 " textColor="#90caf9" textSize="13sp" padding="8 4"/>',
      '          <text id="bulkNoneBtn" text=" 全不选 " textColor="#90caf9" textSize="13sp" padding="8 4"/>',
      '          <text id="bulkExitBtn" text=" 取消 " textColor="#b0bec5" textSize="13sp" padding="8 4"/>',
      '          <text id="bulkConfirmBtn" text=" 确定 " textColor="#69f0ae" textSize="15sp" bg="#1affffff" padding="14 4" marginLeft="4"/>',
      "        </horizontal>",
      "      </vertical>",
      // ---- 长按一行弹出来的菜单（2026-10-08 用户要的，参照自动按键精灵）----
      //
      // **是一块渲染出来的区域，不是弹窗**：本项目明确不用 dialogs.*
      // （阻塞 UI 线程，RECORDER.md 第 4 条坑崩过一次），和批量那两块同一个办法。
      //
      // 长按在这一层此前一次都没用过。**2026-10-08 先在设备上验过才建的**：
      // XML 里画死的真 View 上 setOnLongClickListener 触发得了，返回 true 之后
      // 不会再派发成短按，长按完短按照常（launcher 里记的"list 项 long_click 没验过"
      // 说的是 list 适配器，和这里不是一回事）。
      //
      // 条目固定这几条、靠显隐开关：每次按类型重建的话，控件 id 就得动态生成，
      // 而这个窗口只有 findView 能拿控件。
      '      <vertical id="rowMenuBox" bg="#f21b262e" padding="8 6">',
      '        <text id="rowMenuTitle" text="" textColor="#ffffff" textSize="14sp" padding="4 2"/>',
      '        <text id="rowMenuOpenBtn" text=" ▸ 查看组内 " textColor="#90caf9" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuEditBtn" text=" ✎ 编辑 " textColor="#ffffff" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuCopyBtn" text=" ⧉ 复制 " textColor="#ffd54f" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuPasteBeforeBtn" text=" 黏贴到这一步前 " textColor="#69f0ae" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuPasteAfterBtn" text=" 黏贴到这一步后 " textColor="#69f0ae" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuDisableBtn" text=" ⏸ 禁用 " textColor="#ffab91" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuUngroupBtn" text=" ⤫ 解散分组 " textColor="#90caf9" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuDeleteBtn" text=" 删除 " textColor="#ff8a80" textSize="14sp" bg="#1affffff" padding="12 8" marginTop="4" gravity="center"/>',
      '        <text id="rowMenuCancelBtn" text=" 取消 " textColor="#b0bec5" textSize="13sp" padding="12 6" marginTop="4" gravity="center"/>',
      "      </vertical>",
      '      <horizontal id="listFooter" bg="#f21b262e" gravity="center_vertical" padding="8 6">',
      '        <text id="runAllBtn" text=" ▶ 立即运行 " textColor="#69f0ae" textSize="14sp" padding="12 6"/>',
      '        <text id="bulkBtn" text=" 批量 " textColor="#90caf9" textSize="14sp" padding="12 6"/>',
      // 调用方塞进来的第二个动作（目前是录完之后的「继续录制」）。
      // 没给就整个隐藏，不留一块空着的可点区域。
      '        <text id="extraBtn" text="" textColor="#ffd54f" textSize="14sp" padding="12 6"/>',
      '        <text id="listMsg" text="" textColor="#ffd54f" textSize="11sp" layout_weight="1" marginLeft="8"/>',
      "      </horizontal>",
      "    </vertical>",
      // 单步面板**整体可滚动**，底部那一行固定不动。
      // 这个项目已经四次把按钮挤出窗口了（最近一次是「确定」整行没了），
      // 每次的治法都是把高度再调大一点——而字段只会越来越多，追不上。
      // 现在内容超了就滚，「返回列表 / 确定」永远在。
      '    <vertical id="editBox" layout_weight="1">',
      '      <ScrollView id="editScroll" layout_weight="1">',
      '        <vertical padding="12 10">',
      '      <horizontal gravity="center_vertical">',
      '        <text id="editTitle" text="" textColor="#ffffff" textSize="15sp" layout_weight="1"/>',
      // 改名入口：**就地改**，不再切 App。点它展开下面那行输入框并弹键盘。
      '        <text id="renameBtn" text=" ✎ 改名 " textColor="#ffd54f" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      // 改名行：平时整行隐藏。名字和停顿、坐标一样是草稿——点「用这个名」只是记下，
      // 点「确定」才写盘，省得人以为改完就落地了。
      '      <horizontal id="nameRow" gravity="center_vertical" marginTop="6">',
      // 属性只用项目里已经验过的那几个（text / hint / inputType / textSize / 布局）。
      // 没用过的属性名在这套 XML 里不是被忽略，而是**整层建不出来**——
      // 代价是编辑层整个消失，为一个提示色不值得。
      '        <input id="nameInput" text="" hint="给这一步取个名" textColor="#ffffff" textSize="14sp" layout_weight="1"/>',
      '        <text id="nameOkBtn" text=" 用这个名 " textColor="#69f0ae" textSize="14sp" padding="10 4"/>',
      '        <text id="nameCancelBtn" text=" 取消 " textColor="#b0bec5" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      '      <text id="editMeta" text="" textColor="#b0bec5" textSize="12sp" marginTop="4"/>',
      // ---- 2026-10-06 改版：等待升到主位，动作类型收起来 ----
      // 用户看着这一层说「完全没有重点，一堆东西放在一起」。实测一屏确实如此：
      // 九个动作类型按钮占掉**三整行**、顶在最上面，而改动作类型是低频动作
      // （录完之后偶尔改一次）；高频的是调这一步等多久，它被挤到要滚动才看得见。
      //
      // 所以对调：等待摆在第一屏，动作类型收成一行摘要，点「换一种」才展开那九个。
      // 默认收起省掉三行，这一层本来就在和 setSize 的高度上限较劲
      // （这个项目已经四次把按钮挤出窗口）。
      //
      // 动作**之前**先等多久。两排步进：上排细调、下排粗调。
      // 只有细调的话，一段 20 分钟的等待要按 2400 下 +500——而游戏里
      // 「等体力」「等冷却」这类就是十几二十分钟起步（用户 2026-09-30 的例子）。
      // 精确值就在下面那行输入框里打，不再回 App（2026-10-02 起）。
      // 整块包起来：进分组时要整体隐藏（分组没有"动作前等待"这回事）。
      '      <vertical id="waitBox">',
      '      <text id="editWait" text="" textColor="#ffffff" textSize="16sp" marginTop="10"/>',
      '      <horizontal marginTop="6">',
      '        <text id="wait0" text=" -500 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      '        <text id="wait1" text=" -100 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      '        <text id="wait2" text=" +100 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      '        <text id="wait3" text=" +500 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      "      </horizontal>",
      '      <horizontal marginTop="4">',
      '        <text id="wait4" text=" -5分 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      '        <text id="wait5" text=" -1分 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      '        <text id="wait6" text=" +1分 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      '        <text id="wait7" text=" +5分 " textColor="#90caf9" textSize="15sp" padding="12 5"/>',
      "      </horizontal>",
      // 精确值：步进按得再多也按不出 1200000 这种数（用户 2026-09-30 的例子）。
      // 输入的单位是毫秒——与 App 的步骤编辑页、与用例里的字段同一个单位，
      // 这里再换成秒就是第二套说法，对账时总有一头要换算。
      '      <horizontal id="waitExactRow" gravity="center_vertical" marginTop="6">',
      '        <text text="精确值" textColor="#b0bec5" textSize="13sp"/>',
      '        <input id="waitInput" text="" hint="毫秒" textColor="#ffffff" textSize="14sp" inputType="number" layout_weight="1" marginLeft="8"/>',
      '        <text id="waitOkBtn" text=" 用这个值 " textColor="#69f0ae" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      "      </vertical>",
      // ---- 分组专属的那一块（2026-10-06）----
      // 分组不是一个动作，它没有坐标、没有图、没有动作类型，所以上面那些行
      // 对它一条都不适用；进分组时它们整体隐藏，只留这一块。
      // 改名 / 删除 / 禁用 / 从这一步开始跑沿用通用的那几个按钮——
      // 分组再配一套自己的，两套的二次确认与提示迟早不一致。
      '      <vertical id="groupBox" marginTop="10">',
      '        <text text="这是一个循环分组：下面列出的几步会整组重复执行" textColor="#b0bec5" textSize="12sp"/>',
      '        <horizontal gravity="center_vertical" marginTop="8">',
      '          <text text="执行次数" textColor="#b0bec5" textSize="13sp"/>',
      '          <text id="groupRepeatInfo" text="" textColor="#ffffff" textSize="17sp" layout_weight="1" gravity="center"/>',
      '          <text id="groupRepeatDownBtn" text=" - " textColor="#90caf9" textSize="16sp" padding="14 4"/>',
      '          <text id="groupRepeatUpBtn" text=" + " textColor="#90caf9" textSize="16sp" padding="14 4"/>',
      "        </horizontal>",
      '        <horizontal gravity="center_vertical" marginTop="6">',
      '          <text text="精确值" textColor="#b0bec5" textSize="13sp"/>',
      '          <input id="groupRepeatInput" text="" hint="次" textColor="#ffffff" textSize="14sp" inputType="number" layout_weight="1" marginLeft="8"/>',
      '          <text id="groupRepeatOkBtn" text=" 用这个值 " textColor="#69f0ae" textSize="14sp" padding="10 4"/>',
      "        </horizontal>",
      '        <text id="groupMembers" text="" textColor="#90caf9" textSize="12sp" marginTop="8"/>',
      // 进组内列表。**单独占一行**：和下面两个挤一行会被 setSize 裁掉（栽过五次）。
      '        <horizontal marginTop="8">',
      '          <text id="groupOpenBtn" text=" ▸ 查看组内的步骤 " textColor="#90caf9" textSize="15sp" padding="10 5"/>',
      "        </horizontal>",
      '        <horizontal gravity="center_vertical" marginTop="8">',
      // 复制改成"放进剪贴板"（2026-10-08）。原先它是就地插在原组正后面、落点不可选，
      // 做不出用户要的那个结果（复制分组1 → 粘到节点2 后面 → 副本落在中间）。
      '          <text id="groupCopyBtn" text=" ⧉ 复制分组 " textColor="#ffd54f" textSize="15sp" padding="10 5"/>',
      // 解散和删除**必须是两个入口**：一个是"拆开但留着"，一个是"这一整段不要了"。
      // 合成一个的后果是误删——而删掉的那几步连截图和锚点一起没。
      '          <text id="groupUngroupBtn" text=" ⤫ 解散分组 " textColor="#90caf9" textSize="15sp" padding="10 5" marginLeft="6"/>',
      "        </horizontal>",
      "      </vertical>",
      // 动作类型的摘要行：平时只说"现在是哪一种"，点右边才展开那九个按钮。
      '      <horizontal id="typeSummaryRow" gravity="center_vertical" marginTop="12">',
      '        <text text="动作" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="typeSummary" text="" textColor="#ffffff" textSize="15sp" marginLeft="8" layout_weight="1"/>',
      '        <text id="typeToggleBtn" text=" 换一种 ▾ " textColor="#ffd54f" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      // 动作类型：点击（死坐标）/ 点击图片（找图）/ 滑动 / 长按 / 空等待。当前项高亮。
      // 找图只与点击组合——"找到图再滑一道"没有真实需求（见 case-runner 文件头）。
      //
      // **五个按钮横着放不下**（面板 640 像素 = 320dp，五个加标签要 364dp），
      // 而横向超出 setSize 会被直接裁掉。所以按语义分两行：
      // 第一行是"要落在屏幕某处"的动作，第二行是"不碰屏幕"的那一个。
      '      <vertical id="typeBox">',
      '      <horizontal gravity="center_vertical" marginTop="6">',
      '        <text text="改成" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="typeTapBtn" text=" 点击 " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="6"/>',
      '        <text id="typeImageBtn" text=" 点击图片 " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="4"/>',
      '        <text id="typeSwipeBtn" text=" 滑动 " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="4"/>',
      '        <text id="typeLongBtn" text=" 长按 " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="4"/>',
      "      </horizontal>",
      '      <horizontal gravity="center_vertical" marginTop="4">',
      '        <text id="typeNoopBtn" text=" 空等待 " textColor="#ffffff" textSize="14sp" padding="8 4"/>',
      // 找图拖动：找到图就从那儿按住拖到终点（2026-10-01 用户要的）。
      // 它既要模板图又要终点，所以点下去会连着问两次（先取终点、再框图）。
      '        <text id="typeSwipeImageBtn" text=" 拖动图片 " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="6"/>',
      // 连续点击（2026-10-04 用户要的）：同一个位置连点若干下。
      // 位置沿用这一步已有的坐标，所以切过来不用再取点——与长按同一条路。
      '        <text id="typeMultiBtn" text=" 连续点击 " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="6"/>',
      "      </horizontal>",
      // 认字的两种（2026-10-02 用户要的）。与「点击图片」同一个规矩：
      // **不存在"选了类型但没有内容"的中间态**——点「点击文字」会立刻认一遍屏幕
      // 让人从认出来的词里挑，点「输入文字」会立刻弹出输入框让人打字。
      '      <horizontal gravity="center_vertical" marginTop="4">',
      '        <text id="typeTapTextBtn" text=" 点击文字 " textColor="#ffffff" textSize="14sp" padding="8 4"/>',
      '        <text id="typeInputTextBtn" text=" 输入文字 " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="6"/>',
      "      </horizontal>",
      "      </vertical>",
      // 文字内容：只有认字的两种类型才显示。
      // 「认一下」会当场认一遍屏幕、把认出来的词列出来挑——**这是这一条最要紧的入口**：
      // 游戏自己的美术字（背包、设置这类描金图标字）OCR 根本认不出来，
      // 手打一个认不出的词，表现是回放时每次都找不到，而日志里只有一句"没找到"。
      '      <horizontal id="textRow" gravity="center_vertical" marginTop="8">',
      '        <text text="文字" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="textInfo" text="未设置" textColor="#ffffff" textSize="13sp" marginLeft="8" layout_weight="1"/>',
      '        <text id="textEditBtn" text=" ✎ 改 " textColor="#ffd54f" textSize="14sp" padding="10 4"/>',
      '        <text id="textScanBtn" text=" 认一下 " textColor="#ffd54f" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      '      <horizontal id="textEditRow" gravity="center_vertical" marginTop="6">',
      '        <input id="textInput" text="" hint="要找/要输入的文字" textColor="#ffffff" textSize="14sp" layout_weight="1"/>',
      '        <text id="textOkBtn" text=" 用这个 " textColor="#69f0ae" textSize="14sp" padding="10 4"/>',
      '        <text id="textCancelBtn" text=" 取消 " textColor="#b0bec5" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      // 认字引擎：只有「点击文字」才显示。默认 mlkit（0.6 秒），认不出来时切 rapid
      // （3.2 秒，认得更全）。**按步骤单独设**：一条用例里只有个别步骤需要慢的那个。
      '      <horizontal id="engineRow" gravity="center_vertical" marginTop="8">',
      '        <text text="认字引擎" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="engineMlkitBtn" text=" 快(mlkit) " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="6"/>',
      '        <text id="engineRapidBtn" text=" 全(rapid) " textColor="#ffffff" textSize="14sp" padding="8 4" marginLeft="4"/>',
      "      </horizontal>",
      // 滑动的时长 / 长按的按压时长，共用这一行，标题跟着类型变。
      // 点击与找图点击时整行隐藏——没有这个参数的步骤不该摆一个调不动的数。
      '      <horizontal id="gestureRow" gravity="center_vertical" marginTop="8">',
      '        <text id="gestureLabel" text="" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="gestureInfo" text="" textColor="#ffffff" textSize="13sp" marginLeft="8" layout_weight="1"/>',
      '        <text id="gestureDownBtn" text=" - " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      '        <text id="gestureUpBtn" text=" + " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      "      </horizontal>",
      // 连续点击的三个数（2026-10-04，参照参考产品：按下时间 / 总点击次数 / 点击间隔）。
      // 值本身就是输入框，按一下直接打字；旁边留 -/+ 给微调。
      // **三样分三行**：挤成一行的话最右边那个会被 setSize 裁掉。
      '      <vertical id="multiBox" marginTop="8">',
      '        <horizontal gravity="center_vertical">',
      // **这几个标签不能写 w=**：本文件头上那条实测结论——子节点上写 w 会让
      // findView 返回 null，而 views 里任何一个是 null 都会让整层建不起来，
      // 表现是点「编辑」被甩回 App（2026-10-04 用户实机撞上）。对齐靠空格凑。
      '          <text text="总点击次数　" textColor="#b0bec5" textSize="13sp"/>',
      '          <input id="multiCountInput" text="1" textColor="#ffffff" textSize="14sp" layout_weight="1" singleLine="true"/>',
      '          <text id="multiCountDownBtn" text=" - " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      '          <text id="multiCountUpBtn" text=" + " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      "        </horizontal>",
      '        <horizontal gravity="center_vertical" marginTop="4">',
      '          <text text="点击间隔　　" textColor="#b0bec5" textSize="13sp"/>',
      '          <input id="multiIntervalInput" text="100" textColor="#ffffff" textSize="14sp" layout_weight="1" singleLine="true"/>',
      '          <text id="multiIntervalDownBtn" text=" - " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      '          <text id="multiIntervalUpBtn" text=" + " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      "        </horizontal>",
      '        <horizontal gravity="center_vertical" marginTop="4">',
      '          <text text="按下时间　　" textColor="#b0bec5" textSize="13sp"/>',
      '          <input id="multiPressInput" text="80" textColor="#ffffff" textSize="14sp" layout_weight="1" singleLine="true"/>',
      '          <text id="multiPressDownBtn" text=" - " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      '          <text id="multiPressUpBtn" text=" + " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      "        </horizontal>",
      '        <text id="multiHint" text="次数与毫秒。改完点下面的「确定」才写盘" textColor="#78909c" textSize="11sp" marginTop="2"/>',
      "      </vertical>",
      // 以下两行只有「点击图片」时才显示。
      '      <horizontal id="assetRow" gravity="center_vertical" marginTop="8">',
      '        <text text="图片" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="assetInfo" text="未设置" textColor="#ffffff" textSize="13sp" marginLeft="8" layout_weight="1"/>',
      '        <text id="assetPickBtn" text=" 去截图 " textColor="#ffd54f" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      '      <horizontal id="regionRow" gravity="center_vertical" marginTop="8">',
      '        <text text="限制区域" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="regionInfo" text="全屏" textColor="#ffffff" textSize="13sp" marginLeft="8" layout_weight="1"/>',
      '        <text id="regionPickBtn" text=" 框选 " textColor="#ffd54f" textSize="14sp" padding="10 4"/>',
      '        <text id="regionClearBtn" text=" 全屏 " textColor="#90caf9" textSize="14sp" padding="10 4"/>',
      "      </horizontal>",
      // 找几次 + 找不到怎么办。后者是这一版的要害：默认「继续下一步」，
      // 一个没找到的弹窗不该把整条任务判死。
      '      <horizontal id="triesRow" gravity="center_vertical" marginTop="8">',
      '        <text text="找几次" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="triesInfo" text="" textColor="#ffffff" textSize="13sp" marginLeft="8" layout_weight="1"/>',
      '        <text id="triesDownBtn" text=" -1 " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      '        <text id="triesUpBtn" text=" +1 " textColor="#90caf9" textSize="15sp" padding="12 4"/>',
      "      </horizontal>",
      '      <horizontal id="failRow" gravity="center_vertical" marginTop="8">',
      '        <text text="找不到时" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="failNextBtn" text=" 继续下一步 " textColor="#ffffff" textSize="14sp" padding="10 4" marginLeft="8"/>',
      '        <text id="failStopBtn" text=" 停止任务 " textColor="#ffffff" textSize="14sp" padding="10 4" marginLeft="4"/>',
      "      </horizontal>",
      '      <horizontal marginTop="8">',
      '        <text id="pickBtn" text=" ✚ 取点 " textColor="#ffd54f" textSize="15sp" padding="12 5"/>',
      '        <text id="tryBtn" text=" ▷ 只跑这一步 " textColor="#69f0ae" textSize="15sp" padding="12 5"/>',
      '        <text id="deleteBtn" text=" 删除 " textColor="#ff8a80" textSize="15sp" padding="12 5"/>',
      "      </horizontal>",
      // 从这一步开始跑到底（2026-10-06 用户要的）。与「只跑这一步」是两回事：
      // 那个是调这一步本身，这个是"前面的我已经手动弄好了，从这儿接着往下走"——
      // 调后半截时最常用，否则每次都要从第一步重跑一遍。
      // **单独占一行**：和上面三个挤一行的话最右边会被 setSize 裁掉（栽过五次）。
      '      <horizontal marginTop="6">',
      '        <text id="runFromBtn" text=" ▶ 从这一步开始跑到底 " textColor="#69f0ae" textSize="15sp" padding="12 5"/>',
      "      </horizontal>",
      // 顺序：挪一步、或者在这一步后面补录一步。
      // 这三样都**改结构、立即写盘**：草稿表达不了"这一步现在排第几"。
      '      <horizontal id="orderRow" gravity="center_vertical" marginTop="8">',
      '        <text text="顺序" textColor="#b0bec5" textSize="13sp"/>',
      '        <text id="moveUpBtn" text=" ↑ 上移 " textColor="#90caf9" textSize="15sp" padding="10 5" marginLeft="6"/>',
      '        <text id="moveDownBtn" text=" ↓ 下移 " textColor="#90caf9" textSize="15sp" padding="10 5" marginLeft="4"/>',
      // 「插一步」四个字已经到头了：这一行横着摆不下更长的文案，
      // 而横向超出 setSize 同样会被直接裁掉（这个项目栽过五次的那个坑）。
      // 它插在哪儿由面板顶上的「第 N 步」说清楚，不靠按钮上的字。
      '        <text id="insertBtn" text=" ✚ 插一步 " textColor="#ffd54f" textSize="15sp" padding="10 5" marginLeft="4"/>',
      "      </horizontal>",
      // 禁用 / 启用：**不是删除**。人要临时跳过某一步时，删了就连它的截图与锚点
      // 一起没了，想再用只能重录。禁用把这一步原样留在用例里，只是这一轮不执行。
      '      <horizontal gravity="center_vertical" marginTop="8">',
      '        <text id="disableBtn" text=" ⏸ 禁用这一步 " textColor="#ffab91" textSize="15sp" padding="10 5"/>',
      "      </horizontal>",
      '      <text id="editMsg" text="" textColor="#ffd54f" textSize="11sp" marginTop="6"/>',
      "        </vertical>",
      "      </ScrollView>",
      '      <horizontal bg="#f21b262e" gravity="center_vertical" padding="12 8">',
      '        <text id="backBtn" text=" ← 返回列表 " textColor="#b0bec5" textSize="15sp" padding="12 6"/>',
      '        <text id="applyBtn" text=" 确定 " textColor="#69f0ae" textSize="16sp" padding="18 6"/>',
      "      </horizontal>",
      "    </vertical>",
      "  </vertical>",
      "</vertical>"
    ])
    .join("\n");
}

// options: {
//   logger, title,
//   steps: [{ name, title, subtitle, waitMs, type, assetLabel, regionLabel,
//             gestureLabel, gestureInfo, textLabel, engine, disabled }]
//     textLabel 是认字节点那段文字本身；engine 是 "mlkit" / "rapid"；
//     disabled 为 true 时这一步留在用例里但不执行
//     name 是这一步的名字本身（改名那行要拿它当初值）；title 是列表上显示的
//     「名字　动作」整行，两者不是一回事，别拿 title 去填输入框
//     waitMs 为 null 表示这一步不等；type 是 "tap" / "tapImage" / "swipe" / "longTap"；
//     assetLabel / regionLabel 是给人看的一句话（"136x49" / "全屏"）；
//     gestureLabel / gestureInfo 是滑动、长按那一行的标题与读数（"滑多快" / "300 毫秒"）
//   maxWaitMs,
//   formatWait(ms)             // 等待读给人听怎么写，不给就显示裸毫秒
//   onSetTap(index, done)      // 改回死坐标点击
//   onPickAsset(index, done)   // 框模板图（同时把类型切成找图）
//   onSetLongTap(index, done)  // 改成长按
//   onSetSwipe(index, done)    // 改成滑动（要在游戏上取一次终点）
//   onSetNoop(index, done)     // 改成空等待（只等时间，不碰屏幕）
//   onSetSwipeImage(index, done) // 改成找图拖动（要模板图 + 终点）
//   onSetTapText(index, done)    // 改成点击文字：**调用方负责认一遍屏幕并让人挑一个词**
//                                // （不存在"选了类型但没有文字"的中间态）
//   onSetInputText(index, text, done) // 改成输入文字，text 是人在本层打的内容
//   onSetNodeText(index, text, done)  // 改认字节点的那段文字（类型不变）
//   onSetTextEngine(index, engine, done) // 换认字引擎："mlkit"（快）/ "rapid"（全）
//   onToggleDisabled(index, done)     // 禁用 / 启用这一步（即时写盘，不进草稿）
//     改名**不再是单独的回调**：名字就在本层里打，和停顿、坐标一样进草稿，
//     点「确定」时跟着 onApply 的 patch.name 一起写盘（2026-10-02 起，
//     在这之前它会把 App 切到前台，人被甩出游戏）
//   onSetGestureParam(index, delta, done) // 调滑动时长 / 长按时长
//   onPickRegion(index, done)  // 框限制区域
//   onClearRegion(index, done) // 改回全屏找图
//     以上几个的 done(message, freshRow) 与 onApply 同形
//   onMoveStep(index, delta, done)  // 上移 / 下移；done(message, { rows, index }) 见 moveStep
//   onInsertStep(index, done)       // 在这一步后面补录一步；done(message)，
//                                   // 成功后本层自己关掉，由调用方拿新数据重开
//   onPick(index, done)      // done({ value, text }) 或 done(null, "原因")
//   onApply(index, patch, done)  // patch = { waitMs, point, name }；done(message, freshRow)
//                                // name 只有人改过才出现在 patch 里；空串表示
//                                // 「清掉自取的名字」，叫什么由调用方定（默认名）
//   onDelete(index, done)    // done(message)；成功后本层自己关掉，由调用方重开
//   onTryStep(index, done)   // done(message)
//   onRunFrom(index)         // 从这一步开始跑到底。**调用方负责关层再起跑**，
//                            // 没有 done——层马上就没了，回调也没人看
//   ---- 循环分组（2026-10-06；2026-10-08 加页签与剪贴板）----
//   steps 里每一行都要带 nodeId 与 groupId：
//     nodeId 是这一步（或这个分组）自己的 id；groupId 是它所属分组的 id，
//     根层的那些是空串。**页签分页全靠这两个**：根节点那一页只列 groupId 为空的，
//     进了某一组只列 groupId 等于它的
//   分组行另外带：{ type: "group", repeat, memberText }，memberText 是
//     「含 3 步：2 点击 → 3 滑动 → 4 点击」这样一句，给单步面板显示用
//   onMakeGroup(indexes, name, done)  // 合并；done(message, ok)。ok 为假时
//     本层留在原地并显示原因（多半是"没挨在一起"），为真时由调用方关层重开。
//     **name 必填**（2026-10-08 用户要求），次数建组时一律 1 遍，进面板再调
//   onSetGroupRepeat(index, repeat, done) // 改次数；done(message, freshRow)
//   onUngroup(index, done)     // 解散（子步骤留着）；done(message)，调用方关层重开
//   ---- 剪贴板式的复制 / 粘贴（2026-10-08）----
//   clipboardLabel          // 开层时剪贴板里是什么，空串表示没有。
//     **剪贴板本身不在这一层**：它要活过"改结构就关层重开"这一下，
//     所以存在调用方那边，这里只拿着一句给人看的话
//   onCopy(index, done)     // 复制这一步（分组连子步骤一起）；done(message, label)
//     label 是新的剪贴板文字，本层据此点亮"黏贴"那两条，不关层
//   onPaste(index, where, done) // where 是 "before" / "after"；done(message, ok)
//     ok 为真时结构变了，由调用方关层重开；为假时留在原地说明原因
//   openPage                // 重开时停回哪一页（某个分组的 id）。关层前用
//     overlay.currentPage() 取。不还原的话，在组内每删一步就被弹回根节点一次
//   分组的改名 / 删除 / 禁用 / 从这一步开始跑**沿用通用的那几个回调**，
//   不另开一套——两套的二次确认与提示迟早会不一致
//   onRunAll()               // 调用方负责关层再起跑
//   extraAction: { label, onTap }  // 底部第二个动作，不给就不显示
//   onClose()
// }
// 回调都在界面线程上触发：要 sleep、要存盘的自己开线程。
//
// **必须从工作线程调用 open**：建窗口要等 attach，会 sleep。
// 建不出来返回 null——没有编辑层不该把调用方带崩。
function open(options) {
  var opts = options || {};
  var logger = opts.logger;
  var steps = opts.steps || [];
  var maxWaitMs = opts.maxWaitMs || DEFAULT_MAX_WAIT_MS;
  var window = null;
  var views = null;
  var closed = false;
  var hidden = false;
  // "list" 步骤列表 / "edit" 单步面板
  var mode = "list";
  var editIndex = -1;
  // 批量：两步走（2026-10-07 改版，原先是一屏五行全摆出来）。
  // "" = 没在批量；"menu" = 正在选要做什么；"pick" = 正在勾对哪几步做。
  // **只在列表形态有意义**，进单步面板时自动退出。
  var bulkPhase = "";
  // 选中的那个操作："disable" / "enable" / "delete" / "wait" / "group"
  var bulkAction = "";
  var picked = {};
  // **和单步面板那个 deleteArmed 分开**：共用一个的话，两处的二次确认会互相作废，
  // 表现是"单步面板点过一次删除，回到列表再点批量删除就直接删了"。
  var bulkDeleteArmed = false;
  // 那九个动作类型按钮展开着没有。**默认收起**（2026-10-06 改版）：
  // 它们占三整行、顶在最上面，而改动作类型是低频动作——录完之后偶尔改一次；
  // 高频的是调这一步等多久，原先要滚动才看得见。
  // 收起时靠上面那行摘要说清"现在是哪一种"。
  var typeBoxOpen = false;
  // 草稿：确定之前一律不写盘。半路收摊不该悄悄改掉人家的录制。
  var draftWaitMs = null;
  var draftPoint = null;
  var draftPointText = "";
  // 名字草稿。null = 这一轮没改过名，确定时就不往 patch 里放 name——
  // 否则每点一次确定都会把名字原样写一遍，看着没事，实际把"没改过"也记成了一次修改。
  var draftName = null;
  // 改名那一行是不是展开着。展开期间本层攥着键盘焦点，收起来就得还回去。
  var nameEditing = false;
  // 文字那一行正在为哪种类型打字（"" / "tapText" / "inputText"）。
  // 记类型是因为打完要落到哪个动作上由它决定——人点「输入文字」时这一步可能还是点击。
  var textEditingType = "";
  // 键盘焦点的把手（overlay-keyboard）。建窗之后才有。
  var keyboard = null;
  // 删除要点两次。第一次只是把按钮变成问句，别让一个误触把一步弄没了。
  var deleteArmed = false;
  var busy = false;
  // ---- 页签（2026-10-08）----
  // "" = 根节点那一页；否则是某个分组的 id，这一页只列它的子步骤。
  // 行本身在建窗时就全画好了（分组内外都有），切页只是显隐——
  // **不重建行**：行是 XML 里一次性生成的，重建意味着关窗重开，
  // 而人只是想看一眼组里有什么。
  var page = "";
  // 行首那个序号：**按当前这一页从 1 数**，不是节点在整条录制里的下标。
  // 照绝对下标写的话，根列表会跳号（1、2、5、6——中间那几个在分组里），
  // 而那个号正是人用来对照"我是第几下点的"的东西。
  // 下标 -> 这一页上的第几个（1 起）；不在这一页的是 0。
  var rowOrdinals = [];
  // 长按菜单正开在哪一行上，-1 表示没开。
  var menuIndex = -1;
  // 菜单里的删除同样要点两次，**和单步面板那个 deleteArmed 分开**——
  // 共用一个的话，两处的二次确认会互相作废。
  var menuDeleteArmed = false;
  // 剪贴板里是什么（一句给人看的话），空串表示没东西，"黏贴"那两条就不出现。
  // **剪贴板本身不在这一层**：改结构就要关层重开，存在这儿活不过那一下。
  var clipboardLabel = String(opts.clipboardLabel || "");

  var topOffset = statusBarHeight();
  var posX = DEFAULT_LEFT;
  var posY = topOffset + DEFAULT_TOP_GAP;
  var expandedX = posX;
  var expandedY = posY;
  var shapeWidth = PANEL_WIDTH;
  var shapeHeight = PANEL_WIDTH;
  var duckedForCapture = false;
  var unregister = null;

  // **失败原因要留得住。** open() 返回 null 有三种可能（建不出来 / 窗口没就绪 /
  // 接线失败），而调用方只看得到一个 null，于是 2026-10-04 那次把"控件没找到"
  // 原样显示成了「悬浮窗权限缺失」——权限明明是好的，人照着那句话去查权限，
  // 查了个空。记在模块级变量里，调用方用 lastError() 取。
  function warn(text) {
    lastErrorText = String(text || "");
    if (logger) logger.warn("流程编辑层: " + text);
    // **logger 可能是 null**（从待命层点「编辑」这条路就没有运行期 logger），
    // 而这几条恰恰是整层建不起来的唯一线索。直接写一份到控制台，
    // 菜单里的「查看日志」就能看到——不然人只能看到"被甩回 App"这个结果。
    try {
      console.log("流程编辑层: " + text);
    } catch (error) {}
  }

  function runOnUi(action) {
    uiThread.run(action, UI_CALL_WAIT_MS);
  }

  function listHeight() {
    var room = device.height - PANEL_VERTICAL_MARGIN;
    return Math.max(360, Math.min(PANEL_MAX_HEIGHT, room));
  }

  function sizeOfMode() {
    if (hidden) return { w: HANDLE_WIDTH, h: HANDLE_HEIGHT };
    if (mode === "edit") {
      return {
        w: PANEL_WIDTH,
        h: Math.min(EDIT_HEIGHT, device.height - EDIT_SCREEN_MARGIN)
      };
    }
    return { w: PANEL_WIDTH, h: listHeight() };
  }

  function clampPosition() {
    var maxX = Math.max(0, device.width - shapeWidth);
    var maxY = Math.max(topOffset, device.height - shapeHeight);
    if (posX < 0) posX = 0;
    if (posX > maxX) posX = maxX;
    if (posY < topOffset) posY = topOffset;
    if (posY > maxY) posY = maxY;
  }

  // 换形态之后窗口变大变小都可能把自己顶出屏幕，每次都夹回可见范围。
  // **窗口操作一律经 ui.run 投递**：直接在点击回调里 setSize 的那一版，
  // 点了毫无反应（run-overlay 2026-09-17 实机）。
  function applyShape() {
    var size = sizeOfMode();
    shapeWidth = size.w;
    shapeHeight = size.h;
    clampPosition();
    var showHandle = hidden;
    var showList = !hidden && mode === "list";
    var showEdit = !hidden && mode === "edit";
    var x = posX;
    var y = posY;
    ui.run(function () {
      if (closed || !views) return;
      try {
        views.handle.setVisibility(showHandle ? VISIBLE : GONE);
        views.panel.setVisibility(showHandle ? GONE : VISIBLE);
        views.listBox.setVisibility(showList ? VISIBLE : GONE);
        views.editBox.setVisibility(showEdit ? VISIBLE : GONE);
        window.setPosition(x, y);
        if (!duckedForCapture) window.setSize(shapeWidth, shapeHeight);
      } catch (error) {
        warn("切换形态失败: " + error);
      }
    });
  }

  // 截图前让开、拍完回来。收成 0x0 最干脆，也不用担心某个子视图还残留在画面上。
  function hideForCapture() {
    if (closed || duckedForCapture) return false;
    // 收成 0x0 之前先把键盘还掉：一个 0x0 的窗口还攥着输入焦点，
    // 屏幕上什么都没有，而键盘事件全进了它。
    stopTyping();
    duckedForCapture = true;
    try {
      uiThread.run(function () { window.setSize(0, 0); }, UI_CALL_WAIT_MS);
      return true;
    } catch (error) {
      duckedForCapture = false;
      return false;
    }
  }

  function restoreAfterCapture() {
    if (closed || !duckedForCapture) return;
    duckedForCapture = false;
    try {
      uiThread.run(function () {
        window.setSize(shapeWidth, shapeHeight);
      }, UI_CALL_WAIT_MS);
    } catch (error) {
      warn("截图后没能恢复: " + error);
    }
  }

  function setListMsg(text) {
    if (closed || !views) return;
    views.listMsg.setText(String(text || ""));
  }

  // 给一个数值输入框配上 -/+。**先读框里现在的字再加减**：不读的话，
  // 人手打了 500 再点一下 +，会从上一次的值上跳到一个他没见过的数，而界面不解释。
  function nudgeNumberInput(input, downBtn, upBtn, stepValue, minValue, maxValue) {
    function current(fallback) {
      var raw = String(input.getText()).trim();
      if (!/^[0-9]+$/.test(raw)) return fallback;
      return parseInt(raw, 10);
    }
    function nudge(delta) {
      var value = current(minValue) + delta;
      if (value < minValue) value = minValue;
      if (value > maxValue) value = maxValue;
      input.setText(String(value));
    }
    downBtn.setOnClickListener(function () { nudge(-stepValue); });
    upBtn.setOnClickListener(function () { nudge(stepValue); });
  }

  // 读这三个框，读不动就返回 null，由调用方决定怎么说。
  // **不在这儿兜底成默认值**：人打错一个字就被悄悄换成 100，而他以为自己设的是别的数。
  function readMultiTapDraft() {
    var step = steps[editIndex];
    if (!step || step.type !== "multiTap") return null;
    function parse(input, label, minValue, maxValue) {
      var raw = String(input.getText()).trim();
      if (!/^[0-9]+$/.test(raw)) {
        throw new Error(label + "要填整数，现在是: " + (raw || "(空)"));
      }
      var value = parseInt(raw, 10);
      if (value < minValue || value > maxValue) {
        throw new Error(label + "要在 " + minValue + " 到 " + maxValue + " 之间");
      }
      return value;
    }
    return {
      count: parse(views.multiCountInput, "总点击次数", 1, 2000),
      intervalMs: parse(views.multiIntervalInput, "点击间隔", 0, 60000),
      pressMs: parse(views.multiPressInput, "按下时间", 1, 10000)
    };
  }

  // ---- 页签：根节点 / 组内（2026-10-08）----

  function isGroupStep(step) {
    return !!step && step.type === "group";
  }

  // 这一行属于哪一页。分组节点自己属于根层（它在根列表上占一行），
  // 它的子步骤属于它那一页。
  function pageOfStep(step) {
    return (step && step.groupId) || "";
  }

  function stepIndexOfNodeId(nodeId) {
    if (!nodeId) return -1;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] && steps[i].nodeId === nodeId) return i;
    }
    return -1;
  }

  // 当前这一页上有哪几行。批量的全选、计数都只认这一页——
  // 全选把看不见的行也勾上的话，人点「删除」会删掉他根本没看到的步骤。
  function indexesOnPage() {
    var list = [];
    for (var i = 0; i < steps.length && i < MAX_ROWS; i++) {
      if (steps[i] && pageOfStep(steps[i]) === page) list.push(i);
    }
    return list;
  }

  // 「＋ 添加节点」什么时候露面。它加出来的那一步落在整条录制的末尾，
  // **在组内那一页上会落到组外**，于是人看到的是"加了一步但列表没变"。
  // 所以组内那一页干脆不给这个入口，由提示行说清楚怎么往组里加。
  function refreshAddNodeVisible() {
    if (closed || !views) return;
    var show = !!opts.onAddNode && !bulkPhase && menuIndex < 0 && !page;
    views.addNodeBtn.setVisibility(show ? VISIBLE : GONE);
  }

  function applyPage() {
    if (closed || !views) return;
    var groupStep = null;
    if (page) {
      var at = stepIndexOfNodeId(page);
      groupStep = at < 0 ? null : steps[at];
      // 那一组已经不在了（被删掉、被解散）就退回根节点。
      // 停在一页空的上面，人只会以为列表坏了。
      if (!groupStep) page = "";
    }
    var shown = 0;
    rowOrdinals = [];
    for (var i = 0; i < views.rowBoxes.length; i++) {
      var box = views.rowBoxes[i];
      if (!box || !steps[i]) continue;
      var visible = pageOfStep(steps[i]) === page;
      box.setVisibility(visible ? VISIBLE : GONE);
      rowOrdinals[i] = visible ? ++shown : 0;
    }
    // 页签：当前这一页的那个是亮的，另一个是灰的——颜色说"我在哪一页"。
    views.tabRootBtn.setTextColor(colors.parseColor(page ? "#78909c" : "#ffffff"));
    views.tabGroupBtn.setText(page && groupStep ? "▸ " + (groupStep.name || "分组") : "");
    views.tabGroupBtn.setTextColor(colors.parseColor("#ffffff"));
    views.tabGroupEditBtn.setText(page ? " ✎ 编辑这一组 " : "");
    if (page && groupStep) {
      // 组内这一页没有「＋ 添加节点」（它加出来的那步会落到组外），
      // 所以这行要把"往组里加一步"的两条路说出来，否则人找不到入口。
      views.listHint.setText(
        "分组「" + (groupStep.name || "") + "」执行 " +
          (groupStep.repeat == null ? 1 : groupStep.repeat) + " 次，组内 " + shown +
          " 步。长按一步：复制 / 黏贴 / 删除；要往组里补一步，点一步进去用「插一步」"
      );
    } else {
      views.listHint.setText(
        steps.length > MAX_ROWS
          ? "共 " + shown + " 步（整条录制 " + steps.length + " 步，只画得下前 " +
              MAX_ROWS + " 行）。长按一步弹菜单"
          : "共 " + shown + " 步。点一步改停顿、取点；长按一步弹菜单"
      );
    }
    refreshAddNodeVisible();
    // 序号变了，行上的字就得重画一遍。repaintPicks 是画行标题的唯一出口。
    repaintPicks();
  }

  // 这一步在界面上排第几。**序号归界面管，不写进名字里**（2026-10-08）：
  // 名字里腌着序号的话，人改名时一并把它改掉了。
  function ordinalOf(index) {
    return rowOrdinals[index] || index + 1;
  }

  // 行上显示的那一整行字：勾选标记 + 序号 + 「名字　动作」。
  // **只有这一处拼它**：批量勾选、保存回填、切页各拼一份的话，
  // 三处迟早不一致（序号丢一处就是"这一行没有号"）。
  function rowTitleText(index) {
    var step = steps[index];
    if (!step) return "";
    return (bulkPhase === "pick" ? (picked[index] ? "☑ " : "☐ ") : "") +
      ordinalOf(index) + ". " + step.title;
  }

  function goToPage(groupId) {
    closeRowMenu();
    page = groupId || "";
    // 换页就把勾选清掉：勾中的那几步在新的一页上根本不显示，
    // 而底下的计数还写着"已勾 3 步"，人找不到是哪三步。
    if (bulkPhase === "pick") picked = {};
    setListMsg("");
    applyPage();
  }

  // ---- 长按菜单（2026-10-08）----

  function closeRowMenu() {
    menuIndex = -1;
    menuDeleteArmed = false;
    if (closed || !views) return;
    views.rowMenuBox.setVisibility(GONE);
    refreshAddNodeVisible();
  }

  function openRowMenu(index) {
    var step = steps[index];
    if (!step || closed || !views) return;
    menuIndex = index;
    menuDeleteArmed = false;
    var group = isGroupStep(step);
    // 菜单顶上写的序号必须和列表那一行上的一模一样，否则人分不清
    // 自己长按的到底是哪一步。
    views.rowMenuTitle.setText(ordinalOf(index) + ". " + step.title);
    views.rowMenuBox.setVisibility(VISIBLE);
    // 「查看组内」「解散分组」只对分组有意义。
    views.rowMenuOpenBtn.setVisibility(group ? VISIBLE : GONE);
    views.rowMenuUngroupBtn.setVisibility(group && opts.onUngroup ? VISIBLE : GONE);
    views.rowMenuEditBtn.setText(group ? " ✎ 编辑分组 " : " ✎ 编辑这一步 ");
    views.rowMenuCopyBtn.setText(group ? " ⧉ 复制分组 " : " ⧉ 复制这一步 ");
    views.rowMenuCopyBtn.setVisibility(opts.onCopy ? VISIBLE : GONE);
    // 剪贴板空着就不摆这两条：一个点下去只会说"剪贴板是空的"的按钮，
    // 人点第一次会以为坏了，点第二次还是以为坏了。
    var canPaste = !!opts.onPaste && !!clipboardLabel;
    views.rowMenuPasteBeforeBtn.setVisibility(canPaste ? VISIBLE : GONE);
    views.rowMenuPasteAfterBtn.setVisibility(canPaste ? VISIBLE : GONE);
    if (canPaste) {
      views.rowMenuPasteBeforeBtn.setText(" 黏贴「" + clipboardLabel + "」到这一步前 ");
      views.rowMenuPasteAfterBtn.setText(" 黏贴「" + clipboardLabel + "」到这一步后 ");
    }
    views.rowMenuDisableBtn.setVisibility(opts.onToggleDisabled ? VISIBLE : GONE);
    views.rowMenuDisableBtn.setText(
      step.disabled ? (group ? " ▶ 启用这一组 " : " ▶ 启用 ") : (group ? " ⏸ 禁用这一组 " : " ⏸ 禁用 ")
    );
    views.rowMenuDeleteBtn.setVisibility(opts.onDelete ? VISIBLE : GONE);
    views.rowMenuDeleteBtn.setText(group ? " 删除整组 " : " 删除 ");
    refreshAddNodeVisible();
    setListMsg("");
  }

  // ---- 批量模式 ----
  function pickedIndexes() {
    var list = [];
    var onPage = indexesOnPage();
    for (var i = 0; i < onPage.length; i++) {
      if (picked[onPage[i]]) list.push(onPage[i]);
    }
    return list;
  }

  // 勾选状态画在行首那个位置上。**不动标题本身**：把 ☐ 拼进标题的话，
  // 退出批量时标题要再拆一次，拆错了就永久留着一个勾。
  function repaintPicks() {
    if (closed || !views) return;
    var count = 0;
    for (var i = 0; i < views.rowTitles.length; i++) {
      var titleView = views.rowTitles[i];
      if (!titleView || !steps[i]) continue;
      if (picked[i]) count++;
      // 勾选标记加在标题前面（pick-overlay 那套，已经在真机上跑过）。
      // ☑ 与 ☐ 等宽，所以勾不勾文字都不会左右跳。
      titleView.setText(rowTitleText(i));
    }
    // 分母只数这一页上的：进了组内还写着整条录制的步数，人对不上。
    views.bulkCountText.setText(
      bulkActionLabel() + "　已勾 " + count + " / " + indexesOnPage().length + " 步"
    );
    // 勾选一变，删除的二次确认就作废——不然"勾了 2 步点一次删除，
    // 再多勾 3 步点第二次"会把 5 步一起删掉，而人以为自己还在确认那 2 步。
    if (bulkDeleteArmed) {
      bulkDeleteArmed = false;
      views.bulkConfirmBtn.setText(" 确定 ");
    }
  }

  function bulkActionLabel() {
    if (bulkAction === "disable") return "禁用";
    if (bulkAction === "enable") return "启用";
    if (bulkAction === "delete") return "删除";
    if (bulkAction === "wait") return "统一等待";
    if (bulkAction === "group") return "合并成循环组";
    return "";
  }

  function togglePick(index) {
    picked[index] = !picked[index];
    repaintPicks();
    setListMsg("");
  }

  // phase: "" 退出批量 / "menu" 选操作 / "pick" 勾步骤
  function setBulkPhase(phase, action) {
    bulkPhase = phase || "";
    if (phase !== "pick") picked = {};
    if (phase === "menu") bulkAction = "";
    if (action) bulkAction = action;
    bulkDeleteArmed = false;
    if (closed || !views) return;
    // 批量和长按菜单是两套对"同一批行"的操作，同时开着会让人点出自己没想要的那个。
    if (bulkPhase) closeRowMenu();
    views.bulkMenuBox.setVisibility(bulkPhase === "menu" ? VISIBLE : GONE);
    views.bulkPickBox.setVisibility(bulkPhase === "pick" ? VISIBLE : GONE);
    views.bulkBtn.setText(bulkPhase ? " 批量中 " : " 批量 ");
    refreshAddNodeVisible();
    // 参数行只在要参数的那两种下出现。其余三种一行都不占——
    // 原先那五行里最冤的就是这部分：禁用三步也得对着两个用不上的输入框。
    var needsParam = bulkPhase === "pick" && (bulkAction === "wait" || bulkAction === "group");
    views.bulkParamRow.setVisibility(needsParam ? VISIBLE : GONE);
    if (needsParam) {
      var isWait = bulkAction === "wait";
      // 合并要填的是**名字**，不是次数（2026-10-08 用户要求）。
      // 次数建组时一律 1 遍，进分组面板再调——那儿才看得见它含哪几步。
      views.bulkParamLabel.setText(isWait ? "统一等待" : "分组名称");
      views.bulkParamUnit.setText(isWait ? "毫秒" : "");
      // 人正在框里打字时不回写，否则光标跳回头、打一半被抹掉。
      if (!(keyboard && keyboard.isFocused())) {
        // 名字**不预填**：预填一个默认值的话，人直接点确定就建出一堆同名的组，
        // 而"必须自己起名"正是这一条要的。
        views.bulkParamInput.setText(isWait ? "3000" : "");
      }
    }
    if (!bulkPhase) stopTyping();
    repaintPicks();
    setListMsg(
      bulkPhase === "menu"
        ? "先选要做什么"
        : bulkPhase === "pick"
          ? "点行勾选要「" + bulkActionLabel() + "」的步骤，再点确定"
          : ""
    );
  }

  // 把勾中的那几步交给调用方去改。数据归调用方管（写盘、重编号、重算），
  // 这一层只负责"哪几步"和"干什么"——两边各算一遍迟早算出两个结果。
  function runBulk(action, value) {
    var chosen = pickedIndexes();
    if (chosen.length === 0) {
      setListMsg("先勾几步");
      return;
    }
    stopTyping();
    setListMsg("正在处理 " + chosen.length + " 步…");
    opts.onBulk(action, chosen, value, function (message) {
      setListMsg(message || "");
    });
  }

  function setEditMsg(text) {
    if (closed || !views) return;
    views.editMsg.setText(String(text || ""));
  }

  // 读数怎么写给人看由调用方给（那边有 recorded-case 的 formatWaitMs，
  // 日志、列表、面板共用同一套说法）。没给就退回裸毫秒，本层不自己发明第二套。
  function waitLabel(value) {
    if (value == null || value === 0) return "不等";
    if (opts.formatWait) return opts.formatWait(value);
    return value + " 毫秒";
  }

  function refreshWaitRow() {
    if (closed || !views) return;
    views.editWait.setText("动作前等待　" + waitLabel(draftWaitMs));
    // 精确值框跟着步进走：人按完 +5分 再去框里改，看到的得是现在这个数，
    // 否则两处各说各话，点「用这个值」时会把刚按出来的那段悄悄覆盖掉。
    // **人正在这个框里打字时不碰它**，否则光标会被顶回头、打一半的数被冲掉。
    if (!keyboard || !keyboard.isFocused()) {
      views.waitInput.setText(draftWaitMs == null ? "" : String(draftWaitMs));
    }
  }

  // 按在输入框上就把键盘焦点要过来。返回 false = 事件照旧交给输入框，
  // 否则光标落不到你按的那个位置、也选不中字。
  function attachFocusOnTouch(view) {
    view.setOnTouchListener(function (target, event) {
      try {
        if (event.getAction() === android.view.MotionEvent.ACTION_DOWN && keyboard) {
          if (keyboard.isFocused()) {
            keyboard.keepAlive();
          } else {
            keyboard.focus(target);
          }
        }
      } catch (error) {
        warn("要焦点失败: " + error);
      }
      return false;
    });
  }

  // 这一步现在叫什么：改过名就是草稿里的那个，没改过就是调用方给的。
  function currentName(index) {
    if (draftName !== null) return draftName;
    var step = steps[index];
    return step && step.name != null ? String(step.name) : "";
  }

  // 展开改名那一行并把键盘要过来。**要焦点失败就别装作开着**——
  // 一个弹不出键盘的输入框比没有这个入口更让人发懵。
  function openNameEditor() {
    if (closed || !views) return;
    var name = currentName(editIndex);
    nameEditing = true;
    ui.run(function () {
      if (closed || !views) return;
      views.nameRow.setVisibility(VISIBLE);
      views.nameInput.setText(name);
      try { views.nameInput.setSelection(name.length); } catch (error) {}
    });
    var ok = keyboard && keyboard.focus(views.nameInput);
    if (!ok) {
      stopTyping("键盘要不过来，这一步先不改名");
      return;
    }
    setEditMsg("打完点「用这个名」，再点「确定」写盘。游戏还在底下，照样点得动");
  }

  // 收键盘、收起改名行、把焦点还给游戏。**每条退出路径都要经过它**：
  // 用这个名 / 取消 / 用这个值 / 返回列表 / 关层 / 藏起来 / 截图让开 / 看门狗超时。
  // 漏一条就是"键盘攥着不放"——人回到游戏里按什么都没反应，还查不出所以然。
  function stopTyping(message) {
    if (!nameEditing && !textEditingType && (!keyboard || !keyboard.isFocused())) {
      if (message) setEditMsg(message);
      return;
    }
    nameEditing = false;
    textEditingType = "";
    if (keyboard) keyboard.release();
    ui.run(function () {
      if (closed || !views) return;
      views.nameRow.setVisibility(GONE);
      views.textEditRow.setVisibility(GONE);
    });
    if (message) setEditMsg(message);
  }

  // 把输入框里的名字收进草稿。空着 = 不要自取的名字，交给调用方退回默认名。
  function commitName() {
    if (closed || !views) return;
    var text = "";
    try { text = String(views.nameInput.getText()).trim(); } catch (error) {}
    // 一个字没改就当没改过（2026-10-08）。
    //
    // 改名框现在预填的是**不带序号的那个名字**（默认名就是「点击」），
    // 人打开看一眼又原样确定的话，不挡住就会把「点击」当成他自己取的名字存下去——
    // 从此这一步的名字不再跟着类型变（改成滑动之后还叫「点击」）。
    if (text === currentName(editIndex)) {
      stopTyping("名字没改");
      return;
    }
    draftName = text;
    var step = steps[editIndex];
    if (step) {
      views.editTitle.setText(
        "第 " + ordinalOf(editIndex) + " 步　" + (text || "（用默认名）") + "　（未写盘）"
      );
    }
    stopTyping(text ? "名字先记下了：" + text + "。点「确定」写盘" : "名字清空了，写盘后退回默认名");
  }

  // 文字那一行：打开输入框、把键盘要过来。forType 决定打完之后这一步变成哪种类型。
  function openTextEditor(forType) {
    if (closed || !views) return;
    var step = steps[editIndex];
    var current = step && (step.type === "tapText" || step.type === "inputText")
      ? String(step.textLabel || "")
      : "";
    textEditingType = forType;
    ui.run(function () {
      if (closed || !views) return;
      views.textEditRow.setVisibility(VISIBLE);
      views.textInput.setText(current);
      try { views.textInput.setSelection(current.length); } catch (error) {}
    });
    var ok = keyboard && keyboard.focus(views.textInput);
    if (!ok) {
      textEditingType = "";
      stopTyping("键盘要不过来，这一步先不改文字");
      return;
    }
    setEditMsg(
      forType === "inputText"
        ? "打要输入的内容，点「用这个」。游戏还在底下，照样点得动"
        : "打要找的那段字，点「用这个」。认不出来的字找不到，建议用「认一下」挑"
    );
  }

  // 文字打完了：交给调用方落到节点上（它才有会话数据）。
  // **空文字直接拒绝**：一个没有文字的「点击文字」跑起来不知道找什么，
  // 而校验要等写盘才报，那时人已经走开了。
  function commitText() {
    if (closed || !views) return;
    var value = "";
    try { value = String(views.textInput.getText()).trim(); } catch (error) {}
    if (!value) {
      setEditMsg("文字不能空着——空的「点击文字」不知道要找什么");
      return;
    }
    var forType = textEditingType || (steps[editIndex] && steps[editIndex].type) || "tapText";
    textEditingType = "";
    stopTyping();
    if (forType === "inputText") {
      if (!opts.onSetInputText) return;
      runStepAction("正在改成输入文字", function (index, done) {
        opts.onSetInputText(index, value, done);
      });
      return;
    }
    if (!opts.onSetNodeText) return;
    runStepAction("正在改文字", function (index, done) {
      opts.onSetNodeText(index, value, done);
    });
  }

  // 精确等待值：框里打毫秒，点「用这个值」收进草稿。
  // 校验在这里做一遍（非数字、超上限），别等写盘时才由调用方抛——
  // 那时人已经点完确定，错误信息离他按的那一下太远了。
  function commitExactWait() {
    if (closed || !views) return;
    var text = "";
    try { text = String(views.waitInput.getText()).trim(); } catch (error) {}
    if (text === "") {
      draftWaitMs = null;
      stopTyping();
      refreshWaitRow();
      setEditMsg("这一步改成不等了。点「确定」写盘");
      return;
    }
    if (!/^[0-9]+$/.test(text)) {
      setEditMsg("等待要填整数毫秒，实际填的是「" + text + "」");
      return;
    }
    var value = parseInt(text, 10);
    if (value > maxWaitMs) {
      setEditMsg("最多 " + maxWaitMs + " 毫秒。要等更久，把它拆成两条任务交给常驻调度");
      return;
    }
    draftWaitMs = value === 0 ? null : value;
    stopTyping();
    refreshWaitRow();
    setEditMsg("等待先记下了：" + waitLabel(draftWaitMs) + "。点「确定」写盘");
  }

  // 行数据只有这一个更新入口。字段是一轮一轮加上来的（类型、区域、找几次、
  // 找不到怎么办、手势时长），各处各抄一遍的话漏一个的表现是"改完界面不变"，
  // 而那种不一致最难查。
  var ROW_KEYS = [
    "name", "title", "subtitle", "waitMs", "type",
    "assetLabel", "regionLabel", "triesLabel", "failMode",
    "gestureLabel", "gestureInfo",
    // 认字那两种与禁用状态：少一个的表现同样是"改完界面不变"。
    "textLabel", "engine", "disabled",
    // 连续点击那三个数。**2026-10-04 加这个功能时漏在了这张清单外面**，
    // 后果整整两轮才看清：写盘是对的（列表那行的 subtitle 显示的是新值），
    // 但本地这份 step 的 multiCount 没被抄回来，于是进面板回填时读到旧值——
    // 用户先报「填 2 确定后变回 1」，修了一轮没治住，再报「外面是 3、
    // 点进去还是 2」。后面这句才把两边不一致的形状说清楚。
    // 上面那段注释早就警告过这件事："各处各抄一遍的话漏一个的表现是改完界面不变"。
    "multiCount", "multiIntervalMs", "multiPressMs",
    // 分组那两个。**2026-10-06 加循环分组时又漏了一次，同一张清单、同一类错。**
    // 用户 2026-10-08 报的形状："创建分组默认执行 1 次，这个 2 次没办法修"——
    // 盘上写对了（列表那行显示的是新次数），本地这份 step.repeat 没被抄回来，
    // 于是 -/+ 每次都拿旧值去算：从 1 按「+」得 2，再按「+」还是 2，卡死在那儿。
    // memberText 一起补：改完组内的步骤之后，面板上那句"含哪几步"同样会停在旧值。
    // check 里现在有一道闸守着这张清单（见 check-autojs-project.js）。
    "repeat", "memberText"
  ];

  function adoptRow(index, freshRow) {
    if (!freshRow || closed || !views) return;
    var step = steps[index];
    if (!step) return;
    for (var i = 0; i < ROW_KEYS.length; i++) {
      var key = ROW_KEYS[i];
      if (freshRow[key] !== undefined) step[key] = freshRow[key];
    }
    if (views.rowTitles[index]) {
      // 走 rowTitleText：行首那个序号是界面拼的，直接写 freshRow.title
      // 会把它抹掉——那一行就成了唯一没有号的一行。
      views.rowTitles[index].setText(rowTitleText(index));
      views.rowSubs[index].setText(freshRow.subtitle);
    }
  }

  function disarmDelete() {
    if (!deleteArmed) return;
    deleteArmed = false;
    if (views) views.deleteBtn.setText(" 删除 ");
  }

  function enterEdit(index) {
    var step = steps[index];
    if (!step) return;
    closeRowMenu();
    editIndex = index;
    draftWaitMs = step.waitMs == null ? null : Number(step.waitMs);
    draftPoint = null;
    draftPointText = "";
    draftName = null;
    deleteArmed = false;
    mode = "edit";
    // 换一步就把键盘收了：上一步没点确定的名字不该跟着跑到这一步来。
    stopTyping();
    ui.run(function () {
      if (closed || !views) return;
      views.editTitle.setText("第 " + ordinalOf(index) + " 步　" + step.title);
      views.editMeta.setText(step.subtitle);
      views.nameRow.setVisibility(GONE);
      views.textEditRow.setVisibility(GONE);
      views.deleteBtn.setText(" 删除 ");
      setEditMsg("停顿与坐标点「确定」才写盘；类型 / 参数 / 顺序即时生效");
      refreshWaitRow();
      refreshActionRows();
    });
    applyShape();
  }

  // 动作类型那一排 + 图片 / 限制区域两行。
  // **这三样改完立即写盘**——裁图、存素材本来就不是草稿能表达的事；
  // 停顿和坐标仍然是「确定才写」。两种行为并存，所以提示里说清楚。
  function refreshActionRows() {
    if (closed || !views) return;
    var step = steps[editIndex];
    if (!step) return;

    // ---- 分组（2026-10-06）----
    // 它没有坐标、没有图、没有动作类型，上面那些行一条都不适用。
    // **整块切换，不是逐行隐藏**：逐行判的话每加一种类型都要回来补一遍，
    // 漏一行的表现是"分组面板上摆着一个调不动的参数"。
    var group = step.type === "group";
    views.groupBox.setVisibility(group ? VISIBLE : GONE);
    views.waitBox.setVisibility(group ? GONE : VISIBLE);
    views.typeSummaryRow.setVisibility(group ? GONE : VISIBLE);
    if (group) {
      views.typeBox.setVisibility(GONE);
      views.textRow.setVisibility(GONE);
      views.engineRow.setVisibility(GONE);
      views.textEditRow.setVisibility(GONE);
      views.gestureRow.setVisibility(GONE);
      views.multiBox.setVisibility(GONE);
      views.assetRow.setVisibility(GONE);
      views.regionRow.setVisibility(GONE);
      views.triesRow.setVisibility(GONE);
      views.failRow.setVisibility(GONE);
      // 取点和只跑这一步对分组没有意义：它不碰屏幕，跑的是里面那几步。
      // 灰掉而不是隐藏——位置还在，人知道这两样存在、只是这一步用不上。
      views.pickBtn.setTextColor(colors.parseColor("#546e7a"));
      views.tryBtn.setTextColor(colors.parseColor("#546e7a"));
      views.groupRepeatInfo.setText((step.repeat == null ? 1 : step.repeat) + " 次");
      // 人正在精确值框里打字时不回写，否则光标跳回头、打一半被抹掉。
      if (!(keyboard && keyboard.isFocused())) {
        views.groupRepeatInput.setText(String(step.repeat == null ? 1 : step.repeat));
      }
      views.groupMembers.setText(step.memberText || "");
      views.disableBtn.setText(step.disabled ? " ▶ 启用这一组 " : " ⏸ 禁用这一组 ");
      views.disableBtn.setTextColor(colors.parseColor(step.disabled ? "#69f0ae" : "#ffab91"));
      // 第一步不能上移、最后一步不能下移，与普通步骤同一套规则。
      views.moveUpBtn.setTextColor(colors.parseColor(editIndex > 0 ? "#90caf9" : "#546e7a"));
      views.moveDownBtn.setTextColor(
        colors.parseColor(editIndex < steps.length - 1 ? "#90caf9" : "#546e7a")
      );
      return;
    }
    // 两种找图节点在图片 / 区域 / 找几次 / 找不到怎么办这四行上完全一样。
    var isSwipeImage = step.type === "swipeImage";
    var isImage = step.type === "tapImage" || isSwipeImage;
    var isSwipe = step.type === "swipe";
    var isLong = step.type === "longTap";
    var isNoop = step.type === "noop";
    // 认字的两种：点它（tapText）与往里打字（inputText）。
    var isTapText = step.type === "tapText";
    var isInputText = step.type === "inputText";
    var isText = isTapText || isInputText;
    // 连续点击要单独排除：漏了它的话「点击」会跟着一起亮绿，
    // 界面上同时出现两个"当前类型"，而人改完类型正是靠这个绿字确认的。
    var isMultiTap = step.type === "multiTap";
    var isTap = !isImage && !isSwipe && !isLong && !isNoop && !isText && !isMultiTap;
    // 当前类型亮绿，其余灰掉。五个都要显式设一遍——只设当前那个的话，
    // 上一次亮着的那个会一直亮，界面上就出现两个"当前类型"。
    views.typeTapBtn.setTextColor(colors.parseColor(isTap ? "#69f0ae" : "#78909c"));
    // 「点击图片」只在找图**点击**时亮；找图拖动亮的是「拖动图片」那个。
    views.typeImageBtn.setTextColor(
      colors.parseColor(step.type === "tapImage" ? "#69f0ae" : "#78909c")
    );
    views.typeSwipeBtn.setTextColor(colors.parseColor(isSwipe ? "#69f0ae" : "#78909c"));
    views.typeLongBtn.setTextColor(colors.parseColor(isLong ? "#69f0ae" : "#78909c"));
    views.typeNoopBtn.setTextColor(colors.parseColor(isNoop ? "#69f0ae" : "#78909c"));
    views.typeSwipeImageBtn.setTextColor(colors.parseColor(isSwipeImage ? "#69f0ae" : "#78909c"));
    views.typeMultiBtn.setTextColor(
      colors.parseColor(step.type === "multiTap" ? "#69f0ae" : "#78909c")
    );
    views.typeTapTextBtn.setTextColor(colors.parseColor(isTapText ? "#69f0ae" : "#78909c"));
    views.typeInputTextBtn.setTextColor(colors.parseColor(isInputText ? "#69f0ae" : "#78909c"));
    // 摘要行：收起来的时候，"现在是哪一种"只剩这一行在说。
    // 那九个按钮全灰着没有任何一个亮绿时人根本不知道当前是什么，所以这行必须准。
    views.typeSummary.setText(typeNameOf(step));
    views.typeBox.setVisibility(typeBoxOpen ? VISIBLE : GONE);
    views.typeToggleBtn.setText(typeBoxOpen ? " 收起 ▴ " : " 换一种 ▾ ");
    // 空等待不碰屏幕：取点、只跑这一步都没有意义，灰掉它们。
    // （调用方那边还有一道明说原因的拦截，这里只是别让人白点。）
    views.pickBtn.setTextColor(colors.parseColor(isNoop ? "#546e7a" : "#ffd54f"));
    views.tryBtn.setTextColor(colors.parseColor(isNoop ? "#546e7a" : "#69f0ae"));
    // 认字那几行。「认一下」只对点击文字有意义——输入文字是把字打进去，
    // 不需要先在屏幕上认出它来。
    views.textRow.setVisibility(isText ? VISIBLE : GONE);
    views.engineRow.setVisibility(isTapText ? VISIBLE : GONE);
    views.textScanBtn.setVisibility(isTapText ? VISIBLE : GONE);
    views.textInfo.setText(step.textLabel || "未设置");
    var useRapid = step.engine === "rapid";
    views.engineMlkitBtn.setTextColor(colors.parseColor(useRapid ? "#78909c" : "#69f0ae"));
    views.engineRapidBtn.setTextColor(colors.parseColor(useRapid ? "#69f0ae" : "#78909c"));
    // 禁用的那一步：按钮文案跟着状态走，别让人对着「禁用」猜现在是不是已经禁用了。
    views.disableBtn.setText(step.disabled ? " ▶ 启用这一步 " : " ⏸ 禁用这一步 ");
    views.disableBtn.setTextColor(colors.parseColor(step.disabled ? "#69f0ae" : "#ffab91"));
    views.assetRow.setVisibility(isImage ? VISIBLE : GONE);
    views.regionRow.setVisibility(isImage ? VISIBLE : GONE);
    views.triesRow.setVisibility(isImage ? VISIBLE : GONE);
    views.failRow.setVisibility(isImage ? VISIBLE : GONE);
    views.gestureRow.setVisibility(isSwipe || isLong ? VISIBLE : GONE);
    // 连续点击那三行：只有这一种类型才显示。
    // **人正在这三个框里打字时不回写**，否则光标跳回头、打一半被抹掉。
    views.multiBox.setVisibility(isMultiTap ? VISIBLE : GONE);
    if (isMultiTap && !(keyboard && keyboard.isFocused())) {
      views.multiCountInput.setText(String(step.multiCount == null ? 1 : step.multiCount));
      views.multiIntervalInput.setText(String(step.multiIntervalMs == null ? 100 : step.multiIntervalMs));
      views.multiPressInput.setText(String(step.multiPressMs == null ? 80 : step.multiPressMs));
    }
    views.assetInfo.setText(step.assetLabel || "未设置");
    views.regionInfo.setText(step.regionLabel || "全屏");
    views.triesInfo.setText(step.triesLabel || "");
    views.gestureLabel.setText(step.gestureLabel || "");
    views.gestureInfo.setText(step.gestureInfo || "");
    var keepGoing = step.failMode !== "abort";
    views.failNextBtn.setTextColor(colors.parseColor(keepGoing ? "#69f0ae" : "#78909c"));
    views.failStopBtn.setTextColor(colors.parseColor(keepGoing ? "#78909c" : "#ff8a80"));
    // 第一步不能上移、最后一步不能下移：点了也没意义，灰掉比弹一句提示干净。
    views.moveUpBtn.setTextColor(colors.parseColor(editIndex > 0 ? "#90caf9" : "#546e7a"));
    views.moveDownBtn.setTextColor(
      colors.parseColor(editIndex < steps.length - 1 ? "#90caf9" : "#546e7a")
    );
  }

  // 停顿或坐标还是草稿时，先把它落盘再做别的——否则那点改动会被随后的整行刷新
  // 覆盖掉，人明明改过却没生效，这种丢失最难查。
  function withDraftSaved(action) {
    if (busy) return;
    if (!hasDraftChange()) {
      action();
      return;
    }
    applyDraft(function (ok) {
      if (ok) action();
    });
  }

  // 换类型 / 截图 / 框区域都交给调用方做（它才有会话数据和截图能力），
  // 回来只刷新这一行。
  //
  // **整个过程本层先让开**：它是不透明的一大块，压着游戏半边屏幕，
  // 人要框的按钮很可能正好在底下（2026-09-27 用户实机反馈）。
  // 顺带也保证了随后那一张截图里不会拍进我们自己的界面——
  // 把自己的面板裁进模板图，回放时永远匹配不上。
  function runStepAction(name, invoke) {
    withDraftSaved(function () {
      var index = editIndex;
      markBusy(name + "…");
      hideForCapture();
      invoke(index, function (message, freshRow) {
        ui.run(function () {
          restoreAfterCapture();
          clearBusy();
          if (closed || !views) return;
          if (freshRow) {
            adoptRow(index, freshRow);
            draftWaitMs = freshRow.waitMs == null ? null : Number(freshRow.waitMs);
            // 面板顶上那行也要跟着换：换了类型之后它还写着「死坐标」的话，
            // 人看到的是"改了没生效"（这一行原先只在进面板和写盘时刷）。
            views.editTitle.setText("第 " + ordinalOf(index) + " 步　" + freshRow.title);
            views.editMeta.setText(freshRow.subtitle);
            refreshWaitRow();
            refreshActionRows();
          }
          setEditMsg(message || "");
        });
      });
    });
  }

  function backToList() {
    disarmDelete();
    // 回列表前一定要收键盘：焦点攥在一个已经看不见的输入框上，
    // 人回到游戏里按什么都没反应，而界面上没有任何线索。
    stopTyping();
    editIndex = -1;
    draftPoint = null;
    draftName = null;
    mode = "list";
    // 菜单是列表那一层的东西。不收的话，从单步面板回来会撞见一个
    // 还开在某一行上的菜单，而那一行可能已经不在当前这一页了。
    closeRowMenu();
    // 行的显隐跟着当前页重画一遍：在面板里改过名字或次数之后，
    // 页签上那个组名、提示行里的次数都要跟着变。
    applyPage();
    applyShape();
  }

  // ---- 剪贴板：复制 / 黏贴（2026-10-08）----
  //
  // 数据在调用方那边（它才拿得到 session 的 nodes 与 shots），本层只拿回
  // 一句"剪贴板里现在是什么"用来点亮那两条黏贴。

  // 复制**不关层**：它不改结构，关掉重开会把人从正在看的那一页弹回根节点。
  // say 决定这一轮的提示落在哪儿：从分组面板点进来的写面板那行，
  // 从长按菜单点进来的写列表那行。
  function copyToClipboard(index, say) {
    if (busy || !opts.onCopy || index < 0) return;
    busy = true;
    if (say) say("正在复制…");
    opts.onCopy(index, function (message, label) {
      ui.run(function () {
        clearBusy();
        if (closed || !views) return;
        if (label !== undefined && label !== null) clipboardLabel = String(label);
        closeRowMenu();
        if (say) say(message || "");
      });
    });
  }

  function pasteFromClipboard(where) {
    var index = menuIndex;
    if (busy || index < 0 || !opts.onPaste) return;
    markBusyOnList("正在黏贴…");
    opts.onPaste(index, where, function (message, ok) {
      ui.run(function () {
        clearBusy();
        if (closed || !views) return;
        // 粘成功了结构就变了，本层由调用方关掉重开；没成功就**留在原地**
        // 把原因说清楚（多半是"分组不能粘进分组里"）。关掉再报错的话，
        // 人回到列表上只看到"什么都没发生"。
        if (!ok) {
          setListMsg(message || "黏贴失败");
          return;
        }
        closeRowMenu();
        if (message) toast(message);
      });
    });
  }

  function nudgeWait(delta) {
    disarmDelete();
    var base = draftWaitMs == null ? 0 : draftWaitMs;
    var next = base + delta;
    if (next < 0) next = 0;
    if (next > maxWaitMs) {
      next = maxWaitMs;
      setEditMsg(
        "停顿最多 " + maxWaitMs + " 毫秒。要等更久的界面请升级成找图，找图自带等待"
      );
    }
    draftWaitMs = next === 0 ? null : next;
    refreshWaitRow();
  }

  // 有没有改过。没改就点确定，不该白写一次盘，也不该报「已保存」让人以为动过。
  function hasDraftChange() {
    var step = steps[editIndex];
    if (!step) return false;
    var original = step.waitMs == null ? null : Number(step.waitMs);
    if (draftPoint !== null || draftWaitMs !== original || draftName !== null) return true;
    // 连续点击那三个框也算改动。**漏了它的表现是「没有改动」**：
    // 人把次数从 1 改成 50，点确定，面板回一句"没有改动"，而他明明改了。
    if (step.type === "multiTap") {
      try {
        var multi = readMultiTapDraft();
        if (!multi) return false;
        if (multi.count !== (step.multiCount == null ? 1 : step.multiCount)) return true;
        if (multi.intervalMs !== (step.multiIntervalMs == null ? 100 : step.multiIntervalMs)) return true;
        if (multi.pressMs !== (step.multiPressMs == null ? 80 : step.multiPressMs)) return true;
      } catch (error) {
        // 填错了也算"有改动"：让它走到 applyDraft，由那里把错误显示出来。
        // 当成"没改动"的话，人填错了点确定只会得到一句"没有改动"，更难查。
        return true;
      }
    }
    return false;
  }

  function markBusy(text) {
    busy = true;
    setEditMsg(text);
  }

  // 列表那一层的忙碌提示。**markBusy 写的是单步面板那行字，在列表上根本看不见**——
  // 长按菜单里的复制 / 黏贴 / 删除都发生在列表上，提示要落在人看得见的地方，
  // 否则点下去到结果回来之间界面一动不动，人会再点一次。
  function markBusyOnList(text) {
    busy = true;
    setListMsg(text);
  }

  function clearBusy() {
    busy = false;
  }

  // 存盘：把草稿交给调用方，它负责换算与写盘，回来只更新这一行的文字。
  // 行的结构不动——动结构就得重建窗口，而改个停顿没必要闪一下。
  function applyDraft(afterDone) {
    if (busy) return;
    var index = editIndex;
    // 连续点击那三个框**在动任何别的东西之前先读出来**（2026-10-06 改）。
    //
    // 原先是在 stopTyping() 之后才读，中间隔着收键盘、还焦点、藏行那一串动作——
    // 用户实测「总点击次数填 2，点确定变回 1」。根因没有坐实（PC 上复现不了
    // 浮层与键盘的时序），但那段窗口是唯一可疑的地方：读之前但凡有一次回填，
    // 框里的 2 就被盘上的旧值刷掉，而人看到的是"我明明填了"。
    // 读到手里就不会再被任何后续动作改掉。
    var multi = null;
    try {
      multi = readMultiTapDraft();
    } catch (error) {
      // 读不动就**当场停下**，不写——兜底成默认值的话，
      // 人打错一个字就被悄悄换成 100，而他以为设的是别的数。
      setEditMsg(String(error.message || error));
      if (afterDone) afterDone(false);
      return;
    }
    if (!hasDraftChange()) {
      setEditMsg("没有改动");
      // 没改动也算"这一步完事了"：人点确定就是想收工，告诉他没改过、照样放他走。
      if (afterDone) afterDone(true, "没有改动");
      return;
    }
    // 还开着输入框就先收键盘：写盘之后焦点没人收，人回到游戏里会以为按键坏了。
    stopTyping();
    markBusy("正在保存…");
    // name 只有人这一轮真改过才放进 patch。无脑带上的话，调用方分不清
    // 「没动名字」和「把名字改成现在这个」，日志里也会多出一串没发生过的改名。
    var patch = { waitMs: draftWaitMs, point: draftPoint };
    if (draftName !== null) patch.name = draftName;
    if (multi) patch.multi = multi;
    opts.onApply(
      index,
      patch,
      function (message, freshRow) {
        ui.run(function () {
          clearBusy();
          if (closed || !views) return;
          if (freshRow) {
            adoptRow(index, freshRow);
            draftWaitMs = freshRow.waitMs == null ? null : Number(freshRow.waitMs);
            views.editMeta.setText(freshRow.subtitle);
            refreshWaitRow();
            refreshActionRows();
          }
          draftPoint = null;
          draftPointText = "";
          draftName = null;
          // 标题上那个「（未写盘）」要跟着消失，否则存完了界面还在说没存。
          var saved = steps[index];
          if (saved) {
            views.editTitle.setText("第 " + ordinalOf(index) + " 步　" + saved.title);
          }
          setEditMsg(message || "已保存");
          // 第二个参数给「确定」用：它存完要 toast 一句再退回列表，
          // 而面板那行小字那时候已经看不见了。
          if (afterDone) afterDone(true, message || "已保存");
        });
      }
    );
  }

  // 挪一步：结构变了但**行数没变**，所以不重建窗口——只把受影响的那两行刷一遍，
  // 并把编辑落点跟着挪过去。人挪完还停在同一步上，不该被弹回列表再点一次。
  function moveStep(delta) {
    if (busy || !opts.onMoveStep) return;
    disarmDelete();
    var index = editIndex;
    var target = index + delta;
    if (target < 0 || target >= steps.length) {
      setEditMsg(delta < 0 ? "已经是第一步" : "已经是最后一步");
      return;
    }
    withDraftSaved(function () {
      markBusy(delta < 0 ? "正在上移…" : "正在下移…");
      opts.onMoveStep(index, delta, function (message, payload) {
        ui.run(function () {
          clearBusy();
          if (closed || !views) return;
          if (payload && payload.rows) {
            for (var i = 0; i < payload.rows.length; i++) {
              adoptRow(payload.rows[i].index, payload.rows[i].row);
            }
            editIndex = payload.index != null ? payload.index : index;
            var step = steps[editIndex];
            if (step) {
              views.editTitle.setText("第 " + ordinalOf(editIndex) + " 步　" + step.title);
              views.editMeta.setText(step.subtitle);
              draftWaitMs = step.waitMs == null ? null : Number(step.waitMs);
              refreshWaitRow();
            }
            refreshActionRows();
          }
          setEditMsg(message || "");
        });
      });
    });
  }

  // 在这一步后面补录一步。**行数会变**，而行是 XML 里预先生成的，
  // 硬改已经画好的行会让序号和控件对不上（删除那条是同一个理由）。
  // 所以这件事由调用方主导：它自己收摊、去补录、再拿新数据重开本层。
  // 这里的 done 只服务于"压根没开始"的情形（前台不是游戏之类）。
  function insertStep() {
    if (busy || !opts.onInsertStep) return;
    disarmDelete();
    var index = editIndex;
    withDraftSaved(function () {
      markBusy("在第 " + ordinalOf(index) + " 步后面补一个动作…");
      opts.onInsertStep(index, function (message) {
        ui.run(function () {
          clearBusy();
          if (closed || !views) return;
          setEditMsg(message || "");
        });
      });
    });
  }

  function attachDrag(view, onTap) {
    var grabX = 0;
    var grabY = 0;
    var startX = 0;
    var startY = 0;
    var moved = false;
    view.setOnTouchListener(function (v, event) {
      var action = event.getAction();
      var rawX = event.getRawX();
      var rawY = event.getRawY();
      if (action === event.ACTION_DOWN) {
        grabX = rawX - posX;
        grabY = rawY - posY;
        startX = rawX;
        startY = rawY;
        moved = false;
        return true;
      }
      if (action === event.ACTION_MOVE) {
        if (Math.abs(rawX - startX) > TAP_SLOP_PX ||
            Math.abs(rawY - startY) > TAP_SLOP_PX) {
          moved = true;
        }
        if (moved) {
          posX = Math.round(rawX - grabX);
          posY = Math.round(rawY - grabY);
          clampPosition();
          try {
            window.setPosition(posX, posY);
          } catch (error) {}
        }
        return true;
      }
      if (action === event.ACTION_UP || action === event.ACTION_CANCEL) {
        if (!moved && onTap) {
          onTap();
          return true;
        }
        if (!hidden) {
          expandedX = posX;
          expandedY = posY;
        }
        return true;
      }
      return true;
    });
  }

  try {
    runOnUi(function () {
      window = floaty.rawWindow(buildLayout(steps));
    });
  } catch (error) {
    warn("建不出来: " + error);
    return null;
  }

  // 键盘焦点的把手。建窗之后就能挂，真正要焦点要等人点「改名」那一下。
  // onAutoRelease 是看门狗兜底的回调：焦点被收走了，界面上那行也要跟着收，
  // 否则人对着一个还开着的输入框打字，字一个都进不去，而界面什么都不说。
  keyboard = overlayKeyboard.attach(window, {
    logger: logger,
    onAutoRelease: function () {
      stopTyping("太久没动，键盘已交还游戏。要接着改就再点一次");
    }
  });

  // attach 之前 setSize / findView 都不可用，重试到就绪。
  shapeWidth = PANEL_WIDTH;
  shapeHeight = listHeight();
  var deadline = Date.now() + READY_WAIT_MS;
  while (true) {
    try {
      runOnUi(function () {
        window.setTouchable(true);
        window.setSize(shapeWidth, shapeHeight);
        window.setPosition(posX, posY);
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) {
        warn("窗口没能就绪: " + error);
        try {
          runOnUi(function () { window.close(); });
        } catch (closeError) {}
        return null;
      }
      sleep(POLL_MS * 2);
    }
  }

  try {
    runOnUi(function () {
      views = {
        handle: window.findView("handle"),
        panel: window.findView("panel"),
        listBox: window.findView("listBox"),
        editBox: window.findView("editBox"),
        dragGrip: window.findView("dragGrip"),
        title: window.findView("title"),
        hideBtn: window.findView("hideBtn"),
        closeBtn: window.findView("closeBtn"),
        listHint: window.findView("listHint"),
        listMsg: window.findView("listMsg"),
        runAllBtn: window.findView("runAllBtn"),
        extraBtn: window.findView("extraBtn"),
        addNodeBtn: window.findView("addNodeBtn"),
        bulkBtn: window.findView("bulkBtn"),
        bulkMenuBox: window.findView("bulkMenuBox"),
        bulkPickBox: window.findView("bulkPickBox"),
        bulkCountText: window.findView("bulkCountText"),
        bulkAllBtn: window.findView("bulkAllBtn"),
        bulkNoneBtn: window.findView("bulkNoneBtn"),
        bulkExitBtn: window.findView("bulkExitBtn"),
        bulkConfirmBtn: window.findView("bulkConfirmBtn"),
        bulkParamRow: window.findView("bulkParamRow"),
        bulkParamLabel: window.findView("bulkParamLabel"),
        bulkParamInput: window.findView("bulkParamInput"),
        bulkParamUnit: window.findView("bulkParamUnit"),
        menuDisableBtn: window.findView("menuDisableBtn"),
        menuEnableBtn: window.findView("menuEnableBtn"),
        menuDeleteBtn: window.findView("menuDeleteBtn"),
        menuWaitBtn: window.findView("menuWaitBtn"),
        menuGroupBtn: window.findView("menuGroupBtn"),
        menuCancelBtn: window.findView("menuCancelBtn"),
        editTitle: window.findView("editTitle"),
        renameBtn: window.findView("renameBtn"),
        nameRow: window.findView("nameRow"),
        nameInput: window.findView("nameInput"),
        nameOkBtn: window.findView("nameOkBtn"),
        nameCancelBtn: window.findView("nameCancelBtn"),
        editMeta: window.findView("editMeta"),
        typeTapBtn: window.findView("typeTapBtn"),
        typeImageBtn: window.findView("typeImageBtn"),
        typeSwipeBtn: window.findView("typeSwipeBtn"),
        typeLongBtn: window.findView("typeLongBtn"),
        typeNoopBtn: window.findView("typeNoopBtn"),
        typeSwipeImageBtn: window.findView("typeSwipeImageBtn"),
        typeTapTextBtn: window.findView("typeTapTextBtn"),
        typeInputTextBtn: window.findView("typeInputTextBtn"),
        textRow: window.findView("textRow"),
        textInfo: window.findView("textInfo"),
        textEditBtn: window.findView("textEditBtn"),
        textScanBtn: window.findView("textScanBtn"),
        textEditRow: window.findView("textEditRow"),
        textInput: window.findView("textInput"),
        textOkBtn: window.findView("textOkBtn"),
        textCancelBtn: window.findView("textCancelBtn"),
        engineRow: window.findView("engineRow"),
        engineMlkitBtn: window.findView("engineMlkitBtn"),
        engineRapidBtn: window.findView("engineRapidBtn"),
        disableBtn: window.findView("disableBtn"),
        typeMultiBtn: window.findView("typeMultiBtn"),
        typeSummary: window.findView("typeSummary"),
        typeToggleBtn: window.findView("typeToggleBtn"),
        typeBox: window.findView("typeBox"),
        typeSummaryRow: window.findView("typeSummaryRow"),
        waitBox: window.findView("waitBox"),
        groupBox: window.findView("groupBox"),
        groupRepeatInfo: window.findView("groupRepeatInfo"),
        groupRepeatDownBtn: window.findView("groupRepeatDownBtn"),
        groupRepeatUpBtn: window.findView("groupRepeatUpBtn"),
        groupRepeatInput: window.findView("groupRepeatInput"),
        groupRepeatOkBtn: window.findView("groupRepeatOkBtn"),
        groupMembers: window.findView("groupMembers"),
        groupOpenBtn: window.findView("groupOpenBtn"),
        groupCopyBtn: window.findView("groupCopyBtn"),
        groupUngroupBtn: window.findView("groupUngroupBtn"),
        gestureRow: window.findView("gestureRow"),
        gestureLabel: window.findView("gestureLabel"),
        gestureInfo: window.findView("gestureInfo"),
        multiBox: window.findView("multiBox"),
        multiCountInput: window.findView("multiCountInput"),
        multiCountDownBtn: window.findView("multiCountDownBtn"),
        multiCountUpBtn: window.findView("multiCountUpBtn"),
        multiIntervalInput: window.findView("multiIntervalInput"),
        multiIntervalDownBtn: window.findView("multiIntervalDownBtn"),
        multiIntervalUpBtn: window.findView("multiIntervalUpBtn"),
        multiPressInput: window.findView("multiPressInput"),
        multiPressDownBtn: window.findView("multiPressDownBtn"),
        multiPressUpBtn: window.findView("multiPressUpBtn"),
        multiHint: window.findView("multiHint"),
        gestureDownBtn: window.findView("gestureDownBtn"),
        gestureUpBtn: window.findView("gestureUpBtn"),
        orderRow: window.findView("orderRow"),
        moveUpBtn: window.findView("moveUpBtn"),
        moveDownBtn: window.findView("moveDownBtn"),
        insertBtn: window.findView("insertBtn"),
        assetRow: window.findView("assetRow"),
        assetInfo: window.findView("assetInfo"),
        assetPickBtn: window.findView("assetPickBtn"),
        regionRow: window.findView("regionRow"),
        regionInfo: window.findView("regionInfo"),
        regionPickBtn: window.findView("regionPickBtn"),
        regionClearBtn: window.findView("regionClearBtn"),
        triesRow: window.findView("triesRow"),
        triesInfo: window.findView("triesInfo"),
        triesDownBtn: window.findView("triesDownBtn"),
        triesUpBtn: window.findView("triesUpBtn"),
        failRow: window.findView("failRow"),
        failNextBtn: window.findView("failNextBtn"),
        failStopBtn: window.findView("failStopBtn"),
        editWait: window.findView("editWait"),
        waitExactRow: window.findView("waitExactRow"),
        waitInput: window.findView("waitInput"),
        waitOkBtn: window.findView("waitOkBtn"),
        editMsg: window.findView("editMsg"),
        pickBtn: window.findView("pickBtn"),
        tryBtn: window.findView("tryBtn"),
        runFromBtn: window.findView("runFromBtn"),
        deleteBtn: window.findView("deleteBtn"),
        backBtn: window.findView("backBtn"),
        applyBtn: window.findView("applyBtn"),
        tabBar: window.findView("tabBar"),
        tabRootBtn: window.findView("tabRootBtn"),
        tabGroupBtn: window.findView("tabGroupBtn"),
        tabGroupEditBtn: window.findView("tabGroupEditBtn"),
        rowMenuBox: window.findView("rowMenuBox"),
        rowMenuTitle: window.findView("rowMenuTitle"),
        rowMenuOpenBtn: window.findView("rowMenuOpenBtn"),
        rowMenuEditBtn: window.findView("rowMenuEditBtn"),
        rowMenuCopyBtn: window.findView("rowMenuCopyBtn"),
        rowMenuPasteBeforeBtn: window.findView("rowMenuPasteBeforeBtn"),
        rowMenuPasteAfterBtn: window.findView("rowMenuPasteAfterBtn"),
        rowMenuDisableBtn: window.findView("rowMenuDisableBtn"),
        rowMenuUngroupBtn: window.findView("rowMenuUngroupBtn"),
        rowMenuDeleteBtn: window.findView("rowMenuDeleteBtn"),
        rowMenuCancelBtn: window.findView("rowMenuCancelBtn"),
        rowTitles: [],
        rowSubs: [],
        rowBoxes: [],
      };
      var missing = [];
      for (var key in views) {
        if (key === "rowTitles" || key === "rowSubs" || key === "rowMarks") continue;
        if (key === "rowBoxes") continue;
        if (!views[key]) missing.push(key);
      }
      if (missing.length > 0) {
        throw new Error("控件未找到: " + missing.join(", "));
      }

      // 改名与改文字那两行平时不占地方：**XML 里给不了初始的隐藏**，建完就得先收起来，
      // 否则每次进单步面板都摆着两个空输入框，把真正要看的坐标与动作挤下去。
      views.nameRow.setVisibility(GONE);
      views.textEditRow.setVisibility(GONE);
      // 连续点击那三行同理：XML 给不了初始隐藏，不收起来的话每次进单步面板
      // 都摆着三个与这一步无关的数。
      views.multiBox.setVisibility(GONE);

      views.title.setText(String(opts.title || "编辑主流程"));
      // 长按菜单平时不占地方。**XML 里给不了初始的隐藏**，建完就得先收起来，
      // 和批量那两块同一个道理。
      views.rowMenuBox.setVisibility(GONE);
      // 列表那行提示归 applyPage 写（它要按"在哪一页"说不同的话）：
      // 这里再写一份的话，两处迟早不一致。

      for (var i = 0; i < steps.length && i < MAX_ROWS; i++) {
        var row = window.findView("row" + i);
        views.rowBoxes.push(row);
        views.rowTitles.push(window.findView("rowTitle" + i));
        views.rowSubs.push(window.findView("rowSub" + i));
        if (row) {
          // 闭包里要的是这一行的序号，不是循环结束后的 i。
          (function (index) {
            row.setOnClickListener(function () {
              // 菜单开着时点别处 = 把菜单收起来，不顺便做第二件事。
              // 收起来的同时还跳进某一步的话，人分不清自己点出了哪一个。
              if (menuIndex >= 0) {
                closeRowMenu();
                return;
              }
              // 勾选阶段点一行是勾选，不是进单步面板——
              // 两种含义共用一个点击，谁也说不清自己刚才点出了什么。
              // **选操作那一屏点行什么都不做**：那时候还没决定要干嘛，
              // 勾了也没地方体现，点下去只会让人以为勾丢了。
              if (bulkPhase === "pick") {
                togglePick(index);
                return;
              }
              if (bulkPhase === "menu") return;
              // 点分组行 = 进组内看里面那几步（2026-10-08 用户要的）。
              // 改次数、改名、复制、解散走长按菜单或页签上的「编辑这一组」——
              // 点一下最该给的是"里面到底有什么"，那是人点它的头号目的。
              if (isGroupStep(steps[index])) {
                goToPage(steps[index].nodeId);
                return;
              }
              enterEdit(index);
            });
            // 长按弹菜单。**返回 true**：返回 false 的话 Android 接着把它当短按派发，
            // 菜单弹出来的同时人还被带进了单步面板（2026-10-08 在设备上验过这一条）。
            row.setOnLongClickListener(function () {
              if (bulkPhase) {
                setListMsg("先退出批量再长按");
                return true;
              }
              openRowMenu(index);
              return true;
            });
          })(i);
        }
      }

      // ---- ＋ 添加节点 ----
      if (opts.onAddNode) {
        views.addNodeBtn.setOnClickListener(function () {
          if (bulkPhase) {
            setListMsg("先退出批量再加节点");
            return;
          }
          setListMsg("正在加一步…");
          opts.onAddNode(function (message) {
            setListMsg(message || "");
          });
        });
      } else {
        views.addNodeBtn.setVisibility(GONE);
      }

      // ---- 批量：第一步选操作，第二步勾步骤 ----
      if (opts.onBulk) {
        views.bulkBtn.setOnClickListener(function () {
          setBulkPhase(bulkPhase ? "" : "menu");
        });
        views.menuCancelBtn.setOnClickListener(function () {
          setBulkPhase("");
        });
        function pickFor(action) {
          return function () {
            setBulkPhase("pick", action);
          };
        }
        views.menuDisableBtn.setOnClickListener(pickFor("disable"));
        views.menuEnableBtn.setOnClickListener(pickFor("enable"));
        views.menuDeleteBtn.setOnClickListener(pickFor("delete"));
        views.menuWaitBtn.setOnClickListener(pickFor("wait"));
        views.menuGroupBtn.setOnClickListener(pickFor("group"));

        // 第二步的「取消」退回选操作那一屏，不是直接退出批量——
        // 人多半是选错了操作，退到底还得从头点一遍。
        views.bulkExitBtn.setOnClickListener(function () {
          setBulkPhase("menu");
        });
        views.bulkAllBtn.setOnClickListener(function () {
          // 只勾当前这一页。看不见的行也勾上的话，人点「删除」会删掉他没看到的步骤。
          var onPage = indexesOnPage();
          for (var a = 0; a < onPage.length; a++) picked[onPage[a]] = true;
          repaintPicks();
        });
        views.bulkNoneBtn.setOnClickListener(function () {
          picked = {};
          repaintPicks();
        });
        attachFocusOnTouch(views.bulkParamInput);

        // 一个「确定」收口，按当前选的操作分派。原先是五个按钮各管各的，
        // 而人要先在脑子里把"我勾的这几步"和"我要点的那个按钮"对上。
        views.bulkConfirmBtn.setOnClickListener(function () {
          var chosen = pickedIndexes();
          if (chosen.length === 0) {
            setListMsg("先勾几步");
            return;
          }
          if (bulkAction === "disable" || bulkAction === "enable") {
            runBulk(bulkAction, null);
            return;
          }
          // 删除要点两次：批量删掉的是好几步，连它们的截图与锚点一起没，
          // 误触一下的代价比单步删除大得多。
          if (bulkAction === "delete") {
            if (!bulkDeleteArmed) {
              bulkDeleteArmed = true;
              views.bulkConfirmBtn.setText(" 真的删 ");
              setListMsg("再点一次，这 " + chosen.length + " 步连截图一起没");
              return;
            }
            runBulk("delete", null);
            return;
          }
          if (bulkAction === "group") {
            if (!opts.onMakeGroup) return;
            if (chosen.length < 2) {
              setListMsg("至少要勾两步才能合成一组");
              return;
            }
            var groupName = "";
            try { groupName = String(views.bulkParamInput.getText()).trim(); } catch (error) {}
            // 名字必填（2026-10-08）。**先在这儿拦住**，别让人点完确定、
            // 层关掉重开之后才发现没建成。
            if (!groupName) {
              setListMsg("先给这一组起个名字，再点确定");
              return;
            }
            stopTyping();
            markBusyOnList("正在合并…");
            opts.onMakeGroup(chosen, groupName, function (message, ok) {
              ui.run(function () {
                clearBusy();
                if (closed || !views) return;
                // 合成功了结构就变了，本层由调用方关掉再拿新数据重开；
                // 没成功就留在原地，把原因说出来（多半是"没挨在一起"）。
                setListMsg(message || (ok ? "已合并" : "合并失败"));
              });
            });
            return;
          }
          // 统一等待
          var raw = "";
          try { raw = String(views.bulkParamInput.getText()).trim(); } catch (error) {}
          if (!/^[0-9]+$/.test(raw)) {
            setListMsg("等待要填整数毫秒，现在是: " + (raw || "(空)"));
            return;
          }
          var value = parseInt(raw, 10);
          var limit = opts.maxWaitMs || 3600000;
          if (value > limit) {
            setListMsg("最多 " + limit + " 毫秒");
            return;
          }
          runBulk("wait", value);
        });
      } else {
        views.bulkBtn.setVisibility(GONE);
      }
      // XML 里给不了初始的隐藏，建完就得先收起来：
      // 不收的话每行都摆着一个点不动的 ☐，看着像是批量模式一直开着。
      views.bulkMenuBox.setVisibility(GONE);
      views.bulkPickBox.setVisibility(GONE);
      repaintPicks();

      // 开层时停在哪一页。**结构一变本层就关掉重开**（删除、黏贴、解散都是），
      // 不带着这个的话，人在组内删一步，重开之后被弹回根节点，
      // 而他要删的是组里的第二步、第三步，每删一次都得重新点进去。
      if (opts.openPage) {
        var requested = stepIndexOfNodeId(opts.openPage);
        if (requested >= 0 && isGroupStep(steps[requested])) page = opts.openPage;
      }
      applyPage();

      // 开层时直接落在某一步的单步面板上（「＋ 添加节点」加完就该在那儿挑动作）。
      // 越界就当没给——宁可停在列表上，也不要开出一个指向空步骤的面板。
      if (typeof opts.openAt === "number" && opts.openAt >= 0 && opts.openAt < steps.length) {
        enterEdit(opts.openAt);
      }

      attachDrag(views.dragGrip, null);
      attachDrag(views.handle, function () {
        hidden = false;
        posX = expandedX;
        posY = expandedY;
        applyShape();
      });

      views.hideBtn.setOnClickListener(function () {
        // 藏成把手之前把键盘还掉：输入框已经看不见了，焦点不该还在它身上。
        stopTyping();
        expandedX = posX;
        expandedY = posY;
        hidden = true;
        applyShape();
      });
      views.closeBtn.setOnClickListener(function () {
        close();
        if (opts.onClose) opts.onClose();
      });
      views.runAllBtn.setOnClickListener(function () {
        if (opts.onRunAll) opts.onRunAll();
      });

      if (opts.extraAction && opts.extraAction.label) {
        views.extraBtn.setText(String(opts.extraAction.label));
        views.extraBtn.setVisibility(VISIBLE);
        views.extraBtn.setOnClickListener(function () {
          if (opts.extraAction.onTap) opts.extraAction.onTap();
        });
      } else {
        views.extraBtn.setVisibility(GONE);
      }

      for (var s = 0; s < WAIT_STEPS.length; s++) {
        (function (delta, id) {
          window.findView(id).setOnClickListener(function () {
            nudgeWait(delta);
          });
        })(WAIT_STEPS[s], "wait" + s);
      }

      // 取点：本层先让开（它是不透明的，挡着就没法在游戏上拖十字），
      // 调用方去开 point-picker，回来把坐标交还给草稿。
      views.pickBtn.setOnClickListener(function () {
        if (busy || !opts.onPick) return;
        disarmDelete();
        var index = editIndex;
        markBusy("取点中…");
        hideForCapture();
        opts.onPick(index, function (picked, message) {
          ui.run(function () {
            restoreAfterCapture();
            clearBusy();
            if (closed || !views) return;
            if (picked) {
              draftPoint = picked.value;
              draftPointText = picked.text || "";
              setEditMsg("已取到 " + draftPointText + "，点「确定」写回");
            } else {
              setEditMsg(message || "已取消取点，坐标未改");
            }
          });
        });
      });

      // 只跑这一步：有未保存的改动就**先存再跑**，否则跑的是旧数据，
      // 人会对着一个自己刚改掉的行为发愣。
      views.tryBtn.setOnClickListener(function () {
        if (busy || !opts.onTryStep) return;
        disarmDelete();
        var index = editIndex;
        // 这里**不手动让开**：截图和点击前的让开由 screen-overlays 统一调度
        // （本层开头已登记）。自己再 duck 一次，只会与它的 restore 打架——
        // 它拍完就把窗口恢复了，而我们以为还藏着。
        function go() {
          markBusy("正在只跑这一步…");
          opts.onTryStep(index, function (message) {
            ui.run(function () {
              clearBusy();
              setEditMsg(message || "跑完了");
            });
          });
        }
        if (hasDraftChange()) {
          applyDraft(function (ok) {
            if (ok) go();
          });
          return;
        }
        go();
      });

      // 从这一步开始跑到底。**走的是"真跑一趟任务"那条路**，不是单步调试那条：
      // 它可能跑几分钟，要有运行条、能暂停能终止，而单步调试那条没有这些。
      // 所以和「立即运行」一样，先把这一层关掉再起跑（由调用方负责）。
      views.runFromBtn.setOnClickListener(function () {
        if (busy || !opts.onRunFrom) return;
        disarmDelete();
        var index = editIndex;
        function go() {
          // 关层再跑由调用方做，这里只报一句——层马上就没了，写长了也看不见。
          markBusy("正在从这一步起跑…");
          opts.onRunFrom(index);
        }
        // 没写盘的改动先存：从这一步起跑却用的是盘上的旧值，人会以为改动没生效。
        if (hasDraftChange()) {
          applyDraft(function (ok) {
            if (ok) go();
          });
          return;
        }
        go();
      });

      // 删除要点两次。删完行的结构就变了，本层自己关掉，由调用方拿新数据重开——
      // 硬改已经画好的行会让序号和控件对不上，那种错很难查。
      views.deleteBtn.setOnClickListener(function () {
        if (busy || !opts.onDelete) return;
        if (!deleteArmed) {
          deleteArmed = true;
          views.deleteBtn.setText(" 真的删？ ");
          setEditMsg("只从流程里摘掉，截图与锚点文件留在磁盘上");
          return;
        }
        deleteArmed = false;
        var index = editIndex;
        markBusy("正在删除…");
        opts.onDelete(index, function (message) {
          ui.run(function () {
            clearBusy();
            if (message) toast(message);
          });
        });
      });

      // 动作类型：切「点击」是把找图还原成死坐标；切「点击图片」必然要先有模板，
      // 所以它和「去截图」是同一个动作——不存在"选了类型但没有图"的中间态。
      views.typeTapBtn.setOnClickListener(function () {
        if (!opts.onSetTap) return;
        // **从任何类型都能改回死坐标点击**。这里原先只允许从「点击图片」回来
        // （它当初是作为"升级找图"的反向操作写的），于是改成空等待、长按、滑动、
        // 认字之后就再也回不到普通点击——点那个按钮毫无反应，而界面上没有任何解释。
        // 2026-10-02 加认字两种时撞上：改完「输入文字」想改回点击，点了没反应。
        // 调用方的 onSetTap 本来就是拿 shot 里的坐标重建，对哪种类型都成立。
        if (steps[editIndex] && steps[editIndex].type === "tap") return;
        runStepAction("正在改回死坐标", opts.onSetTap);
      });
      views.typeImageBtn.setOnClickListener(function () {
        if (!opts.onPickAsset) return;
        runStepAction("去框模板图", opts.onPickAsset);
      });
      // 改成长按：不需要额外数据，坐标就用这一步原来的落点。
      views.typeLongBtn.setOnClickListener(function () {
        if (!opts.onSetLongTap) return;
        if (steps[editIndex] && steps[editIndex].type === "longTap") return;
        runStepAction("正在改成长按", opts.onSetLongTap);
      });
      // 改成滑动：**必须先有终点**，所以它和"去游戏上取终点"是同一个动作——
      // 不存在"选了滑动但没有终点"的中间态（与找图必须先有模板图同一个道理）。
      views.typeSwipeBtn.setOnClickListener(function () {
        if (!opts.onSetSwipe) return;
        runStepAction("去取滑动终点", opts.onSetSwipe);
      });
      // 改名：**就地改**。展开下面那行输入框、把键盘要过来，游戏仍在底下照常显示。
      // 不再像以前那样把 App 切到前台——那一下人就被甩出游戏了，
      // 而他正是对着游戏画面在认这一步是哪一下（用户 2026-10-01 明确要求改掉）。
      views.renameBtn.setOnClickListener(function () {
        if (busy) return;
        disarmDelete();
        if (nameEditing) {
          stopTyping("名字没改");
          return;
        }
        openNameEditor();
      });
      views.nameOkBtn.setOnClickListener(function () {
        if (busy) return;
        commitName();
      });
      views.nameCancelBtn.setOnClickListener(function () {
        stopTyping("名字没改");
      });
      // 点进输入框要重新把焦点要回来：确定过一次之后焦点已经还给游戏了，
      // 不重新要的话，光标看着在框里，字一个也进不去（实机就是这个表现）。
      //
      // **用触摸而不是点击**：窗口在 NOT_FOCUSABLE 状态下，输入框的
      // setOnClickListener 实测不触发（2026-10-02 真机：点进精确值框，
      // 光标出来了、焦点却没要到，打的字一个没进去）。按下那一刻就要焦点，
      // 并且**不吃掉事件**，光标定位、选中这些照旧由输入框自己处理。
      attachFocusOnTouch(views.nameInput);
      attachFocusOnTouch(views.waitInput);
      views.waitOkBtn.setOnClickListener(function () {
        if (busy) return;
        commitExactWait();
      });
      // 找图拖动：既要模板图又要终点，所以这一下会连着问两次
      // （先取终点——已经有就跳过，再框图）。
      views.typeSwipeImageBtn.setOnClickListener(function () {
        if (!opts.onSetSwipeImage) return;
        runStepAction("去设找图拖动", opts.onSetSwipeImage);
      });
      // 改成连续点击：位置沿用这一步已有的坐标，不用再取点（与长按同一条路）。
      // 三个数在下面那三行里改，改完点「确定」才写盘。
      views.typeMultiBtn.setOnClickListener(function () {
        if (!opts.onSetMultiTap) return;
        if (steps[editIndex] && steps[editIndex].type === "multiTap") return;
        runStepAction("正在改成连续点击", opts.onSetMultiTap);
      });
      // 连续点击那三个数：按一下框直接打字，-/+ 给微调。
      // 步进按数值量级给：次数 ±1、间隔 ±10 毫秒、按下 ±10 毫秒。
      nudgeNumberInput(views.multiCountInput, views.multiCountDownBtn, views.multiCountUpBtn, 1, 1, 2000);
      nudgeNumberInput(views.multiIntervalInput, views.multiIntervalDownBtn, views.multiIntervalUpBtn, 10, 0, 60000);
      nudgeNumberInput(views.multiPressInput, views.multiPressDownBtn, views.multiPressUpBtn, 10, 1, 10000);
      attachFocusOnTouch(views.multiCountInput);
      attachFocusOnTouch(views.multiIntervalInput);
      attachFocusOnTouch(views.multiPressInput);

      // ---- 分组：次数、复制、解散 ----
      // 次数**立即写盘**（和类型、顺序同一类）：草稿表达不了"这一组现在跑几遍"，
      // 而人改完次数多半会直接去跑，不会再回来点确定。
      function commitGroupRepeat(value) {
        if (!opts.onSetGroupRepeat) return;
        runStepAction("正在改次数", function (index, done) {
          opts.onSetGroupRepeat(index, value, done);
        });
      }
      views.groupRepeatDownBtn.setOnClickListener(function () {
        var step = steps[editIndex];
        if (!step || step.type !== "group") return;
        commitGroupRepeat((step.repeat == null ? 1 : step.repeat) - 1);
      });
      views.groupRepeatUpBtn.setOnClickListener(function () {
        var step = steps[editIndex];
        if (!step || step.type !== "group") return;
        commitGroupRepeat((step.repeat == null ? 1 : step.repeat) + 1);
      });
      attachFocusOnTouch(views.groupRepeatInput);
      views.groupRepeatOkBtn.setOnClickListener(function () {
        var text = "";
        try { text = String(views.groupRepeatInput.getText()).trim(); } catch (error) {}
        if (!/^[0-9]+$/.test(text)) {
          setEditMsg("次数要填整数，现在是「" + (text || "(空)") + "」");
          return;
        }
        stopTyping();
        commitGroupRepeat(parseInt(text, 10));
      });
      // 复制与解散都**改结构**（行数变了），所以与「删除」走同一条路：
      // 本层由调用方关掉再拿新数据重开。硬改已经画好的行会让序号和控件对不上，
      // 那种错很难查（行是 XML 里一次性画死的，没有数据源绑定那一套）。
      function runGroupStructure(label, invoke) {
        var index = editIndex;
        markBusy(label + "…");
        invoke(index, function (message) {
          ui.run(function () {
            clearBusy();
            if (message) toast(message);
          });
        });
      }
      // 进组内列表。**不写盘、不动结构**，所以不走 runGroupStructure 那条关层重开的路。
      views.groupOpenBtn.setOnClickListener(function () {
        var step = steps[editIndex];
        if (!step || step.type !== "group") return;
        var target = step.nodeId;
        backToList();
        goToPage(target);
      });
      views.groupCopyBtn.setOnClickListener(function () {
        if (busy) return;
        copyToClipboard(editIndex, setEditMsg);
      });
      views.groupUngroupBtn.setOnClickListener(function () {
        if (busy || !opts.onUngroup) return;
        runGroupStructure("正在解散分组", opts.onUngroup);
      });

      // ---- 页签 ----
      views.tabRootBtn.setOnClickListener(function () {
        goToPage("");
      });
      views.tabGroupEditBtn.setOnClickListener(function () {
        // 组内那一页上，这个按钮进的是**这一组自己**的单步面板（次数、改名、删除都在那儿）。
        if (!page) return;
        var at = stepIndexOfNodeId(page);
        if (at >= 0) enterEdit(at);
      });

      // ---- 长按菜单的九条 ----
      views.rowMenuCancelBtn.setOnClickListener(function () {
        closeRowMenu();
      });
      views.rowMenuOpenBtn.setOnClickListener(function () {
        var step = steps[menuIndex];
        if (!step || !isGroupStep(step)) return;
        goToPage(step.nodeId);
      });
      views.rowMenuEditBtn.setOnClickListener(function () {
        var index = menuIndex;
        if (index < 0) return;
        closeRowMenu();
        enterEdit(index);
      });
      views.rowMenuCopyBtn.setOnClickListener(function () {
        if (busy || menuIndex < 0) return;
        copyToClipboard(menuIndex, setListMsg);
      });
      views.rowMenuPasteBeforeBtn.setOnClickListener(function () {
        pasteFromClipboard("before");
      });
      views.rowMenuPasteAfterBtn.setOnClickListener(function () {
        pasteFromClipboard("after");
      });
      views.rowMenuDisableBtn.setOnClickListener(function () {
        var index = menuIndex;
        if (busy || index < 0 || !opts.onToggleDisabled) return;
        markBusyOnList("正在切换…");
        opts.onToggleDisabled(index, function (message, freshRow) {
          ui.run(function () {
            clearBusy();
            if (closed || !views) return;
            if (freshRow) adoptRow(index, freshRow);
            closeRowMenu();
            setListMsg(message || "");
          });
        });
      });
      views.rowMenuUngroupBtn.setOnClickListener(function () {
        var index = menuIndex;
        if (busy || index < 0 || !opts.onUngroup) return;
        markBusyOnList("正在解散分组…");
        opts.onUngroup(index, function (message) {
          ui.run(function () {
            clearBusy();
            if (closed || !views) return;
            if (message) toast(message);
          });
        });
      });
      // 删除同样要点两次。菜单里误触的代价和面板里一样大——删掉的那几步
      // 连截图和锚点一起没。
      views.rowMenuDeleteBtn.setOnClickListener(function () {
        var index = menuIndex;
        if (busy || index < 0 || !opts.onDelete) return;
        var step = steps[index];
        if (!menuDeleteArmed) {
          menuDeleteArmed = true;
          views.rowMenuDeleteBtn.setText(" 真的删，再点一次 ");
          setListMsg(
            isGroupStep(step)
              ? "再点一次，这一组连里面那几步一起没"
              : "再点一次，这一步连截图一起没"
          );
          return;
        }
        markBusyOnList("正在删除…");
        opts.onDelete(index, function (message) {
          ui.run(function () {
            clearBusy();
            if (closed || !views) return;
            if (message) toast(message);
          });
        });
      });

      // 「合并成循环组」挪进了批量的那个「确定」里（2026-10-07 改版）：
      // 五个各管各的按钮改成一个确定按钮按当前操作分派，见上面那一段。

      // 展开 / 收起那九个动作类型按钮。
      // **不写盘、不碰草稿**：它只决定面板上露出多少东西。
      views.typeToggleBtn.setOnClickListener(function () {
        typeBoxOpen = !typeBoxOpen;
        refreshActionRows();
      });

      // 改成空等待：不需要任何额外数据，坐标留在会话里，改回动作时还能用。
      views.typeNoopBtn.setOnClickListener(function () {
        if (!opts.onSetNoop) return;
        if (steps[editIndex] && steps[editIndex].type === "noop") return;
        runStepAction("正在改成空等待", opts.onSetNoop);
      });
      // 改成「点击文字」：**立刻去认一遍屏幕**，从认出来的词里挑一个。
      // 不做成"先选类型、再回头设文字"：那个中间态下这一步既不知道找什么，
      // 跑起来又不会报错（校验要等写盘），正是最难查的那类半截状态。
      views.typeTapTextBtn.setOnClickListener(function () {
        if (!opts.onSetTapText) return;
        runStepAction("去认屏幕上的字", opts.onSetTapText);
      });
      // 改成「输入文字」：当场弹输入框打字，打完才落类型。
      views.typeInputTextBtn.setOnClickListener(function () {
        if (busy || !opts.onSetInputText) return;
        disarmDelete();
        openTextEditor("inputText");
      });
      // 已经是认字节点时，改那段文字。
      views.textEditBtn.setOnClickListener(function () {
        if (busy) return;
        disarmDelete();
        var step = steps[editIndex];
        if (!step || (step.type !== "tapText" && step.type !== "inputText")) return;
        openTextEditor(step.type);
      });
      // 再认一遍屏幕换个词（只有点击文字有这个按钮）。
      views.textScanBtn.setOnClickListener(function () {
        if (!opts.onSetTapText) return;
        runStepAction("去认屏幕上的字", opts.onSetTapText);
      });
      views.textOkBtn.setOnClickListener(function () {
        if (busy) return;
        commitText();
      });
      views.textCancelBtn.setOnClickListener(function () {
        textEditingType = "";
        stopTyping("文字没改");
      });
      attachFocusOnTouch(views.textInput);
      views.engineMlkitBtn.setOnClickListener(function () {
        if (!opts.onSetTextEngine) return;
        if (steps[editIndex] && steps[editIndex].engine !== "rapid") return;
        runStepAction("换成快引擎", function (index, done) {
          opts.onSetTextEngine(index, "mlkit", done);
        });
      });
      views.engineRapidBtn.setOnClickListener(function () {
        if (!opts.onSetTextEngine) return;
        if (steps[editIndex] && steps[editIndex].engine === "rapid") return;
        runStepAction("换成全引擎", function (index, done) {
          opts.onSetTextEngine(index, "rapid", done);
        });
      });
      // 禁用 / 启用。**即时生效、立刻写盘**（与类型、顺序同一类）：
      // 草稿态的"禁用"看不出来，人点完去跑一遍只会发现它照样执行了。
      views.disableBtn.setOnClickListener(function () {
        if (!opts.onToggleDisabled) return;
        var step = steps[editIndex];
        runStepAction(step && step.disabled ? "正在启用" : "正在禁用", opts.onToggleDisabled);
      });
      views.gestureDownBtn.setOnClickListener(function () {
        if (!opts.onSetGestureParam) return;
        runStepAction("改时长", function (index, done) {
          opts.onSetGestureParam(index, -1, done);
        });
      });
      views.gestureUpBtn.setOnClickListener(function () {
        if (!opts.onSetGestureParam) return;
        runStepAction("改时长", function (index, done) {
          opts.onSetGestureParam(index, 1, done);
        });
      });
      views.moveUpBtn.setOnClickListener(function () {
        moveStep(-1);
      });
      views.moveDownBtn.setOnClickListener(function () {
        moveStep(1);
      });
      views.insertBtn.setOnClickListener(function () {
        insertStep();
      });
      views.assetPickBtn.setOnClickListener(function () {
        if (!opts.onPickAsset) return;
        runStepAction("去框模板图", opts.onPickAsset);
      });
      views.regionPickBtn.setOnClickListener(function () {
        if (!opts.onPickRegion) return;
        runStepAction("去框限制区域", opts.onPickRegion);
      });
      views.regionClearBtn.setOnClickListener(function () {
        if (!opts.onClearRegion) return;
        runStepAction("改回全屏找图", opts.onClearRegion);
      });
      views.triesDownBtn.setOnClickListener(function () {
        if (!opts.onSetTries) return;
        runStepAction("改找图次数", function (index, done) {
          opts.onSetTries(index, -1, done);
        });
      });
      views.triesUpBtn.setOnClickListener(function () {
        if (!opts.onSetTries) return;
        runStepAction("改找图次数", function (index, done) {
          opts.onSetTries(index, 1, done);
        });
      });
      views.failNextBtn.setOnClickListener(function () {
        if (!opts.onSetFailMode) return;
        runStepAction("改成找不到就继续", function (index, done) {
          opts.onSetFailMode(index, "next", done);
        });
      });
      views.failStopBtn.setOnClickListener(function () {
        if (!opts.onSetFailMode) return;
        runStepAction("改成找不到就停", function (index, done) {
          opts.onSetFailMode(index, "abort", done);
        });
      });

      views.backBtn.setOnClickListener(function () {
        if (busy) return;
        backToList();
      });
      // 「确定」= 写盘 + 吐一句 + 退回列表（2026-10-08 用户要求）。
      //
      // 原先写完就停在面板上，只在底下那行小字里写一句「已保存」——
      // 而人点确定时心里想的是"这一步改完了"，接着要做的是看列表或改下一步。
      // 停在原地还会让人怀疑到底存没存上，于是再点一次。
      //
      // **只有这个按钮会退回列表**：withDraftSaved 里那条路（改类型、挪顺序、
      // 插一步之前的顺手保存）照旧留在面板上——那几件事做完人还在这一步上。
      views.applyBtn.setOnClickListener(function () {
        applyDraft(function (ok, message) {
          if (!ok) return;
          // toast 而不是面板那行小字：面板马上就看不见了。
          if (message) toast(message);
          backToList();
        });
      });

      applyShape();
    });
  } catch (error) {
    warn("接线失败: " + error);
    try {
      runOnUi(function () { window.close(); });
    } catch (closeError) {}
    return null;
  }

  // 「只跑这一步」会截图找图，不让开就会挡住锚点：稳定失败且看不出根因。
  unregister = require("./screen-overlays-autojs.js").register({
    hideForCapture: hideForCapture,
    restoreAfterCapture: restoreAfterCapture
  });

  function close() {
    if (closed) return;
    // **先还焦点再关窗**。窗口都没了焦点却还记在它名下的话，
    // 键盘和 BACK 就都落进一个不存在的层里，游戏那边表现成"按键失灵"。
    try { stopTyping(); } catch (error) {}
    closed = true;
    if (unregister) {
      try { unregister(); } catch (error) {}
      unregister = null;
    }
    try {
      runOnUi(function () {
        try { window.close(); } catch (error) {}
      });
    } catch (error) {}
  }

  return {
    close: close,
    // 关层之前问一句"人正停在哪一页"，重开时原样还回去（opts.openPage）。
    // 不还的话，在组内每删一步就被弹回根节点一次，而他要删的是组里的第二、第三步。
    currentPage: function () {
      return page;
    },
    setListMsg: function (text) {
      ui.run(function () { setListMsg(text); });
    }
  };
}

module.exports = {
  open: open,
  // open() 返回 null 之后用它问"到底为什么"。
  lastError: function () {
    return lastErrorText;
  }
};
