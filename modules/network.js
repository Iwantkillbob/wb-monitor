/**
 * 网速监控模块 v2
 * 接收主进程通过 IPC 推送的网卡流量数据，计算差值得出速度
 */
const NetworkMonitor = (() => {
  let currentSpeed = { upload: 0, download: 0 };
  let lastBytes = { rx: 0, tx: 0 };
  let lastTime = Date.now();
  let callbackFn = null;
  let isListening = false;

  function formatSpeed(kbps) {
    if (!kbps || kbps < 1) return '0 B/s';
    if (kbps < 1024) return Math.round(kbps) + ' KB/s';
    return (kbps / 1024).toFixed(1) + ' MB/s';
  }

  function start(callback) {
    callbackFn = callback;
    lastTime = Date.now();

    if (!isListening && window.electronAPI?.onNetworkUpdate) {
      window.electronAPI.onNetworkUpdate((data) => {
        const now = Date.now();
        const dt = (now - lastTime) / 1000;

        if (dt > 0 && lastBytes.rx > 0) {
          currentSpeed.download = ((data.rx - lastBytes.rx) / dt) / 1024;
          currentSpeed.upload = ((data.tx - lastBytes.tx) / dt) / 1024;
        }

        lastBytes = { rx: data.rx, tx: data.tx };
        lastTime = now;

        if (callbackFn) {
          callbackFn({
            upload: currentSpeed.upload,
            download: currentSpeed.download,
            uploadStr: formatSpeed(currentSpeed.upload),
            downloadStr: formatSpeed(currentSpeed.download)
          });
        }
      });
      isListening = true;
    }
    // 注意：不再有 fallback 模拟数据
    // 在真实 Electron 环境中，数据由主进程 systeminformation 推送
    // 如果主进程推送失败，显示占位值 "-- KB/s"
  }

  function stop() {
    if (isListening && window.electronAPI?.removeAllListeners) {
      window.electronAPI.removeAllListeners('network-update');
      isListening = false;
    }
    callbackFn = null;
  }

  return { start, stop, formatSpeed };
})();

window.NetworkMonitor = NetworkMonitor;
