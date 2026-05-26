# CDP Session 池化 — 实施计划

## 背景

`inspect-styles.ts` 每次调用都 `page.createCDPSession()` → enable agents → 使用 → `detach()`。
并行调用时，一个 session detach 会关掉 DOM/CSS agent，另一个 session 还在用 → 连接崩溃。

方案：共享持久 CDP session，per page，连接建立时创建、断开时统一清理。

---

## 改动总览

| 文件 | 改动 |
|------|------|
| `core/browser.ts` | 新增 `getCdpSession()` / `destroyAllCdpSessions()`，修改 `connectChrome()` / `disconnectChrome()` |
| `tools/inspect-styles.ts` | 用 `getCdpSession()` 替代 `page.createCDPSession()` + `detach()` |

共 2 个文件。

---

## 第一步：`core/browser.ts`

### 1.1 新增 import

```typescript
// 改前
import type { Browser, Page } from 'puppeteer-core';

// 改后
import type { Browser, Page, CDPSession } from 'puppeteer-core';
import { CDPSessionEvent } from 'puppeteer-core';
```

说明：`CDPSession` 是类型，用 `import type`；`CDPSessionEvent` 是运行时值（namespace + symbol），必须用 `import`。

### 1.2 新增模块状态

在 `// ─── 模块状态 ───` 后面追加：

```typescript
// ─── CDP Session 池 ───
// 以 Page 为 key 缓存共享的 CDP session。
// Page 对象在连接生命周期内引用不变（Target.page() 有 pagePromise 缓存），可安全用作 Map key。
const cdpSessions = new Map<Page, CDPSession>();
```

### 1.3 新增 `getCdpSession()`

在 `ensureConnection()` 函数后面追加：

```typescript
/** 获取 page 对应的共享 CDP session（懒创建，首次调用时建立） */
export async function getCdpSession(page: Page): Promise<CDPSession> {
  const existing = cdpSessions.get(page);
  if (existing && !existing.detached) return existing;

  // 旧 session 已失效，先清理
  if (existing) cdpSessions.delete(page);

  // 创建新 session 并启用 DOM / CSS agent
  const session = await page.createCDPSession();

  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
  } catch (error) {
    // agent 启用失败，清理并抛出
    cdpSessions.delete(page);
    try { await session.detach(); } catch (detachError) {
      console.debug('[pi-to-chrome] getCdpSession: enable 失败后 detach 也失败', detachError);
    }
    throw error;
  }

  // session 被关闭时自动从池中移除，下次 getCdpSession 会重建
  // 用 SessionDetached（session 级别断开），而非 Disconnected（全局连接断开）
  session.on(CDPSessionEvent.SessionDetached, () => {
    cdpSessions.delete(page);
  });

  cdpSessions.set(page, session);
  return session;
}
```

### 1.4 新增 `destroyAllCdpSessions()`

紧跟 `getCdpSession()` 后面追加：

```typescript
/** 清理所有 CDP sessions（断线/断开时调用） */
export function destroyAllCdpSessions(): void {
  for (const [, session] of cdpSessions) {
    try {
      session.detach();
    } catch (error) {
      // 断线时底层 WebSocket 已关，detach 失败属正常
      console.debug('[pi-to-chrome] destroyAllCdpSessions: detach 失败（可能已断线）', error);
    }
  }
  cdpSessions.clear();
}
```

### 1.5 修改 `connectChrome()` — 断线时清理 sessions

在 `browser.on('disconnected', ...)` 回调中加一行：

```typescript
  browser.on('disconnected', () => {
    console.error('[pi-to-chrome] browser disconnected 事件触发');
    browser = null;
    lastHealthCheckResult = false;
    destroyAllCdpSessions();    // ← 新增
    disconnectedCallback?.();
  });
```

### 1.6 修改 `disconnectChrome()` — 主动断开前清理

在 `browser.disconnect()` 之前加一行：

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

---

## 第二步：`tools/inspect-styles.ts`

### 2.1 新增 import

```typescript
// 改前
import type { ToolDefinition } from '../core/types';
import { Type } from '@sinclair/typebox';

// 改后
import type { ToolDefinition } from '../core/types';
import { getCdpSession } from '../core/browser';
import { Type } from '@sinclair/typebox';
```

