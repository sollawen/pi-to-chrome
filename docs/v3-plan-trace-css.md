# v3 实施计划: chrome_trace_css（修复样式来源）

> 前置：Step 0 验证完成 → [v3-validation-report.md](./v3-validation-report.md)
> 结论：采用 **CSSOM 方案**（`page.evaluate` + `document.styleSheets`），无需 CDP 监听器。

---

## 目标

将现有 `chrome_inspect_styles` 工具重命名为 `chrome_trace_css`，修复样式来源全部显示为 `unknown` / `inline` 的问题，让每条 CSS 规则都能准确追溯到源文件。

---

## 现状分析

### 当前代码位置
- `tools/inspect-styles.ts` — 完整工具定义

### 当前 source 定位逻辑（有 bug）

```typescript
const sourceLocation = (rule.rule as any).sourceURL
  ? `${(rule.rule as any).sourceURL}:${(rule.rule as any).sourceLine || '?'}`
  : 'inline';
```

问题：
1. `sourceURL` 在 `rule.rule` 上永远是 `undefined`（即使是外部 CSS 文件）
2. `sourceLine` 也永远是 `undefined`
3. 导致所有规则 fallback 成 `'inline'`

### Step 0 验证结论

| 方案 | 结论 |
|------|------|
| CDP `rule.rule.sourceURL` | ❌ 永远 `undefined` |
| CDP `CSS.getStyleSheetInfo` | ❌ API 不存在 |
| CDP `CSS.styleSheetAdded` 事件 | ✅ 可用，但需要注册持久监听器 |
| **CSSOM `document.styleSheets`** | **✅ 最佳方案，零监听器，`page.evaluate` 一步到位** |

---

## 实施步骤

### Step 1: 新建文件 `tools/trace-css.ts`

基于 `tools/inspect-styles.ts` 复制并改造。

#### 1.1 元数据更新

```typescript
name: 'chrome_trace_css',
label: 'Chrome Trace CSS',
description: '追踪元素的 CSS 样式来源：查看完整层叠链，每条规则标注来源文件。',
promptSnippet: '追踪元素 CSS 样式来源',
promptGuidelines: [
  '【查样式来源】当需要知道某条 CSS 规则写在哪个文件、被什么覆盖时使用。先用 chrome_find_elements 定位元素，再用 chrome_trace_css 追踪样式来源。',
  '返回结果按优先级排列（inline > CSS class > user-agent）。',
  '来源格式：文件名、<style> 标签、inline style、user-agent 浏览器默认。',
]
```

#### 1.2 参数变更

去掉 `includeChildren` 参数（不需要了），保留 `selector`。

```typescript
parameters: Type.Object({
  selector: Type.String({ description: 'CSS selector，应定位到唯一元素' })
})
```

#### 1.3 selector 唯一性验证

使用公共函数 `validateSelectorUniqueness`（定义在 `core/selector-utils.ts`，详见 [overview](./v3-plan-overview.md)）：

```typescript
import { validateSelectorUniqueness } from '../core/selector-utils';

// execute 开头
const validation = await validateSelectorUniqueness(page, params.selector);
if (!validation.ok) {
  // 统一错误处理（见 overview 的错误消息格式）
}
```

#### 1.4 核心改造：CSSOM 方案获取来源

**完全用 `page.evaluate` 完成，不依赖 CDP session。**

```typescript
// 在 page.evaluate 中一次性获取所有匹配规则 + 文件名
const result = await page.evaluate((selector: string) => {
  const el = document.querySelector(selector);
  if (!el) return null;

  const rules: Array<{
    type: 'inline' | 'regular' | 'user-agent';
    source: string;
    selector: string;
    properties: string;
  }> = [];

  // 1. inline style
  if (el.style.cssText) {
    rules.push({
      type: 'inline',
      source: 'inline style',
      selector: '<inline>',
      properties: el.style.cssText,
    });
  }

  // 2. 遍历 document.styleSheets 匹配规则
  for (const sheet of Array.from(document.styleSheets)) {
    const fileName = sheet.href
      ? sheet.href.split('/').pop()
      : '<style>';
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule) {
          try {
            if (el.matches(rule.selectorText)) {
              rules.push({
                type: 'regular',
                source: fileName,
                selector: rule.selectorText,
                properties: rule.style.cssText,
              });
            }
          } catch {} // selector 可能有兼容性问题
        }
      }
    } catch {} // 跨域样式表
  }

  return rules;
}, params.selector);
```

