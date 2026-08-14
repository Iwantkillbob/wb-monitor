/**
 * WB Monitor 主进程 v5 — 极简版
 * 零原生依赖（去掉 systeminformation）
 * 所有数据读取异步，绝不阻塞 UI 线程
 */
const { app, BrowserWindow, ipcMain, screen, globalShortcut, Menu, Tray, nativeImage } = require('electron');
// GPU 兼容（关键，避免打包后 exe 闪退）：
//   开发模式靠 scripts/start-clean.js 传 CLI 参数；但「打包后的 exe」走 electron 默认启动，
//   不会带那些参数 → 在无显卡环境（VM / 远程桌面 / 部分笔记本）必崩（GPU 子进程 fatal 退出，
//   连带 kill 渲染进程 → 窗口一闪而过）。
//   故在应用层用 app.commandLine 强制设置，开发/打包都生效：
//     --in-process-gpu        把 GPU 跑进主进程，干掉必崩的独立 GPU 子进程
//     --disable-gpu           走软件渲染（本应用是 DOM 悬浮球，无需 GPU）
//     --no-sandbox            避免沙箱限制加剧崩溃
//     --disable-dev-shm-usage 避免 /dev/shm 空间不足导致崩溃
//   注意：绝不调用 app.disableHardwareAcceleration() —— 它与 in-process-gpu 冲突会 kill 渲染进程。
if (app.commandLine) {
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ===== 启动握手日志（写 stderr + 文件，方便排查 "npm start 一闪而过" 类问题）=====
// 打包后 __dirname 指向 resources/app，NSIS 默认装到 Program Files（只读），
// 日志写不进去就等于没有排查手段。故打包态改写用户数据目录：
//   %APPDATA%\WB Monitor\boot.log
function _resolveBootLogPath() {
  try {
    if (app.isPackaged) {
      const dir = app.getPath('userData'); // app.getPath 在 ready 之前即可用
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      return path.join(dir, 'boot.log');
    }
  } catch {}
  return path.join(__dirname, 'boot.log');
}
const _BOOT_LOG = _resolveBootLogPath();
try { fs.writeFileSync(_BOOT_LOG, ''); } catch {} // 每次启动清空旧日志
function bootLog(stage, info) {
  const ts = new Date().toISOString();
  const line = ts + ' [boot ' + stage + '] ' + (info || '') + '\n';
  try { process.stderr.write('[boot ' + stage + '] ' + (info || '') + '\n'); } catch {}
  try { fs.appendFileSync(_BOOT_LOG, line); } catch {}
}
bootLog('1', 'electron loaded, argv=' + JSON.stringify(process.argv.slice(0, 4)));

let mainWindow;
let isDev = process.argv.includes('--dev');
let penetrationOn = false;

// ===== 系统托盘（小托盘）：常驻通知区域，方便寻找与管理 =====
const TRAY_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42u3XwRGAIBAEwYmDIMw/BLPCBESgrIXV2se9p1/cQSlH3TkE8EkAZ70dKaAVfYtBEZ9BoIqPIlDGRxCo4z0EK+JPiABYFW8hAgjAD5B3wAKwfRlZrGOLg8TiJLM4Si3O8vyMfgu4ADVN9SpvZxXkAAAAAElFTkSuQmCC';
let tray = null;
function createTray() {
  try {
    const img = nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_ICON_BASE64);
    tray = new Tray(img);
    tray.setToolTip('WB Monitor — AI API 用量实时监控');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示窗口', click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ]));
    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    });
    bootLog('6', 'tray created');
  } catch (e) {
    _crashLog('createTray', e);
    bootLog('6-FAIL', (e && e.message) || String(e));
  }
}

// ===== 配置 =====
// config.json 在三种形态下位置不同，按优先级依次探测：
//   1) 用户数据目录  %APPDATA%\WB Monitor\config.json —— 允许用户改配置且不被升级覆盖
//   2) resources 目录（extraResources 投放）—— 打包后的默认配置
//   3) __dirname —— 开发模式
function _configCandidates() {
  const out = [];
  try { if (app.isPackaged) out.push(path.join(app.getPath('userData'), 'config.json')); } catch {}
  try { if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'config.json')); } catch {}
  out.push(path.join(__dirname, 'config.json'));
  return out;
}
let CONFIG = {
  refresh: { tokenMs: 1500 }, // 1.5s：贴近"实时"。本地 JSONL 读带 mtime 缓存，几乎零成本
  window: { panelSize: { w: 340, h: 600 }, ballSize: 56 }
};

