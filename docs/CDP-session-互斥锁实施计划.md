# CDP Session 互斥锁实施计划

## 背景

CDP session 池化已实现（见《CDP-session-池化实施计划》），但并行调用 `inspect_styles` 时出现 `Could not find node with given id` 错误。

原因：同一 CDP session 上的 `DOM.getDocument` / `DOM.querySelector` 等命令不能并发执行，两个调用交叉操作导致 nodeId 失效。

解决：在 session 管理层加互斥锁，同一 page 的 CDP 操作串行执行。

---

## 改动总览

| 文件 | 改动 |
|------|------|
| `core/browser.ts` | 新增 `withCdpSession()` |
| `tools/inspect-styles.ts` | 用 `withCdpSession()` 替代 `getCdpSession()` |

共 2 个文件。

---

## 第一步：`core/browser.ts`

### 1.1 新增模块状态

在 `cdpSessions` Map 声明后面追加：

```typescript
// ─── CDP Session 互斥锁 ───
// per-page：同一 page 的 CDP 调用串行，不同 page 互不影响
// 注：page 通常复用，不会无限增长；若需彻底清理，page close 时可 delete cdpLocks.get(page)
const cdpLocks = new Map<Page, Promise<void>>();
```

### 1.2 新增 `withCdpSession()`

在 `getCdpSession()` 后面追加：

```typescript
/**
 * 获取共享 CDP session 并执行回调，同一 page 的调用自动串行。
 * 所有需要 CDP session 的工具都应通过此函数访问，不要直接调用 getCdpSession()。
 */
export async function withCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>
): Promise<T> {
  // 排队：等前一个调用完成
  const prev = cdpLocks.get(page) || Promise.resolve();
  let release: () => void;
  const wait = new Promise<void>(r => { release = r; });
  cdpLocks.set(page, wait);
  await prev;

  // 执行
  const session = await getCdpSession(page);
  try {
    return await fn(session);
  } finally {
    release();
  }
}
```

---

## 第二步：`tools/inspect-styles.ts`

### 2.1 替换 import

```typescript
// 改前
import { getCdpSession } from '../core/browser';

// 改后
import { withCdpSession } from '../core/browser';
```

### 2.2 替换 execute 方法结构

```typescript
// 改前
  async execute(page, params) {
    const cdpSession = await getCdpSession(page);

    // Get document and find node
    const { root } = await cdpSession.send('DOM.getDocument', { depth: 0 });
    ...（整个方法体）...
    return {
      content: [{ type: 'text', text: summary }],
      details: { element: elementInfo, cssRules }
    };
  }

// 改后
  async execute(page, params) {
    return withCdpSession(page, async (cdpSession) => {

      // Get document and find node
      const { root } = await cdpSession.send('DOM.getDocument', { depth: 0 });
      ...（方法体不变）...
      return {
        content: [{ type: 'text', text: summary }],
        details: { element: elementInfo, cssRules }
      };

    });
  }
```

方法体代码完全不变，只是包进 `withCdpSession(page, async (cdpSession) => { ... })`。

---

## 验证

1. **并行安全**：并行调两次 `inspect_styles`，两个都应正常返回，不再出现 `Could not find node`
2. **串行执行**：临时在 `withCdpSession` 中加时间戳日志，确认第二个调用等第一个完成后才执行
3. **不相关工具不受影响**：并行调 `find_elements` 和 `inspect_styles`，`find_elements` 不应被拖慢
4. **断线/重连**：原有池化清理逻辑不受影响
