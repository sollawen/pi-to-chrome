
## 原因分析

以 `/new` 命令为例，执行顺序是：

```
1. runtimeHost.newSession()
   ├─ teardownCurrent()        → 发射 session_shutdown
   ├─ createRuntime()          → 创建新 session
   └─ finishSessionReplacement()
       └─ rebindSession()
           └─ bindCurrentSessionExtensions()
               ├─ session.bindExtensions()
               │   ├─ runner.setUIContext(uiContext)   ← UI 上下文已绑定
               │   └─ runner.emit("session_start")     ← ★ 你的 handler 在这里运行
               │       └─ ctx.ui.notify() → showStatus() → 向 chatContainer 添加文本 ✓
               └─ showLoadedResources()
2. renderCurrentSessionState()                            ← ★ 这里 chatContainer.clear() 把你的通知清掉了！
3. 添加 "✓ New session started"
```

**`ctx.ui.notify()` 实际上执行成功了**，它把文本加到了 `chatContainer`。但 `session_start` handler 跑完之后，`handleClearCommand()` 调用了 `renderCurrentSessionState()` → `this.chatContainer.clear()`，把你加的通知清掉了。

而你用 `pi.sendMessage()` 能显示是因为：消息被持久化到了 session 里，`renderCurrentSessionState()` 清空容器后又调用了 `renderInitialMessages()`，会重新渲染 session 中的消息。

**结论**：这是 pi 的时序问题 — `session_start` 发射时机太早，之后 chat 会被清空重绘。`ctx.ui.notify()` 是即时的、非持久化的，所以被后续的 `clear()` 吃掉了。`sendMessage` 是持久化的，能活过重绘。

你目前用 `sendMessage` 的做法已经是正确的 workaround。如果想要更好看，可以考虑：
- 用 `ctx.ui.setWidget()` — widget 在 editor 上方的独立容器里，不受 `chatContainer.clear()` 影响
- 或者继续用 `sendMessage` 但搭配自定义 renderer（`pi.registerMessageRenderer`）来控制显示样式
