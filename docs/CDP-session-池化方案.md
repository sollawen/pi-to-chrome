# CDP Session 池化方案

## 问题

`inspect-styles.ts` 每次调用都创建独立的 CDP session：
```
page.createCDPSession() → DOM.enable → CSS.enable → ... → cdpSession.detach()
```

当并行调用 inspect_styles 时：
1. 两个 CDP session 同时创建，同时 enable DOM/CSS agent
2. 第一个完成，detach 关掉 session → 触发 DOM/CSS disable
3. 第二个还在用，agent 已被关掉 → 连接崩溃，整个 WebSocket 断开

## 方案：共享持久 CDP Session

### 核心思路

- 在 `core/browser.ts` 中维护**一个共享的 CDP session**（per page）
- 所有工具共用这一个 session，不各自 create/detach
- 连接建立时创建，断开时统一清理

### 涉及文件

| 文件 | 改动 |
|------|------|
| `core/browser.ts` | 新增 `getCdpSession(page)` 和 `destroyAllCdpSessions()` |
| `core/browser.ts` | `connectChrome()` 断线回调中清理 sessions |
| `core/browser.ts` | `disconnectChrome()` 中清理 sessions |
| `tools/inspect-styles.ts` | 用 `getCdpSession()` 替代 `page.createCDPSession()` + `detach()` |

---

## 详细改动

### 1. `core/browser.ts` — 新增 CDP session 管理

```typescript
// ─── CDP Session 管理 ───
// 用 WeakMap 以 page 为 key，page 销毁时 session 自动可回收
const cdpSessions = new Map<Page, any>();
// 用 WeakRef 跟踪 page，避免 Map 强引用导致 page 无法回收
// 但 Map<string, {page: WeakRef<Page>, session: any}> 更稳妥

// 简单方案：直接用 page 对象做 key（连接生命周期内 page 不会变）
```

新增函数：

```typescript
/** 获取 page 对应的共享 CDP session（懒创建，首次调用时建立） */
export async function getCdpSession(page: Page): Promise<CDPSession> {
  // 复用已有 session
  const existing = cdpSessions.get(page);
  if (existing) return existing;

  // 创建新 session 并启用必要 agent
  const session = await page.createCDPSession();
  await session.send('DOM.enable');
  await session.send('CSS.enable');

  cdpSessions.set(page, session);
  return session;
}

/** 清理所有 CDP sessions（断线/断开时调用） */
export function destroyAllCdpSessions(): void {
  for (const [page, session] of cdpSessions) {
    try {
      session.detach();
    } catch (error) {
      console.error('[pi-to-chrome] destroyAllCdpSessions: detach 失败', error);
    }
  }
  cdpSessions.clear();
}
```

### 2. `core/browser.ts` — 断线时清理

在 `connectChrome()` 的 `browser.on('disconnected')` 回调中加一行：
```typescript
browser.on('disconnected', () => {
  console.error('[pi-to-chrome] browser disconnected 事件触发');
  browser = null;
  lastHealthCheckResult = false;
  destroyAllCdpSessions();    // ← 新增：清理所有 CDP sessions
  disconnectedCallback?.();
});
```

在 `disconnectChrome()` 中加一行：
```typescript
export async function disconnectChrome(): Promise<void> {
  if (browser) {
    destroyAllCdpSessions();    // ← 新增：先清理 CDP sessions
    try {
      browser.disconnect();
    } catch (error) {
      console.error('[pi-to-chrome] disconnectChrome: browser.disconnect() 失败', error);
    }
    browser = null;
    lastHealthCheckResult = false;
  }
}
```

### 3. `tools/inspect-styles.ts` — 用共享 session

改动前：
```typescript
async execute(page, params) {
  let cdpSession: any = null;
  try {
    cdpSession = await page.createCDPSession();
    await cdpSession.send('DOM.enable');
    await cdpSession.send('CSS.enable');
    // ... 使用 cdpSession ...
  } finally {
    if (cdpSession) {
      try { await cdpSession.detach(); } catch (error) { ... }
    }
  }
}
```

改动后：
```typescript
async execute(page, params) {
  const cdpSession = await getCdpSession(page);
  // ... 使用 cdpSession（不再 create/detach）...
  // 删除 finally 中的 detach
}
```

具体：
- 删除 `let cdpSession` 和 `page.createCDPSession()`
- 删除 `DOM.enable` / `CSS.enable`（已在 getCdpSession 中完成）
- 删除 `finally` 块中的 `cdpSession.detach()`
- 整个 try/finally 简化为 try/catch（只捕获业务错误）

### 4. `core/types.ts` — 新增 import 类型

`getCdpSession` 返回的是 `CDPSession` 类型（puppeteer-core），需要在 browser.ts 中 import：
```typescript
import type { Browser, Page, CDPSession } from 'puppeteer-core';
```

---

## Review 记录（2025-05-26）

基于 puppeteer-core 源码、devtools-protocol 类型定义、项目实际代码的逐项验证。

### ✅ 方案正确的部分

1. **问题定位准确**：`page.createCDPSession()` 底层调用 `Target.attachToTarget`（Connection.js:208-210），每次创建独立 session。`session.detach()` 调用 `Target.detachFromTarget`（CdpSession.js:105-109）。

