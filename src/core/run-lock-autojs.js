// =====================================================================
// 通用能力：跨脚本引擎的「同一时刻只跑一个任务」互斥锁
// 设计约束：
//   - 界面里那个 busy 布尔量是**模块级变量**，只在一个脚本引擎内有效。
//     而入口是会被重新执行的：脚本页在后台被系统回收后，moveTaskToFront
//     把任务栈拉回来会**从根 activity 重建**，入口随之重跑、菜单重新出现、
//     倒计时又起一个任务——此时 busy 是新引擎里的 false，拦不住
//     （2026-09-16 实测：BOSS 任务跑到一半，切前台申请截图权限时触发重建，
//     6 秒后 main.js 重新执行，10 秒后倒计时又起了一个常驻）。
//   - 所以互斥必须落在引擎之外。用文件，并且带心跳：
//     进程被杀、脚本崩溃都不会留下一把永远解不开的锁。
//   - 锁不是安全边界，是防误触发。两个进程同时抢的竞态不做处理——
//     本项目的场景是「同一台设备上人和倒计时抢」，不是高并发。
// =====================================================================

var LOCK_VERSION = 1;

// 心跳间隔与判定失效的阈值。阈值取心跳的 4 倍：设备卡顿时漏写一两次心跳很正常，
// 太敏感会把正在跑的任务误判成死锁，从而真的并发起两个任务——那正是要防的事。
var HEARTBEAT_INTERVAL_MS = 5000;
var STALE_AFTER_MS = 20000;

function lockPathOf(config) {
  return config.outputRoot + "/run.lock";
}

function currentPid() {
  try {
    return android.os.Process.myPid();
  } catch (error) {
    return -1;
  }
}

function readLock(config) {
  var path = lockPathOf(config);
  if (!files.exists(path)) {
    return null;
  }
  try {
    var raw = files.read(path);
    if (raw && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    var parsed = JSON.parse(raw);
    if (parsed.version !== LOCK_VERSION) return null;
    return parsed;
  } catch (error) {
    // 锁文件写坏了就当没有。留着一个解析不了的锁，等于永远起不了任务。
    return null;
  }
}

function writeLock(config, lock) {
  files.ensureDir(config.outputRoot + "/");
  files.write(lockPathOf(config), JSON.stringify(lock, null, 2) + "\n");
}

// 返回当前**有效**的锁；心跳过期的视为无主，返回 null。
function inspect(config) {
  var lock = readLock(config);
  if (!lock) return null;
  var age = Date.now() - (lock.heartbeatAt || 0);
  if (age > STALE_AFTER_MS) {
    return null;
  }
  return lock;
}

// 抢锁。抢不到返回 null，由调用方决定怎么提示——本模块不碰界面。
function acquire(config, taskId) {
  if (inspect(config)) {
    return null;
  }

  var now = Date.now();
  writeLock(config, {
    version: LOCK_VERSION,
    pid: currentPid(),
    taskId: taskId,
    startedAt: now,
    heartbeatAt: now
  });

  var released = false;
  // 心跳线程：任务本身可能长时间阻塞在找图或 sleep 上，没法顺便刷心跳，
  // 所以单独起一个。它只写文件，绝不碰界面。
  var heartbeat = threads.start(function () {
    while (!released) {
      sleep(HEARTBEAT_INTERVAL_MS);
      if (released) break;
      try {
        var current = readLock(config);
        if (!current || current.taskId !== taskId) {
          // 锁被别人接管或删掉了，不要再续，避免把别人的锁写活。
          break;
        }
        current.heartbeatAt = Date.now();
        writeLock(config, current);
      } catch (error) {
        // 写不动就算了，让它自然过期，总好过把心跳线程炸掉。
      }
    }
  });

  return {
    taskId: taskId,
    // 幂等：任务正常结束会 release 一次，「停止并返回」也会 release 一次。
    release: function () {
      if (released) return;
      released = true;
      try { heartbeat.interrupt(); } catch (error) {}
      try {
        var current = readLock(config);
        if (!current || current.taskId === taskId) {
          files.remove(lockPathOf(config));
        }
      } catch (error) {}
    }
  };
}

module.exports = {
  LOCK_VERSION: LOCK_VERSION,
  HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
  STALE_AFTER_MS: STALE_AFTER_MS,
  lockPathOf: lockPathOf,
  inspect: inspect,
  acquire: acquire
};
