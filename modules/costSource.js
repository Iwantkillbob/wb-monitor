/**
 * costSource.js — WorkBuddy 本地成本数据源（v2 · 含逐调用明细）
 *
 * 数据来源：~/.workbuddy/workbuddy.db（SQLite，cc switch / 使用统计页同源）
 *   - session_usage 表：每会话一行，credit_json 字段 = { conversationRequestId(去横线hex): ¥成本 }
 *   - sessions 表：model / title / updated_at
 *
 * 关键事实（已实地核查）：
 *   - 本地 JSONL 只写「本地路由」模型的 rawUsage（hy3 / glm / deepseek / kimi…），
 *     Claude / GPT 等走远程路由，rawUsage 不落本地 JSONL。
 *   - 但 Claude/GPT 的「计费」会写进 workbuddy.db：auto 路由的会话（含 Claude/GPT）
 *     其 credit_json 里每一条 convId 都是一次真实计费的远程模型调用。
 *   - 因此：本模块把 db 的逐 convId 成本展开成「逐调用」列表（dbCalls），
 *     并带上该会话的 model（auto / 具体模型）。主进程把它与本地 JSONL 调用合并，
 *     Claude 就能出现在悬浮球的实时明细里（带成本、标注「远程/auto」）。
 *
 * 用纯 JS 的 sql.js（wasm）读取，避免原生模块在某些机器上编译/卡死。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const initSqlJs = require('sql.js');

let _SQL = null;

// ===== 稳定性关键：db 读取结果缓存 + 串行锁 =====
// 痛点：每 5s 轮询都 new SQL.Database()+close，sql.js 的 wasm 堆在高频 open/close 下
// 会 native crash（整个 electron 闪退，无 JS 异常可捕获）。
// 解决：db 文件 mtime 不变 → 直接返回上次结果，完全不碰 wasm 堆；
//       即便 mtime 变了，同一时刻也只允许一个读取在跑（串行），杜绝并发 open 堆损坏。
const _costCache = { mtimeMs: 0, result: null, reading: null };

function getDbPath() {
  return path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
}

async function ensureSql() {
  if (!_SQL) {
    const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    _SQL = await initSqlJs({ locateFile: () => wasmPath });
  }
  return _SQL;
}

// 真正的查询（内部用，不做缓存/串行）
async function _queryCost() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return null;

  let SQL;
  try { SQL = await ensureSql(); }
  catch (e) { console.error('[costSource] sql.js 初始化失败:', e.message); return null; }

  // 注意：用 readFileSync 读进内存再 open，不会锁真实文件（WAL 写入方无感知），
  // 至多略滞后于最新 checkpoint，可接受。
  let db;
  try { db = new SQL.Database(fs.readFileSync(dbPath)); }
  catch (e) { console.error('[costSource] 打开 workbuddy.db 失败:', e.message); return null; }

  try {
    const res = db.exec(`
      SELECT s.id AS session_id, s.title, s.model, s.updated_at, u.used, u.size, u.credit_json
      FROM session_usage u
      LEFT JOIN sessions s ON s.id = u.session_id
    `);
    if (!res.length) return { totalCost: 0, todayCost: 0, byModel: [], sessions: [], costMap: {}, dbCalls: [] };

    const cols = res[0].columns;
    const rows = res[0].values;

    let totalCost = 0, todayCost = 0;
    const byModel = {};
    const costMap = {};            // conversationRequestId -> ¥成本（逐调用，id 与 JSONL 不同空间，仅作诊断）
    const sessionCostMap = {};     // session_id(=JSONL 文件名) -> 该会话总 ¥成本（用于按 token 比例摊到本地逐调用）
    const dbCalls = [];            // 逐调用明细（含 Claude/auto），用于合并进实时 feed
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    for (const r of rows) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = r[i]; });
      const model = obj.model || 'unknown';
      const updated = obj.updated_at || 0;
      const sessionId = obj.session_id || '';

      // 展开 credit_json：每条 convId = 一次计费调用
      let sessionCost = 0;
      if (obj.credit_json) {
        try {
          const o = JSON.parse(obj.credit_json);
          for (const k in o) {
            const v = Number(o[k]) || 0;
            if (v <= 0) continue;
            sessionCost += v;
            costMap[k] = (costMap[k] || 0) + v;
            dbCalls.push({
              conversationRequestId: k,
              cost: v,
              model,
              sessionTitle: obj.title || '',
              sessionId,
              updatedAt: updated
            });
          }
        } catch {}
      }
      totalCost += sessionCost;
      if (updated >= todayMs) todayCost += sessionCost;
      if (sessionId) sessionCostMap[sessionId] = (sessionCostMap[sessionId] || 0) + sessionCost;

      if (!byModel[model]) byModel[model] = { model, cost: 0, calls: 0 };
      byModel[model].cost += sessionCost;
      byModel[model].calls += 1;
    }

    // dbCalls 含「所有模型」的逐调用成本（含本地 hy3 与远程 auto）。注意：credit_json 的
    // key 与 JSONL 的 id 是不同 id 空间，无法逐调用 join；本地 hy3 的成本由主进程用「会话级
    // ¥ 按 token 比例/单价」估算，而 model='auto' 的条目由主进程单独作为「远程(Claude/GPT)」
    // 行补进 feed。这里只负责把 db 逐调用明细原样摊开，过滤逻辑在主进程。
    const byModelArr = Object.values(byModel).sort((a, b) => b.cost - a.cost);
    dbCalls.sort((a, b) => b.updatedAt - a.updatedAt);
    return { totalCost, todayCost, byModel: byModelArr, sessions: [], costMap, sessionCostMap, dbCalls };
  } catch (e) {
    console.error('[costSource] 查询失败:', e.message);
    return null;
  } finally {
    db.close();
  }
}

async function fetchCostAggregateAsync() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return null;

  // 1) mtime 没变 → 直接返回缓存（完全不碰 sql.js wasm 堆，杜绝高频 open/close 闪退）
  try {
    const st = fs.statSync(dbPath);
    if (_costCache.result && _costCache.mtimeMs === st.mtimeMs) return _costCache.result;
  } catch {}

  // 2) 串行锁：同一时刻只允许一个读取在跑
  if (_costCache.reading) return _costCache.reading;
  _costCache.reading = (async () => {
    const st = fs.statSync(dbPath);
    const result = await _queryCost();
    if (result) { _costCache.result = result; _costCache.mtimeMs = st.mtimeMs; }
    return result;
  })();
  try { return await _costCache.reading; }
  finally { _costCache.reading = null; }
}

module.exports = { fetchCostAggregateAsync, getDbPath };
