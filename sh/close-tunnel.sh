#!/bin/bash
# 关闭 SSH 反向隧道
# 用法: ./close-tunnel.sh

pkill -f "ssh -fN -R 9222" 2>/dev/null

if [ $? -eq 0 ]; then
  echo "✅ SSH 隧道已关闭"
else
  echo "没有运行中的隧道"
fi
