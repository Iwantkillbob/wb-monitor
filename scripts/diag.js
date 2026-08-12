/**
 * 诊断脚本：列出环境/路径/版本/依赖完整性，无需启动 electron。
 * 输出"为什么 npm start 闪退"的快速排查清单。运行: `npm run diag`
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

console.log('===== WB Monitor 诊断 =====\n');

// 1. 干扰变量
const KNOWN_BAD = ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'SENTRY_DSN'];
console.log('[1] 干扰变量检查:');
KNOWN_BAD.forEach(k => {
  if (process.env[k]) console.log('    ⚠ ' + k + '=' + process.env[k]);
});
console.log('    (上方空白表示 OK)\n');

// 2. electron 二进制完整性
console.log('[2] electron 二进制:');
const electronPath = require('electron');
console.log('    路径:    ' + electronPath);
try {
  const stat = fs.statSync(electronPath);
  console.log('    大小:    ' + (stat.size / 1024 / 1024).toFixed(1) + ' MB');
  if (stat.size < 100 * 1024 * 1024) {
    console.log('    ⚠ 文件偏小（< 100 MB），可能下载不完整。建议: rm -rf node_modules/electron && npm install');
  } else {
    console.log('    ✓ 完整');
  }
} catch (e) {
  console.log('    ✗ 不存在或读不到: ' + e.message);
}
console.log();

// 3. sql.js wasm
console.log('[3] sql.js wasm:');
const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
console.log('    路径: ' + wasmPath);
console.log('    存在: ' + fs.existsSync(wasmPath));
console.log();

// 4. workbuddy.db
console.log('[4] workbuddy.db:');
const dbPath = path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
console.log('    路径: ' + dbPath);
console.log('    存在: ' + fs.existsSync(dbPath));
console.log();

// 5. 项目根
console.log('[5] 当前工作目录:');
console.log('    ' + process.cwd());
console.log();

// 6. node 版本
console.log('[6] node 版本: ' + process.version + ' (electron 自带 node: 参考 ' + electronPath + ')\n');

// 7. boot.log / crash.log
console.log('[7] 日志（最近一次启动的痕迹）:');
for (const fn of ['boot.log', 'crash.log']) {
  const p = path.join(__dirname, '..', fn);
  if (fs.existsSync(p)) {
    const lines = fs.readFileSync(p, 'utf-8').trim().split(/\r?\n/);
    console.log('    ' + fn + '（共 ' + lines.length + ' 行）:');
    lines.slice(-15).forEach(l => console.log('      ' + l));
  } else {
    console.log('    ' + fn + ': 无');
  }
}
console.log();

console.log('===== 建议启动方式 =====');
console.log('  npm run start:clean    （自动清干扰变量）');
console.log('  启动后看 boot.log / crash.log 即可定位');
