// =====================================================================
// 通用能力：从工作线程往界面线程派一件事，并等它做完
// 设计约束：
//   - `ui.run` 是异步的，而悬浮窗的 setSize / setPosition / close 都只能在
//     界面线程上调。工作线程派过去之后如果不等，就会拿不到异常、也不知道做完没有
//   - 界面线程里抛的异常要带回来。否则悬浮窗建不出来这种事会被静默吞掉，
//     表现成"功能没反应"，而日志里什么都没有
//   - **不能从界面线程调用本模块**：这里的等待要 sleep，而 UI 线程里 sleep 会抛
//     「UI 线程内无法执行阻塞操作」并让整个脚本退出（RECORDER.md 第 4 条坑）。
//     调用方一律接住异常降级，不要让一个辅助功能掀翻任务
// =====================================================================

var DEFAULT_TIMEOUT_MS = 1000;
var POLL_MS = 30;

// 已经在界面线程上了吗。触摸回调、点击回调本来就跑在界面线程上，
// 那里再派一次并等待，等的是自己——直接死锁，而 sleep 还会先把脚本干掉。
function isUiThread() {
  try {
    return android.os.Looper.myLooper() === android.os.Looper.getMainLooper();
  } catch (error) {
    return false;
  }
}

function run(action, timeoutMs) {
  // 在界面线程上就地做掉：既不用等，也不会 sleep。
  if (isUiThread()) {
    action();
    return;
  }
  var done = false;
  var failure = null;
  ui.run(function () {
    try {
      action();
    } catch (error) {
      failure = error;
    }
    done = true;
  });
  var deadline = Date.now() + (timeoutMs || DEFAULT_TIMEOUT_MS);
  while (!done && Date.now() < deadline) {
    sleep(POLL_MS);
  }
  if (!done) throw new Error("界面线程没有及时响应");
  if (failure) throw failure;
}

module.exports = {
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  POLL_MS: POLL_MS,
  isUiThread: isUiThread,
  run: run
};
