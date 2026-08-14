/**
 * harness-source.js — 本机 AI harness（代理运行时）自动发现 v1
 *
 * 作用：扫描本机已安装 / 有数据的 AI 编程/对话 harness，列出清单并标注 token 可用性。
 * 设计原则（master 要求「零模糊、不编造」）：
 *   - hasTokenData=true 的 harness，其本地文件含可解析的 token 记录，WB Monitor 才真实统计；
 *   - hasTokenData=false 的 harness，仅标注「已检测·本地无 token 记录」，绝不编造数字。
 *
 * 实测结论（2026-08-14 本机探查）：
 *   可统计：claude(~/.claude/projects 逐消息 input_tokens)、workbuddy(~/.workbuddy/projects + db)
 *   不可统计：codex(会话未落盘为可解析 JSONL)、gemini(仅存对话文本)、cursor/windsurf(私有 sqlite)
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

// 已知 harness 定义。dir() 返回数据/安装目录；hasTokenData 表示本地是否含可解析 token。
const HARNESS_DEFS = [
  { id: 'claude', name: 'Claude Code / CC Switch', dir: () => path.join(os.homedir(), '.claude', 'projects'), hasTokenData: true,
    note: '逐消息含 input_tokens / output_tokens，真实可统计' },
  { id: 'workbuddy', name: 'WorkBuddy', dir: () => path.join(os.homedir(), '.workbuddy', 'projects'), hasTokenData: true,
    note: '本地 JSONL + workbuddy.db 含 token，真实可统计' },
  { id: 'codex', name: 'Codex CLI', dir: () => path.join(os.homedir(), '.codex'), hasTokenData: false,
    note: '已安装且有数据，但真实会话未落盘为可解析 JSONL，本地无 token 记录' },
  { id: 'gemini', name: 'Gemini CLI', dir: () => path.join(os.homedir(), '.gemini'), hasTokenData: false,
    note: '本地仅存对话文本，不写 token 数' },
  { id: 'cursor', name: 'Cursor', dir: () => path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User'), hasTokenData: false,
    note: '对话存于私有 state.vscdb(sqlite)，无公开 token 字段' },
  { id: 'windsurf', name: 'Windsurf', dir: () => path.join(os.homedir(), '.windsurf'), hasTokenData: false,
    note: '会话在 AppData 私有格式，本地无 token 记录' }
];

// 递归统计目录下的 json/jsonl 数量与总字节（用于「本机有哪些 harness + 数据量」展示）
async function _scan(dir) {
  let jsonl = 0, bytes = 0;
  try { await fsp.access(dir); } catch { return { exists: false, jsonl: 0, bytes: 0 }; }
  async function walk(d) {
    let entries = [];
    try { entries = await fsp.readdir(d); } catch { return; }
    for (const n of entries) {
      const fp = path.join(d, n);
      try {
        const st = fs.statSync(fp);
        if (st.isDirectory()) await walk(fp);
        else if (n.endsWith('.jsonl') || n.endsWith('.json')) { jsonl++; bytes += st.size; }
      } catch {}
    }
  }
  await walk(dir);
  return { exists: true, jsonl, bytes };
}

// 发现本机所有已知 harness 的安装/数据情况
async function detectHarnesses() {
  const out = [];
  for (const h of HARNESS_DEFS) {
    const s = await _scan(h.dir());
    out.push({
      id: h.id,
      name: h.name,
      detected: s.exists,
      jsonlCount: s.jsonl,
      sizeBytes: s.bytes,
      hasTokenData: h.hasTokenData && s.exists,
      note: h.note,
      dataDir: h.dir()
    });
  }
  return out;
}

// 合并多个 harness 的 byModel 数组为统一「全部模型 token」列表。
// pairs: [{ harness: 'claude'|'workbuddy', models: [{model, inputTokens, outputTokens, totalTokens, calls, cost, costEstimated, ...}] }]
function mergeTokenByModel(pairs) {
  const map = {};
  for (const { harness, models } of (pairs || [])) {
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      const key = m.model || 'unknown';
      if (!map[key]) map[key] = { model: key, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, cost: 0, costEstimated: false, harnesses: new Set() };
      const t = map[key];
      t.inputTokens += m.inputTokens || 0;
      t.outputTokens += m.outputTokens || 0;
      t.totalTokens += m.totalTokens || 0;
      t.calls += m.calls || 0;
      t.cost += m.cost || 0;
      if (m.costEstimated) t.costEstimated = true;
      t.harnesses.add(harness);
    }
  }
  const arr = Object.values(map).map(o => { o.harnesses = Array.from(o.harnesses); return o; });
  arr.sort((a, b) => b.totalTokens - a.totalTokens);
  return arr;
}

module.exports = { HARNESS_DEFS, detectHarnesses, mergeTokenByModel };
