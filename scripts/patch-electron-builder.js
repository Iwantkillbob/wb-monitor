/**
 * patch-electron-builder.js
 *
 * 目的：修复 electron-builder 在 Windows 上打包必然失败的竞态 bug。
 *
 * 现象：
 *   ⨯ EPERM: operation not permitted, rename
 *     '...\win-unpacked.tmp' -> '...\win-unpacked'
 *
 * 根因：
 *   app-builder-lib/out/util/electronGet.js 的 extractArchive() 把 electron 运行时
 *   （electron.exe + 一堆 .dll，约 250MB）解压到 `<dir>.tmp`，解压完立刻
 *   `fs.rename(tmpDir, dir)`。而此刻 Windows Defender 实时保护 / 搜索索引服务
 *   正在扫描这批刚落盘的可执行文件，持有文件句柄且未带 FILE_SHARE_DELETE，
 *   于是整个目录改名被内核拒绝 → EPERM。
 *   等 1-3 秒句柄释放后手动 rename 即可成功，故这是纯竞态、非权限问题。
 *
 * 处理：
 *   给最后的 rm + rename 套一层指数退避重试（最多 12 次，累计约 40s）。
 *   只对 EPERM / EACCES / EBUSY 重试，其他错误立即抛出，不掩盖真实故障。
 *
 * 幂等：
 *   已打过补丁（含 __WBM_RENAME_RETRY__ 标记）则直接跳过。
 *   npm install 覆盖 node_modules 后重跑本脚本即可恢复，所以 build.bat 每次都调用它。
 */
const fs = require('fs');
const path = require('path');

const MARKER = '__WBM_RENAME_RETRY__';
const TARGET = path.join(
  __dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'util', 'electronGet.js'
);

function log(msg) {
  process.stdout.write('[patch-electron-builder] ' + msg + '\n');
}

function main() {
  if (!fs.existsSync(TARGET)) {
    log('跳过：未找到 app-builder-lib（electron-builder 尚未安装？）');
    log('  期望路径 ' + TARGET);
    return 0;
  }

  let src = fs.readFileSync(TARGET, 'utf8');

  if (src.includes(MARKER)) {
    log('已打过补丁，跳过。');
    return 0;
  }

  // 原始代码片段（app-builder-lib 26.x）
  const NEEDLE = 'await fs.rm(dir, { recursive: true, force: true });\n        await fs.rename(tmpDir, dir);';

  if (!src.includes(NEEDLE)) {
    log('警告：未匹配到目标代码，可能 electron-builder 版本已变更。');
    log('  未打补丁 —— 若打包报 EPERM rename，请更新本脚本的 NEEDLE。');
    return 0;
  }

  const PATCHED = [
    '// ' + MARKER + ' Windows 反病毒/索引服务会在解压完成瞬间持有新落盘的 exe/dll 句柄，',
    '        // 导致目录 rename 抛 EPERM。此处加指数退避重试（仅针对占用类错误）。',
    '        const __wbmRetry = async (fn) => {',
    '            let __err = null;',
    '            for (let __i = 0; __i < 12; __i++) {',
    '                try {',
    '                    await fn();',
    '                    return;',
    '                }',
    '                catch (e) {',
    '                    __err = e;',
    '                    const __c = e && e.code;',
    '                    if (__c === "EPERM" || __c === "EACCES" || __c === "EBUSY" || __c === "ENOTEMPTY") {',
    '                        await new Promise(r => setTimeout(r, 500 + __i * 500));',
    '                        continue;',
    '                    }',
    '                    throw e;',
    '                }',
    '            }',
    '            throw __err;',
    '        };',
    '        await __wbmRetry(() => fs.rm(dir, { recursive: true, force: true }));',
    '        await __wbmRetry(() => fs.rename(tmpDir, dir));',
  ].join('\n');

  src = src.replace(NEEDLE, PATCHED);
  fs.writeFileSync(TARGET, src, 'utf8');
  log('补丁已应用：extractArchive() 的 rm/rename 现已带重试。');
  return 0;
}

process.exit(main());
