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
├── dist/                # 构建产物（electron-builder 输出，含 WB-Monitor-*-win-x64.exe 单文件便携版）
└── README.md            # 本文件
```
> 桌面另有两个启动器（不在仓库内）：`WB Monitor 源码版.bat`（日常）、`WB Monitor 一键启动(管理员).bat`（清锁/应急）。

## 排障实录（2026-08「闪退 / 打不开」事件）

> 环境：Windows 11 24H2、无 GPU/远程桌面；Node 用 `C:\Users\DCKJ\AppData\Local\hermes\node`（v22.23.1）；
> 源码工程 `D:\workbody\2026-07-31-11-14-14\wb-monitor`；仓库 `github.com/Iwantkillbob/wb-monitor`。

### 现象
从桌面/资源管理器双击 → 窗口一闪即关，**任何日志文件都不生成**（连启动器第一行就该写的面包屑日志都没有）。

### 真因（已逐项验证，非猜测）
1. **破损的打包版 `WB Monitor.exe` 才是罪魁**。早期 `electron-builder` 打的包，启动即因
   `NODE_OPTIONS=--use-system-ca` 被 electron 拒绝（exit code 9）静默闪退、**不写任何日志**。
   用户双击的其实一直是这个坏 exe（开始菜单/任务栏搜 "WB Monitor" 出来的就是它），不是源码版。
2. **`NODE_OPTIONS` 是 WorkBuddy 注入进自身进程树的，并非系统持久变量**（已查注册表 HKCU/HKLM
   `Environment` 均无 `NODE_OPTIONS`）。所以**从资源管理器正常双击 exe 时环境是干净的，不会触发 exit 9**；
   只有从 WorkBuddy 进程树内拉起才会带这串变量。
3. **陈旧进程长期占着单实例锁**。旧打包 exe 的实例（`WB Monitor.exe`）与早前沙箱测试遗留的源码版
   `electron.exe` 一直没被杀掉，新实例抢不到锁 → 静默退出 / 弹"已在运行"。

### 已落地的修复（commit 见 git log）
- `scripts/start-clean.js`：启动前**同步杀掉遗留进程**、**删除陈旧锁文件**、**剥离 `NODE_OPTIONS` 等干扰变量**
  再 spawn electron；并把 electron 的 stderr 落盘到 `launch.log`，异常退出弹 Windows 提示框写明原因。
- `main.js`（a6df900）：崩溃兜底**前移到最顶部**——`require` 阶段抛错 / 未捕获异常 / 未处理 Promise 拒绝 /
  渲染进程崩溃（`webContents.on('crashed')` + `app.on('render-process-gone')`）全部**弹窗 + 写 `crash.log`**，
  不再无声闪退；窗口创建后加 3s/10s 存活心跳写进 `boot.log`，便于定位卡在哪一环。
- 桌面交付两个启动器（见下）。

### 运行方式（三种入口，按需）
| 入口 | 用途 | 何时用 |
|------|------|--------|
| **`dist/WB-Monitor-*-win-x64.exe`**（打包产物） | 单文件，资源管理器双击即运行 | **首选**。干净环境，正常双击即可 |
| `WB Monitor 源码版.bat` / `start.bat` | 走 `start-clean.js` 剥离变量后起源码 | 当从 WorkBuddy 进程树内拉起（带 `NODE_OPTIONS`）时用 |
| `WB Monitor 一键启动(管理员).bat` | 杀全部陈旧进程 → 改坏 exe 为 `.bak` → 删旧快捷方式 → 起源码 | 遇到"已在运行"或锁被占用时，**右键以管理员身份运行一次**即可彻底清锁 |

> 调用流水的展示格式已统一为 **harness → 徽标 → 模型**，例如
> `WorkBuddy [WB] hy3`、`claude-sonnet-4 [CC]`、`qwen3.8-max [DSH]`。

## 构建（打包成 exe）

前置：已 `npm install`（含 `electron` + `electron-builder`）。

```bash
# 方式一：直接命令（产出单文件便携版到 dist/）
node_modules/.bin/electron-builder --win portable --config.directories.output=dist

# 方式二：一键脚本（会先打 EPERM 兼容补丁，输出到 dist/）
build.bat
```

产物：`dist/WB-Monitor-1.1.2-win-x64.exe`（单文件便携版，拷走即用）。
如需安装版（含桌面快捷方式）把 `portable` 换成 `nsis` 或省略（默认打 nsis + portable 两个）。

> 注意：打包出的 exe 从资源管理器双击运行环境是干净的，无需手动剥离变量；
> 仅当从 WorkBuddy 内部拉起时才需要走 `start.bat` 那条剥离链路。

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
