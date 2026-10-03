# ====================================================================
# WARP 控制中心 —— 单容器 Dockerfile
# 同时包含: warp-svc + Node 守护进程 + Next.js 面板
# ====================================================================

# ---------- 阶段 1: 构建前端面板 ----------
FROM node:20-slim AS dashboard-builder

WORKDIR /build/dashboard
COPY dashboard/package.json dashboard/package.json
RUN npm install --no-audit --no-fund

COPY dashboard/ ./
COPY tsconfig.json next.config.ts tailwind.config.ts postcss.config.mjs components.json eslint.config.mjs ./
# globals.css 依赖 tw-animate-css，已在 package.json
RUN npm run build

# ---------- 阶段 2: 运行时 ----------
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 安装系统依赖 + cloudflare-warp 客户端
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        gnupg ca-certificates curl socat \
        && \
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | \
        gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg && \
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" \
        > /etc/apt/sources.list.d/cloudflare-client.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends cloudflare-warp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 安装 Bun 运行时（用于运行 Node 守护进程，性能优于 node）
RUN curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun

# 复制后端服务
WORKDIR /app
COPY mini-services/warp-proxy/package.json mini-services/warp-proxy/package.json
COPY mini-services/warp-proxy/ ./mini-services/warp-proxy/
RUN cd mini-services/warp-proxy && bun install --production

# 复制前端构建产物（standalone 模式）
COPY --from=dashboard-builder /build/dashboard/.next/standalone ./dashboard-standalone/
COPY --from=dashboard-builder /build/dashboard/.next/static ./dashboard-standalone/.next/static/
COPY --from=dashboard-builder /build/dashboard/public ./dashboard-standalone/public/

# 复制启动脚本
COPY deploy/docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 环境变量默认值
ENV PROXY_PORT=40000 \
    CONTROL_PORT=3030 \
    UPSTREAM_HOST=127.0.0.1 \
    UPSTREAM_PORT=40001 \
    AUTO_CONNECT=false \
    MAX_CONNECTIONS=2048 \
    IDLE_TIMEOUT_MS=120000 \
    METRICS_INTERVAL_MS=1000 \
    LOG_BUFFER_SIZE=500 \
    NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NEXT_PUBLIC_WARP_API_BASE=

# 暴露端口: 40000 代理 / 3000 面板
EXPOSE 40000 3000

# 健康检查（控制面）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fs http://127.0.0.1:3030/api/health || exit 1

# warp-svc 需要 CAP_NET_ADMIN（docker-compose 已配置）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
