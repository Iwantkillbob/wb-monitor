/**
 * 干净启动 WB Monitor —— 先列出/清掉会干扰 electron 的环境变量，再 fork electron。
 * 针对"npm start 一闪而过"类问题。运行: `npm run start:clean`
 */
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 顶部面包屑：即便后续 require('electron') 抛错，也能证明本脚本已被启动。
// 用于定位"双击后毫无日志"——确认是 .bat 没调到 node，还是 node 起脚本后崩溃。
try {
  const _bm = path.join(__dirname, '..', 'start-clean.started.log');
  fs.writeFileSync(_bm, new Date().toISOString() + ' start-clean.js started; node=' + process.version +
    '; NODE_OPTIONS=' + (process.env.NODE_OPTIONS || '(none)') + '\n');
} catch (e) {}

/**
 * 启动前清理：解决“重启没用 / 双击 start.bat 仍显示旧数据 / 打不开”的根因。
 * 1) 删掉陈旧的 Electron 单实例锁文件（%~APPDATA%/wb-monitor/lockfile 等）。
 *    进程崩溃/被杀后这个锁文件可能残留，导致新实例误以为“另一个实例在运行”而直接退出。
 * 2) 终止任何会霸锁的遗留进程：
 *    - 打包版 WB Monitor.exe（来自 wb-monitor-output/win-unpacked 的旧构建，含旧 bug、无 dsh 功能）
 *    - 任何没关干净的「源码版 electron（命令行含 wb-monitor）」—— 它占着源码版的锁，
 *      会导致新启动被单实例机制静默挡掉（表现就是"打不开"，且毫无提示）
 *    均按进程名 + 命令行匹配，不误杀其它 electron 应用（如 WorkBuddy）。
 */
function preLaunchCleanup() {
  // 1) 删除陈旧锁文件（覆盖可能的 userData 目录）
  const lockDirs = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'wb-monitor'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'WB Monitor'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Electron')
  ];
  for (const d of lockDirs) {
    try { const lp = path.join(d, 'lockfile'); if (fs.existsSync(lp)) fs.unlinkSync(lp); } catch (e) { /* 忽略 */ }
  }
  try { console.log('[clean-start] 已删除陈旧单实例锁文件'); } catch (e) {}

  // 2) 终止遗留进程（不误杀其它 electron 应用）
  try {
    const killScript = [
      "Get-CimInstance Win32_Process -Filter \"Name='WB Monitor.exe'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*wb-monitor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*wb-monitor-output*win-unpacked*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-Command', killScript], { stdio: 'ignore', windowsHide: true }, () => {});
    console.log('[clean-start] 已尝试清理遗留的 WB Monitor / 源码版 electron 进程');
  } catch (e) { /* 无遗留进程或权限不足，忽略 */ }
}

// 会在启动时让 electron 崩溃的环境变量（尤其 NODE_OPTIONS=--use-system-ca 会导致 electron
// 直接 exit code 9 闪退；ELECTRON_RUN_AS_NODE 会让 electron 退化成 node 不启动 GUI）。
// 这些变量通常是其它桌面应用（如 WorkBuddy）注入到全局环境的，必须清除。
const KNOWN_BAD = ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING_FILE', 'ELECTRON_ENABLE_LOGGING', 'SENTRY_DSN', 'ELECTRON_DISABLE_SECURITY_WARNINGS'];
const AUDIT = known => {
  const hits = known.filter(k => process.env[k]);
  if (hits.length === 0) {
    console.log('[clean-start] ✓ 无已知的干扰变量');
  } else {
    console.log('[clean-start] ⚠ 发现干扰变量（将被清空）:');
    hits.forEach(k => console.log('  - ' + k + '=' + process.env[k]));
  }
  return hits;
};
const bad = AUDIT(KNOWN_BAD);
bad.forEach(k => { delete process.env[k]; });

// 启动前清理：删锁文件 + 杀遗留进程（根治“重启没用 / 打不开”）
preLaunchCleanup();

// 找到 electron 可执行：node_modules/.bin/electron（Windows 下可能是个 .cmd/.ps1，需跨平台）
const electronBin = require('electron');

// 把 electron 的 stdout/stderr 落到 launch.log，即使"闪退"也能事后查看真实报错
const LAUNCH_LOG = path.join(__dirname, '..', 'launch.log');
let launchLog;
try { launchLog = fs.createWriteStream(LAUNCH_LOG, { flags: 'a' }); } catch (e) { launchLog = null; }
const ts = () => new Date().toISOString();
function logLine(s) {
  const line = ts() + ' ' + s + '\n';
  if (launchLog) try { launchLog.write(line); } catch {}
  process.stdout.write(line);
}

const child = spawn(electronBin, [path.join(__dirname, '..'), '--enable-logging', '--in-process-gpu', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,     // 已被 delete 干扰项
  shell: false
});
child.stdout.on('data', d => logLine('[electron] ' + d.toString().trimEnd()));
child.stderr.on('data', d => logLine('[electron-ERR] ' + d.toString().trimEnd()));
child.on('error', e => logLine('[spawn-error] ' + (e && e.stack || e)));

// 异常退出：写 launch.log + 弹 Windows 提示框写明原因（避免"闪退看不到原因"）
function showCrashBox(code, reason) {
  const msg = 'WB Monitor 启动失败（exit code=' + code + '）。\n\n' +
    (reason || '原因已记录到项目目录 launch.log，可发给开发排查。') +
    '\n\n请确认：① 双击的是 start.bat / 本快捷方式，不是旧 WB Monitor.exe；② 若提示 NODE_OPTIONS / --use-system-ca，是系统环境变量冲突，start.bat 本应已清除，可重试一次。';
  try {
    execFile('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(' +
      JSON.stringify(msg) + ', \'WB Monitor 启动失败\', \'OK\', \'Error\')'],
      { windowsHide: true }, () => {});
  } catch (e) { /* 弹窗失败就只写日志 */ }
}
child.on('exit', code => {
  if (code && code !== 0) {
    const reason = (code === 9)
      ? '疑似 NODE_OPTIONS 环境变量冲突（--use-system-ca 不被 electron 允许）。'
      : '';
    logLine('[clean-start] ⚠ electron 异常退出 (code=' + code + ')。' + (reason ? ' ' + reason : ''));
    showCrashBox(code, reason);
  }
  if (launchLog) try { launchLog.end(); } catch {}
  process.exit(code || 0);
});
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
