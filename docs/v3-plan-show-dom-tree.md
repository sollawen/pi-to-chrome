# v3 实施计划: chrome_show_dom_tree（新增）

> 依赖：无。独立性最强的工具，可单独开发测试。

---

## 目标

新增 `chrome_show_dom_tree` 工具，向下展开指定元素的 DOM 子树，以树状结构清晰展示嵌套关系、标签名、class、id、文本内容。替代目前用 `execute_js` 读 `outerHTML` 再人工解读的低效流程。

---

## 定位

**只做向下展开子树**。看结构、看子元素关系、看嵌套层级。向上查归 `check_layout`。

---

## 工具定义

### 输入参数

```typescript
{
  selector: string;   // 必填，CSS 选择器，应定位到唯一元素
  depth?: number;     // 可选，最大展开深度，默认 3
}
```

### 输出格式

```
<div#statusScreen>
  └─ <div.status-container>
       ├─ <div.status-item>
       │    ├─ <div.status-lamp.green#guardianLamp>
       │    └─ <span.status-text#guardianLabel> "自动模式"
       ├─ <div.status-item>
       │    ├─ <div.status-lamp#senderLamp>
       │    └─ <span.status-text#senderLabel> "Sender"
       └─ <div.status-item>
            ├─ <div.status-lamp#receiverLamp>
            └─ <span.status-text#receiverLabel> "Receiver"
```

### 信息规则

| 元素 | 显示内容 |
|------|----------|
| 每个节点 | `<tagName>` + `.class1.class2`（最多 3 个 class）+ `#id` |
| 叶子节点 | 额外附 `"文本内容"`（截断 40 字符） |
| open shadow root | `[shadow-root]` 标记，不展开 |
| closed shadow root | 无法检测，当普通子节点处理 |

### 截断保护

同级兄弟超过 5 个时截断，显示 `... 还有 N 个子节点省略`。

---

## 实施步骤

### Step 1: 新建 `core/selector-utils.ts`

创建公共函数文件（本工具是第一个使用者）：

```typescript
import type { Page } from 'puppeteer-core';

export type ValidateResult =
  | { ok: true }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'multiple'; count: number; items: Array<{ tag: string; text: string; nthSelector: string }> }
  | { ok: false; kind: 'invalid'; message: string };

export async function validateSelectorUniqueness(page: Page, selector: string): Promise<ValidateResult> {
  const result = await page.evaluate((sel: string) => {
    try {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) return { ok: false as const, kind: 'not_found' as const };
      if (elements.length > 1) {
        const items = Array.from(elements).map((el) => {
          const tag = el.tagName.toLowerCase();
          const text = (el.textContent || '').trim().slice(0, 40);
          const parent = el.parentElement;
          const index = parent ? Array.from(parent.children).indexOf(el) + 1 : 0;
          const nthSelector = index > 0 ? `${tag}:nth-child(${index})` : tag;
          return { tag, text, nthSelector };
        });
        return { ok: false as const, kind: 'multiple' as const, count: elements.length, items };
      }
      return { ok: true as const };
    } catch (e: any) {
      return { ok: false as const, kind: 'invalid' as const, message: e.message };
    }
  }, selector);
  return result;
}

export function formatElementLabel(tag: string, id?: string | null, classes?: string[], maxClasses: number = 3): string {
  let label = `<${tag}`;
  if (classes && classes.length > 0) {
    label += '.' + classes.slice(0, maxClasses).join('.');
  }
  if (id) {
    label += '#' + id;
  }
  label += '>';
  return label;
}
```

### Step 2: 新建 `tools/show-dom-tree.ts`

#### 2.1 参数定义

```typescript
parameters: Type.Object({
  selector: Type.String({ description: 'CSS selector，应定位到唯一元素' }),
  depth: Type.Optional(Type.Number({
    description: '最大展开深度，默认 3',
    minimum: 1,
    maximum: 10,
    default: 3
  }))
})
```

#### 2.2 execute 实现