function loadConfig() {
  for (const p of _configCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (raw.window) CONFIG.window = { ...CONFIG.window, ...raw.window };
      if (raw.refresh) CONFIG.refresh = { ...CONFIG.refresh, ...raw.refresh };
      bootLog('3b', 'config from ' + p);
      return;
    } catch {}
  }
  bootLog('3b', 'config not found, using defaults');
}

// ===== Token 数据（异步）=====
const tokenSource = require('./modules/tokenSource');
// ===== 成本数据（来自 workbuddy.db，与 cc switch 同源）=====
const costSource = require('./modules/costSource');
// ===== CC (Claude Code fork) 数据源：扫描 ~/.claude/projects，逐消息聚合模型+token+费用 =====
const ccSource = require('./modules/cc-source');
const harnessSource = require('./modules/harness-source');
bootLog('2', 'modules loaded: tokenSource=ok costSource=ok ccSource=ok');

// ===== 进程级异常兜底：任何未捕获异常/拒绝都写日志，避免直接闪退 =====
const _CRASH_LOG = path.join(__dirname, 'crash.log');
function _crashLog(tag, e) {
  try {
    const line = new Date().toISOString() + ' [' + tag + '] ' + (e && e.stack ? e.stack : (e && e.message ? e.message : e)) + '\n';
    require('fs').appendFileSync(_CRASH_LOG, line);
  } catch {}
}
process.on('uncaughtException', (e) => { _crashLog('uncaughtException', e); });
process.on('unhandledRejection', (e) => { _crashLog('unhandledRejection', e); });

// ===== 网速（跨平台真实字节计数）=====
// Windows netstat -e 在中文系统输出"字节"而非"Bytes"，需兼容多语言。
// 格式示例（英文）: "                    Bytes                     1234567890    987654321"
// 格式示例（中文）: "                    字节                     1234567890    987654321"
// 策略：先按已知关键词匹配，失败则回退到"含两个大数字的行"启发式匹配。
function getNetworkBytes() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-e'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(null);
        const lines = stdout.split('\n');

        // 策略1：按关键词匹配（中英文 + 常见变体）
        const KEYWORDS = ['Bytes', 'bytes', '字节', 'octets'];
        for (const line of lines) {
          for (const kw of KEYWORDS) {
            if (line.includes(kw)) {
              const nums = line.match(/[\d,]+/g);
              if (nums && nums.length >= 2) {
                return resolve({
                  rx: parseInt(nums[0].replace(/,/g, ''), 10) || 0,
                  tx: parseInt(nums[1].replace(/,/g, ''), 10) || 0
                });
              }
            }
          }
        }

        // 策略2：启发式 —— 找第一个包含 ≥2 个大数字（>10000）的行
        for (const line of lines) {
          const nums = line.match(/\d{5,}/g); // 至少 5 位数字
          if (nums && nums.length >= 2) {
            return resolve({
              rx: parseInt(nums[0], 10) || 0,
              tx: parseInt(nums[1], 10) || 0
            });
          }
        }

        resolve(null);
      });
    } else if (process.platform === 'linux') {
      try {
        const ifaces = os.networkInterfaces();
        let rx = 0, tx = 0, found = false;
        for (const name in ifaces) {
          for (const iface of ifaces[name]) {
            if (!iface.internal && iface.family === 'IPv4' &&
                !name.startsWith('veth') && !name.startsWith('docker') && name !== 'lo') {
              try {
                rx += parseInt(fs.readFileSync(`/sys/class/net/${name}/statistics/rx_bytes`, 'utf8'), 10) || 0;
                tx += parseInt(fs.readFileSync(`/sys/class/net/${name}/statistics/tx_bytes`, 'utf8'), 10) || 0;
                found = true;
              } catch {}
            }
          }
        }
        resolve(found ? { rx, tx } : null);
      } catch { resolve(null); }
    } else {
      resolve(null); // macOS 暂未实现
    }
  });
}

// 简易调试日志（写到 wb-monitor/debug.log，便于排查推送是否真的在跑）
const DEBUG_LOG = path.join(__dirname, 'debug.log');
function debugLog(msg) {
  try {
    const line = new Date().toISOString() + ' ' + msg + '\n';
    if (fs.existsSync(DEBUG_LOG) && fs.statSync(DEBUG_LOG).size > 102400) {
      fs.writeFileSync(DEBUG_LOG, line);
    } else {
      fs.appendFileSync(DEBUG_LOG, line);
    }
  } catch {}
}

