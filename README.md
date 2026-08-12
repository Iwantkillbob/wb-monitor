# WB Monitor

**WorkBuddy 桌面悬浮球监控** — 实时显示网速 / 帧率 / Token 消耗 / 模型调用明细（三路数据源统一时间线）。

基于 Electron 32，零原生依赖，Windows / macOS / Linux 可用。

![Electron](https://img.shields.io/badge/Electron-32-blue) ![License](https://img.shields.io/badge/License-MIT-green)

## 功能特性

| 功能 | 说明 |
|------|------|
| 📶 **实时网速** | 跨平台真实字节计数（Windows netstat / Linux /proc），3s 刷新 |
| 🎮 **帧率监控** | requestAnimationFrame 计数，50+ 绿 / 30-49 黄 / <30 红 |
| 🧾 **统一调用时间线** | 三路数据源合并：本地模型 + CC Switch 远程 + WorkBuddy 平台，按时间倒序 |
| 💰 **模型成本** | 逐调用成本估算 + 按模型汇总，支持 ¥ / USD 双单位 |
| 🖥️ **CC Switch 监控** | 扫描 `~/.claude/projects` JSONL，逐消息采集模型/token/费用 |
| ⏱ **本次/累计切换** | 一键切换「本次启动后」或「全量累计」视图 |
| 👁 **鼠标穿透** | 只看不动模式，快捷键 Ctrl+Shift+M |
| 📌 **悬浮球模式** | 收起为 56px 悬浮球，点击展开 |

## 数据源

WB Monitor 同时接入三个独立数据源，合并为统一时间线：

```
┌─────────────────────────────────────────┐
│           统一调用时间线 (feed)          │
│                                         │
│  11:48:27  claude-sonnet-4-6 [CC]       │ ← ccSource: ~/.claude/projects/*.jsonl
│           50,264 / 805 tok   $0.16      │
│                                         │
│  11:47:58  hy3                          │ ← tokenSource: WorkBuddy 本地会话 JSONL
│           110,801 / 422 tok   ¥1.77     │
│                                         │
│  11:45:00  auto · Claude/GPT [远程]     │ ← costSource: workbuddy.db (auto 路由)
│           成本计费            ¥2.30     │
└─────────────────────────────────────────┘
```

| 数据源 | 文件/路径 | 采集内容 |
|--------|----------|---------|
| **tokenSource** | WorkBuddy 会话 JSONL | 本地模型（hy3/glm/deepseek…）逐调用 token 明细 |
| **costSource** | `~/.workbuddy/workbuddy.db` | 平台侧计费（auto/Claude/GPT 远程路由） |
| **ccSource** | `~/.claude/projects/**/*.jsonl` | CC Switch (claude-code-zh fork) 多模型远程调用 |

## 环境要求

- **Node.js** >= 18
- **npm** >= 9
- **Electron** 32（自动安装）
- **操作系统**: Windows 10+ / macOS 10.15+ / Linux（无 GPU 的 VM/远程桌面需特殊处理，见下方）

## 安装运行

```bash
# 1. 克隆仓库
git clone https://github.com/Iwantkillbob/wb-monitor.git
cd wb-monitor

# 2. 安装依赖（国内用户已配置 npmmirror 镜像）
npm install

# 3. 启动
npm start          # 或 npm run start:clean（推荐，清理干扰环境变量）

# Windows 用户也可直接双击 start.bat
```

### 首次启动后

窗口弹出即表示成功。首次加载数据需要几秒（扫描 JSONL 文件），之后每 5 秒自动刷新。

## 配置

编辑 `config.json`（修改后重启生效）：

```jsonc
{
  "refresh": {
    "networkMs": 3000,    // 网速刷新间隔（ms），最小值代码兜底 ≥2000
    "tokenMs": 5000       // Token 刷新间隔（ms），最小值代码兜底 ≥5000
  },
  "window": {
    "ballSize": 56,       // 悬浮球尺寸（px）
    "panelSize": {
      "w": 320,           // 展开面板宽度
      "h": 520            // 展开面板高度
    }
  }
}
```

## 无 GPU 环境（VM / 远程桌面）

在无显卡的 Windows 环境（如云服务器、远程桌面）中，Electron 默认的 GPU 进程会导致渲染进程崩溃（`Renderer process killed`）。

**解决方案**：项目已内置处理，通过 `scripts/start-clean.js` 启动时自动传入以下参数：

```bash
--in-process-gpu --disable-gpu --no-sandbox --disable-dev-shm-usage
```

如果仍遇到黑屏/崩溃，手动使用：

```bash
npm run start:clean
```

**不要**使用 `npm start`（缺少 GPU 兼容参数）。

## 费用估算说明

CC Switch 的费用为**按核实单价估算**（非官方扣费账单）：

- ✅ 已核实官方价：`claude-sonnet-4-6`, `claude-opus-4-8`, `claude-haiku-4-5`, `claude-fable-5`, `gemini-3.1-pro-preview`, `grok-4.5`, `deepseek-v4-pro`
- ✗ 未核实（沿用同系单价）：`sonnet`(别名), `claude-opus-5`, `qwen3.7-max`, `kimi-k3` — 标注 ✗

> 单价表位于 `modules/cc-source.js` 的 `PRICE_TABLE`，可随时更新。

## 目录结构

```
wb-monitor/
├── main.js              # 主进程（窗口创建、IPC、数据轮询）
├── preload.js           # 渲染进程桥接（contextBridge）
├── index.html           # 主页面
├── renderer.js          # 渲染进程逻辑（UI 渲染、交互）
├── styles.css           # 样式（暗色主题、毛玻璃效果）
├── config.json          # 用户配置
├── start.bat            # Windows 双击启动器
├── .npmrc               # npm 镜像配置（国内加速）
├── package.json         # 项目配置 & 依赖
├── modules/
│   ├── tokenSource.js   # 数据源：WorkBuddy 本地 JSONL
│   ├── costSource.js    # 数据源：workbuddy.db 平台计费
│   ├── cc-source.js     # 数据源：CC Switch JSONL（多模型）
│   ├── network.js       # 网速采集
│   ├── fps.js           # 帧率计算
│   └── token.js         # Token 解析工具
├── scripts/
│   ├── start-clean.js   # 干净启动脚本（清干扰变量 + GPU 参数）
│   ├── diag.js          # 诊断工具
│   └── verify-boot.js   # 启动验证
└── README.md            # 本文件
```

## 已知限制

1. **CC 费用为估算** — 不暴露终身账单文件，单价来自公开文档/聚合站，与实际扣费可能有偏差（通常 <5%）
2. **`~/.claude.json` 的 lastModelUsage 不可作为累计校验基准** — 它只记录各工程"最近一次会话"，已标注为参考
3. **macOS 网速暂未实现** — 仅 Windows（netstat）和 Linux（/proc/net/dev）
4. **首次加载较慢** — 首次扫描 `~/.claude/projects` 全量 JSONL（可能数千文件），后续有 mtime 缓存几乎零开销

## 技术栈

- **Electron** 32 — 桌面应用框架
- **sql.js** (WASM) — SQLite 读取 workbuddy.db（纯 JS，无需编译原生模块）
- **原生依赖**: 零 — 所有功能用 Node.js 内置模块 + Electron API

## License

MIT
