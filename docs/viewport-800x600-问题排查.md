# Viewport 自动变成 800×600 问题排查

## 现象

- Chrome 页面的 viewport 不定时自动变回 800×600
- `window.innerWidth` / `window.innerHeight` 变为 800×600
- `window.outerWidth` / `window.outerHeight` 正常（如 1280×770）
- 用户手动刷新页面后容易触发
- 重新最大化窗口无法恢复（inner 还是 800×600）

## 根因

**孤儿 CDP 连接**。

800×600 是 puppeteer 的 `DEFAULT_VIEWPORT` 硬编码值（见 `puppeteer-core/lib/cjs/puppeteer/common/util.js`）。

当存在残留的 puppeteer CDP 连接时（如 pi 重启后旧进程未清理、调试脚本未正常退出），该连接可能带着默认的 `defaultViewport: { width: 800, height: 600 }`。页面刷新时的触发链：

```
页面刷新 → Chrome 触发 targetCreated
         → 孤儿连接的 browser.on('targetcreated') 回调
         → target.page()
         → CdpPage._create(client, target, defaultViewport)
         → page.setViewport({ width: 800, height: 600 })
         → viewport 被覆盖
```

**关键证据**：
1. 杀掉孤儿进程后，刷新不再触发问题
2. 用原始 WebSocket 被动监听 CDP 流量，看不到 pi 连接发送任何 Emulation 命令
3. 本项目的 `connectChrome()` 已正确传入 `defaultViewport: null`，不是主连接的锅

## 排查方法

### 1. 确认 viewport 状态

```js
// 在 chrome_execute_js 中
JSON.stringify({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  outerWidth: window.outerWidth,
  outerHeight: window.outerHeight,
  screenX: window.screenX,
  screenY: window.screenY
})
```

如果 `innerWidth/Height` = 800×600 但 `outerWidth/Height` 正常 → 说明有 CDP Device Metrics Override。

### 2. 检查残留连接

```bash
ss -tnp | grep 9222
```

正常应该只有 pi 一个连接。如果看到多个 node 进程连到 9222，检查是否有孤儿进程：

```bash
ps -p <pid> -o pid,ppid,comm,args
```

`ppid=1` 且命令是旧的调试脚本 → 孤儿进程，需要 kill。

### 3. 临时修复 viewport

```js
// 方法1：通过 CDP 清除 override（不一定有效，如果窗口本身就小了）
await client.send('Emulation.clearDeviceMetricsOverride');

// 方法2：直接设置正确的 viewport
await client.send('Emulation.setDeviceMetricsOverride', {
  width: 1280, height: 683, deviceScaleFactor: 2, mobile: false
});

// 方法3：重新最大化窗口（先 normal 再 maximized）
const { windowId } = await client.send('Browser.getWindowForTarget');
await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
```

### 4. 被动监听 CDP 流量（排查谁在改 viewport）

```js
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/browser/<browser-session-id>');
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.method?.includes('Emulation.setDevice')) {
    console.log('🎯 谁在改 viewport:', msg.method, JSON.stringify(msg.params));
  }
});
```

## 本项目的防护措施

1. **连接时传 `defaultViewport: null`**（`core/browser.ts:175`）
   - 已正确设置，不会主动覆盖 viewport

2. **`console-buffer.ts` 的 `targetcreated` 监听**
   - 只做 `page.on('console', ...)`，不会触发 viewport 设置
   - 但如果未来有人在回调中调用 `target.page()` 并手动设置 viewport，需要注意

3. **`session_shutdown` 清理**（`index.ts` 末尾）
   - 断开连接并清理 console buffer 监听

## 经验教训

- 调试脚本用 `puppeteer.connect()` 后一定要确保正常退出，否则会残留 CDP 连接
- `browser.disconnect()` 只断开 CDP WebSocket，不会关闭 Chrome
- 页面刷新会触发 `targetcreated` 事件，所有活跃的 CDP 连接都会收到
- puppeteer 的 `DEFAULT_VIEWPORT = { width: 800, height: 600 }` 是常见陷阱