```typescript
import { validateSelectorUniqueness, formatElementLabel } from '../core/selector-utils';

async execute(page, params) {
  // 1. 验证 selector 唯一性
  const validation = await validateSelectorUniqueness(page, params.selector);
  if (!validation.ok) {
    if (validation.kind === 'not_found')
      throw new Error(`❌ 未找到匹配 "${params.selector}" 的元素`);
    if (validation.kind === 'invalid')
      throw new Error(`❌ 无效的 CSS selector: ${params.selector}\n${validation.message}`);
    if (validation.kind === 'multiple') {
      const list = validation.items.map((item, i) =>
        `${i+1}. <${item.tag}> "${item.text}"\n   → ${item.nthSelector}`
      ).join('\n');
      throw new Error(`❌ 该 selector 匹配了 ${validation.count} 个元素，请指定唯一元素:\n\n${list}`);
    }
  }

  // 2. 构建树（page.evaluate 内完成，一次 round-trip）
  const tree = await page.evaluate((sel: string, maxDepth: number) => {
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT']);
    const MAX_SIBLINGS = 5;
    const MAX_TEXT_LEN = 40;
    const MAX_CLASSES = 3;

    interface TreeNode {
      tag: string;
      id: string | null;
      classes: string[];
      text: string | null;
      hasShadowRoot: boolean;
      children: TreeNode[];
      truncated: number;
    }

    function buildNode(el: Element, depth: number): TreeNode {
      const tag = el.tagName.toLowerCase();
      const id = el.id || null;
      const classes = Array.from(el.classList).slice(0, MAX_CLASSES);
      const hasShadowRoot = el.shadowRoot !== null;  // open shadow DOM

      // 文本内容：只取直接文本子节点
      let directText = '';
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          directText += child.textContent || '';
        }
      }
      directText = directText.trim();
      const text = directText.length > 0 ? directText.slice(0, MAX_TEXT_LEN) : null;

      const children: TreeNode[] = [];
      let truncated = 0;

      if (depth < maxDepth && !hasShadowRoot) {
        const childElements = Array.from(el.children).filter(
          c => !SKIP_TAGS.has(c.tagName)
        );

        for (let i = 0; i < Math.min(childElements.length, MAX_SIBLINGS); i++) {
          children.push(buildNode(childElements[i], depth + 1));
        }
        truncated = Math.max(0, childElements.length - MAX_SIBLINGS);
      }

      return { tag, id, classes, text, hasShadowRoot, children, truncated };
    }

    const root = document.querySelector(sel)!;
    return buildNode(root, 0);
  }, params.selector, params.depth ?? 3);

  // 3. 格式化输出
  const summary = formatTree(tree);

  return {
    content: [{ type: 'text', text: summary }],
    details: { tree }
  };
}
```

#### 2.3 树格式化函数（Node 侧）

```typescript
function formatTree(node: any, prefix: string = '', isLast: boolean = true, isRoot: boolean = true): string {
  // 构建标签描述
  let label = formatElementLabel(node.tag, node.id, node.classes);

  if (node.hasShadowRoot) label += ' [shadow-root]';
  if (node.text) label += ` "${node.text}"`;

  let result = '';
  if (isRoot) {
    result = label + '\n';
  } else {
    const connector = isLast ? '└─ ' : '├─ ';
    result = prefix + connector + label + '\n';
  }

  // 子节点
  const childPrefix = isRoot
    ? ''
    : prefix + (isLast ? '    ' : '│   ');

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const childIsLast = i === node.children.length - 1 && node.truncated === 0;
    result += formatTree(child, childPrefix, childIsLast, false);
  }

  // 截断提示
  if (node.truncated > 0) {
    result += childPrefix + `... 还有 ${node.truncated} 个子节点省略\n`;
  }

  return result;
}
```

#### 2.4 工具元数据

```typescript
name: 'chrome_show_dom_tree',
label: 'Chrome Show DOM Tree',
description: '查看指定元素的 DOM 子树结构。以树状图展示嵌套关系、标签名、class、id 和文本内容。',
promptSnippet: '查看 DOM 子树结构',
promptGuidelines: [
  '【查看元素结构】当需要了解某个容器内部的 HTML 结构、子元素关系时使用。先用 chrome_find_elements 定位，再用 chrome_show_dom_tree 查看结构。',
  '默认展开 3 层深度。嵌套较深时可指定更大的 depth 值。',
  '只向下展开子树，不显示祖先链。如需查看祖先布局信息，用 chrome_check_layout。',
  '同级兄弟超过 5 个时自动截断，避免输出过长。',
  '遇到 open shadow DOM 时显示 [shadow-root] 标记，不展开。closed shadow DOM 无法检测。如需查看 shadow DOM 内部，通过 chrome_execute_js 使用 element.shadowRoot.querySelector() 手动穿透。'
]
```

---

### Step 3: 注册工具

在 `index.ts` 中：

```typescript
import { showDomTreeTool } from './tools/show-dom-tree';

const ALL_TOOLS: ToolDefinition[] = [
  findElementsTool,
  showDomTreeTool,    // 新
  // ...
];
```

---

## 测试清单

### 基本功能
- [ ] 单个元素 + 浅层子树 → 正确树状输出
- [ ] depth=1 → 只显示直接子元素
- [ ] depth=5 → 深层展开
- [ ] 叶子节点附带文本内容
- [ ] 文本截断到 40 字符

### 截断保护
- [ ] 同级 5+ 个兄弟 → 显示前 5 个 + "还有 N 个省略"
- [ ] 深层嵌套不卡住（depth 限制生效）

### Shadow DOM
- [ ] open shadow root → 显示 `[shadow-root]`，不展开
- [ ] closed shadow root → 无法检测，正常展开子节点（不做特殊处理）

### 错误处理
- [ ] selector 匹配 0 个 → `❌ 未找到匹配...`
- [ ] selector 匹配多个 → 报错 + 附带 nth-child selector 列表
- [ ] 无效 CSS selector → `❌ 无效的 CSS selector` + 错误信息
- [ ] 未连接 Chrome → 由 ensureConnection() 统一处理

### 边界
- [ ] 空元素（无子节点）→ 只显示自身标签
- [ ] 大量子节点（100+）→ 截断保护生效，不超时
- [ ] SVG 元素 → 标签名正确（小写）
- [ ] 文本节点混合元素节点 → 只取直接文本，不包含子元素的文本

### iframe 边界
- [ ] 目标元素在 iframe 内 → 返回「未找到匹配元素」

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `core/selector-utils.ts` | 新建（公共函数） |
| `tools/show-dom-tree.ts` | 新建 |
| `index.ts` | 添加 import 和注册 |
