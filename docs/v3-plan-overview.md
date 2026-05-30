# v3 工具改进 — 实施总览

> 基于 [v3-tool-ideas.md](./v3-tool-ideas.md)

---

## 实施顺序

| 阶段 | 工具 | 计划文档 | 依赖 | 说明 |
|------|------|----------|------|------|
| Step 0 | trace_css 动态样式表验证 | — | 无 | 验证 CDP API 行为，产出 [v3-validation-report.md](./v3-validation-report.md) |
| Step 1 | **trace_css**（修复样式来源） | [v3-plan-trace-css.md](./v3-plan-trace-css.md) | Step 0 | 解决最大痛点 |
| Step 2 | **show_dom_tree**（新增） | [v3-plan-show-dom-tree.md](./v3-plan-show-dom-tree.md) | 无 | 独立性最强 |
| Step 3 | **check_layout**（新增） | [v3-plan-check-layout.md](./v3-plan-check-layout.md) | 无 | 与 Step 2 并行 |
| Step 4 | **find_elements**（summary 优化） | [v3-plan-find-elements.md](./v3-plan-find-elements.md) | Step 1-3 | 影响所有场景 |

**并行策略**：Step 2 和 Step 3 互不依赖，可同时开发。Step 4 依赖前三个的 promptGuidelines 更新。

---

## 各工具实施计划

| 计划文档 | 核心改动 | 新建文件 | 修改文件 | 删除文件 |
|----------|----------|----------|----------|----------|
| [v3-plan-trace-css.md](./v3-plan-trace-css.md) | 修复 source 定位 + 重命名 | `tools/trace-css.ts` | `index.ts` | `tools/inspect-styles.ts` |
| [v3-plan-show-dom-tree.md](./v3-plan-show-dom-tree.md) | 新增 DOM 子树展示 | `tools/show-dom-tree.ts` | `index.ts` | — |
| [v3-plan-check-layout.md](./v3-plan-check-layout.md) | 新增布局检查 | `tools/check-layout.ts` | `index.ts` | — |
| [v3-plan-find-elements.md](./v3-plan-find-elements.md) | summary 格式优化 | — | `tools/find-elements.ts` | — |

---

## 公共模块：`core/selector-utils.ts`

多个工具共享以下函数。在 Step 2 开发时创建此文件，后续工具直接引用。

### 函数签名

```typescript
import type { Page } from 'puppeteer-core';

/** 验证结果 */
export type ValidateResult =
  | { ok: true }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'multiple'; count: number; items: Array<{ tag: string; text: string; nthSelector: string }> }
  | { ok: false; kind: 'invalid'; message: string };

/**
 * 验证 selector 是否定位到唯一元素。
 * 全部在 page.evaluate 内完成，一次 round-trip。
 * 多元素时附带每个元素的 tag / text / nth-child selector。
 */
export async function validateSelectorUniqueness(page: Page, selector: string): Promise<ValidateResult>;

/**
 * 格式化元素标签: "<tag.class1.class2#id>"
 * @param maxClasses 最多显示的 class 数量，默认 3
 */
export function formatElementLabel(tag: string, id?: string | null, classes?: string[], maxClasses?: number): string;
```

### 使用方式

三个工具（trace_css / show_dom_tree / check_layout）在 `execute` 开头统一调用：

```typescript
const validation = await validateSelectorUniqueness(page, params.selector);
if (!validation.ok) {
  if (validation.kind === 'not_found') throw new Error(`❌ 未找到匹配 "${params.selector}" 的元素`);
  if (validation.kind === 'invalid') throw new Error(`❌ 无效的 CSS selector: ${params.selector}\n${validation.message}`);
  if (validation.kind === 'multiple') {
    const list = validation.items.map((item, i) =>
      `${i+1}. <${item.tag}> "${item.text}"\n   → ${item.nthSelector}`
    ).join('\n');
    throw new Error(`❌ 该 selector 匹配了 ${validation.count} 个元素，请指定唯一元素:\n\n${list}`);
  }
}
```

---

## 错误消息格式

统一遵循 v3-tool-ideas.md 中的「错误处理原则」：

| 情况 | 返回 |
|------|------|
| 0 个匹配 | `❌ 未找到匹配 "..." 的元素` |
| 多个匹配 | `❌ 该 selector 匹配了 N 个元素` + 每个元素的 tag/text/nth-child selector |
| 无效 selector | `❌ 无效的 CSS selector` + 原样返回 selector + 语法错误信息 |
| 未连接 | 由 `browser.ensureConnection()` 统一处理 |

---

## iframe 与 shadow DOM 边界

v3 所有工具只操作主页面（top-level frame），不穿透 iframe。

| 场景 | 行为 | 说明 |
|------|------|------|
| 目标元素在 iframe 内 | `querySelector` 找不到，返回「未找到匹配元素」 | AI 可通过 `execute_js` 手动穿透 |
| open shadow DOM | `show_dom_tree` 检测到 `[shadow-root]` 标记，不展开 | `el.shadowRoot !== null` |
| closed shadow DOM | 无法检测，当普通子节点处理 | `el.shadowRoot` 返回 `null`，v3 不额外处理 |

---

## 不变动的工具

| 工具 | 说明 |
|------|------|
| `execute_js` | 功能完备，无改动 |
| `read_console` | 功能完备，无改动 |

---

## 集成测试

各工具单独测试通过后，执行以下端到端链路验证：

| 场景 | 链路 | 验证点 |
|------|------|--------|
| 查样式来源 | `find_elements` → `trace_css` | selector 传递正确，来源显示文件名 |
| 查结构 | `find_elements` → `show_dom_tree` | selector 传递正确，树状输出完整 |
| 查布局 | `find_elements` → `check_layout` | selector 传递正确，尺寸数值合理 |
| 多元素选择 | `find_elements` → 从 summary 拿 selector → `trace_css` | nth-child selector 唯一性 |
| 多元素报错 | 直接传宽泛 selector 给 `show_dom_tree` | 报错附带 nth-child selector 列表 |

---

## 完成后最终文件结构

```
core/
  browser.ts           ← 不变
  connection-state.ts   ← 不变
  console-buffer.ts     ← 不变
  types.ts              ← 不变
  selector-utils.ts     ← 新建（公共函数）
tools/
  find-elements.ts      ← 修改 summary + promptSnippet
  trace-css.ts          ← 新建（替代 inspect-styles.ts）
  show-dom-tree.ts      ← 新建
  check-layout.ts       ← 新建
  execute-js.ts         ← 不变
  read-console.ts       ← 不变
  inspect-styles.ts     ← 删除
```