// ===== 合并数据：JSONL 本地调用 + workbuddy.db 全模型成本（含 Claude/auto）=====
// 返回 { aggregate, recentCalls(本地+远程合并，已合成本), costTotal, costToday,
//        costByModel, remoteCallCount, latestSessionCost, fetchedAt }
// 数据模型（已实测核查）：
//  - 本地 JSONL：逐调用 token 明细 + 会话级 conversationRequestId；不含成本；
//    且只含「本地路由」模型（hy3/glm/deepseek…），Claude/GPT 等远程模型不落本地 JSONL。
//  - workbuddy.db.session_usage.credit_json：逐调用 ¥成本，key 是「与 JSONL 不同 id 空间」
//    的 per-call id（无法与 JSONL 逐调用 join）；但 JSONL 文件名 == db sessions.id（23/23 命中），
//    故可在「会话级」把会话总 ¥ 摊回该会话的每条本地调用（按 token 比例）。
//  - db 中 model='auto' 的会话即 Claude/GPT 等远程路由（不落本地 JSONL），其 credit_json 条目
//    直接作为「远程调用」补进实时明细；model=hy3 等本地模型的 db 条目已被本地 JSONL 覆盖，不重复补。
// 注意：用单一 in-flight promise 串行化。否则并发 open workbuddy.db（sql.js 共享 wasm 堆）
// 有几率直接崩 native 进程（闪退）。
let _building = null;
// 本次启动基线：首次构建时记录「当时最新一条调用的 ts」，之后只统计 ts 比它新的调用
// = 真正的「本次启动后的消耗」。稳定不变（只在第一次 build 时赋值一次）。
let BASELINE_TS = null;
async function buildFullPayload() {
  if (_building) return _building;
  _building = (async () => {
    const [aggregate, recent, allRecent, cost, cc, ccRecent] = await Promise.all([
      tokenSource.fetchTokenAggregateAsync(),
      tokenSource.fetchRecentCallsAsync(60),
      tokenSource.fetchRecentCallsAsync(999999), // 全量：由「已计费会话」反推单价（文件级缓存，二次几乎零成本）
      costSource.fetchCostAggregateAsync(),
      ccSource.fetchCCAggregateAsync(), // CC fork：~/.claude/projects 聚合
      ccSource.fetchRecentCCCallsAsync(60) // CC fork：最近 60 条逐调用明细（合并进统一 feed）
    ]);
    const sessionCostMap = (cost && cost.sessionCostMap) || {};
    const dbCalls = (cost && cost.dbCalls) || [];

    // 1) 由「已计费会话」推导各模型有效 ¥/token 估算率，用于给实时（含尚未计费的）调用估算成本。
    //    为什么这样做：本地 JSONL 没有逐调用成本；db 的 credit_json 是另一个 id 空间无法逐调用 join，
    //    且当前正在跑的会话往往还没写进 db（延迟计费）。用历史已计费会话的「总成本/总 token」反推
    //    每 token 单价，再乘实时 token 数，得到一个有真实账单背书的「实时估算 ¥」。
    //    注：用全量调用(allRecent)而非最近 60 条——最近 60 条多来自尚未计费的活跃会话，取不到样本会退化成 0。
    const groups = {};
    for (const c of allRecent) {
      const sid = c.fileSessionId || '__unknown__';
      (groups[sid] = groups[sid] || []).push(c);
    }
    const modelRateAcc = {}; // model -> { cost, tok }
    for (const sid in groups) {
      const sessCost = sessionCostMap[sid] || 0;
      if (sessCost <= 0) continue;
      const grp = groups[sid];
      const totTok = grp.reduce((s, c) => s + (c.totalTokens || 0), 0) || 0;
      const m = grp[0].model;
      if (!modelRateAcc[m]) modelRateAcc[m] = { cost: 0, tok: 0 };
      modelRateAcc[m].cost += sessCost; modelRateAcc[m].tok += totTok;
    }
    const modelRate = {}; // model -> ¥/token
    for (const m in modelRateAcc) modelRate[m] = modelRateAcc[m].tok > 0 ? modelRateAcc[m].cost / modelRateAcc[m].tok : 0;

    // 1.5) 本地调用：cost = totalTokens × 模型有效单价（实时估算，有历史账单背书）
    const sessionEstMap = {}; // 会话 -> 估算总成本（头条「本会话 ¥」）
    const localMerged = [];
    for (const c of recent) {
      const rate = modelRate[c.model] || 0;
      const est = (c.totalTokens || 0) * rate;
      const sid = c.fileSessionId || '__unknown__';
      sessionEstMap[sid] = (sessionEstMap[sid] || 0) + est;
      localMerged.push({
        ts: c.ts,
        time: new Date(c.ts).toLocaleTimeString('zh-CN', { hour12: false }),
        model: c.model,
        route: c.requestModelName || '—',
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        totalTokens: c.totalTokens,
        cachedTokens: c.cachedTokens,
        reasoningTokens: c.reasoningTokens,
        status: c.status,
        statusCode: c.status === 'completed' ? 200 : 0,
        durationMs: c.durationMs,
        durationStr: c.durationMs == null ? '—' : (c.durationMs < 1000 ? c.durationMs + 'ms' : (c.durationMs / 1000).toFixed(1) + 's'),
        conversationRequestId: c.conversationRequestId,
        fileSessionId: c.fileSessionId,
        cost: est,
        costEstimated: rate > 0, // 本地成本均为估算（≈）；远程 auto 为 db 真实账单
        fromRemote: false
      });
    }
    localMerged.sort((a, b) => b.ts - a.ts);

    // 2) 远程调用（Claude/GPT，记在 auto 下）：只取 db 中 model='auto' 的逐调用条目。
    //    这些在本地 JSONL 中完全不存在，是用户最想看到的「其他模型实时调用」，成本为 db 真实账单。
    let remoteCount = 0;
    const remoteMerged = dbCalls
      .filter(c => (c.model || '').toLowerCase() === 'auto' && c.conversationRequestId)
      .map(c => {
        remoteCount++;
        return {
          ts: c.updatedAt || 0,
          time: c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--',
          model: 'auto',
          route: 'Claude/GPT 等',
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          cachedTokens: 0,
          reasoningTokens: 0,
          status: 'billed',
          statusCode: 200,
          durationMs: null,
          durationStr: '—',
          conversationRequestId: c.conversationRequestId,
          cost: c.cost || 0,
          costEstimated: false,
          fromRemote: true
        };
      });

    // 3) 合并三路数据源为统一时间线：本地(tokenSource) + 远程(costSource auto) + CC Switch(ccSource)
    //    按时间倒序，截断 80 条（给 CC 调用留足够展示空间）
    const merged = localMerged.slice(0, 50).concat(remoteMerged).concat(ccRecent || [])
      .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 80);

    // 4) 本次启动后的消耗：基线 = 首次构建时最新一条调用的 ts，只统计比它新的调用
    if (BASELINE_TS === null) BASELINE_TS = (merged[0] && merged[0].ts) || Date.now();
    const sinceCalls = merged.filter(c => (c.ts || 0) > BASELINE_TS);
    const sinceCost = sinceCalls.reduce((s, c) => s + (c.cost || 0), 0);
    const sinceTokens = sinceCalls.reduce((s, c) => s + (c.totalTokens || 0), 0);
    const sinceRemote = sinceCalls.filter(c => c.fromRemote).length;
    const sinceByModelMap = {};
    for (const c of sinceCalls) {
      const m = c.model || 'unknown';
      if (!sinceByModelMap[m]) sinceByModelMap[m] = { model: m, cost: 0 };
      sinceByModelMap[m].cost += (c.cost || 0);
    }
    const sinceByModel = Object.values(sinceByModelMap).sort((a, b) => b.cost - a.cost);

    // 最新一条调用所属会话的估算 ¥（用于头条「本会话 ¥X」）；远程条目无会话归属，记 0
    const latestSessionCost = (merged[0] && !merged[0].fromRemote)
      ? (sessionEstMap[merged[0].fileSessionId] || 0)
      : 0;

    if (aggregate && aggregate.latest) {
      aggregate.latest.cost = latestSessionCost;
    }
    return {
      aggregate,
      recentCalls: merged,
      remoteCallCount: remoteCount,
      latestSessionCost,
      costTotal: cost ? cost.totalCost : 0,
      costToday: cost ? cost.todayCost : 0,
      costByModel: cost ? cost.byModel : [],
      cc, // CC (Claude Code fork) 模型/token/费用聚合
      harnessToken: { byModel: harnessSource.mergeTokenByModel([
        { harness: 'workbuddy', models: (aggregate && aggregate.byModel) || [] },
        { harness: 'claude', models: (cc && cc.byModel) || [] }
      ]) },
      since: {
        calls: sinceCalls.length,
        tokens: sinceTokens,
        cost: sinceCost,
        remoteCallCount: sinceRemote,
        recentCalls: sinceCalls,
        byModel: sinceByModel
      },
      fetchedAt: Date.now()
    };
  })();
  try { return await _building; }
  finally { _building = null; }
}

