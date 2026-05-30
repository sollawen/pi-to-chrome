# 多匹配元素定位方案

## 问题

当 `chrome_trace_css`、`chrome_check_layout`、`chrome_show_dom_tree` 的 selector 匹配到多个元素时，工具直接报错拒绝工作：

```
❌ 该 selector 匹配了 9 个元素，请指定唯一元素:
1. <div> "自动守护"
   → div.command-list div.card > div:nth-child(1)
...
```

### 痛点

1. **报错建议的 nthSelector 无法使用** — 建议用 `> div:nth-child(1)` 但传回去经常找不到（nth-child 是基于父元素子元素位置，不是匹配列表的位置）
2. **LLM 反复重试浪费时间** — 需要多次尝试构造唯一 selector，往往最终放弃，改用 `chrome_execute_js` + `getComputedStyle` 手动获取样式
3. **典型场景** — 列表中的 `.card`、`.item` 等重复元素，CSS 样式都一样，只需要查其中一个就够了

### 影响范围

| 工具 | 文件 | 多匹配时行为 |
|------|------|-------------|
| `chrome_trace_css` | `tools/trace-css.ts` | 报错 + 列出建议 selector |
| `chrome_check_layout` | `tools/check-layout.ts` | 报错 + 列出建议 selector |
| `chrome_show_dom_tree` | `tools/show-dom-tree.ts` | 报错 + 列出建议 selector |

## 核心设计：数据驱动定位

> **原则**：工具之间通过 `find_elements` 返回的**完整数据对象**传递元素信息，而非让下游工具仅凭 `selector` 字符串重新定位。

### 工作流

```
第一步：find_elements(selector) → { code, msg, number, resultList }
第二步：LLM 从 resultList 中挑选目标 → trace_css(resultList[N])
第三步：trace_css 内部用多个属性联合定位，精确到具体元素
```

LLM 一看 `find_elements` 返回了多个结果，挑选目标元素，将该元素的**完整数据对象**传给 `trace_css` / `check_layout` / `show_dom_tree`。下游工具用对象中的多个属性（tag、class、text、selector、index 等）联合定位，而非仅靠 selector。

### 为什么比 `selector + index` 更好

| | selector + index | 数据驱动定位 |
|---|---|---|
| 定位依据 | CSS selector + 位置序号 | tag + class + text + selector + index 联合匹配 |
| DOM 变动容错 | index 变了就定位错 | 多属性联合，一项变动仍有其他兜底 |
| 工具间耦合 | 下游工具不知道上游搜到了什么 | 上游的搜索结果完整传递到下游 |
| LLM 负担 | 需要理解 index 概念并手动传参 | 直接传对象，LLM 无需额外理解 |

## 统一返回数据结构

所有工具（`find_elements`、`trace_css`、`check_layout`、`show_dom_tree`）统一返回：

```typescript
interface ToolResult {
  code: 0 | 1;           // 0 = 成功, 1 = 失败
  msg: string;           // "success" 或失败原因说明
  number: number;        // 结果数量（0=无匹配, 1=1个, N=N个）
  resultList: object[];  // 匹配项的完整数据
}
```

### 各工具的 resultList 条目结构

**find_elements** — 已有，每项包含 `{ tag, id, classes, text, selector, rect, ... }`

**trace_css** — `resultList` 含一项：
```typescript
{
  element: { tagName, id, classes, text, boundingRect },
  cssRules: [...]
}
```

**check_layout** — `resultList` 含一项：
```typescript
{
  element: { tagName, id, classes, text, boundingRect },
  layout: { ... }
}
```

**show_dom_tree** — `resultList` 含一项：
```typescript
{
  element: { tagName, id, classes, text, boundingRect },
  tree: { ... }
}
```

## 统一输入结构：ElementLocator

下游工具（`trace_css` / `check_layout` / `show_dom_tree`）的元素定位参数改为接收一个 `ElementLocator` 对象，而非裸 `selector` 字符串：

