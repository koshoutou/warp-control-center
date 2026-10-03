# API 参考

后端控制面（`mini-services/warp-proxy`，默认端口 `3030`）提供的 REST API 与 WebSocket 事件。

## 目录

- [REST API](#rest-api)
- [WebSocket 事件](#websocket-事件)
- [数据结构](#数据结构)

---

## REST API

所有路径前缀 `/api/`。响应均为 JSON。

### `GET /api/health`

健康检查。

**响应**：
```json
{ "ok": true, "t": 1696312345678 }
```

---

### `GET /api/status`

获取完整状态快照（面板首次加载时调用）。

**响应**：
```json
{
  "warp": {
    "state": "connected",
    "installed": true,
    "cliInstalled": true,
    "running": true,
    "mode": "proxy",
    "port": 40001,
    "version": "warp-cli 2024.1.1",
    "demo": false,
    "pid": 1234,
    "lastChecked": 1696312345678,
    "lastError": null
  },
  "proxy": {
    "listening": true,
    "port": 40000,
    "connections": 3,
    "totalConnections": 42,
    "activeRx": 51200,
    "activeTx": 8192,
    "totalRx": 1048576,
    "totalTx": 131072,
    "rejected": 0,
    "demo": false
  },
  "process": {
    "t": 1696312345678,
    "rssMB": 30.5,
    "heapUsedMB": 4.2,
    "heapTotalMB": 6.0,
    "cpuPct": 1.5,
    "pid": 1234,
    "connections": 3,
    "totalConnections": 42,
    "rxBytesPerSec": 51200,
    "txBytesPerSec": 8192,
    "warpState": "connected",
    "warpDemo": false
  },
  "config": {
    "proxyPort": 40000,
    "controlPort": 3030,
    "upstreamHost": "127.0.0.1",
    "upstreamPort": 40001,
    "demoMode": false,
    "warpSvcPath": "warp-svc",
    "warpCliPath": "warp-cli",
    "licenseConfigured": false,
    "mode": "proxy"
  }
}
```

---

### `GET /api/metrics/history?limit=300`

获取历史指标采样（默认 300 条，最大 600 条）。

**查询参数**：
- `limit`：返回条数，默认 300，最大 600

**响应**：`MetricSample[]`，见 [数据结构](#metricsample)。

---

### `GET /api/logs?limit=200`

获取历史日志（环形缓冲区，默认 200 条，最大 2000 条）。

**查询参数**：
- `limit`：返回条数，默认 200，最大 2000

**响应**：`LogLine[]`，见 [数据结构](#logline)。

---

### `POST /api/warp/connect`

连接 WARP（注册 + 设置代理模式 + 连接）。

**请求体**：无

**响应**：
```json
{ "ok": true, "message": "Success." }
```

失败时：
```json
{ "ok": false, "message": "warp-cli not installed" }
```

---

### `POST /api/warp/disconnect`

断开 WARP。

**响应**：
```json
{ "ok": true, "message": "Success." }
```

---

### `POST /api/warp/restart`

重启 WARP（断开后重新连接）。

**响应**：
```json
{ "ok": true, "message": "Success." }
```

---

### `POST /api/warp/register`

使用许可证密钥注册并连接。

**请求体**：
```json
{ "license": "your-warp-plus-license-key" }
```

**响应**：
```json
{ "ok": true, "message": "Success." }
```

---

### `POST /api/trace`

执行链路测试（通过本地代理请求 `https://www.cloudflare.com/cdn-cgi/trace`）。

**响应**：
```json
{
  "ok": true,
  "trace": "fl=...\nh=www.cloudflare.com\nip=...\nwarp=on\n...",
  "warp": "on"
}
```

演示模式下返回合成的示例 trace：
```json
{
  "ok": true,
  "demo": true,
  "trace": "fl=...\nwarp=on\n...",
  "warp": "on"
}
```

---

## WebSocket 事件

连接：`io('/', { transports: ['websocket', 'polling'] })`

### 服务端 → 客户端

#### `snapshot`

连接建立后立即推送一次，包含完整状态快照。

**载荷**：
```json
{
  "status": { /* WarpStatus */ },
  "proxy": { /* ProxyStats */ },
  "process": { /* MetricSample */ },
  "config": { /* PublicConfig */ },
  "logs": [ /* LogLine[] */ ],
  "history": [ /* MetricSample[] */ ]
}
```

---

#### `metrics`

每秒推送一次指标采样。

**载荷**：`MetricSample`，见 [数据结构](#metricsample)。

---

#### `log`

每产生一条日志即推送。

**载荷**：`LogLine`，见 [数据结构](#logline)。

---

#### `connection:event`

连接事件（开/关/错误）。

**载荷**：
```json
{
  "type": "open" | "close" | "error",
  "id": 42,
  "host": "example.com",
  "port": 443,
  "rx": 5120,
  "tx": 1024,
  "durationMs": 1234,
  "reason": "client-end"
}
```

---

#### `warp:status`

WARP 状态变化时推送。

**载荷**：`WarpStatus`，见 [数据结构](#warpstatus)。

---

#### `traffic`

吞吐量增量（可选，部分实现）。

**载荷**：
```json
{ "rx": 1024, "tx": 512 }
```

---

### 客户端 → 服务端

无自定义事件。客户端仅需监听上述事件并维护 `connect`/`disconnect` 状态。

---

## 数据结构

### WarpStatus

WARP 守护进程状态。

| 字段 | 类型 | 说明 |
|------|------|------|
| `state` | `WarpState` | `unknown` / `disconnected` / `connecting` / `connected` / `error` / `demo` |
| `installed` | `boolean` | warp-svc 是否安装 |
| `cliInstalled` | `boolean` | warp-cli 是否安装 |
| `running` | `boolean` | warp-svc 是否运行 |
| `mode` | `string` | 模式（`proxy`） |
| `port` | `number` | warp-svc 本地代理端口 |
| `version` | `string` | warp-cli 版本 |
| `demo` | `boolean` | 是否演示模式 |
| `pid` | `number?` | warp-svc PID（若由本服务启动） |
| `lastChecked` | `number` | 最后检查时间戳 |
| `lastError` | `string?` | 最后错误信息 |

---

### ProxyStats

代理服务器统计。

| 字段 | 类型 | 说明 |
|------|------|------|
| `listening` | `boolean` | 是否监听中 |
| `port` | `number` | 监听端口 |
| `connections` | `number` | 当前活动连接数 |
| `totalConnections` | `number` | 累计连接数 |
| `activeRx` | `number` | 当前每秒接收字节 |
| `activeTx` | `number` | 当前每秒发送字节 |
| `totalRx` | `number` | 累计接收字节 |
| `totalTx` | `number` | 累计发送字节 |
| `rejected` | `number` | 拒绝连接数（超 maxConnections） |
| `demo` | `boolean` | 是否演示模式 |

---

### MetricSample

单次指标采样。

| 字段 | 类型 | 说明 |
|------|------|------|
| `t` | `number` | 时间戳 |
| `rssMB` | `number` | 进程 RSS（MB） |
| `heapUsedMB` | `number` | V8 堆已用（MB） |
| `heapTotalMB` | `number` | V8 堆总量（MB） |
| `cpuPct` | `number` | CPU 占用率（0-100，单核） |
| `pid` | `number` | 进程 PID |
| `connections` | `number` | 活动连接数 |
| `totalConnections` | `number` | 累计连接数 |
| `rxBytesPerSec` | `number` | 每秒接收字节 |
| `txBytesPerSec` | `number` | 每秒发送字节 |
| `warpState` | `string` | WARP 状态 |
| `warpDemo` | `boolean` | 是否演示模式 |

---

### LogLine

单条日志。

| 字段 | 类型 | 说明 |
|------|------|------|
| `t` | `number` | 时间戳 |
| `level` | `LogLevel` | `debug` / `info` / `warn` / `error` |
| `cat` | `string` | 分类（如 `warp`、`proxy`、`boot`） |
| `msg` | `string` | 消息内容 |

---

### ConnEvent

连接事件。

| 字段 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | `open` / `close` / `error` |
| `id` | `number` | 连接 ID |
| `host` | `string?` | 目标主机 |
| `port` | `number?` | 目标端口 |
| `rx` | `number?` | 接收字节 |
| `tx` | `number?` | 发送字节 |
| `durationMs` | `number?` | 持续时间（毫秒） |
| `reason` | `string?` | 关闭原因 |

---

### PublicConfig

公开配置（不含敏感信息）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `proxyPort` | `number` | 代理端口 |
| `controlPort` | `number` | 控制面端口 |
| `upstreamHost` | `string` | 上游主机 |
| `upstreamPort` | `number` | 上游端口 |
| `demoMode` | `boolean` | 是否强制演示模式 |
| `warpSvcPath` | `string` | warp-svc 路径 |
| `warpCliPath` | `string` | warp-cli 路径 |
| `licenseConfigured` | `boolean` | 是否配置了许可证 |
| `mode` | `string` | 模式 |
