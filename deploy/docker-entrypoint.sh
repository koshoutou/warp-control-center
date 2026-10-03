#!/bin/bash
# ====================================================================
# WARP 控制中心 —— 容器入口脚本
# 启动顺序: warp-svc → Node 守护进程(代理+控制面) → Next.js 面板
# ====================================================================
set -e

echo "[entrypoint] 启动 WARP 控制中心..."

# ---------- 1. 启动 warp-svc（后台）----------
echo "[entrypoint] 启动 warp-svc..."
mkdir -p /var/lib/cloudflare-warp
# warp-svc 需要 DBus
mkdir -p /run/dbus
dbus-daemon --system --fork 2>/dev/null || true
warp-svc &
WARP_SVC_PID=$!

# 等待 warp-svc 就绪
echo "[entrypoint] 等待 warp-svc 就绪..."
for i in $(seq 1 30); do
    if warp-cli --accept-tos status >/dev/null 2>&1; then
        echo "[entrypoint] warp-svc 已就绪"
        break
    fi
    sleep 1
done

# ---------- 2. 注册与配置 ----------
# 若挂载了 mdm.xml（Zero Trust），warp-svc 会自动注册；否则创建消费版注册
if [ ! -f /var/lib/cloudflare-warp/mdm.xml ]; then
    echo "[entrypoint] 消费版注册..."
    warp-cli --accept-tos registration new 2>/dev/null || true
fi

# 设置代理模式（消费版；Zero Trust 由 org profile 控制，会失败但可忽略）
warp-cli --accept-tos mode proxy 2>/dev/null || true
warp-cli --accept-tos proxy port 40001 2>/dev/null || true

# 应用许可证（若有）
LICENSE="${LICENSE#[\"\']}"
LICENSE="${LICENSE%[\"\']}"
if [ -n "$LICENSE" ]; then
    echo "[entrypoint] 应用 WARP+ 许可证..."
    warp-cli --accept-tos registration license "$LICENSE" 2>/dev/null || true
fi

# 自动连接
if [ "$AUTO_CONNECT" = "true" ]; then
    echo "[entrypoint] 自动连接 WARP..."
    warp-cli --accept-tos connect 2>/dev/null || true
fi

# ---------- 3. 启动 Node 守护进程（代理 + 控制面）----------
echo "[entrypoint] 启动 Node 守护进程（代理 :40000 + 控制面 :3030）..."
cd /app/mini-services/warp-proxy
bun index.ts &
NODE_PID=$!

# ---------- 4. 启动 Next.js 面板 ----------
echo "[entrypoint] 启动 Next.js 面板 (:3000)..."
cd /app/dashboard-standalone
node server.js &
DASHBOARD_PID=$!

# ---------- 5. 信号处理与等待 ----------
trap "echo '[entrypoint] 收到终止信号，停止所有服务...'; kill $WARP_SVC_PID $NODE_PID $DASHBOARD_PID 2>/dev/null; exit 0" SIGTERM SIGINT

# 等待任一进程退出
wait -n $WARP_SVC_PID $NODE_PID $DASHBOARD_PID 2>/dev/null || true
echo "[entrypoint] 某个进程已退出，停止所有服务..."
kill $WARP_SVC_PID $NODE_PID $DASHBOARD_PID 2>/dev/null || true
exit 0
