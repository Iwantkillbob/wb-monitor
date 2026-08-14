/**
 * dshSource — 解析 DeepSeek Harness (DSH) 的会话日志
 *
 * 数据位置：~/.dsh/sessions/<profile>/session-<uuid>/session.jsonl.zstd
 *  - 每个会话是 zstd 压缩的 JSONL（单文件，随对话增长被整体重写）
 *  - 真实模型调用记录在 type=assistant/message 且 data.usage 存在 的记录中
 *  - 关键字段：
 *      data.source.model   -> 真实模型名（如 deepseek-v4-flash，不是路由名）
 *      data.source.provider-> 供应商（如 deepseek-official）
 *      data.usage.inputTokens / outputTokens / cacheReadTokens / reasoningTokens
 *      time                -> 毫秒时间戳
 *
 * 与 WB 的区别：WB 记的是内部路由名(hy3)，DSH 直接记真实模型名。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zstd = require('fzstd');

const os = require('os');
const DSH_HOME = path.join(os.homedir(), '.dsh');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');

// provider -> 简短品牌名（用于面板展示）
const PROVIDER_LABEL = {
  'deepseek-official': 'DeepSeek',
  'amazon-bedrock': 'Bedrock',
  'ollama': 'Ollama',
};
function providerLabel(p) {
  if (!p) return 'DSH';
  return PROVIDER_LABEL[p] || p;
}

// 列表缓存：12s TTL，返回 [{path, mtimeMs, size}]
let _listCache = { at: 0, files: [] };
const LIST_TTL = 12000;

function globSessionsSync() {
  // Node 18.17+/20 支持 fs.globSync；做一层兼容
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.name === 'session.jsonl.zstd') out.push(fp);
    }
  };
  if (fs.existsSync(SESSIONS_DIR)) walk(SESSIONS_DIR);
  return out;
}

async function listAllSessionFiles() {
  const now = Date.now();
  if (_listCache.files.length && (now - _listCache.at) < LIST_TTL) return _listCache.files;
  const paths = globSessionsSync();
  const files = [];
  await Promise.all(paths.map(async (p) => {
    try {
      const st = await fsp.stat(p);
      files.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {}
  }));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  _listCache = { at: now, files };
  return files;
}

// 单文件解析缓存：按 (mtimeMs+size) 判重，未变直接返回缓存
const _fileCache = {};

async function readSessionFile(filePath, knownMtime, knownSize) {
  try {
    const st = (knownMtime != null && knownSize != null)
      ? { mtimeMs: knownMtime, size: knownSize }
      : await fsp.stat(filePath);
    const mtimeMs = st.mtimeMs;
    const size = st.size;
    const cached = _fileCache[filePath];
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.calls;

    const buf = await fsp.readFile(filePath);
    const out = await zstd.decompress(buf);
    const text = Buffer.from(out).toString('utf-8');

    const calls = [];
    let idx = 0;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      idx++;
      let o;
      try { o = JSON.parse(s); } catch { continue; }
      if (o.type !== 'assistant/message') continue;
      const d = o.data;
      if (!d || !d.usage) continue;
      // 真实模型名在 data.message.source（data.source 不存在）
      const src = (d.message && d.message.source) || d.source || {};
      if (!src.model) continue;
      const u = d.usage;
      const inT = Number(u.inputTokens) || 0;
      const outT = Number(u.outputTokens) || 0;
      const cacheT = Number(u.cacheReadTokens) || 0;
      const reasonT = Number(u.reasoningTokens) || 0;
      calls.push({
        idx,
        ts: Number(o.time) || 0,
        time: new Date(Number(o.time) || 0).toLocaleTimeString('zh-CN', { hour12: false }),
        model: src.model || 'unknown',
        provider: src.provider || 'dsh',
        inputTokens: inT,
        outputTokens: outT,
        cachedTokens: cacheT,
        reasoningTokens: reasonT,
        totalTokens: inT + outT,
        turn: d.turn,
        step: d.step,
      });
    }
    _fileCache[filePath] = { mtimeMs, size, calls };
    return calls;
  } catch (e) {
    return [];
  }
}

async function _allCalls() {
  const files = await listAllSessionFiles();
  const lists = await Promise.all(files.map(f => readSessionFile(f.path, f.mtimeMs, f.size)));
  // 合并并去重（不同文件 idx 不冲突，直接 concat；按 ts 倒序由上层处理）
  const merged = [];
  for (const l of lists) for (const c of l) merged.push(c);
  return merged;
}

function _aggregate(calls) {
  let total = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  const byModelMap = {};
  let latest = null;
  for (const c of calls) {
    total.calls++;
    total.inputTokens += c.inputTokens;
    total.outputTokens += c.outputTokens;
    total.cachedTokens += c.cachedTokens;
    total.reasoningTokens += c.reasoningTokens;
    total.totalTokens += c.totalTokens;
    if (!byModelMap[c.model]) {
      byModelMap[c.model] = { model: c.model, provider: c.provider, providers: new Set(), calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    }
    const m = byModelMap[c.model];
    m.calls++; m.inputTokens += c.inputTokens; m.outputTokens += c.outputTokens;
    m.cachedTokens += c.cachedTokens; m.reasoningTokens += c.reasoningTokens; m.totalTokens += c.totalTokens;
    if (c.provider) m.providers.add(c.provider);
    if (!latest || c.ts > latest.ts) latest = { model: c.model, provider: c.provider, totalTokens: c.totalTokens, ts: c.ts };
  }
  const byModel = Object.values(byModelMap).sort((a, b) => b.totalTokens - a.totalTokens);
  // provider 集合转展示串
  for (const m of byModel) {
    const ps = Array.from(m.providers);
    m.providers = ps;
    m.providerLabels = ps.map(providerLabel);
    m.multi = ps.length > 1;
  }
  return { total, byModel, latest, sessions: 0 };
}

async function fetchDshAggregateAsync() {
  const calls = await _allCalls();
  const agg = _aggregate(calls);
  // 统计会话数（不同文件路径）
  const files = await listAllSessionFiles();
  agg.sessions = files.length;
  return agg;
}

async function fetchRecentDshCallsAsync(limit) {
  const calls = await _allCalls();
  const sorted = calls.slice().sort((a, b) => b.ts - a.ts);
  const top = (limit ? sorted.slice(0, limit) : sorted);
  // 转成统一 feed 条目（与 WB/CC 同构，便于直接并入实时明细）
  return top.map(c => ({
    ts: c.ts,
    time: c.time,
    model: c.model,
    route: providerLabel(c.provider),
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    totalTokens: c.totalTokens,
    cachedTokens: c.cachedTokens,
    reasoningTokens: c.reasoningTokens,
    status: 'completed',
    statusCode: 200,
    durationMs: null,
    durationStr: '—',
    cost: 0,
    costEstimated: false,
    fromDsh: true,
  }));
}

module.exports = {
  providerLabel,
  listAllSessionFiles,
  readSessionFile,
  fetchDshAggregateAsync,
  fetchRecentDshCallsAsync,
};