```typescript
/**
 * 元素定位信息，通常由 find_elements 的 resultList 条目直接传入。
 * 包含多个属性供 evaluate 内联合定位。
 */
const ElementLocatorSchema = Type.Object({
  /** CSS selector */
  selector: Type.String({ description: 'CSS selector' }),
  /** 在 selector 匹配列表中的位置（0-based），用于多匹配时定位具体元素 */
  index: Type.Optional(Type.Integer({ description: '匹配列表中的位置（0-based）', minimum: 0 })),
  /** 元素标签名，用于联合校验 */
  tag: Type.Optional(Type.String({ description: '元素标签名，如 div、span' })),
  /** 元素文本摘要，用于联合校验 */
  text: Type.Optional(Type.String({ description: '元素文本内容摘要' })),
});
```

**LLM 使用方式**：

```
# find_elements 找到 3 个匹配「.btn」的元素：
#   resultList = [
#     { selector: ".btn", tag: "button", text: "确认", classes: ["btn-primary"], ... },
#     { selector: ".btn", tag: "button", text: "取消", classes: ["btn-secondary"], ... },
#     { selector: ".btn", tag: "button", text: "删除", classes: ["btn-danger"], ... },
#   ]

# LLM 决定要查"删除"按钮的样式：
trace_css({ selector: ".btn", index: 2, tag: "button", text: "删除" })
```

对象中的 `selector` + `index` 提供精确索引，`tag` + `text` 提供校验兜底。

## 改动 1：`core/selector-utils.ts` — 用 ElementLocator 定位元素

### 1.1 新增 `locateElement` evaluate 函数

替换原来仅靠 `document.querySelector(sel)` 的方式，改为多属性联合定位：

```typescript
/**
 * 在 page.evaluate 内执行：用 selector + index 定位元素，
 * 并用 tag / text 校验身份。
 */
export interface LocateOptions {
  selector: string;
  index?: number;
  tag?: string;
  text?: string;
}

export async function locateElement(
  page: Page,
  opts: LocateOptions
): Promise<Element | null> {
  // 定位 + 校验全部在 evaluate 内完成，避免多次 round-trip
  const found = await page.evaluate((opts: {
    selector: string;
    index?: number;
    tag?: string;
    text?: string;
  }) => {
    const matches = document.querySelectorAll(opts.selector);
    if (matches.length === 0) {
      return { ok: false, kind: 'not_found' as const };
    }

    const idx = opts.index ?? 0;
    const el = matches[idx] ?? null;
    if (!el) {
      return { ok: false, kind: 'index_out_of_range' as const, total: matches.length, requested: idx };
    }

    // 校验 tag（如果提供）
    if (opts.tag && el.tagName.toLowerCase() !== opts.tag.toLowerCase()) {
      return {
        ok: false,
        kind: 'tag_mismatch' as const,
        expected: opts.tag,
        actual: el.tagName.toLowerCase()
      };
    }

    // 校验 text（如果提供）— 前缀匹配，容错
    if (opts.text) {
      const elText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (!elText.includes(opts.text) && !opts.text.includes(elText)) {
        return {
          ok: false,
          kind: 'text_mismatch' as const,
          expected: opts.text,
          actual: elText.slice(0, 50)
        };
      }
    }

    // 成功定位
    return { ok: true as const, count: matches.length };
  }, opts);

  return found;
}
```

> **注意**：`page.evaluate` 返回的是序列化后的普通对象，不是 DOM `Element` 引用。
> `locateElement` 的实际用途是**验证定位结果**（ok / 错误类型），而后续的数据收集 evaluate 会在内部
> 重复同一套定位逻辑，一次 round-trip 完成定位 + 数据收集。
>
> 或者，更简洁的做法：**不在 `locateElement` 中单独做一轮 evaluate**，
> 而是把定位逻辑内联到各工具自己的 evaluate 函数开头。详见下方各工具改动。

### 1.2 `validateSelectorUniqueness` 改为 `resolveElement`

合并原有的"校验唯一性"和新的"多属性定位"，统一为一个函数：