### 2.2 替换 execute 方法体

将整个 `async execute(page, params)` 方法从 try/finally 结构改为直接使用共享 session：

```typescript
  async execute(page, params) {
    const cdpSession = await getCdpSession(page);

    // Get document and find node
    const { root } = await cdpSession.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdpSession.send('DOM.querySelector', {
      selector: params.selector,
      nodeId: root.nodeId
    });

    if (!nodeId) {
      throw new Error(`未找到匹配 "${params.selector}" 的元素`);
    }

    // Get element info
    const { node: nodeInfo } = await cdpSession.send('DOM.describeNode', { nodeId });

    // Get bounding rect
    const boundingRect = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, params.selector);

    // Get text content (truncated)
    const textContent = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      return (el?.textContent || '').trim().slice(0, 200);
    }, params.selector);

    // Build element info
    const elementInfo = {
      tagName: nodeInfo.localName?.toLowerCase() || 'unknown',
      text: textContent,
      classList: nodeInfo.attributes
        ? extractClasses(nodeInfo.attributes)
        : [],
      attributes: nodeInfo.attributes || [],
      boundingRect
    };

    // Get matched styles
    const matchedStyles = await cdpSession.send('CSS.getMatchedStylesForNode', { nodeId });

    // Process CSS rules
    const cssRules: any[] = [];

    // Inline style
    if (matchedStyles.inlineStyle) {
      const inlineProps = processStyleProperties(matchedStyles.inlineStyle.cssProperties, matchedStyles.inlineStyle.shorthandEntries);
      if (Object.keys(inlineProps).length > 0) {
        cssRules.push({
          type: 'inline',
          selector: '<inline style>',
          source: 'inline style',
          properties: inlineProps
        });
      }
    }

    // Regular matched rules
    if (matchedStyles.matchedCSSRules) {
      for (const rule of matchedStyles.matchedCSSRules) {
        const props = processStyleProperties(rule.rule.style.cssProperties, rule.rule.style.shorthandEntries);

        const source = rule.rule.origin === 'user-agent'
          ? 'user-agent'
          : rule.rule.selectorList?.selectors?.map((s: any) => s.value).join(', ') || 'unknown';

        const sourceLocation = rule.rule.sourceURL
          ? `${rule.rule.sourceURL}:${rule.rule.sourceLine || '?'}`
          : 'inline';

        cssRules.push({
          type: rule.rule.origin === 'user-agent' ? 'user-agent' : 'regular',
          selector: source,
          source: sourceLocation,
          properties: props
        });
      }
    }

    // Build summary
    const summary = `元素 <${elementInfo.tagName}> 的 CSS 层叠链:\n` +
      cssRules.map((rule, i) =>
        `  ${i + 1}. [${rule.type}] ${rule.selector}\n     来源: ${rule.source}\n` +
        (rule.properties.length > 0
          ? `     属性: ${rule.properties.slice(0, 5).map((p: any) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`).join(', ')}${rule.properties.length > 5 ? '...' : ''}\n`
          : '')
      ).join('');

    return {
      content: [{ type: 'text', text: summary }],
      details: { element: elementInfo, cssRules }
    };
  }
```

对比原代码，删除了：
- `let cdpSession: any = null;` 声明
- `cdpSession = await page.createCDPSession();`
- `await cdpSession.send('DOM.enable');`
- `await cdpSession.send('CSS.enable');`
- 整个 `finally` 块（包含 `cdpSession.detach()`）
- 外层 `try/finally` 不再需要（无资源需要释放）

代码从 try/finally 包裹整个方法体，变成平铺结构。

---

## 验证

1. **并行安全**：并行调用多个 `inspect_styles`，确认不再断线
2. **session 复用**：在 `getCdpSession` 临时加日志 `console.log('[debug] session id:', session.id())`，连续调用两次 `inspect_styles`，确认 id 相同
3. **断线清理**：关闭 Chrome 或 `/chrome-stop`，确认 sessions 被清理（观察 `destroyAllCdpSessions` 日志）
4. **重连恢复**：重新 `/chrome-start`，确认功能正常，session 被重新创建（id 不同于之前）
