/**
 * cc-source.js — Claude Code (cc switch / fork) 数据源 v1
 *
 * 数据来源：~/.claude/projects/<编码工程路径>/<session>.jsonl
 *   cc fork 每次切换模型后的每条 assistant 消息都带：
 *     - message.model         （如 deepseek-v4-pro / claude-sonnet-4-6 / gemini-3.1-pro-preview ...）
 *     - message.usage         { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 *     - timestamp             ISO 字符串
 *   这是「用了哪些模型 + 多少 token」的逐消息真源（WorkBuddy 本地 JSONL 不含 cc 远程调用）。
 *
 * 费用：用核实过的 2026 官方/聚合单价（USD/1M tokens）按 token 换算。
 *   fork 内部别名（sonnet / claude-opus-5 / qwen3.7-max / kimi-k3）按最近同系单价计，priceVerified=false 显式标注。
 *   交叉校验：与 ~/.claude.json 各工程 lastModelUsage[model].costUSD 之和比对，给出偏差百分比。
 *
 * 稳定性：沿用 tokenSource 的「文件 mtime 缓存 + 循环 push」范式，避免大文件 spread 栈溢出。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// ===== 单价表（USD / 1M tokens），已联网核实 2026-08-12 =====
// 字段：in=输入单价, out=输出单价, cw=cache_write 单价(可空→按 in), cr=cache_read 单价(可空→按 in)
// v=是否官方核实；note=别名/估算说明（不编造未核实数字，只标"沿用 X 单价"）
const PRICE_TABLE = {
  'claude-haiku-4-5': { in: 1.00, out: 5.00, cw: 1.25, cr: 0.10, v: true },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cw: 3.75, cr: 0.30, v: true },
  'claude-opus-4-8': { in: 5.00, out: 25.00, cw: 6.25, cr: 0.50, v: true },
  'claude-opus-5': { in: 5.00, out: 25.00, cw: 6.25, cr: 0.50, v: false, note: '沿用 Opus 4.8 单价，Opus 5 官方价未核实' },
  'claude-fable-5': { in: 10.00, out: 50.00, cw: 12.50, cr: 1.00, v: true },
  // "sonnet" 是 cc fork 里的简短别名，按 Sonnet 4.6 计
  'sonnet': { in: 3.00, out: 15.00, cw: 3.75, cr: 0.30, v: false, note: 'sonnet 别名，按 Sonnet 4.6 计' },
  'gemini-3.1-pro-preview': { in: 2.00, out: 12.00, cw: 2.00, cr: 0.20, v: true, note: '≤200K 单价；>200K 翻倍' },
  'grok-4.5': { in: 2.00, out: 6.00, cw: 2.00, cr: 0.30, v: true },
  'deepseek-v4-pro': { in: 0.435, out: 0.87, cw: 0.435, cr: 0.003625, v: true },
  // qwen3.7-max / kimi-k3 为较新名，沿用最近同系国际单价，标未核实
  'qwen3.7-max': { in: 0.78, out: 3.90, cw: 0.78, cr: 0.78, v: false, note: '沿用 qwen3-max 国际单价，qwen3.7-max 官方价未核实' },
  'kimi-k3': { in: 0.57, out: 2.30, cw: 0.57, cr: 0.57, v: false, note: '沿用 Kimi K2 单价，kimi-k3 官方价未核实' }
};

// 模型名归一化：用于价目表查找（保留原始名做展示）
function normalizeModel(m) {
  if (!m) return m;
  const s = String(m).toLowerCase().trim();
  if (s === 'sonnet') return 'sonnet';
  if (s.startsWith('claude-opus-5')) return 'claude-opus-5';
  if (s.startsWith('claude-opus-4-8')) return 'claude-opus-4-8';
  if (s.startsWith('claude-opus-4')) return 'claude-opus-4-8'; // 4.x 同档
  if (s.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
  if (s.startsWith('claude-sonnet')) return 'claude-sonnet-4-6'; // 其他 sonnet 按 4.6
  if (s.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5';
  if (s.startsWith('claude-fable-5')) return 'claude-fable-5';
  if (s.startsWith('gemini-3.1-pro')) return 'gemini-3.1-pro-preview';
  if (s.startsWith('grok-4.5')) return 'grok-4.5';
  if (s.startsWith('deepseek-v4-pro')) return 'deepseek-v4-pro';
  if (s.startsWith('deepseek')) return 'deepseek-v4-pro'; // 兜底
  if (s.startsWith('qwen3.7-max')) return 'qwen3.7-max';
  if (s.startsWith('qwen')) return 'qwen3.7-max'; // 其他 qwen 按 3.7-max 计
  if (s.startsWith('kimi-k3')) return 'kimi-k3';
  if (s.startsWith('kimi')) return 'kimi-k3';
  return s;
}

function priceFor(model) {
  const key = normalizeModel(model);
  return PRICE_TABLE[key] || null;
}

// 单条调用 cost（USD）：input/cacheCreation/cacheRead/output 分别按单价
function costOfCall(p, input, output, cacheCreation, cacheRead) {
  if (!p) return null;
  const in1 = p.in, out1 = p.out;
  const cw = (typeof p.cw === 'number') ? p.cw : in1;
  const cr = (typeof p.cr === 'number') ? p.cr : in1;
  const nonCache = Math.max(0, input - (cacheRead || 0) - (cacheCreation || 0));
  const cost =
    nonCache * in1 +
    (cacheCreation || 0) * cw +
    (cacheRead || 0) * cr +
    output * out1;
  return cost / 1e6;
}

// ===== 文件扫描（与 tokenSource 同范式）=====
let _fileCache = {}; // filePath -> { mtimeMs, calls:[...] }
let _claudeJsonMtime = 0;
let _claudeJsonCostUSD = null; // 缓存的 CC 自报总费用

function getProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// 递归目录清单缓存：原实现每次调用都用 fs.statSync 同步递归整棵 ~/.claude/projects
// （含多层 agent 子目录），每轮都阻塞主进程。改为异步 fsp.stat + 12s TTL 缓存，
// 返回 [{ path, mtimeMs }]，mtime 直接喂 readSessionFile，省去逐文件再 stat。
let _listCache = { ts: 0, files: null };
const LIST_TTL = 12000;
async function listAllSessionFiles() {
  const DIR = getProjectsDir();
  const now = Date.now();
  if (_listCache.files && (now - _listCache.ts) < LIST_TTL) return _listCache.files;
  try { await fsp.access(DIR); } catch { _listCache = { ts: now, files: [] }; return []; }
  // 递归遍历：cc fork 把 session 嵌套在多层子目录（工程/session/agent 等）
  const result = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      try {
        if (e.isDirectory()) await walk(fp);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          const st = await fsp.stat(fp);
          result.push({ path: fp, mtimeMs: st.mtimeMs });
        }
      } catch {}
    }
  }
  await walk(DIR);
  _listCache = { ts: now, files: result };
  return result;
}

// 解析单个文件为调用列表（带 mtime 缓存）
async function readSessionFile(filePath, knownMtime) {
  try {
    const mtimeMs = (knownMtime != null) ? knownMtime : (await fsp.stat(filePath)).mtimeMs;
    const cached = _fileCache[filePath];
    if (cached && cached.mtimeMs === mtimeMs) return cached.calls;

    const content = await fsp.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const calls = [];
    for (const line of lines) {
      try {
        const d = JSON.parse(line.trim());
        if (d.type !== 'assistant') continue;
        const msg = d.message;
        if (!msg || !msg.model || msg.model === '<synthetic>') continue;
        const u = msg.usage;
        if (!u) continue;
        const input = u.input_tokens || 0;
        const output = u.output_tokens || 0;
        // cache 字段可能缺失
        const cacheCreation = u.cache_creation_input_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0;
        // 跳过占位/纯缓存写入消息：真实一次生成必有 input>0 或 output>0，
        // 否则是 CC Switch 重写的空 usage 桩（如 deepseek-v4-pro|0|0 出现数千次），会严重虚增计数。
        if (input === 0 && output === 0) continue;
        const total = input + output + cacheCreation + cacheRead;
        if (total <= 0) continue; // 跳过无 token 的占位消息
        const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
        calls.push({
          ts,
          model: msg.model,
          messageId: d.id || msg.id || null, // 顶层 id 或 message.id，用于跨文件/同文件去重
          inputTokens: input,
          outputTokens: output,
          cacheCreation,
          cacheRead,
          totalTokens: total
        });
      } catch {}
    }
    _fileCache[filePath] = { mtimeMs, calls };
    return calls;
  } catch { return []; }
}

// 读取 ~/.claude.json 自报总费用（各工程 lastModelUsage[model].costUSD 之和）
function readClaudeJsonReportedUSD() {
  try {
    const p = path.join(os.homedir(), '.claude.json');
    const st = fs.statSync(p);
    if (_claudeJsonCostUSD !== null && _claudeJsonMtime === st.mtimeMs) return _claudeJsonCostUSD;
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    let sum = 0;
    const projects = d.projects || {};
    for (const k in projects) {
      const lmu = projects[k] && projects[k].lastModelUsage;
      if (!lmu) continue;
      for (const m in lmu) {
        const c = lmu[m] && lmu[m].costUSD;
        if (typeof c === 'number') sum += c;
      }
    }
    _claudeJsonMtime = st.mtimeMs;
    _claudeJsonCostUSD = sum;
    return sum;
  } catch { return null; }
}

// 去重键：优先用 messageId（同一调用在多处/多次重写时 id 不变）；
// 无 id 时退化为「秒级时间戳 + 模型 + token 签名」，合并同一次生成的微秒级重复写入。
function callKey(c) {
  if (c.messageId) return 'mid:' + c.messageId + '|' + c.model + '|' + c.inputTokens + '|' + c.outputTokens;
  return 't:' + Math.floor((c.ts || 0) / 1000) + '|' + c.model + '|' + c.inputTokens + '|' + c.outputTokens + '|' + c.cacheCreation + '|' + c.cacheRead;
}

// 对采集到的调用列表去重（去除 CC Switch 同文件 38 遍重写 / 跨文件副本）
function dedupeCalls(list) {
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const k = callKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

async function fetchCCAggregateAsync() {
  const files = await listAllSessionFiles();
  const all = [];
  for (const f of files) {
    const c = await readSessionFile(f.path, f.mtimeMs);
    for (const item of c) all.push(item);
  }
  const paths = files.map(f => f.path);
  for (const fp of Object.keys(_fileCache)) {
    if (!paths.includes(fp)) delete _fileCache[fp];
  }
  const entries = dedupeCalls(all); // 去重后再聚合，避免占位桩与重写副本虚增计数
  if (!entries.length) {
    return {
      byModel: [], total: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, costEstimated: false },
      today: { calls: 0, totalTokens: 0, cost: 0 },
      sessions: 0, projects: 0,
      billing: { ccReportedUSD: readClaudeJsonReportedUSD(), ourPricedUSD: 0, deltaPct: null, matched: null, note: '无 cc 调用记录' }
    };
  }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const byModel = {};
  let tIn = 0, tOut = 0, tTot = 0, tCost = 0, tCostEstimated = false;
  let tdCalls = 0, tdTok = 0, tdCost = 0;
  let unpricedModels = 0;

  for (const e of entries) {
    tIn += e.inputTokens; tOut += e.outputTokens; tTot += e.totalTokens;
    const p = priceFor(e.model);
    const cost = costOfCall(p, e.inputTokens, e.outputTokens, e.cacheCreation, e.cacheRead);
    if (cost === null) { unpricedModels++; tCostEstimated = tCostEstimated; }
    else { tCost += cost; if (!p.v) tCostEstimated = true; }

    const key = e.model; // 展示用原始名
    if (!byModel[key]) byModel[key] = { model: key, inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, totalTokens: 0, calls: 0, cost: 0, costEstimated: false, priceVerified: false, note: '' };
    const m = byModel[key];
    m.inputTokens += e.inputTokens; m.outputTokens += e.outputTokens;
    m.cacheCreation += e.cacheCreation; m.cacheRead += e.cacheRead;
    m.totalTokens += e.totalTokens; m.calls += 1;
    if (cost !== null) { m.cost += cost; m.costEstimated = m.costEstimated || !p.v; m.priceVerified = !!p.v; m.note = p.note || ''; }

    if (e.ts >= todayMs) { tdCalls++; tdTok += e.totalTokens; if (cost !== null) tdCost += cost; }
  }

  const byModelArr = Object.values(byModel).sort((a, b) => b.totalTokens - a.totalTokens);

  // 账单参考：~/.claude.json 的 lastModelUsage[model].costUSD 是「各工程最近一次会话」的用量，
  // 并非终身累计，故不能作为终身账单校验基准。仅作参考展示，明确标注非累计。
  const ccLastSessionUSD = readClaudeJsonReportedUSD();
  const note = 'CC 不暴露终身账单文件；本表费用为按核实单价估算。'
    + (unpricedModels > 0 ? ' 其中 ' + unpricedModels + ' 个模型标 ✗（沿用同系单价，未官方核实）。' : '')
    + (ccLastSessionUSD !== null ? ' CC 最近一次会话自报 $' + ccLastSessionUSD.toFixed(2) + '（非累计，仅供参考）。' : '');

  return {
    byModel: byModelArr,
    total: { calls: entries.length, inputTokens: tIn, outputTokens: tOut, totalTokens: tTot, cost: tCost, costEstimated: tCostEstimated },
    today: { calls: tdCalls, totalTokens: tdTok, cost: tdCost },
    sessions: files.length,
    projects: new Set(files.map(f => path.basename(path.dirname(f.path)))).size,
    billing: { ccLastSessionUSD, ourPricedUSD: tCost, unpricedModels, note }
  };
}

// ===== 逐调用明细（用于合并进统一时间线 feed）=====
// 返回最近 limit 条 CC 调用，按时间倒序，每条带完整字段（与 tokenSource 的 recentCalls 格式对齐）
async function fetchRecentCCCallsAsync(limit) {
  if (!limit || limit < 1) limit = 60;
  const files = await listAllSessionFiles();
  const all = [];
  for (const f of files) {
    const calls = await readSessionFile(f.path, f.mtimeMs);
    for (const c of calls) {
      const p = priceFor(c.model);
      const cost = costOfCall(p, c.inputTokens, c.outputTokens, c.cacheCreation, c.cacheRead);
      all.push({
        ts: c.ts,
        time: c.ts ? new Date(c.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--',
        model: c.model,
        route: 'CC Switch',
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cachedTokens: (c.cacheCreation || 0) + (c.cacheRead || 0),
        totalTokens: c.totalTokens,
        reasoningTokens: 0,
        status: 'completed',
        statusCode: 200,
        durationMs: null,
        durationStr: '—',
        cost: cost || 0,
        costEstimated: !p || !p.v,
        fromRemote: false,
        fromCC: true,          // 标记来源：CC Switch
        fileSessionId: null,
        conversationRequestId: null
      });
    }
  }
  // 去重（同文件 38 遍重写 / 跨文件副本）→ 合并成真实调用
  const deduped = dedupeCalls(all);
  // 按时间倒序，截取最近 N 条
  deduped.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return deduped.slice(0, limit);
}

module.exports = { fetchCCAggregateAsync, fetchRecentCCCallsAsync, getProjectsDir, PRICE_TABLE, priceFor };
