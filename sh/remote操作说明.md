# 远程连接 Chrome 操作说明

## 场景

Pi 在 Linux 服务器上，Chrome 在 Mac 上。

## Mac 上操作（2 步，顺序随便）

### 第 1 步：启动 Chrome

```bash
./start-chrome.sh
```

### 第 2 步：建立 SSH 隧道

```bash
./start-tunnel.sh
```

默认连接 `Solla@208`，如需指定其他服务器：

```bash
./start-tunnel.sh user@other-server
```

> 两个步骤都不需要保留终端窗口。

## Linux 上操作

在 Pi 中执行：

```
/chrome-start --remote
```

## 收尾

在 Mac 上关掉隧道：

```bash
./close-tunnel.sh
```

---

## 如果在 Mac 本地开发

不需要隧道，直接在 Pi 中执行：

```
/chrome-start
```

---

## 常见问题

**Q：Chrome 关掉后重新打开，隧道还能用吗？**
A：隧道还在，但重新打开 Chrome 时要用 `./start-chrome.sh`，不能双击图标启动。

**Q：怎么确认隧道还在不在？**
A：在 Mac 终端执行 `ps aux | grep "ssh.*9222"`，有结果就是还在。

**Q：怎么确认 Chrome 调试端口开没开？**
A：在 Mac 终端执行 `curl -s http://127.0.0.1:9222/json/version`，有 JSON 输出就是开了。
