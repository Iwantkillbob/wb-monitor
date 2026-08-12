/**
 * FPS 监控模块
 * 基于 requestAnimationFrame 计数实现帧率检测
 */
const FPSMonitor = (() => {
  let frames = 0;
  let lastTime = performance.now();
  let fps = 60;
  let fpsHistory = []; // 最近 30 帧的 FPS 用于平滑
  let rafId = null;
  let callbackFn = null;

  function tick(now) {
    frames++;

    const delta = now - lastTime;

    // 每 500ms 更新一次 FPS
    if (delta >= 500) {
      fps = Math.round((frames * 1000) / delta);
      fpsHistory.push(fps);
      if (fpsHistory.length > 12) fpsHistory.shift(); // 保留最近 6 秒的数据

      frames = 0;
      lastTime = now;

      if (callbackFn) {
        const avgFps = Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length);
        callbackFn({
          current: fps,
          average: avgFps,
          percent: Math.min(100, (avgFps / 144) * 100) // 以 144Hz 为满值
        });
      }
    }

    rafId = requestAnimationFrame(tick);
  }

  function start(callback) {
    callbackFn = callback;
    frames = 0;
    lastTime = performance.now();
    fpsHistory = [];
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    callbackFn = null;
  }

  return { start, stop };
})();

window.FPSMonitor = FPSMonitor;
