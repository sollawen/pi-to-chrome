#!/bin/bash
# 在 Mac 上建立 SSH 反向隧道到 Linux 服务器
# 用法: ./start-tunnel.sh [user@host]  默认: Solla@208

TARGET="${1:-Solla@208}"

# 先关掉已有的隧道
pkill -f "ssh -fN -R 9222" 2>/dev/null
sleep 1

ssh -fN -R 9222:127.0.0.1:9222 "$TARGET"

if [ $? -eq 0 ]; then
  echo "✅ SSH 隧道已建立 → $TARGET"
else
  echo "❌ 隧道建立失败"
fi
