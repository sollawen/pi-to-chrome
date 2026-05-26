#!/bin/bash
# 在 Mac 上启动 Chrome 并开启远程调试端口
# 用法: ./start-chrome.sh

# 先关掉已有的 Chrome
pkill -f "Google Chrome" 2>/dev/null
sleep 1

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome-Debug" \
  2>/dev/null &

echo "✅ Chrome 已启动（调试端口 9222）"