```typescript
export type ResolveResult =
  | { ok: true; count: number }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'multiple'; count: number; items: Array<{ tag: string; text: string; nthSelector: string }> }
  | { ok: false; kind: 'index_out_of_range'; total: number; requested: number }
  | { ok: false; kind: 'tag_mismatch'; expected: string; actual: string }
  | { ok: false; kind: 'text_mismatch'; expected: string; actual: string }
  | { ok: false; kind: 'invalid'; message: string };

export async function resolveElement(
  page: Page,
  locator: { selector: string; index?: number; tag?: string; text?: string }
): Promise<ResolveResult> {
  const result = await page.evaluate((sel: string) => {
    // 现有逻辑：返回匹配列表 + ok/multiple/not_found
  }, locator.selector);

  // 不传 index，走原有逻辑（多元素报错）
  if (locator.index === undefined) {
    if (!result.ok) return result;
    if (result.count > 1) {
      // 仍返回 multiple 错误，让调用方知道
      return { ok: false, kind: 'multiple' as const, count: result.count, items: result.items };
    }
    return result;
  }

  // 传了 index：处理 not_found / invalid
  if (!result.ok && (result.kind === 'not_found' || result.kind === 'invalid')) {
    return result;
  }

  // 校验 index 范围
  const total = result.count!;
  if (locator.index < 0 || locator.index >= total) {
    return {
      ok: false,
      kind: 'index_out_of_range' as const,
      total,
      requested: locator.index
    };
  }

  return { ok: true, count: total };
}
```

## 改动 2：`tools/find-elements.ts` — 返回统一结构

### 2.1 返回值改为 `{ code, msg, number, resultList }`

```typescript
// 当前返回：
return {
  content: [{ type: 'text', text: summaryLines.join('\n') }],
  details: { ... }
};

// 改为：
return {
  content: [{ type: 'text', text: summaryLines.join('\n') }],
  details: {
    code: 0,
    msg: 'success',
    number: items.length,
    resultList: items  // 每项含 { selector, tag, text, classes, rect, ... }
  }
};
```

### 2.2 每条结果追加 index 属性

```typescript
// 每条 result item 增加 index 字段
const resultList = items.map((item, i) => ({
  ...item,
  index: i  // 供下游工具直接使用
}));
```

### 2.3 输出文本追加 `[index: N]`

```
找到 9 个匹配「.card」的元素:

1. <div.card> "自动守护"
   selector: div.command-list div.card > div:nth-child(1)   [index: 0]
2. <div.card> "人工接管"
   selector: div.command-list div.card > div:nth-child(2)   [index: 1]
...
```

## 改动 3：三个工具添加 `ElementLocator` 参数 + 统一返回结构

### 3.1 trace-css.ts

**参数变更**：`selector: string` → `locator: ElementLocator`（对象形式）

```typescript
parameters: Type.Object({
  locator: Type.Object({
    selector: Type.String({ description: 'CSS selector，通常来自 find_elements 的结果' }),
    index: Type.Optional(Type.Integer({ description: '匹配列表中的位置（0-based）', minimum: 0 })),
    tag: Type.Optional(Type.String({ description: '元素标签名，用于联合校验' })),
    text: Type.Optional(Type.String({ description: '元素文本内容摘要，用于联合校验' })),
  }),
}),

async execute(page, params) {
  const { selector, index, tag, text } = params.locator;

  // 1. 验证（无 index 时多元素仍报错）
  const validation = await resolveElement(page, { selector, index });
  if (!validation.ok) {
    // 现有报错逻辑不变，multiple 分支显示 [index: N] 提示
    // ...
  }

  // 2. 一趟 evaluate：定位 + 校验 + 数据收集
  const result = await page.evaluate((args: {
    selector: string; index?: number; tag?: string; text?: string;
  }) => {
    const matches = document.querySelectorAll(args.selector);
    const idx = args.index ?? 0;
    const el = matches[idx] ?? null;
    if (!el) return null;

    // 校验 tag / text（同 resolveElement 逻辑）
    if (args.tag && el.tagName.toLowerCase() !== args.tag.toLowerCase()) return null;
    if (args.text) {
      const elText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (!elText.includes(args.text) && !args.text.includes(elText)) return null;
    }

    // ── elementInfo + cssRules ──
    const elementInfo = { ... };
    const cssRules = [ ... ];
    return { elementInfo, cssRules };
  }, { selector, index, tag, text });

  if (!result) {
    return {
      content: [{ type: 'text', text: `❌ 未找到匹配元素` }],
      details: { code: 1, msg: `未找到匹配 "${selector}" 的元素`, number: 0, resultList: [] }
    };
  }

  const { elementInfo, cssRules } = result;
  // summaryLines 构建逻辑不变 ...

  return {
    content: [{ type: 'text', text: summaryLines.join('\n') }],
    details: {
      code: 0,
      msg: 'success',
      number: 1,
      resultList: [{ element: elementInfo, cssRules }]
    }
  };
}
```