// 安全发送（注意：不再加 isLoading() 判断，否则 Windows 下 loadFile 后该状态若未翻转，
// 所有推送会被永久吞掉，表现为“有初始数据但永远不刷新”）
function safeSend(ch, data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send(ch, data);
  } catch {}
}

// ===== 模型调用实时速率（类比网速仪表）=====
// 网速 = 字节增量/时间差，且持续流动；模型 token 是"脉冲式"消耗（一次调用一大块）。
// 若只用两次轮询的 delta，大部分时刻会是 0。改用 60s 滚动窗口：统计最近 60s 内
// 所有调用的 token 总和与次数，折算成 tok/s 与 次/min —— 像网速那样"持续有数、有活动时跳动"。
// 目前活跃调用（最新一条 < 8s）额外点亮"调用中"状态。
function computeModelRate(aggregate, recentCalls) {
  const now = Date.now();
  const rate = { inputPerSec: 0, outputPerSec: 0, callsPerMin: 0, activeSince: 0, live: false };
  if (aggregate) {
    const win = 60000; // 60s 滚动窗口
    const recent = (recentCalls || []).filter(c => now - (c.ts || 0) <= win);
    let inSum = 0, outSum = 0;
    let earliest = now;
    for (const c of recent) { inSum += c.inputTokens || 0; outSum += c.outputTokens || 0; if (c.ts && c.ts < earliest) earliest = c.ts; }
    const spanMs = Math.max(1000, now - earliest);
    const minutes = spanMs / 60000;
    rate.inputPerSec = inSum / minutes / 60;   // tok/s（窗口内平均）
    rate.outputPerSec = outSum / minutes / 60;
    rate.callsPerMin = recent.length / minutes;
    const latest = aggregate.latest;
    if (latest && (now - (latest.ts || 0)) < 8000) rate.activeSince = now - latest.ts;
    rate.live = true;
  }
  return rate;
}

