# WARP 控制中心

> `seiry/cloudflare-warp-proxy` 的 Node.js 重写版 —— 极低占用的 Cloudflare WARP 代理，带实时监控面板。

[![部署状态](https://img.shields.io/badge/部署-Docker%20%2F%20裸机-success)](docs/DEPLOYMENT.md)
[![界面语言](https://img.shields.io/badge/界面-简体中文-red)](dashboard/src/app/page.tsx)
[![后端](https://img.shields.io/badge/后端-Node.js%20%2F%20Bun-yellow)](mini-services/warp-proxy/)
[![前端](https://img.shields.io/badge/前端-Next.js%2016-black)](dashboard/)

---

## 项目简介

本项目是对 [`seiry/cloudflare-warp-proxy`](https://hub.docker.com/r/seiry/cloudflare-warp-proxy) Docker 镜像的**重新设计与优化重写**。

原镜像通过 Debian + `cloudflare-warp` apt 包 + `socat` 端口转发 + `bash` 入口脚本实现 WARP 代理，但存在**资源占用过高**的问题（详见 [架构说明](docs/ARCHITECTURE.md)）。

本项目用 **Node.js（Bun 运行时）** 重写了代理与守护层，**消除了 socat 双跳**，并新增了**实时监控面板**，在保持与原镜像完全兼容的代理能力（SOCKS5 + HTTP CONNECT）的同时，将空闲内存占用从 ~110 MB 降至 ~30 MB。

### 核心改进

| 维度 | 原始镜像 (`seiry/cloudflare-warp-proxy`) | 本项目 (Node.js 重写) |
|------|------------------------------------------|------------------------|
| 镜像基础 | Debian bullseye-slim (~150 MB) | 主机已有的 warp-svc + ~30 MB Node 守护进程 |
| 每条连接的进程数 | 2（socat + warp-svc） | 1（Node 代理 → warp-svc） |
| 每条连接的 TCP 跳数 | 2（client → socat → warp-svc） | 1（client → Node → warp-svc，零拷贝 pipe） |
| 空闲 RSS | ~110 MB（warp-svc + socat + bash） | ~30 MB（仅 Node 守护进程，堆 ~4 MB） |
| socat 依赖 | 必须 | **已消除**（Node 原生 SOCKS5/HTTP） |
| 背压 / 限制 | 无 | 最大连接数 + 空闲超时 + ulimit |
| 实时监控 | 无（仅 docker logs） | **实时 WebSocket 面板**（CPU/内存/吞吐/连接/日志） |
| 部署灵活性 | 仅 Docker | Docker / 裸机 / systemd |

> ⚠️ **重要说明**：官方 `warp-svc`（Rust 守护进程）仍然必需，因为它负责实际的 MASQUE 协议通信——这部分无法用纯 Node 重新实现。本项目**优化的是其外层包装**（消除 socat 双跳 + bash 开销），并增加守护与可观测性。

---

## 功能特性

- 🚀 **原生 SOCKS5 + HTTP 代理**：单 Node 进程，零拷贝 `pipe()`，无 socat 中转
- 📊 **实时监控面板**：CPU、内存、堆、吞吐量、连接数、日志流，1 秒粒度 WebSocket 推送
- 🔧 **WARP 生命周期管理**：连接 / 断开 / 重启 / 许可证注册 / 链路测试，一键操作
- 🛡️ **进程守护**：自动检测 warp-svc，崩溃恢复，状态轮询
- 🔐 **Zero Trust 支持**：通过 `mdm.xml` 挂载，支持服务令牌注册到企业组织
- 🎨 **中文界面**：深色「任务控制台」风格，琥珀/橙色主题
- 🐳 **完整可部署**：提供 Dockerfile、docker-compose、systemd unit、Nginx 反代配置
- 🧪 **演示模式**：无 warp-svc 环境下自动降级，便于评估与演示

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/koshoutou/warp-control-center.git
cd warp-control-center

# 启动（首次会构建镜像并自动注册 WARP）
docker compose -f deploy/docker-compose.yml up -d

# 查看面板（等待 ~10 秒让 warp-svc 上线）
open http://localhost:3000

# 测试代理
curl https://www.cloudflare.com/cdn-cgi/trace -x socks5h://127.0.0.1:40000
# 输出应包含 warp=on
```

### 方式二：裸机 / systemd

详见 [部署指南](docs/DEPLOYMENT.md#方式二裸机--systemd)。

### 代理使用

面板启动后，将任何支持 SOCKS5 或 HTTP CONNECT 的客户端指向：

```
socks5h://127.0.0.1:40000   # SOCKS5（远程 DNS 解析，推荐）
socks5://127.0.0.1:40000    # SOCKS5（本地 DNS 解析）
http://127.0.0.1:40000      # HTTP CONNECT 代理
```

**示例：**

```bash
# curl
curl https://www.cloudflare.com/cdn-cgi/trace -x socks5h://127.0.0.1:40000

# git
git -c http.proxy=socks5h://127.0.0.1:40000 clone https://github.com/...

# 浏览器（Firefox）
# 首选项 → 网络设置 → 手动配置代理 → SOCKS 主机: 127.0.0.1  端口: 40000  SOCKS v5  ✓ 远程 DNS
```

---

## 端口说明

| 端口 | 服务 | 说明 |
|------|------|------|
| `40000` | 代理 | SOCKS5 + HTTP CONNECT，客户端指向此端口 |
| `3000` | 面板 | Next.js 监控面板（浏览器访问） |
| `3030` | 控制面 | 后端 REST + WebSocket（内部，无需暴露） |
| `40001` | warp-svc | WARP 守护进程本地代理（内部，由 Node 转发） |

---

## 配置

通过环境变量配置（详见 [配置参考](docs/DEPLOYMENT.md#环境变量配置)）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LICENSE` | （空） | WARP+ 许可证密钥（可选） |
| `AUTO_CONNECT` | `false` | 启动时是否自动连接 WARP |
| `PROXY_PORT` | `40000` | 代理监听端口 |
| `CONTROL_PORT` | `3030` | 控制面端口 |
| `MAX_CONNECTIONS` | `2048` | 最大并发连接数 |
| `IDLE_TIMEOUT_MS` | `120000` | 连接空闲超时（毫秒） |

**WARP+ 许可证：**

```bash
# docker-compose
environment:
  - LICENSE=your-warp-plus-key

# 裸机
export LICENSE=your-warp-plus-key
```

**Zero Trust（企业组织）：**

挂载 `mdm.xml` 到 `/var/lib/cloudflare-warp/mdm.xml`，详见 [Zero Trust 部署](docs/DEPLOYMENT.md#zero-trust-企业组织部署)。

---

## 文档

- 📖 [**部署指南**](docs/DEPLOYMENT.md) —— Docker / 裸机 / systemd / Nginx 反代 / Zero Trust 完整步骤
- 🏗️ [**架构说明**](docs/ARCHITECTURE.md) —— 原理、为什么占用高、优化策略、组件职责
- 🔌 [**API 参考**](docs/API.md) —— REST 接口与 WebSocket 事件

---

## 技术栈

- **后端**：Node.js 24+ / Bun · socket.io · 原生 `node:net` SOCKS5/HTTP
- **前端**：Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · recharts
- **运行时依赖**：`cloudflare-warp` apt 包（提供 `warp-svc` + `warp-cli`）

---

## 致谢

- 原项目 [`seiry/cloudflare-warp-proxy`](https://github.com/seiry/docker-warp-proxy) —— 本项目在其基础上重新设计优化
- [Cloudflare WARP](https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/warp/) —— MASQUE 隧道协议
