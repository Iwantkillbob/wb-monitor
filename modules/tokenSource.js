/**
 * tokenSource.js — WorkBuddy 会话 JSONL 数据源（v4 · 每调用明细版）
 *
 * 数据来源：~/.workbuddy/projects/<project>/<session>.jsonl
 *   每条 role==='assistant' 且含 providerData.rawUsage 的消息 = 一次模型调用
 *
 * 本版新增：
 *  - fetchRecentCallsAsync(limit)：返回"最近 limit 条调用明细"，每条含
 *      ts / model / requestModelName / status / conversationRequestId
 *      输入/输出/总/缓存/推理 token / durationMs(本调用与同会话前一条消息的时间差)
 *    → 用于悬浮球的"实时调用明细"列表（cc switch 风格）
 *  - fetchTokenAggregateAsync：仍返回聚合统计（总/今日/按模型/最新），
 *    每条 entry 也带 durationMs/conversationRequestId 供主进程合并成本
 *
 * 成本本地就有：workbuddy.db 的 session_usage.credit_json[key] 的 key
 *   正是 JSONL 的 providerData.conversationRequestId（去横线后的 hex）。
 *   合并工作由 main.js 负责（见 costSource.getCostMap）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

let _fileCache = {}; // filePath -> { mtimeMs, messages:[{ts,role,id}], calls:[...] }
// 注：readSessionFile 自带 mtime 缓存，文件级已去重；fetch* 之间不再加互斥锁，
//     否则 Promise.all 并发时第二个会拿到空缓存导致 aggregate 为 null。

function getProjectsDir() {
  return path.join(os.homedir(), '.workbuddy', 'projects');
}

async function listAllSessionFiles() {
  const PROJECTS_DIR = getProjectsDir();
  try { await fsp.access(PROJECTS_DIR); } catch { return []; }
  const result = [];
  let projects = [];
  try {
    projects = (await fsp.readdir(PROJECTS_DIR)).filter(d => {
      try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
  for (const proj of projects) {
    const dir = path.join(PROJECTS_DIR, proj);
    let files = [];
    try { files = await fsp.readdir(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) result.push(path.join(dir, f));
    }
  }
  return result;
}

// 解析单个文件：产出 messages(全量轻量索引) + calls(assistant+rawUsage 每次调用)
// 带 mtime 缓存；durationMs = 本次调用 ts − 同会话前一条消息 ts
async function readSessionFile(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    const cached = _fileCache[filePath];
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.calls;

    const content = await fsp.readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const messages = []; // {ts, role, id}
    const calls = [];    // assistant entries with duration
    // 关键：JSONL 文件名（去 .jsonl）= db sessions.id（已实测 23/23 命中）。
    // 借此可在「会话级」把 workbuddy.db 的 ¥成本 归并到本会话的本地调用上
    // （逐调用 id 在两个数据源是不同 id 空间，无法直接 join，只能用会话级）。
    const fileSessionId = path.basename(filePath, '.jsonl');

    for (const line of lines) {
      try {
        const data = JSON.parse(line.trim());
        const ts = data.timestamp || 0;
        if (data.id) messages.push({ ts, role: data.role || '', id: data.id });

        // 抓"一次调用的 rawUsage"。WorkBuddy 在 tool/function-call 流程里
        // 把 rawUsage 放在 type==='function_call'（role=undefined）行上，
        // 而 type==='message'+role==='assistant' 那行 rawUsage 可能为 false。
        // 历史：旧条件 `type==='message' && role==='assistant'` 把所有走工具的
        // 调用都漏掉，导致 feed 长时间停留在最后一次纯文本回复。
        // 一次调用在同一 ts 内通常只产生 1 条 rawUsage 行（观测稳定），无需去重。
        const pd = data.providerData;
        if (pd && pd.rawUsage) {
          const ru = pd.rawUsage;
          calls.push({
            ts,
            sessionId: data.sessionId || '',
            fileSessionId,
            messageId: pd.messageId || data.id || '',
            model: pd.model || pd.requestModelName || 'unknown',
            requestModelName: pd.requestModelName || '',
            conversationRequestId: pd.conversationRequestId || '',
            status: data.status || 'completed',
            type: data.type || '',  // 保留类型便于诊断
            inputTokens: ru.prompt_tokens || 0,
            outputTokens: ru.completion_tokens || 0,
            totalTokens: ru.total_tokens || 0,
            cachedTokens: ru.prompt_tokens_details?.cached_tokens || 0,
            reasoningTokens: ru.completion_tokens_details?.reasoning_tokens || 0,
            durationMs: null // 下面补算
          });
        }
      } catch {}
    }

    messages.sort((a, b) => a.ts - b.ts);
    // 为每个 call 计算 durationMs：本调用 ts - 同文件前一条消息 ts
    const tsIndex = messages.map(m => m.ts);
    for (const c of calls) {
      // 二分找最后一个 ts < c.ts 的消息
      let lo = 0, hi = messages.length - 1, pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (messages[mid].ts < c.ts) { pos = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (pos >= 0) c.durationMs = c.ts - messages[pos].ts;
    }

    _fileCache[filePath] = { mtimeMs: stat.mtimeMs, messages, calls };
    return calls;
  } catch { return []; }
}

// 聚合统计（总/今日/按模型/最新），结构与 v3 兼容；calls 内已含 duration/conversationRequestId
async function fetchTokenAggregateAsync() {
  const files = await listAllSessionFiles();
  const all = [];
  for (const f of files) {
    const c = await readSessionFile(f);
    for (const item of c) all.push(item); // 循环 push，避免大文件 spread 栈溢出
  }
  // 清理已删文件的缓存
  for (const fp of Object.keys(_fileCache)) {
    if (!files.includes(fp)) delete _fileCache[fp];
  }
  return buildAggregate(all);
}

// 拉取最近 N 条调用明细（cc switch 风格 feed），按 ts 倒序
async function fetchRecentCallsAsync(limit = 40) {
  const files = await listAllSessionFiles();
  const all = [];
  for (const f of files) {
    const c = await readSessionFile(f);
    for (const item of c) all.push(item);
  }
  for (const fp of Object.keys(_fileCache)) {
    if (!files.includes(fp)) delete _fileCache[fp];
  }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, limit);
}

function collectCachedCalls() {
  const out = [];
  for (const fp of Object.keys(_fileCache)) out.push(..._fileCache[fp].calls);
  return out;
}

// 同步版（测试用）
function fetchRecentCallsSync(limit = 40) {
  const out = collectCachedCalls();
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

function buildAggregate(entries) {
  if (!entries || !entries.length) return null;
  entries.sort((a, b) => a.ts - b.ts);
  const latest = entries[entries.length - 1];

  let tIn = 0, tOut = 0, tCached = 0;
  const byModel = {};
  for (const e of entries) {
    tIn += e.inputTokens; tOut += e.outputTokens;
    tCached += e.cachedTokens || 0;
    if (!byModel[e.model]) byModel[e.model] = { model: e.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 };
    const m = byModel[e.model];
    m.inputTokens += e.inputTokens; m.outputTokens += e.outputTokens;
    m.totalTokens += e.totalTokens; m.cachedTokens += e.cachedTokens || 0; m.calls += 1;
  }

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const todayEntries = entries.filter(e => e.ts >= todayMs);
  let tdIn = 0, tdOut = 0, tdCached = 0, tdCost = 0;
  for (const e of todayEntries) { tdIn += e.inputTokens; tdOut += e.outputTokens; tdCached += e.cachedTokens || 0; tdCost += e.cost || 0; }

  let duration = '--';
  if (entries.length >= 2) {
    const dt = (latest.ts - entries[entries.length - 2].ts) / 1000;
    duration = dt < 60 ? dt.toFixed(1) + 's' : Math.floor(dt / 60) + 'm' + Math.round(dt % 60) + 's';
  }

  return {
    latest: {
      model: latest.model, requestModelName: latest.requestModelName,
      inputTokens: latest.inputTokens, outputTokens: latest.outputTokens,
      totalTokens: latest.totalTokens, cachedTokens: latest.cachedTokens,
      reasoningTokens: latest.reasoningTokens, duration, status: latest.status,
      conversationRequestId: latest.conversationRequestId, ts: latest.ts, cost: latest.cost || 0
    },
    total: { calls: entries.length, inputTokens: tIn, outputTokens: tOut, totalTokens: tIn + tOut, cachedTokens: tCached },
    today: { calls: todayEntries.length, inputTokens: tdIn, outputTokens: tdOut, totalTokens: tdIn + tdOut, cachedTokens: tdCached },
    byModel: Object.values(byModel).sort((a, b) => b.totalTokens - a.totalTokens)
  };
}

module.exports = {
  listAllSessionFiles, readSessionFile,
  fetchTokenAggregateAsync, fetchRecentCallsAsync, fetchRecentCallsSync,
  buildAggregate
};