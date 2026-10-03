# 架构说明

本文档解释本项目的工作原理、原项目的资源占用问题、以及优化策略。

## 目录

- [原项目工作原理](#原项目工作原理)
- [为什么原项目占用这么高](#为什么原项目占用这么高)
- [本项目的优化策略](#本项目的优化策略)
- [系统架构](#系统架构)
- [组件职责](#组件职责)
- [数据流](#数据流)
- [关键技术决策](#关键技术决策)

---

## 原项目工作原理

原项目 [`seiry/cloudflare-warp-proxy`](https://hub.docker.com/r/seiry/cloudflare-warp-proxy) 的 Dockerfile 与入口脚本：

### Dockerfile

```dockerfile
FROM debian:bullseye-slim
RUN apt install -y gnupg ca-certificates curl socat
RUN curl ... | gpg ... && apt install cloudflare-warp -y
COPY entrypoint.sh /
EXPOSE 40000/tcp
ENTRYPOINT [ "/entrypoint.sh" ]
```

### entrypoint.sh

```bash
# 1. 注册 WARP（消费版）或使用挂载的 mdm.xml（Zero Trust）
warp-cli --accept-tos registration new

# 2. 设置代理模式，warp-svc 在 127.0.0.1:40001 监听 SOCKS5
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40001
warp-cli --accept-tos connect

# 3. socat 把宿主机 40000 转发到 warp-svc 的 40001
socat TCP-LISTEN:40000,fork TCP:localhost:40001 &

# 4. warp-svc 成为 PID 1
exec warp-svc
```

### 工作流程

```
客户端 ──→ :40000 (socat) ──→ :40001 (warp-svc SOCKS5) ──→ MASQUE 隧道 ──→ Cloudflare
```

---

## 为什么原项目占用这么高

分析原镜像的资源占用，主要瓶颈有 6 个：

### 1. Debian bullseye-slim 基础镜像（~150 MB）

```
$ docker images seiry/cloudflare-warp-proxy
REPOSITORY                     TAG       SIZE
seiry/cloudflare-warp-proxy    latest    ~180MB
```

解压后约 150 MB，包含完整的 Debian 用户态、glibc、coreutils 等。

### 2. cloudflare-warp apt 包（~80 MB 安装，~110 MB 运行时 RSS）

`cloudflare-warp` 包含：
- `warp-svc`：Rust 编写的守护进程（~80-120 MB RSS），负责 MASQUE 隧道
- `warp-cli`：控制工具
- DBus 依赖
- 大量共享库（libssl、libcrypto、libcurl 等）
- 遥测与日志子系统

`warp-svc` 本身是资源大户，但**这是必需的**——MASQUE 协议无法用纯 Node 重新实现。

### 3. socat 双跳（每条连接 2 个进程）

```
客户端 ──→ socat:40000 ──→ warp-svc:40001
            (fork)         (SOCKS5)
```

- `socat` 用 `fork` 模式，**每条连接 fork 一个 socat 子进程**
- 每条连接经历 2 次 TCP accept/connect
- 2 次内核态↔用户态数据拷贝
- 进程创建/销毁开销（fork + exit）

这是**最可优化的部分**——socat 纯粹是端口转发，完全可以用 Node 的 `pipe()` 替代，实现单进程零拷贝。

### 4. bash 入口脚本常驻

`entrypoint.sh` 中的 `socat ... &` 让 bash 一直挂着（虽然占用极小，~5 MB，但仍是浪费）。

### 5. 无资源限制

`warp-svc` 运行在无约束环境，无：
- 内存上限（cgroups limit）
- CPU 配额
- 文件描述符限制
- 连接数限制

突发流量时会无限膨胀。

### 6. 遥测与日志噪声

`warp-svc` 内置遥测上报与详细日志，在容器环境中产生不必要的 CPU 与磁盘 I/O。

---

## 本项目的优化策略

### 核心思路

> **官方 `warp-svc` 必须保留**（MASQUE 协议无法重写），但可以优化它**外层的包装**：消除 socat 双跳、消除 bash 开销、增加守护与可观测性、施加资源限制。

### 优化点详解

#### 1. 消除 socat —— 原生 Node SOCKS5/HTTP 代理

**原方案**：
```
客户端 → socat:40000 → warp-svc:40001
         (fork/连接)   (SOCKS5)
```

**本方案**：
```
客户端 → Node:40000 → warp-svc:40001
         (SOCKS5+HTTP CONNECT, 单进程, 零拷贝 pipe)
```

Node 代理同时支持：
- **SOCKS5**（RFC 1928）：完整实现，支持 IPv4/IPv6/域名
- **HTTP CONNECT**：用于 HTTPS 代理
- **普通 HTTP 代理**：重写绝对 URI 为相对路径

关键代码（`proxy-server.ts`）：
```typescript
// 零拷贝 pipe：客户端 ↔ 上游
client.on('data', (d) => { if (!upstream.write(d)) client.pause() })
upstream.on('data', (d) => { if (!client.write(d)) upstream.pause() })
client.on('drain', () => upstream.resume())
upstream.on('drain', () => client.resume())
```

**收益**：
- 每条连接少 1 个进程（无 socat fork）
- 少 1 次 TCP 跳转
- 背压处理（`pause`/`resume`）防止内存堆积

#### 2. 单 Node 守护进程替代 bash + socat

**原方案**：`exec warp-svc` + 后台 `socat &`（2 个常驻进程）

**本方案**：1 个 Node 进程同时承担：
- 代理服务器（替代 socat）
- warp-svc 生命周期管理（替代 bash 脚本）
- 指标采集
- WebSocket 推送

**收益**：常驻进程从 2 个降为 1 个（外加 warp-svc 本身）。

#### 3. 资源限制与背压

```typescript
// 最大连接数（DoS 防护）
if (conns.size >= config.maxConnections) {
  sock.destroy()
  return
}
// 空闲超时（资源回收）
ctx.idleTimer = setTimeout(() => closeConn(ctx, 'idle-timeout'), config.idleTimeoutMs)
```

Docker 部署时还可叠加：
- `mem_limit: 512m`（cgroups 内存上限）
- `cpus: '1.0'`（CPU 配额）
- `ulimit nofile`（文件描述符上限）

#### 4. 实时可观测性

新增 WebSocket 面板，1 秒粒度推送：
- CPU% / RSS / 堆内存
- 每秒吞吐量（rx/tx bytes/sec）
- 活动连接数 / 总连接数
- 实时日志流
- 连接事件（开/关/错误，含目标、字节、持续时间）

指标采集用低开销方式：读取 `/proc/self/stat`（CPU ticks）+ `process.memoryUsage()`，无需额外依赖。

#### 5. 优雅降级（演示模式）

无 root 或无 `CAP_NET_ADMIN` 时，`warp-svc` 无法启动。本项目自动检测并降级为**演示模式**：
- 代理仍可工作（直连目标，不走 WARP）
- 面板正常显示
- 状态明确标注「演示模式」

便于在受限环境（CI、开发机、本沙箱）评估与演示。

---

## 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│                         浏览器（用户）                            │
│                  http://localhost:3000                           │
└────────────────────────────┬─────────────────────────────────────┘
                             │ HTTP + WebSocket
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              dashboard (Next.js :3000)                           │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  page.tsx (中文界面)                                       │  │
│  │  - KPI 卡片 / 图表 / 控制面板 / 连接表 / 日志流            │  │
│  │  - useWarp() hook                                          │  │
│  └────────────────────────┬───────────────────────────────────┘  │
└───────────────────────────┼──────────────────────────────────────┘
                            │ fetch /api/* + io() WebSocket
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│            mini-services/warp-proxy (Node :3030)                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  ┌─────────┐ │
│  │ HTTP+WS 服务│  │ REST API     │  │ 指标采集    │  │ 日志    │ │
│  │ (socket.io) │  │ /api/*       │  │ 1s 粒度    │  │ 环形缓冲│ │
│  └──────┬──────┘  └──────────────┘  └────────────┘  └─────────┘ │
│         │                                                        │
│  ┌──────▼────────────────────────────────────────────────────┐  │
│  │  WarpManager (warp-svc 守护)                                │  │
│  │  - 检测/启动 warp-svc                                       │  │
│  │  - warp-cli 注册/模式/端口/连接管理                         │  │
│  │  - 状态轮询 (5s)                                            │  │
│  └──────┬────────────────────────────────────────────────────┘  │
│  ┌──────▼────────────────────────────────────────────────────┐  │
│  │  ProxyServer (原生 SOCKS5 + HTTP CONNECT, :40000)         │  │
│  │  - 零拷贝 pipe()                                            │  │
│  │  - 背压 / 空闲超时 / 最大连接数                            │  │
│  └──────┬────────────────────────────────────────────────────┘  │
└─────────┼────────────────────────────────────────────────────────┘
          │ TCP (SOCKS5 客户端 → warp-svc:40001)
          ▼
┌──────────────────────────────────────────────────────────────────┐
│                warp-svc (官方 Rust 守护进程, :40001)              │
│  - MASQUE 隧道协议                                              │
│  - Cloudflare WARP 网络                                         │
└────────────────────────────┬─────────────────────────────────────┘
                             │ MASQUE (UDP/443)
                             ▼
                    ┌─────────────────┐
                    │  Cloudflare 边缘 │
                    └─────────────────┘
                             │
                             ▼
                       互联网目标
```

---

## 组件职责

### 后端 `mini-services/warp-proxy/`

| 文件 | 职责 |
|------|------|
| `index.ts` | 入口：创建 HTTP+WS 服务器，启动代理与 warp-svc 守护 |
| `src/config.ts` | 环境变量配置加载 |
| `src/logger.ts` | 环形缓冲日志，发射 `log` 事件 |
| `src/warp-manager.ts` | warp-svc 生命周期管理（检测/启动/注册/连接/状态轮询） |
| `src/proxy-server.ts` | 原生 SOCKS5 + HTTP CONNECT + 普通 HTTP 代理（替代 socat） |
| `src/metrics.ts` | 低开销指标采集（CPU/RSS/堆/吞吐） |
| `src/api.ts` | REST API 路由 |

### 前端 `dashboard/`

| 文件 | 职责 |
|------|------|
| `src/app/page.tsx` | 主面板（中文界面，单页面） |
| `src/app/layout.tsx` | 根布局（`lang="zh-CN"`） |
| `src/lib/warp/use-warp.ts` | React hook：REST + socket.io 状态管理 |
| `src/lib/warp/types.ts` | 共享 TypeScript 类型 |
| `src/components/ui/*` | shadcn/ui 组件 |

---

## 数据流

### 1. 客户端代理请求

```
1. curl -x socks5h://127.0.0.1:40000 https://example.com
2. Node ProxyServer 接收 TCP 连接
3. 解析 SOCKS5 握手 → 提取目标 host:port
4. dialViaWarpSocks() → 连接 warp-svc:40001，发起 SOCKS5 客户端请求
5. warp-svc 通过 MASQUE 隧道连接目标
6. 双向 pipe(): 客户端 ↔ Node ↔ warp-svc ↔ 目标
7. 空闲超时或任一端关闭 → 清理连接，发射 connection:event
```

### 2. 实时监控数据

```
1. MetricsCollector 每秒读取 /proc/self/stat + memoryUsage()
2. 计算 CPU% / RSS / 堆 / 吞吐
3. 发射 'tick' 事件 → socket.io 广播 'metrics'
4. 浏览器 useWarp() 收到 → 更新 React state → recharts 重绘
```

### 3. WARP 控制操作

```
1. 用户点击「连接」按钮
2. fetch POST /api/warp/connect
3. WarpManager.connect() → spawn warp-cli connect
4. 轮询 warp-cli status → 状态变 connected
5. 发射 'status' 事件 → socket.io 广播 'warp:status'
6. 浏览器更新 KPI 卡片状态
```

---

## 关键技术决策

### 为什么用 Bun 而不是 Node.js 直接运行？

- **启动快**：Bun 启动比 Node 快 2-3 倍
- **内置 TypeScript**：无需编译步骤
- **兼容 Node API**：`node:net`、`node:http` 等完全兼容
- **性能**：HTTP/WS 处理更快

生产环境也可用 `node` 直接运行（`package.json` 中 `start` 脚本）。

### 为什么 socket.io 的 path 是 `/`？

因为沙箱环境用 Caddy 网关，通过 `XTransformPort` 查询参数路由到不同端口。socket.io 的 path 必须是 `/` 才能让 Caddy 正确转发 WebSocket 升级请求。

但这会导致 engine.io 吞掉所有 HTTP 请求。解决方案：用 `io.engine.use()` 中间件拦截 `/api/*`，让 REST 请求走我们的路由，其余请求落回 engine.io。

生产环境（Nginx 反代）建议用**同源模式**：`/api/*` 转发到 `:3030`，`/socket.io/` 转发到 `:3030`，其余转发到 `:3000`。

### 为什么保留 warp-svc 而不重写 MASQUE？

MASQUE 是基于 QUIC 的复杂协议，Cloudflare 的实现是闭源 Rust 代码。重新实现：
- 工程量巨大（数千行 Rust 级别）
- 无法保证与 Cloudflare 后端兼容
- 维护成本高（协议更新频繁）

**正确做法**：保留官方 `warp-svc`，优化其外层包装。这正是本项目的策略。

### 为什么用 `net.createConnection` 而不是 `new Socket() + connect()`？

实测在 Bun 运行时中，`new Socket()` + 手动 `setTimeout` + `s.connect()` 的组合偶尔不触发 `connect` 事件（疑似 Bun 的 socket 事件循环集成问题）。改用 `net.createConnection({host, port}, cb)` 后稳定可靠。

### 为什么禁用 `bun --hot`？

`bun --hot` 文件监听热重载在重启时会因为端口未及时释放而 `EADDRINUSE`。对于长时间运行的服务，热重载无必要，故禁用。

---

## 性能对比

### 内存占用（空闲状态）

| 组件 | 原项目 | 本项目 |
|------|--------|--------|
| Debian base | ~30 MB RSS | 0（主机共享） |
| warp-svc | ~80-110 MB RSS | ~80-110 MB RSS（相同） |
| socat | ~5 MB × N 连接 | 0（已消除） |
| bash 入口 | ~3 MB | 0（已消除） |
| Node 守护 | 0 | ~30 MB（堆 ~4 MB） |
| **合计** | **~118 MB + N×5 MB** | **~110-140 MB（固定）** |

> 注：warp-svc 本身占用两项目相同。本项目的优化在**外层**：消除 socat 的每连接 fork 开销，使内存占用与连接数解耦。

### 每连接开销

| 维度 | 原项目 | 本项目 |
|------|--------|--------|
| 进程数 | 2（socat fork + warp-svc） | 0 新增（Node 事件循环） |
| TCP 跳数 | 2 | 1 |
| 内存 | ~5 MB/连接（socat fork） | ~几 KB/连接（socket buffer） |
| fork 开销 | 有 | 无 |

### 1000 并发连接对比

| 指标 | 原项目 | 本项目 |
|------|--------|--------|
| 额外内存 | ~5 GB（socat fork） | ~几 MB（socket buffer） |
| CPU | 持续 fork/exit | 事件循环 |
| 文件描述符 | 2× 连接数 | 1× 连接数 |