**关键点**：
- `sheet.href` 有值 → 截取文件名（如 `NavBar2.css`）
- `sheet.href` 为空 → `<style>` 标签或 CSS-in-JS
- 跨域样式表访问 `cssRules` 抛异常 → try-catch 跳过
- `el.matches(rule.selectorText)` 检查元素是否匹配该选择器
- 无需 CDP session、无需监听器、无需缓存

#### 1.5 属性格式化

`rule.style.cssText` 返回的是原始 CSS 文本（如 `"position: fixed; right: 30px;"`）。
如果需要更结构化的输出（区分 !important、shorthand 等），可以进一步解析 `rule.style` 的各个属性：

```typescript
// 可选：结构化属性列表
const props: Array<{ name: string; value: string; important: boolean }> = [];
for (let i = 0; i < rule.style.length; i++) {
  const name = rule.style[i];
  const value = rule.style.getPropertyValue(name);
  const priority = rule.style.getPropertyPriority(name);
  props.push({ name, value, important: priority === 'important' });
}
```

#### 1.6 输出格式

```
[inline] inline style
  属性: top: 71px

[regular] NavBar2.css
  选择器: .msg-card
  属性: position: fixed; right: 30px; width: 400px; ...

[regular] style2.css
  选择器: *
  属性: margin: 0px; padding: 0px; box-sizing: border-box; ...

[user-agent] user-agent
  属性: display: block
```

**注意**：CSSOM 的 `document.styleSheets` 不包含 user-agent 样式。如需展示 user-agent 规则，仍需 CDP `CSS.getMatchedStylesForNode` 补充，或通过 `getComputedStyle` 获取计算值。**初始版本可省略 user-agent 规则**，因为开发者主要关心自己写的 CSS。

#### 1.7 是否保留 CDP `getMatchedStylesForNode`？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 纯 CSSOM | 简单、无监听器、无 CDP 依赖 | 无 user-agent 规则、无行号 |
| CSSOM + CDP 混合 | 可补全 user-agent 规则和 !important 标注 | 代码更复杂 |

**建议**：先实现纯 CSSOM 方案，验证效果后再决定是否补充 CDP。

---

### Step 2: 注册新工具 + 清理旧工具

在 `index.ts` 中：

```typescript
import { traceCssTool } from './tools/trace-css';

const ALL_TOOLS: ToolDefinition[] = [
  findElementsTool,
  traceCssTool,       // 新：替代 inspectStylesTool
  readConsoleTool,
  executeJsTool,
];
```

同时：
- 删除 `tools/inspect-styles.ts`
- 清理 index.ts 中的旧 import

> 不做两步过渡。验证通过后直接替换。

---

## 测试清单

### 基本功能
- [ ] 外部 CSS 文件规则 → 显示 `filename.css`
- [ ] `<style>` 标签规则 → 显示 `<style>`
- [ ] inline style → 显示 `inline style`
- [ ] 跨域样式表 → 不报错，静默跳过
- [ ] 属性列表完整
- [ ] 层叠顺序正确（inline > CSS class）

### 错误处理
- [ ] selector 匹配 0 个元素 → 明确报错
- [ ] selector 匹配多个元素 → 报错 + 附带 nth-child selector 列表
- [ ] 无效 CSS selector → 报错 + 语法错误信息
- [ ] 未连接 Chrome → 由 ensureConnection() 统一处理

### 回归
- [ ] 与 `find_elements` 配合：selector 传递正确
- [ ] 结果格式与 plan-overview 中定义的格式一致

### iframe 边界
- [ ] 目标元素在 iframe 内 → 返回「未找到匹配元素」

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `tools/trace-css.ts` | 新建（基于 inspect-styles.ts，核心逻辑改用 CSSOM） |
| `tools/inspect-styles.ts` | 删除 |
| `index.ts` | 更新 import 和 ALL_TOOLS |
| `core/selector-utils.ts` | 引用（validateSelectorUniqueness） |
