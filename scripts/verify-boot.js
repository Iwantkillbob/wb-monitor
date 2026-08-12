// 自举验证：拉起 electron 主进程，等待后读回 boot.log / crash.log，再杀掉。
// 绕过 bash 后台进程 + safe-delete 的不可靠问题，用 node 直接 spawn + 读文件。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname.replace(/[\\/]scripts$/, '');
const bootLog = path.join(ROOT, 'boot.log');
const crashLog = path.join(ROOT, 'crash.log');
try { fs.writeFileSync(bootLog, ''); } catch {}
try { fs.writeFileSync(crashLog, ''); } catch {}

const env = { ...process.env };
delete env.NODE_OPTIONS;
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(
  path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [ROOT, '--no-sandbox', '--disable-gpu', '--headless'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
);

let out = '';
child.stdout.on('data', d => out += d.toString());
child.stderr.on('data', d => out += d.toString());

function finish(why) {
  try { child.kill('SIGKILL'); } catch {}
  console.log('===== electron 退出原因:', why, '=====');
  console.log('--- boot.log ---');
  try { console.log(fs.readFileSync(bootLog, 'utf-8') || '(空)'); } catch (e) { console.log('读取失败:', e.message); }
  console.log('--- crash.log ---');
  try { console.log(fs.readFileSync(crashLog, 'utf-8') || '(空 — 无未捕获异常)'); } catch (e) { console.log('读取失败:', e.message); }
  console.log('--- electron 自身 stderr/stdout ---');
  console.log(out.slice(0, 800) || '(无)');
  process.exit(0);
}

setTimeout(() => finish('等待 8s 后主动读取'), 8000);
setTimeout(() => finish('硬超时 12s'), 12000);
child.on('exit', (code) => finish('进程自行退出 code=' + code));