2. **`CDPSessionEvent.Disconnected` 确实存在**（CDPSession.d.ts:31）：`CDPSessionEvent.Disconnected` 是 `unique symbol`，session 断开时触发。可在 `getCdpSession` 中监听以实现自动恢复。

3. **Page 引用一致性已确认**：`Target.page()` 使用 `pagePromise` 缓存（Target.js:205-214），同一 Target 始终返回同一 Page 实例。`BrowserContext.pages()` 遍历 targets 调用 `target.page()`（BrowserContext.js:83-93），不会创建新实例。因此 `Map<Page, CDPSession>` 的 key 一致性有保证。

4. **生命周期管理正确**：`Connection.#onClose()` 遍历所有 sessions 调用 `session.onClosed()`（Connection.js:185-188），browser 断线时所有 session 的 `detached` 属性变为 `true`。方案在 `browser.on('disconnected')` 回调中调用 `destroyAllCdpSessions()` 是正确的，此时 detach 会失败但 try/catch 吞掉错误也合理。

5. **`CdpCDPSession.detached` getter**（CdpSession.js:51-53）：`return this.#connection._closed || this.#detached`，能正确反映 session 是否已失效。

6. **`send()` 在 detached 状态的行为**（CdpSession.js:60-63）：直接 reject `TargetCloseError`，不会静默失败。如果共享 session 意外断开，下次调用会得到明确错误。

### ⚠️ 需要补充/修正的点

#### 1. DOM/CSS enable 是 per-session 的（不是 per-page）

CDP 协议文档：
- `DOM.enable`："Enables DOM agent for the given page"——实际上 agent 状态是 **per-session** 的。每个 session 独立维护自己的 enabled agent 列表。
- `CSS.enable`："Clients should not assume that the CSS agent has been enabled until the result of this command is received."

**结论**：方案在共享 session 中只 enable 一次是正确的。但如果 session 断开后重建，需要重新 enable。方案中 `getCdpSession` 在创建新 session 时会调用 `DOM.enable` / `CSS.enable`，这覆盖了重建场景。✅ 无需改动。

#### 2. 缺少 session 断开的自动恢复

当前方案只在 browser 断线时（`browser.on('disconnected')`）清理 sessions。但如果 **单个 CDP session 断开**（比如 target 被 Chrome 回收），`cdpSessions` Map 中会残留失效的 session 对象。

CdpCDPSession 在 session 断开时会 emit `CDPSessionEvent.Disconnected`（CdpSession.js:114）。应在 `getCdpSession` 中监听此事件，从 Map 中移除失效 session：

```typescript
session.on(CDPSessionEvent.Disconnected, () => {
  cdpSessions.delete(page);
});
```

注意：`CDPSessionEvent` 是从 puppeteer-core 导出的，需新增 import。

#### 3. `DOM.enable` 失败时需清理 Map 条目

如果 `DOM.enable` 或 `CSS.enable` 失败，session 已创建但 agent 未完全启用，Map 中会残留半初始化的 session。应在 catch 中移除并 re-throw：

```typescript
try {
  await session.send('DOM.enable');
  await session.send('CSS.enable');
} catch (error) {
  cdpSessions.delete(page);
  try { session.detach(); } catch {}
  throw error;
}
```

#### 4. 方案中注释代码应清理

`core/browser.ts` 改动部分有一段被注释掉的代码和多种方案的讨论：
```typescript
// 用 WeakMap 以 page 为 key，page 销毁时 session 自动可回收
// 用 WeakRef 跟踪 page，避免 Map 强引用导致 page 无法回收
// 但 Map<string, {page: WeakRef<Page>, session: any}> 更稳妥
// 简单方案：直接用 page 对象做 key（连接生命周期内 page 不会变）
```

既然选定了「简单方案」，这些注释应删除，只保留最终选型的说明。

#### 5. import 类型需确认

`getCdpSession` 返回 `CDPSession`，但 `browser.ts` 当前 import 是：
```typescript
import type { Browser, Page } from 'puppeteer-core';
```
需改为：
```typescript
import type { Browser, Page, CDPSession } from 'puppeteer-core';
```

同时如果监听 `CDPSessionEvent.Disconnected`，还需要 import `CDPSessionEvent`。但 `CDPSessionEvent` 不是 type export，而是 value export，需用 `import { CDPSessionEvent } from 'puppeteer-core'`。

### 📋 最终结论

方案整体可行，改动范围合理。建议：
1. **必须补充**：session 断开自动恢复（监听 `CDPSessionEvent.Disconnected`）
2. **建议补充**：`DOM.enable`/`CSS.enable` 失败时的清理逻辑
3. **建议清理**：注释掉的方案讨论代码

其余方案内容经验证无误。

---

## 验证方式

1. 启动 Chrome，连接后**并行调用多个 inspect_styles**
2. 确认不会断线
3. 执行 `/chrome-stop` 或关闭 Chrome，确认 sessions 被正确清理
4. 重新 `/chrome-start`，确认 session 被重新创建，功能正常

## 风险点

- **Map 内存泄漏**：如果 page 对象在连接期间被 Chrome 销毁（比如用户关闭了标签页），Map 中会残留条目。但影响很小（一个 session 对象），下次 `getCdpSession` 会用新 page 创建新 session。可以在 `getActivePage()` 中顺便做一次清理，但优先级低。