### 3.2 check-layout.ts

同样的模式：

```typescript
parameters: Type.Object({
  locator: Type.Object({
    selector: Type.String({ description: 'CSS selector，通常来自 find_elements 的结果' }),
    index: Type.Optional(Type.Integer({ description: '匹配列表中的位置（0-based）', minimum: 0 })),
    tag: Type.Optional(Type.String({ description: '元素标签名，用于联合校验' })),
    text: Type.Optional(Type.String({ description: '元素文本内容摘要，用于联合校验' })),
  }),
  ancestors: Type.Optional(Type.Number({ ... }))
}),

async execute(page, params) {
  const { selector, index, tag, text } = params.locator;

  const validation = await resolveElement(page, { selector, index });
  if (!validation.ok) { /* 报错逻辑不变 */ }

  const data = await page.evaluate((args: {
    selector: string; index?: number; tag?: string; text?: string; ancestorCount: number;
  }) => {
    const matches = document.querySelectorAll(args.selector);
    const idx = args.index ?? 0;
    const el = matches[idx] ?? null;
    if (!el) return null;
    // 校验 tag / text
    if (args.tag && el.tagName.toLowerCase() !== args.tag.toLowerCase()) return null;
    if (args.text) {
      const elText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (!elText.includes(args.text) && !args.text.includes(elText)) return null;
    }
    // 后续布局收集逻辑不变 ...
  }, { selector, index, tag, text, ancestorCount: params.ancestors ?? 5 });

  // ... 格式化输出 ...
  return {
    content: [{ type: 'text', text: summaryLines.join('\n') }],
    details: {
      code: 0, msg: 'success', number: 1,
      resultList: [{ element: elementInfo, layout: layoutData }]
    }
  };
}
```

### 3.3 show-dom-tree.ts

同样的模式：

```typescript
parameters: Type.Object({
  locator: Type.Object({
    selector: Type.String({ description: 'CSS selector，通常来自 find_elements 的结果' }),
    index: Type.Optional(Type.Integer({ description: '匹配列表中的位置（0-based）', minimum: 0 })),
    tag: Type.Optional(Type.String({ description: '元素标签名，用于联合校验' })),
    text: Type.Optional(Type.String({ description: '元素文本内容摘要，用于联合校验' })),
  }),
  depth: Type.Optional(Type.Number({ ... }))
}),

async execute(page, params) {
  const { selector, index, tag, text } = params.locator;

  const validation = await resolveElement(page, { selector, index });
  if (!validation.ok) { /* 报错逻辑不变 */ }

  const tree = await page.evaluate((args: {
    selector: string; index?: number; tag?: string; text?: string; maxD: number;
  }) => {
    const matches = document.querySelectorAll(args.selector);
    const idx = args.index ?? 0;
    const el = matches[idx] ?? null;
    if (!el) return null;
    // 校验 tag / text
    if (args.tag && el.tagName.toLowerCase() !== args.tag.toLowerCase()) return null;
    if (args.text) {
      const elText = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
      if (!elText.includes(args.text) && !args.text.includes(elText)) return null;
    }
    // 后续 DOM 树构建逻辑不变 ...
  }, { selector, index, tag, text, maxD: params.depth ?? 3 });

  return {
    content: [{ type: 'text', text: summaryLines.join('\n') }],
    details: {
      code: 0, msg: 'success', number: 1,
      resultList: [{ element: elementInfo, tree }]
    }
  };
}
```

