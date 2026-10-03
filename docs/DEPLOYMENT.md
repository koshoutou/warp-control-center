# 部署指南

本文档详细介绍 WARP 控制中心的多种部署方式。

## 目录

- [方式一：Docker Compose（推荐）](#方式一docker-compose推荐)
- [方式二：裸机 / systemd](#方式二裸机--systemd)
- [方式三：仅后端（无面板）](#方式三仅后端无面板)
- [Nginx 反向代理（生产推荐）](#nginx-反向代理生产推荐)
- [Zero Trust 企业组织部署](#zero-trust-企业组织部署)
- [环境变量配置](#环境变量配置)
- [健康检查与排障](#健康检查与排障)
- [升级与卸载](#升级与卸载)

---

## 方式一：Docker Compose（推荐）

最简单的方式，一条命令启动面板 + 代理 + warp-svc。

### 前置要求

- Docker 20.10+
- Docker Compose v2+

### 步骤

```bash
git clone https://github.com/koshoutou/warp-control-center.git
cd warp-control-center

# （可选）配置 WARP+ 许可证
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，填入 LICENSE=your-key

# 构建并启动
docker compose -f deploy/docker-compose.yml up -d --build

# 查看日志
docker compose -f deploy/docker-compose.yml logs -f

# 查看状态
docker compose -f deploy/docker-compose.yml ps
```

### 访问

- **监控面板**：`http://<服务器IP>:3000`
- **代理**：`socks5h://<服务器IP>:40000`

### 停止与清理

```bash
# 停止
docker compose -f deploy/docker-compose.yml down

# 停止并删除数据（WARP 注册状态）
docker compose -f deploy/docker-compose.yml down -v
```

### 架构

```
┌─────────────────────────────────────────────────────────┐
│  Docker Compose (deploy/docker-compose.yml)             │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  容器: warp-control-center                        │  │
│  │                                                   │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────┐  │  │
│  │  │ Next.js     │  │ Node 守护    │  │ warp-svc │  │  │
│  │  │ 面板 :3000  │←→│ + 代理 :40000│←→│ :40001   │  │  │
│  │  └─────────────┘  └──────────────┘  └──────────┘  │  │
│  │         ↑                ↑                        │  │
│  │      浏览器           客户端                       │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 方式二：裸机 / systemd

适合已有服务器、不想用 Docker 的场景。

### 前置要求

- Debian 11+ / Ubuntu 20.04+ / 其他支持 cloudflare-warp 的 Linux
- Node.js 20+ 或 Bun 1.1+
- root 权限（安装 cloudflare-warp 包）

### 步骤 1：安装 Cloudflare WARP 客户端

```bash
# Debian/Ubuntu
curl https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflare-client.list
apt update && apt install -y cloudflare-warp

# 验证
warp-cli --version
```

### 步骤 2：安装 Bun 运行时

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

### 步骤 3：克隆项目

```bash
git clone https://github.com/koshoutou/warp-control-center.git
cd warp-control-center
```

### 步骤 4：安装后端依赖

```bash
cd mini-services/warp-proxy
bun install
cd ../..
```

### 步骤 5：安装前端依赖并构建

```bash
cd dashboard
bun install
bun run build
cd ..
```

### 步骤 6：配置环境变量

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env
```

### 步骤 7：安装 systemd 服务

```bash
# 后端服务
sudo cp deploy/systemd/warp-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload

# 前端服务
sudo cp deploy/systemd/warp-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload

# 启动
sudo systemctl enable --now warp-svc        # 官方 warp-svc
sudo systemctl enable --now warp-proxy      # 本项目后端
sudo systemctl enable --now warp-dashboard  # 本项目前端

# 查看状态
sudo systemctl status warp-proxy warp-dashboard
```

### 步骤 8：访问

- 面板：`http://<服务器IP>:3000`
- 代理：`socks5h://<服务器IP>:40000`

---

## 方式三：仅后端（无面板）

只需要代理功能，不需要监控面板：

```bash
cd mini-services/warp-proxy
bun install
# 启动（会自动检测 warp-svc 并连接）
sudo AUTO_CONNECT=true bun run dev
```

此时只有代理端口 `40000` 可用，无面板。

---

## Nginx 反向代理（生产推荐）

将面板与代理统一在同一域名下，启用 HTTPS。

### 推荐配置（同源模式）

设置 `dashboard/.env.local`：
```
# 同源模式：不设置 CONTROL_PORT 和 BASE_URL
# 由 Nginx 将 /api/* 转发到 :3030，其余转发到 :3000
```

Nginx 配置（详见 `deploy/nginx/warp-control-center.conf`）：

```nginx
server {
    listen 443 ssl http2;
    server_name warp.example.com;

    ssl_certificate     /etc/ssl/certs/warp.pem;
    ssl_certificate_key /etc/ssl/private/warp.key;

    # 后端 API（:3030）
    location /api/ {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # socket.io WebSocket 升级（:3030）
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 60000;
    }

    # 面板（Next.js :3000）
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Next.js HMR（开发模式）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

---

## Zero Trust 企业组织部署

将设备注册到 Cloudflare Zero Trust 组织（用于接入企业内网或合作伙伴网络）。

### 1. 创建服务令牌

参考 [Cloudflare 官方文档](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/deployment/device-enrollment/#check-for-service-token)：

- **Access controls → Service credentials → Service Tokens → Create Service Token**
- 复制 Client ID（以 `.access` 结尾）和 Client Secret（仅显示一次）
- **Team & Resources → Devices → Management → Device enrollment permissions → Manage → Policies → Create policy**
- 设置 **Action = `Service Auth`**（不是 `Allow`），Selector 选择你的令牌，保存

### 2. 编写 `mdm.xml`

```xml
<dict>
    <!-- 合作伙伴端点覆盖（如中国本地网络合作伙伴） -->
    <key>override_api_endpoint</key>
    <string>1.1.1.1</string>
    <key>override_doh_endpoint</key>
    <string>1.1.1.1</string>
    <key>override_warp_endpoint</key>
    <string>1.1.1.1:443</string>

    <!-- Zero Trust 注册（服务令牌） -->
    <key>organization</key>
    <string>your-team-name</string>
    <key>auth_client_id</key>
    <string>xxxxxxxx.access</string>
    <key>auth_client_secret</key>
    <string>xxxxxxxxxxxxxxxx</string>

    <!-- 代理模式仅支持 MASQUE -->
    <key>warp_tunnel_protocol</key>
    <string>masque</string>

    <!-- 本地 SOCKS 代理端口（Node 守护进程会转发 40000 → 40001） -->
    <key>service_mode</key>
    <string>proxy</string>
    <key>proxy_port</key>
    <integer>40001</integer>
    <key>onboarding</key>
    <false/>
</dict>
```

> ⚠️ **安全提醒**：`mdm.xml` 含敏感凭据，**绝不提交到仓库**（已在 `.gitignore` 中排除）。请通过 Docker secret、环境变量或只读挂载方式注入。

### 3. 挂载运行

**Docker Compose：**

```yaml
services:
  warp-control-center:
    volumes:
      - ./mdm.xml:/var/lib/cloudflare-warp/mdm.xml:ro
```

**裸机：**

```bash
sudo cp mdm.xml /var/lib/cloudflare-warp/mdm.xml
sudo systemctl restart warp-svc
```

### 4. 验证

在 Zero Trust 控制台 **My Team → Devices** 中应看到以 `non_identity@<team-name>.cloudflareaccess.com` 邮箱注册的设备。

---

## 环境变量配置

### 后端（`mini-services/warp-proxy`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | `40000` | 代理监听端口 |
| `CONTROL_PORT` | `3030` | 控制面（REST + WS）端口 |
| `UPSTREAM_HOST` | `127.0.0.1` | warp-svc 主机 |
| `UPSTREAM_PORT` | `40001` | warp-svc 代理端口 |
| `WARP_SVC_PATH` | `warp-svc` | warp-svc 可执行文件路径 |
| `WARP_CLI_PATH` | `warp-cli` | warp-cli 可执行文件路径 |
| `LICENSE` | （空） | WARP+ 许可证密钥 |
| `MDM_FILE` | `/var/lib/cloudflare-warp/mdm.xml` | MDM 配置文件路径 |
| `AUTO_CONNECT` | `false` | 启动时自动连接 WARP |
| `LOG_BUFFER_SIZE` | `500` | 日志环形缓冲区大小 |
| `METRICS_INTERVAL_MS` | `1000` | 指标采集间隔 |
| `FORCE_DEMO` | `false` | 强制演示模式（跳过 warp-svc 检测） |
| `MAX_CONNECTIONS` | `2048` | 最大并发连接数 |
| `IDLE_TIMEOUT_MS` | `120000` | 连接空闲超时（毫秒） |

### 前端（`dashboard`）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXT_PUBLIC_WARP_CONTROL_PORT` | （空） | 网关查询模式：后端端口（如 `3030`） |
| `NEXT_PUBLIC_WARP_BASE_URL` | （空） | 直连模式：后端完整 URL（如 `http://127.0.0.1:3030`） |
| `NEXT_PUBLIC_WARP_PROXY_PORT` | `40000` | 面板展示的代理端口 |

**部署模式选择**：
- **同源模式**（生产推荐）：不设置上述变量，由 Nginx 反代统一路由
- **网关查询模式**（Caddy 网关）：设置 `NEXT_PUBLIC_WARP_CONTROL_PORT=3030`
- **直连模式**（开发）：设置 `NEXT_PUBLIC_WARP_BASE_URL=http://127.0.0.1:3030`

---

## 健康检查与排障

### 健康检查

```bash
# 后端健康
curl http://127.0.0.1:3030/api/health
# 期望: {"ok":true,"t":...}

# 完整状态
curl http://127.0.0.1:3030/api/status

# 代理功能测试
curl https://www.cloudflare.com/cdn-cgi/trace -x socks5h://127.0.0.1:40000
# 期望输出包含 warp=on
```

### 常见问题

**Q: 面板显示「演示模式」？**

A: 后端未检测到 `warp-svc`。检查：
```bash
which warp-svc warp-cli
systemctl status warp-svc
```
确保 `cloudflare-warp` 包已安装且 `warp-svc` 正在运行。Docker 部署则检查容器是否以 `--cap-add NET_ADMIN` 启动（compose 文件已配置）。

**Q: 面板显示「无法连接到 WARP 控制面」？**

A: 后端 `:3030` 未启动或被防火墙拦截。检查：
```bash
curl http://127.0.0.1:3030/api/health
sudo systemctl status warp-proxy
```

**Q: 代理连接超时？**

A: 
1. WARP 未连接：在面板点「连接」按钮，或 `warp-cli connect`
2. 端口被占用：`ss -tlnp | grep 40000`
3. 防火墙：放行 40000 端口

**Q: `warp=off`？**

A: WARP 隧道未建立。检查：
```bash
warp-cli status
warp-cli connect
warp-cli status  # 应显示 Connected
```

**Q: Docker 容器反复重启？**

A: 查看日志：
```bash
docker compose -f deploy/docker-compose.yml logs warp-control-center
```
常见原因：`warp-svc` 需要 `CAP_NET_ADMIN`，compose 文件已配置，但若用 `docker run` 需手动加 `--cap-add NET_ADMIN`。

---

## 升级与卸载

### 升级

**Docker：**
```bash
cd warp-control-center
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

**裸机：**
```bash
cd warp-control-center
git pull
cd mini-services/warp-proxy && bun install && cd ../..
cd dashboard && bun install && bun run build && cd ..
sudo systemctl restart warp-proxy warp-dashboard
```

### 卸载

**Docker：**
```bash
docker compose -f deploy/docker-compose.yml down -v
docker rmi warp-control-center:latest
```

**裸机：**
```bash
sudo systemctl disable --now warp-proxy warp-dashboard
sudo rm /etc/systemd/system/warp-{proxy,dashboard}.service
sudo systemctl daemon-reload

# 卸载 WARP 客户端
sudo apt remove --purge cloudflare-warp -y
sudo rm -rf /var/lib/cloudflare-warp/
```