function formatSpeed(kbps) {
  if (!kbps || kbps < 1) return '0 B/s';
  if (kbps < 1024) return Math.round(kbps) + ' KB/s';
  return (kbps / 1024).toFixed(1) + ' MB/s';
}

// ===== 网速轮询（setTimeout 循环，异步不阻塞）=====
let _netTimer = null;
let prevNetBytes = null;
function startNetPolling() {
  if (_netTimer) return;
  async function tick() {
    try {
      const now = await getNetworkBytes();
      if (now) {
        if (prevNetBytes) {
          const dt = 2000;
          const download = ((now.rx - prevNetBytes.rx) / dt) * 1000; // bytes/s
          const upload = ((now.tx - prevNetBytes.tx) / dt) * 1000;
          safeSend('network-update', {
            upload: Math.max(0, upload / 1024),     // KB/s
            download: Math.max(0, download / 1024),   // KB/s
            uploadStr: formatSpeed(Math.max(0, upload / 1024)),
            downloadStr: formatSpeed(Math.max(0, download / 1024))
          });
        } else {
          // 首个采样点：先推一次占位，避免 UI 一直显示 --
          safeSend('network-update', { upload: 0, download: 0, uploadStr: '测量中…', downloadStr: '测量中…' });
        }
        prevNetBytes = now;
      }
    } catch (e) { /* 忽略 */ }
    _netTimer = setTimeout(tick, 2000);
  }
  _netTimer = setTimeout(tick, 2000);
}

// Token+成本+调用明细：每 5s 合并推送（首次 1s 后立即推送）
let _tokenTimer = null;
let _tokenPollingMs = 5000;
async function startTokenPolling() {
  if (_tokenTimer) return;
  _tokenPollingMs = (CONFIG.refresh && CONFIG.refresh.tokenMs) || 5000;
  async function tick() {
    try {
      const data = await buildFullPayload();
      if (data && data.aggregate) {
        const a = data.aggregate;
        data.modelRate = computeModelRate(a, data.recentCalls); // 实时速率（类比网速，60s 滚动窗口）
        debugLog('[feed] calls=' + a.total.calls + ' models=' + a.byModel.length + ' recent=' + data.recentCalls.length + ' ¥' + data.costTotal.toFixed(2) + ' rate=' + data.modelRate.inputPerSec.toFixed(0) + 'tok/s');
        safeSend('token-update', data);
      } else {
        debugLog('[feed] 空数据（未扫到任何会话文件）');
      }
    } catch (e) { debugLog('[feed] 异常: ' + (e && e.message)); }
    _tokenTimer = setTimeout(tick, _tokenPollingMs);
  }
  _tokenTimer = setTimeout(tick, 1000);
}

