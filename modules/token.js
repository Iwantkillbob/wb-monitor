/**
 * Token 消耗监控模块 v2
 * 数据来源：WorkBuddy 会话 JSONL → providerData.rawUsage
 */
const TokenMonitor = (() => {
  let callbackFn = null;
  let isListening = false;
  let cachedData = null;

  function start(callback) {
    callbackFn = callback;

    if (!isListening && window.electronAPI?.onTokenUpdate) {
      // 主进程主动推送（每 5 秒一次）
      window.electronAPI.onTokenUpdate((data) => {
        cachedData = data;
        if (callbackFn && data) {
          callbackFn({
            inputTokens: data.latest?.inputTokens ?? '--',
            outputTokens: data.latest?.outputTokens ?? '--',
            totalTokens: data.latest?.totalTokens ?? '--',
            model: data.latest?.model ?? '--',
            cachedTokens: data.latest?.cachedTokens ?? 0,
            reasoningTokens: data.latest?.reasoningTokens ?? 0,
            duration: data.latest?.duration ?? '--',
            status: data.latest?.status ?? '--',
            statusCode: data.latest?.statusCode ?? null,
            todayCalls: data.today?.calls || 0,
            todayTotalInput: data.today?.totalInputTokens || 0,
            todayTotalOutput: data.today?.totalOutputTokens || 0,
            todayTotalTokens: data.today?.totalTokens || 0,
            todayCached: data.today?.totalCached || 0,
            source: data.source
          });
        }
      });
      isListening = true;
    }

    // 首次加载：主动拉取（不等推送）
    setTimeout(async () => {
      if (window.electronAPI?.getTokenData) {
        try {
          const data = await window.electronAPI.getTokenData();
          if (data && callbackFn) {
            cachedData = data;
            callbackFn({
              inputTokens: data.latest?.inputTokens ?? '--',
              outputTokens: data.latest?.outputTokens ?? '--',
              totalTokens: data.latest?.totalTokens ?? '--',
              model: data.latest?.model ?? '--',
              cachedTokens: data.latest?.cachedTokens ?? 0,
              reasoningTokens: data.latest?.reasoningTokens ?? 0,
              duration: data.latest?.duration ?? '--',
              status: data.latest?.status ?? '--',
              statusCode: data.latest?.statusCode ?? null,
              todayCalls: data.today?.calls || 0,
              todayTotalInput: data.today?.totalInputTokens || 0,
              todayTotalOutput: data.today?.totalOutputTokens || 0,
              todayTotalTokens: data.today?.totalTokens || 0,
              todayCached: data.today?.totalCached || 0,
              source: data.source
            });
          }
        } catch {}
      }
    }, 1000);
  }

  function stop() {
    if (isListening && window.electronAPI?.removeAllListeners) {
      window.electronAPI.removeAllListeners('token-update');
      isListening = false;
    }
    callbackFn = null;
  }

  return { start, stop };
})();

window.TokenMonitor = TokenMonitor;
