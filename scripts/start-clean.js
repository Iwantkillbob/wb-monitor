/**
 * 干净启动 WB Monitor —— 先列出/清掉会干扰 electron 的环境变量，再 fork electron。
 * 针对"npm start 一闪而过"类问题。运行: `npm run start:clean`
 */
const { spawn } = require('child_process');
const path = require('path');

const KNOWN_BAD = ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING_FILE', 'SENTRY_DSN'];
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

// 找到 electron 可执行：node_modules/.bin/electron（Windows 下可能是个 .cmd/.ps1，需跨平台）
const electronBin = require('electron');

const child = spawn(electronBin, [path.join(__dirname, '..'), '--enable-logging', '--in-process-gpu', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage'], {
  stdio: 'inherit',
  env: process.env,     // 已被 delete 干扰项
  shell: false
});
child.on('exit', code => process.exit(code || 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