// ===== 窗口创建 =====
function createWindow() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  const ps = CONFIG.window.panelSize;

  mainWindow = new BrowserWindow({
    width: ps.w || 320,
    height: ps.h || 540,
    x: sw - (ps.w || 320) - 16,
    y: 60,
    transparent: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,    // 不在任务栏显示，改用系统托盘(小托盘)常驻管理
    resizable: true,       // 允许程序化 resize（收起/展开切换尺寸）
    hasShadow: true,
    backgroundColor: '#1a1a2e',
    minWidth: 56,
    minHeight: 56,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // 诊断：渲染进程加载生命周期
  mainWindow.webContents.on('did-finish-load', () => {
    bootLog('4b', 'renderer: index.html did-finish-load fired');
  });
  mainWindow.webContents.on('did-frame-finish-load', (_ev, _isMainFrame, _frameProcessId, _frameRoutingId) => {
    bootLog('4c', 'renderer: did-frame-finish-load (isMainFrame=true expected)');
  });
  mainWindow.webContents.on('console-message', (_ev, level, msg) => {
    if (msg.includes('[WB-Monitor') || level < 2)
      bootLog('CON', 'renderer console[' + level + ']: ' + (msg || '').slice(0, 300));
  });

  mainWindow.show();
  mainWindow.focus();
  createTray();

  // 右键菜单
  const ctxMenu = Menu.buildFromTemplate([
    { label: '收起为悬浮球', click: () => safeSend('collapse-to-ball', {}) },
    { label: '展开面板', click: () => safeSend('expand-panel', {}) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  mainWindow.webContents.on('context-menu', () => ctxMenu.popup());

  // 启动数据推送（不阻塞窗口显示）
  setImmediate(() => {
    startNetPolling();
    startTokenPolling();
  });
}

// ===== IPC 处理 =====
ipcMain.handle('get-config', async () => CONFIG);
ipcMain.handle('get-token-data', async () => {
  try { return await buildFullPayload(); }
  catch (e) { _crashLog('get-token-data', e); return { aggregate: null, recentCalls: [], costTotal: 0, costToday: 0, costByModel: [], error: String(e && e.message || e) }; }
});

// 本机 harness 发现（含 token 可用性标注）
ipcMain.handle('get-harnesses', async () => {
  try { return await harnessSource.detectHarnesses(); }
  catch (e) { _crashLog('get-harnesses', e); return []; }
});
ipcMain.handle('quit-app', async () => { app.quit(); return true; });
ipcMain.handle('set-window-size', async (e, w, h) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [curX, curY] = mainWindow.getPosition();
    mainWindow.setBounds({ x: curX, y: curY, width: w, height: h });
    return true;
  }
  return false;
});
ipcMain.handle('set-window-pos', async (e, x, y) => {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setPosition(x, y); return true; }
  return false;
});
ipcMain.handle('toggle-topmost', async (e, on) => {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.setAlwaysOnTop(!!on); return true; }
  return false;
});
ipcMain.handle('toggle-penetration', async (e, on) => {
  penetrationOn = !!on;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(penetrationOn);
    safeSend('penetration-changed', penetrationOn);
  }
  return true;
});

// ===== 快捷键 =====
function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+B', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    penetrationOn = !penetrationOn;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setIgnoreMouseEvents(penetrationOn);
      safeSend('penetration-changed', penetrationOn);
    }
  });
}

// ===== 单实例锁 =====
bootLog('2b', 'requesting single-instance lock');
if (!app.requestSingleInstanceLock()) {
  bootLog('0-LOCKED', 'another WB Monitor instance is already running; this duplicate exits');
  // 不强行 quit 已有实例，只让本副本静默退出（避免用户误以为没启动）
  process.exit(0);
}

app.whenReady().then(() => {
  bootLog('3', 'app whenReady fired');
  loadConfig();
  bootLog('3a', 'config loaded: ' + JSON.stringify(CONFIG));
  try {
    createWindow();
    bootLog('4', 'window created');
    registerShortcuts();
    bootLog('5', 'shortcuts registered');
  } catch (e) {
    bootLog('4-FAIL', (e && e.stack) || String(e));
    _crashLog('window-create', e);
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (tray) { try { tray.destroy(); } catch {} } });
