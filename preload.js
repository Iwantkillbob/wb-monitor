const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制
  setWindowSize: (w, h) => ipcRenderer.invoke('set-window-size', w, h),
  setWindowPos: (x, y) => ipcRenderer.invoke('set-window-pos', x, y),
  toggleTopmost: (on) => ipcRenderer.invoke('toggle-topmost', on),
  togglePenetration: (on) => ipcRenderer.invoke('toggle-penetration', on),

  // 数据
  getConfig: () => ipcRenderer.invoke('get-config'),
  getTokenData: () => ipcRenderer.invoke('get-token-data'),
  getHarnesses: () => ipcRenderer.invoke('get-harnesses'),
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // 监听主进程推送（token-update 现在包含：aggregate + recentCalls[逐调已合成本] + costTotal/costToday）
  onNetworkUpdate: (cb) => ipcRenderer.on('network-update', (_, d) => cb(d)),
  onTokenUpdate: (cb) => ipcRenderer.on('token-update', (_, d) => cb(d)),
  onPenetrationChanged: (cb) => ipcRenderer.on('penetration-changed', (_, on) => cb(on)),

  // 主进程指令
  onCollapseToBall: (cb) => ipcRenderer.on('collapse-to-ball', () => cb()),
  onExpandPanel: (cb) => ipcRenderer.on('expand-panel', () => cb()),
});