## 改动 4：更新 promptGuidelines

三个工具的 promptGuidelines 中说明 locator 参数的来源：

```typescript
promptGuidelines: [
  // ... 现有内容 ...
  '先用 chrome_find_elements 搜索元素，从返回的 resultList 中选取目标元素，将该条结果作为 locator 参数传入。',
  'locator 中的 selector + index 定位元素，tag 和 text 用于身份校验。',
]
```

`chrome_find_elements` 自身的 promptGuidelines 更新：

```
'如果返回了多个结果，将目标元素对应的完整结果条目作为 locator 传给下游工具（trace_css / check_layout / show_dom_tree）。'
```

## 改动文件清单

| 文件 | 改动内容 |
|------|---------|
| `core/selector-utils.ts` | ① 新增 `ResolveResult` 类型 ② `validateSelectorUniqueness` 重构为 `resolveElement`，接收 locator 对象 ③ 支持 index 定位 + tag/text 校验 |
| `tools/find-elements.ts` | ① 返回值改为 `{ code, msg, number, resultList }` ② 每条结果追加 `index` 字段 ③ 输出文本追加 `[index: N]` ④ promptGuidelines 更新 |
| `tools/trace-css.ts` | ① 参数 `selector` → `locator` 对象 ② evaluate 内多属性联合定位 + 校验 ③ 两趟 evaluate 合并为一趟 ④ 返回值改为 `{ code, msg, number, resultList }` ⑤ 多元素报错格式显示 `[index: N]` |
| `tools/check-layout.ts` | ① 参数 `selector` → `locator` 对象 ② evaluate 内多属性联合定位 + 校验 ③ 返回值改为 `{ code, msg, number, resultList }` ④ 多元素报错格式显示 `[index: N]` |
| `tools/show-dom-tree.ts` | ① 参数 `selector` → `locator` 对象 ② evaluate 内多属性联合定位 + 校验 ③ 返回值改为 `{ code, msg, number, resultList }` ④ 多元素报错格式显示 `[index: N]` |

## 向后兼容

- `locator` 对象中的 `index`/`tag`/`text` 均为可选。传 `{ selector: ".btn" }` 时，行为与原有 `selector: ".btn"` 一致
- `find_elements` 的 `details` 字段从旧结构变为 `{ code, msg, number, resultList }`，如果现有消费方依赖 `details` 的旧字段，需同步更新
- 返回结构统一后，LLM 可以用统一的模式处理所有工具的返回值

## 测试要点

1. **正常定位（多匹配 + index）**：`find_elements` 找到 5 个 `.card`，LLM 传 `{ selector: ".card", index: 2, tag: "div", text: "人工接管" }` 给 `trace_css`，正确获取第 3 个元素的样式
2. **tag 校验失败**：传 `{ selector: ".card", index: 0, tag: "span" }` 但实际是 `div`，返回清晰的 tag_mismatch 错误
3. **text 校验失败**：传 `{ selector: ".card", index: 0, text: "不存在" }`，返回 text_mismatch 错误
4. **index 越界**：匹配 3 个元素传 `index: 5`，返回 index_out_of_range 错误
5. **不传 index 仍报多匹配**：selector 匹配多个但不传 index，仍返回 multiple 错误 + `[index: N]` 提示
6. **唯一匹配不受影响**：selector 只匹配一个元素，无论是否传 index/tag/text 都正常工作
7. **find_elements 输出**：确认 `[index: N]` 提示正确显示，`resultList` 每项含 `index` 字段
8. **统一返回结构**：所有工具返回 `{ code, msg, number, resultList }` 格式
9. **trace-css 合并 evaluate**：确认 elementInfo 和 cssRules 在同一次 evaluate 中正确返回
