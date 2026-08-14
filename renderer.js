/**
 * WB Monitor 渲染进程 v7 — cc switch 风格：实时调用明细为主，紧凑汇总为辅
 * 数据：主进程推送 token-update = { aggregate, recentCalls[已合并逐调成本], costTotal, costToday, costByModel }
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const els = {
    netUp: $('net-upload'), netDown: $('net-download'),
    fpsVal: $('fps-value'), fpsBar: $('fps-bar'),
    feed: $('calls-feed'), feedHint: $('feed-hint'),
    modelRate: $('model-rate'), modelStatus: $('model-status'),
    modelName: $('model-name'), modelCost: $('model-cost'),
    modelCostList: $('model-cost-list'),
    ccTotalTokens: $('cc-total-tokens'), ccTotalCost: $('cc-total-cost'),
    ccBillingNote: $('cc-billing-note'), ccModelList: $('cc-model-list'),
    dshTotalCalls: $('dsh-total-calls'), dshTotalTokens: $('dsh-total-tokens'),
    dshTotalCache: $('dsh-total-cache'), dshModelList: $('dsh-model-list'),
    sumTodayCalls: $('sum-today-calls'), sumTodayTokens: $('sum-today-tokens'),
    sumTodayCost: $('sum-today-cost'), sumTotalCost: $('sum-total-cost'),
    sumLblCalls: $('sum-lbl-calls'), sumLblTokens: $('sum-lbl-tokens'),
    sumLblCost: $('sum-lbl-cost'), sumLblTotal: $('sum-lbl-total'),
    remoteCount: $('remote-count'),
    harnessList: $('harness-list'), harnessTokenList: $('harness-token-list'),
    debug: $('debug-status'), lastUpdate: $('last-update'),
    panel: $('panel'), ball: $('drag-ball'),
    btnClose: $('btn-close-panel'), btnPin: $('btn-pin'), btnRefresh: $('btn-refresh'),
    btnTop: $('btn-topmost'), btnPen: $('btn-penetration'), btnQuit: $('btn-quit'),
    btnView: $('btn-view')
  };

  const APP_VERSION = 'v1.1.2-dsh';

  // 视图模式：'since' = 只看本次启动后的消耗（默认）；'all' = 累计全量
  let viewMode = 'since';
  let lastPayload = null;
  let BASELINE_READY = false;
  let PANEL_W = 320, PANEL_H = 540, BALL = 56;

  // ===== 格式化 =====
  const fmt = (n) => (typeof n === 'number' && !isNaN(n)) ? n.toLocaleString('en-US') : (n || '--');
  const fmtK = (n) => {
    if (typeof n !== 'number' || isNaN(n)) return '--';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  };
  const fmtCost = (n) => '¥' + ((n || 0).toFixed ? (n).toFixed(2) : '0.00');
  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return (m < 10 ? '0' + m : m) + ':' + ((s % 60) < 10 ? '0' + (s % 60) : (s % 60));
  };

  // ===== 当前模型 + 花费（最显眼，最先显示）=====
  function renderModelHeadline(d, scope) {
    if (!d) return;
    const latest = (d.aggregate && d.aggregate.latest) || null;
    const model = latest ? (latest.model || '--') : '--';
    const route = latest && latest.requestModelName && latest.requestModelName !== '—' ? ' · ' + latest.requestModelName : '';
    if (els.modelName) {
      els.modelName.textContent = model + route;
      els.modelName.style.color = latest ? '#6cceb0' : 'rgba(255,255,255,0.4)';
    }
    if (els.modelCost) {
      if (scope.mode === 'since') {
        els.modelCost.innerHTML = '本次启动 <b>≈¥' + (scope.headlineCost || 0).toFixed(2) + '</b>';
      } else {
        const sessCost = (typeof d.latestSessionCost === 'number') ? d.latestSessionCost : 0;
        els.modelCost.innerHTML = '累计 <b>¥' + (d.costTotal || 0).toFixed(2) + '</b> · 本会话 <b>≈¥' + sessCost.toFixed(2) + '</b>';
      }
    }
  }

  // ===== 实时速率（类比网速仪表）=====
  // 主进程每 5s 推一次 modelRate（inputPerSec/outputPerSec/callsPerMin/activeSince）。
  // 本地保存，配合 1s 定时器让"调用中 ⏱"计时持续跳动，像网速那样"活"。
  let _lastRate = null; // { activeSince, receivedAt }
  function renderModelRate(rate) {
    if (!rate) rate = _lastRate ? { inputPerSec: 0, outputPerSec: 0, callsPerMin: 0, activeSince: _lastRate.activeSince, live: true } : null;
    if (!rate) {
      if (els.modelRate) els.modelRate.innerHTML = '↑ 0 ↓ 0 · 0 次/min';
      if (els.modelStatus) { els.modelStatus.textContent = '测量中…'; els.modelStatus.className = 'model-status'; }
      return;
    }
    const up = fmtK(Math.round(rate.inputPerSec));
    const down = fmtK(Math.round(rate.outputPerSec));
    if (els.modelRate) els.modelRate.innerHTML = '↑ <span class="up">' + up + '</span>/s ↓ <span class="down">' + down + '</span>/s · ' + (rate.callsPerMin || 0).toFixed(1) + ' 次/min';
    if (els.modelStatus) {
      if (rate.activeSince > 0) {
        const elapsed = rate.activeSince;
        _lastRate = { activeSince: rate.activeSince, receivedAt: Date.now() };
        els.modelStatus.textContent = '🔵 调用中 ⏱ ' + fmtClock(elapsed);
        els.modelStatus.className = 'model-status active';
      } else {
        _lastRate = null;
        els.modelStatus.textContent = rate.live ? '空闲' : '测量中…';
        els.modelStatus.className = 'model-status';
      }
    }
  }
  // 本地 1s 心跳：让"调用中"计时持续跳动
  function startModelTimer() {
    setInterval(() => {
      if (_lastRate && _lastRate.activeSince) {
        const elapsed = _lastRate.activeSince + (Date.now() - _lastRate.receivedAt);
        if (els.modelStatus) { els.modelStatus.textContent = '🔵 调用中 ⏱ ' + fmtClock(elapsed); }
      }
    }, 1000);
  }

  // ===== 渲染：网速 / FPS =====
  function renderNet(d) {
    d = d || {};
    if (els.netUp) els.netUp.textContent = '↑ ' + (d.uploadStr || '-- KB/s');
    if (els.netDown) els.netDown.textContent = '↓ ' + (d.downloadStr || '-- KB/s');
  }
  function renderFps(fps) {
    fps = fps || 60;
    if (els.fpsVal) {
      els.fpsVal.textContent = fps + ' FPS';
      els.fpsVal.className = 'metric-value fps-value ' + (fps >= 50 ? 'status-ok' : fps >= 30 ? 'status-warn' : 'status-error');
    }
    if (els.fpsBar) {
      const pct = Math.min(100, (fps / 144) * 100);
      els.fpsBar.innerHTML = '<div style="width:' + pct + '%;height:100%;border-radius:3px;background:linear-gradient(90deg,#ffd93d,#ff9f43);transition:width 0.3s"></div>';
    }
  }

  // ===== 渲染：实时调用明细 feed（cc switch 风格，每条一行，最新在上） =====
  // 同时包含「本地模型」(有 token 明细) 与「远程/auto」(Claude/GPT 等，仅成本) 调用。
  function renderFeed(calls) {
    if (!els.feed) return;
    if (!calls || !calls.length) {
      const msg = viewMode === 'since' ? '本次启动后暂无新调用' : '暂无调用记录';
      els.feed.innerHTML = '<div class="token-subitem" style="padding:14px;text-align:center">' + msg + '</div>';
      return;
    }
    const rows = calls.map((c, i) => {
      const costClass = c.cost > 0 ? '' : 'zero';
      const statusClass = c.statusCode === 200 ? 'st-ok' : (c.statusCode ? 'st-bad' : '');
      const statusText = c.statusCode === 200 ? '200' : (c.statusCode || '--');
      const dur = c.durationStr || '—';
      const isRemote = !!c.fromRemote;
      const isCC = !!c.fromCC;  // CC Switch 调用（有真实 token 明细）
      const isDsh = !!c.fromDsh; // DSH (DeepSeek Harness) 调用（真实模型名 + token）
      // 三路数据源样式区分：
      //   本地(tokenSource) → 模型名 + route · token I/O
      //   远程(costSource auto) → auto · 远程徽标 + 成本计费
      //   CC Switch(ccSource)  → 模型名 + CC 徽标 + 真实 token I/O（与本地同格式但不同色）
      let modelLabel, ioText, rowClass = '';
      if (isRemote) {
        modelLabel = '<span class="call-model">' + (c.route || 'auto') + '</span><span class="remote-badge">远程</span>';
        ioText = '<span class="call-io remote-io">成本计费</span>';
        rowClass = ' remote';
      } else if (isCC) {
        modelLabel = '<span class="call-model cc-model-name">' + (c.model || '--') + '</span><span class="cc-badge">CC</span>' +
          (c.route && c.route !== '—' ? '<span class="call-route">· ' + c.route + '</span>' : '');
        ioText = '<span class="call-io"><span class="in">' + fmt(c.inputTokens) + '</span> / <span class="out">' + fmt(c.outputTokens) + '</span> tok</span>';
        rowClass = ' cc-call';
      } else if (isDsh) {
        modelLabel = '<span class="call-model dsh-model-name">' + (c.model || '--') + '</span><span class="dsh-badge">DSH</span>' +
          (c.route && c.route !== '—' ? '<span class="call-route">· ' + c.route + '</span>' : '');
        ioText = '<span class="call-io"><span class="in">' + fmt(c.inputTokens) + '</span> / <span class="out">' + fmt(c.outputTokens) + '</span> tok</span>';
        rowClass = ' dsh-call';
      } else {
        modelLabel = '<span class="call-model">' + (c.model || '--') + '</span>' + (c.route && c.route !== '—' ? '<span class="call-route">· ' + c.route + '</span>' : '');
        ioText = '<span class="call-io"><span class="in">' + fmt(c.inputTokens) + '</span> / <span class="out">' + fmt(c.outputTokens) + '</span> tok</span>';
      }
      return (
        '<div class="call-row' + (i === 0 ? ' latest' : '') + rowClass + '">' +
          '<span class="call-time">' + (c.time || '--:--:--') + '</span>' +
          '<span class="call-mid">' + modelLabel + ioText + '</span>' +
          '<span class="call-right">' +
            '<span class="call-cost ' + costClass + '">' + (c.costEstimated ? '≈' : '') + fmtCost(c.cost) + '</span>' +
            '<span class="call-meta">' + dur + ' · <span class="' + statusClass + '">' + statusText + '</span></span>' +
          '</span>' +
        '</div>'
      );
    });
    els.feed.innerHTML = rows.join('');
    els.feed.scrollTop = 0; // 自动滚到顶部（最新一条）
  }

  // ===== 渲染：各模型成本（含 Claude/GPT，记在 auto 下）=====
  function renderCostByModel(costByModel) {
    if (!els.modelCostList) return;
    if (!costByModel || !costByModel.length) {
      const msg = viewMode === 'since' ? '本次启动后暂无成本' : '暂无成本数据';
      els.modelCostList.innerHTML = '<div class="cost-empty">' + msg + '</div>';
      return;
    }
    const rows = costByModel.map(m => {
      const isAuto = (m.model || '').toLowerCase() === 'auto';
      const tag = isAuto ? '<span class="auto-tag">含 Claude/GPT</span>' : '';
      return (
        '<div class="cost-row' + (isAuto ? ' auto' : '') + '">' +
          '<span class="cost-model">' + (m.model || 'unknown') + tag + '</span>' +
          '<span class="cost-val">¥' + (m.cost || 0).toFixed(2) + '</span>' +
        '</div>'
      );
    });
    els.modelCostList.innerHTML = rows.join('');
  }

  // ===== 渲染：紧凑汇总 =====
  function renderSummary(d, scope) {
    if (!d) return;
    if (els.sumTodayCalls) els.sumTodayCalls.textContent = scope.calls || 0;
    if (els.sumTodayTokens) els.sumTodayTokens.textContent = fmtK(scope.tokens || 0);
    if (els.sumTodayCost) els.sumTodayCost.textContent = '≈¥' + (scope.cost || 0).toFixed(2);
    if (els.sumTotalCost) els.sumTotalCost.textContent = fmtCost(d.costTotal);
    if (els.sumLblCalls) els.sumLblCalls.textContent = scope.lblCalls;
    if (els.sumLblTokens) els.sumLblTokens.textContent = scope.lblTokens;
    if (els.sumLblCost) els.sumLblCost.textContent = scope.lblCost;
    if (els.sumLblTotal) els.sumLblTotal.textContent = '累计¥';
    if (els.remoteCount) els.remoteCount.textContent = (scope.remote || 0) + ' 远程';
    if (els.lastUpdate) els.lastUpdate.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (els.debug) {
      const c = (scope.feed || [])[0];
      if (c) {
        els.debug.textContent = '✓ ' + APP_VERSION + ' · ' + (scope.feed.length) + '条 · 远程' + (scope.remote || 0);
        els.debug.style.color = '#6cceb0';
      } else {
        els.debug.textContent = '等待数据... ' + APP_VERSION;
        els.debug.style.color = '#ffd93d';
      }
    }
  }

  // ===== 视图作用域：根据 viewMode 选择「本次启动」或「累计」数据 =====
  function buildScope(d) {
    if (viewMode === 'since') {
      const s = d.since || { calls: 0, tokens: 0, cost: 0, remoteCallCount: 0, recentCalls: [], byModel: [] };
      return {
        mode: 'since',
        calls: s.calls, tokens: s.tokens, cost: s.cost, remote: s.remoteCallCount,
        feed: s.recentCalls, byModel: s.byModel,
        headlineCost: s.cost,
        lblCalls: '本次调用', lblTokens: '本次Token', lblCost: '本次¥'
      };
    }
    const agg = d.aggregate || {};
    const T = agg.today || {};
    return {
      mode: 'all',
      calls: T.calls || 0, tokens: T.totalTokens || 0, cost: d.costToday || 0, remote: d.remoteCallCount || 0,
      feed: d.recentCalls || [], byModel: d.costByModel || [],
      headlineCost: d.costTotal || 0,
      lblCalls: '今日调用', lblTokens: '今日Token', lblCost: '今日¥'
    };
  }

  // ===== 渲染：CC (Claude Code) 模型用量（逐消息真源，token 100% 真实，费用按核实单价）=====
  function renderCC(cc) {
    if (!cc) return;
    const t = cc.total || { calls: 0, totalTokens: 0, cost: 0 };
    if (els.ccTotalTokens) els.ccTotalTokens.textContent = fmtK(t.totalTokens || 0);
    if (els.ccTotalCost) els.ccTotalCost.textContent = (t.cost || 0).toFixed(2);
    if (els.ccBillingNote) {
      const est = t.costEstimated ? '估算·含未核实单价' : '按核实单价';
      els.ccBillingNote.textContent = cc.billing && cc.billing.note ? cc.billing.note : est;
      els.ccBillingNote.title = 'CC 调用 ' + (t.calls || 0) + ' 次 · 工程 ' + (cc.projects || 0) + ' 个';
    }
    if (!els.ccModelList) return;
    const list = cc.byModel || [];
    if (!list.length) {
      els.ccModelList.innerHTML = '<div class="cost-empty">暂无 CC 调用记录</div>';
      return;
    }
    const rows = list.map(m => {
      const flag = m.priceVerified ? '' : '<span class="cc-unverified" title="' + (m.note || '单价未官方核实') + '">✗</span>';
      return (
        '<div class="cc-row">' +
          '<span class="cc-model">' + (m.model || 'unknown') + flag + '</span>' +
          '<span class="cc-tok">' + fmtK(m.totalTokens) + '</span>' +
          '<span class="cc-cost">$' + (m.cost || 0).toFixed(2) + '</span>' +
        '</div>'
      );
    });
    els.ccModelList.innerHTML = rows.join('');
  }

  // ===== 渲染：DSH (DeepSeek Harness) 模型用量（真实模型名，zstd 日志逐调用 token）=====
  function renderDSH(dsh) {
    if (!dsh) return;
    const t = dsh.total || { calls: 0, totalTokens: 0, cachedTokens: 0 };
    if (els.dshTotalCalls) els.dshTotalCalls.textContent = fmt(t.calls || 0);
    if (els.dshTotalTokens) els.dshTotalTokens.textContent = fmtK(t.totalTokens || 0);
    if (els.dshTotalCache) els.dshTotalCache.textContent = '缓存 ' + fmtK(t.cachedTokens || 0);
    if (!els.dshModelList) return;
    const list = dsh.byModel || [];
    if (!list.length) {
      els.dshModelList.innerHTML = '<div class="cost-empty">暂无 DSH 调用记录</div>';
      return;
    }
    const rows = list.map(m => {
      const prov = (m.providerLabels && m.providerLabels.length) ? m.providerLabels.join('/') : (m.provider || '');
      return (
        '<div class="dsh-row">' +
          '<span class="dsh-model">' + (m.model || 'unknown') +
            (prov ? '<span class="dsh-prov">' + prov + '</span>' : '') +
          '</span>' +
          '<span class="dsh-calls">' + (m.calls || 0) + '次</span>' +
          '<span class="dsh-tok">' + fmtK(m.totalTokens) + ' tok</span>' +
        '</div>'
      );
    });
    els.dshModelList.innerHTML = rows.join('');
  }

  // 本机 harness 发现清单
  function renderHarnesses(list) {
    if (!els.harnessList) return;
    if (!list || !list.length) { els.harnessList.innerHTML = '<div class="cost-empty">未发现</div>'; return; }
    const rows = list.map(h => {
      const sizeStr = h.sizeBytes > 0 ? (h.sizeBytes >= 1048576 ? (h.sizeBytes / 1048576).toFixed(0) + 'MB' : (h.sizeBytes / 1024).toFixed(0) + 'KB') : '';
      const tokBadge = h.hasTokenData
        ? '<span class="h-tok ok">✓ 可统计</span>'
        : (h.detected ? '<span class="h-tok no" title="' + (h.note || '') + '">本地无 token 记录</span>' : '<span class="h-tok off">未安装</span>');
      const det = h.detected ? ('<span class="h-meta">' + h.jsonlCount + ' 文件 · ' + sizeStr + '</span>') : '';
      return '<div class="h-row' + (h.detected ? '' : ' h-row-off') + '">'
        + '<span class="h-name">' + h.name + '</span>'
        + det + tokBadge + '</div>';
    });
    els.harnessList.innerHTML = rows.join('');
  }

  // 全部模型 Token（本地可统计真实源合并）
  function renderHarnessToken(byModel) {
    if (!els.harnessTokenList) return;
    if (!byModel || !byModel.length) { els.harnessTokenList.innerHTML = '<div class="cost-empty">暂无</div>'; return; }
    const rows = byModel.map(m => {
      const hs = (m.harnesses && m.harnesses.length) ? m.harnesses.map(x => x === 'claude' ? 'CC' : (x === 'workbuddy' ? 'WB' : x)).join('/') : '';
      return '<div class="h-tok-row">'
        + '<span class="h-tok-model">' + (m.model || 'unknown') + '</span>'
        + '<span class="h-tok-tok">' + fmtK(m.totalTokens) + ' tok</span>'
        + '<span class="h-tok-cost">$' + (m.cost || 0).toFixed(2) + '</span>'
        + (hs ? '<span class="h-tok-src">' + hs + '</span>' : '')
        + '</div>';
    });
    els.harnessTokenList.innerHTML = rows.join('');
  }

  function renderView() {
    const d = lastPayload;
    if (!d) return;
    const scope = buildScope(d);
    renderModelHeadline(d, scope);
    renderFeed(scope.feed);
    renderCostByModel(scope.byModel);
    renderModelRate(d.modelRate);
    renderSummary(d, scope);
    renderCC(d.cc);
    renderDSH(d.dsh);
    renderHarnessToken(d.harnessToken && d.harnessToken.byModel);
  }

  function renderPayload(d) {
    if (!d) return;
    lastPayload = d;
    renderView();
  }

  // ===== 模式控制 =====
  let isLocked = false;
  function setMode(collapsed) {
    if (collapsed) {
      els.panel?.classList.add('hidden');
      if (els.ball) { els.ball.style.display = 'flex'; els.ball.style.top = '4px'; els.ball.style.right = '4px'; }
      document.body.classList.add('mode-ball');
      window.electronAPI?.setWindowSize(BALL, BALL);
    } else {
      els.panel?.classList.remove('hidden');
      if (els.ball) els.ball.style.display = 'none';
      document.body.classList.remove('mode-ball');
      window.electronAPI?.setWindowSize(PANEL_W, PANEL_H);
    }
  }

  // ===== 拖拽 =====
  let dragging = false, offset = { x: 0, y: 0 };
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true;
    offset = { x: e.clientX, y: e.clientY };
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onDragEnd);
  });
  function onDrag(e) {
    if (!dragging || isLocked) return;
    window.electronAPI?.setWindowPos(Math.round(e.screenX - offset.x), Math.round(e.screenY - offset.y));
  }
  function onDragEnd() {
    dragging = false;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', onDragEnd);
  }

  // ===== 按钮 =====
  els.btnClose?.addEventListener('click', () => setMode(true));
  els.btnPin?.addEventListener('click', () => {
    isLocked = !isLocked;
    els.btnPin.classList.toggle('active', !isLocked);
  });
  els.btnTop?.addEventListener('click', () => {
    const on = !els.btnTop.classList.contains('active');
    els.btnTop.classList.toggle('active', on);
    window.electronAPI?.toggleTopmost(on);
  });
  let penOn = false;
  els.btnPen?.addEventListener('click', () => {
    penOn = !penOn;
    els.btnPen.classList.toggle('active', penOn);
    window.electronAPI?.togglePenetration(penOn);
  });
  els.btnQuit?.addEventListener('click', () => window.electronAPI?.quitApp());
  els.btnRefresh?.addEventListener('click', async () => {
    if (els.debug) { els.debug.textContent = '⟳ 手动刷新中... ' + APP_VERSION; els.debug.style.color = '#ffd93d'; }
    try {
      const d = await window.electronAPI?.getTokenData();
      if (d) renderPayload(d);
    } catch (e) {
      if (els.debug) { els.debug.textContent = '⚠ 刷新失败: ' + (e && e.message || e); els.debug.style.color = '#ff6b6b'; }
    }
  });
  els.ball?.addEventListener('click', () => setMode(false));

  // 视图切换：本次启动 / 累计
  function updateViewBtn() {
    if (els.btnView) {
      els.btnView.textContent = viewMode === 'since' ? '⏱本次' : '📅累计';
      els.btnView.title = viewMode === 'since' ? '当前：只看本次启动后的消耗（点击看累计）' : '当前：累计全量（点击看本次启动）';
      els.btnView.classList.toggle('active', viewMode === 'since');
    }
  }
  els.btnView?.addEventListener('click', () => {
    viewMode = (viewMode === 'since') ? 'all' : 'since';
    updateViewBtn();
    renderView();
    if (els.debug) { els.debug.textContent = '视图: ' + (viewMode === 'since' ? '本次启动' : '累计'); els.debug.style.color = '#6cceb0'; }
  });

  window.electronAPI?.onCollapseToBall(() => setMode(true));
  window.electronAPI?.onExpandPanel(() => setMode(false));
  window.electronAPI?.onPenetrationChanged((on) => {
    penOn = !!on;
    els.btnPen?.classList.toggle('active', penOn);
    if (els.debug) els.debug.textContent = on ? '👁 鼠标穿透中 · Ctrl+Shift+M 退出' : '等待数据...';
  });

  // ===== FPS 计数器 =====
  let frames = 0, lastFpsTime = performance.now();
  function rafTick(t) {
    frames++;
    if (t - lastFpsTime >= 500) {
      const fps = Math.round((frames * 1000) / (t - lastFpsTime));
      frames = 0; lastFpsTime = t;
      renderFps(fps);
    }
    requestAnimationFrame(rafTick);
  }

  // ===== 启动 =====
  async function start() {
    renderNet(null);
    renderFps(60);
    updateViewBtn();
    if (els.debug) els.debug.textContent = '启动中... ' + APP_VERSION;

    try {
      const cfg = await window.electronAPI?.getConfig();
      if (cfg?.window) {
        PANEL_W = cfg.window.panelSize?.w || 320;
        PANEL_H = cfg.window.panelSize?.h || 540;
        BALL = cfg.window.ballSize || 56;
      }
    } catch {}

    if (window.electronAPI) {
      window.electronAPI.onNetworkUpdate(renderNet);
      window.electronAPI.onTokenUpdate(renderPayload);
      try {
        const d = await window.electronAPI.getTokenData();
        if (d) renderPayload(d);
        else if (els.debug) { els.debug.textContent = '⚠ 数据为空'; els.debug.style.color = '#ff6b6b'; }
      } catch (e) {
        if (els.debug) { els.debug.textContent = '⚠ 拉取失败: ' + (e && e.message || e); els.debug.style.color = '#ff6b6b'; }
      }
    }

    requestAnimationFrame(rafTick);
    startModelTimer();
    // 本机 harness 发现（非关键，延迟拉取 + 定时刷新，避免阻塞首屏）
    setTimeout(() => {
      const pull = () => { try { window.electronAPI.getHarnesses().then(renderHarnesses).catch(() => {}); } catch {} };
      pull();
      setInterval(pull, 30000);
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();