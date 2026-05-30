# v3 实施计划: chrome_check_layout（新增）

> 依赖：无。可与 show_dom_tree 并行开发。

---

## 目标

新增 `chrome_check_layout` 工具，收集元素的布局属性（display、overflow、flex 等）和尺寸数值（offset/scroll/client），沿祖先链向上展示每层的布局属性。替代目前用 `execute_js` 手写 `getComputedStyle()` 排查布局问题的低效流程。

**核心原则：不做诊断，只返回数据。** flex 嵌套、overflow 正常用途等边界情况下的自动判断容易误判，诊断交给 AI 更可靠。

---

## 工具定义

### 输入参数

```typescript
{
  selector: string;    // 必填，CSS 选择器
  ancestors?: number;  // 可选，向上排查的层数，默认 5，设为 0 跳过祖先链
}
```

### 输出格式

```
== 布局信息: <div#statusScreen> ==

元素布局属性:
  display: flex
  overflow-x: hidden
  overflow-y: hidden
  height: 688px
  position: relative
  flex-direction: column
  box-sizing: border-box

尺寸数值:
  垂直: offsetHeight=688  scrollHeight=1200  clientHeight=688
  水平: offsetWidth=300   scrollWidth=300    clientWidth=300

== 祖先链 (向上 5 层) ==

<body> [display:block, overflow:visible, height:auto, box-sizing:content-box]
  └─ <div#page-container> [display:flex, overflow:hidden, height:1463px, box-sizing:border-box]
       └─ <div#main> [display:block, overflow:auto, height:1403px, box-sizing:border-box]
            └─ <div#statusScreen> [display:flex, overflow:hidden, height:688px, box-sizing:border-box]
```

### 信息收集规则

| 区域 | 收集内容 |
|------|----------|
| **元素布局属性** | display、overflow-x、overflow-y、position、height、min-height、max-height、flex-direction、flex-wrap、box-sizing |
| **尺寸数值** | offsetWidth、offsetHeight、scrollWidth、scrollHeight、clientWidth、clientHeight |
| **祖先链每层** | display、overflow、height、min-height、max-height、position、box-sizing — 全部显示 `getComputedStyle` 计算值 |

---

## 实施步骤

### Step 1: 新建 `tools/check-layout.ts`

#### 1.1 参数定义

```typescript
parameters: Type.Object({
  selector: Type.String({ description: 'CSS selector，应定位到唯一元素' }),
  ancestors: Type.Optional(Type.Number({
    description: '向上排查祖先链的层数，默认 5，设为 0 跳过',
    minimum: 0,
    maximum: 20,
    default: 5
  }))
})
```

#### 1.2 execute 实现

核心逻辑全部在 `page.evaluate` 内完成（一次 round-trip）。

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

  // 2. 收集布局数据
  const data = await page.evaluate((sel: string, ancestorCount: number) => {
    // 元素自身收集的属性
    const LAYOUT_PROPS = [
      'display', 'overflow-x', 'overflow-y',
      'position', 'height', 'min-height', 'max-height',
      'flex-direction', 'flex-wrap', 'box-sizing'
    ];

    // 祖先链每层收集的属性（统一只取计算值，不做声明值→计算值的转换）
    const ANCESTOR_PROPS = [
      'display', 'overflow', 'height', 'min-height', 'max-height',
      'position', 'box-sizing'
    ];

    function collectLayoutProps(el: Element): Record<string, string> {
      const computed = getComputedStyle(el);
      const props: Record<string, string> = {};
      for (const prop of LAYOUT_PROPS) {
        const val = computed.getPropertyValue(prop);
        if (val) props[prop] = val;
      }
      return props;
    }

    function collectDimensions(el: HTMLElement) {
      return {
        offsetWidth: el.offsetWidth,
        offsetHeight: el.offsetHeight,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
      };
    }

    function collectAncestor(el: Element): {
      label: string;
      props: Record<string, string>;
    } {
      const computed = getComputedStyle(el);
      const props: Record<string, string> = {};
      for (const prop of ANCESTOR_PROPS) {
        const val = computed.getPropertyValue(prop);
        if (val && val !== 'normal') {
          props[prop] = val;
        }
      }
      return {
        label: formatLabel(el),
        props,
      };
    }

    function formatLabel(el: Element): string {
      let label = `<${el.tagName.toLowerCase()}`;
      if (el.id) label += '#' + el.id;
      const cls = Array.from(el.classList).slice(0, 3);
      if (cls.length > 0) label += '.' + cls.join('.');
      label += '>';
      return label;
    }

    // --- 主逻辑 ---
    const el = document.querySelector(sel) as HTMLElement;
    if (!el) return null;

    const label = formatLabel(el);
    const layoutProps = collectLayoutProps(el);
    const dimensions = collectDimensions(el);

    // 祖先链
    const ancestors: Array<{
      label: string;
      propsSummary: string;  // 格式化后的 "key:val, key:val"
    }> = [];

    if (ancestorCount > 0) {
      let current = el.parentElement;
      let depth = 0;
      // 遍历到 document.documentElement（<html>）为止，包含 <html>
      while (current && depth < ancestorCount) {
        const info = collectAncestor(current);
        const parts: string[] = [];
        for (const [prop, val] of Object.entries(info.props)) {
          parts.push(`${prop}:${val}`);
        }
        ancestors.push({
          label: info.label,
          propsSummary: parts.join(', ')
        });

        // 到达 <html> 时停止，不再向上
        if (current === document.documentElement) break;
        current = current.parentElement;
        depth++;
      }
    }

    return { label, layoutProps, dimensions, ancestors };
  }, params.selector, params.ancestors ?? 5);

  if (!data) {
    throw new Error(`❌ 未找到匹配 "${params.selector}" 的元素`);
  }

  // 3. 格式化输出
  const summary = formatLayout(data);

  return {
    content: [{ type: 'text', text: summary }],
    details: data
  };
}
```

#### 1.3 格式化函数（Node 侧）

```typescript
function formatLayout(data: any): string {
  const lines: string[] = [];

  // 标题
  lines.push(`== 布局信息: ${data.label} ==`);
  lines.push('');

  // 元素布局属性
  lines.push('元素布局属性:');
  const displayOrder = [
    'display', 'position', 'box-sizing',
    'overflow-x', 'overflow-y',
    'height', 'min-height', 'max-height',
    'flex-direction', 'flex-wrap'
  ];
  for (const prop of displayOrder) {
    const val = data.layoutProps[prop];
    if (val !== undefined) {
      lines.push(`  ${prop}: ${val}`);
    }
  }
  lines.push('');

  // 尺寸数值
  lines.push('尺寸数值:');
  const d = data.dimensions;
  lines.push(`  垂直: offsetHeight=${d.offsetHeight}  scrollHeight=${d.scrollHeight}  clientHeight=${d.clientHeight}`);
  lines.push(`  水平: offsetWidth=${d.offsetWidth}   scrollWidth=${d.scrollWidth}    clientWidth=${d.clientWidth}`);

  // 祖先链
  if (data.ancestors.length > 0) {
    lines.push('');
    lines.push(`== 祖先链 (向上 ${data.ancestors.length} 层) ==`);
    lines.push('');

    for (let i = 0; i < data.ancestors.length; i++) {
      const ancestor = data.ancestors[i];
      const indent = '  '.repeat(i);
      if (i === 0) {
        lines.push(`${ancestor.label} [${ancestor.propsSummary}]`);
      } else {
        lines.push(`${'  '.repeat(i - 1)}  └─ ${ancestor.label} [${ancestor.propsSummary}]`);
      }
    }
  }

  return lines.join('\n');
}
```

#### 1.4 工具元数据

```typescript
name: 'chrome_check_layout',
label: 'Chrome Check Layout',
description: '检查元素的布局属性和尺寸数值，沿祖先链向上展示各层布局信息。用于排查溢出、高度约束断裂、flex 布局等问题。',
promptSnippet: '检查元素布局属性和尺寸',
promptGuidelines: [
  '【排查布局问题】当内容溢出、滚动条异常、尺寸不对、flex/grid 不生效时，用 chrome_check_layout 查看元素的布局属性和尺寸数值。',
  '默认沿祖先链向上查 5 层，展示每层的 display、overflow、height、box-sizing 等属性。排查"高度约束断裂"时特别有用。',
  '工具只返回数据，不做诊断。请根据返回的数值自行判断问题所在。',
  '先找到元素: chrome_find_elements → chrome_check_layout(selector)',
  '如需查看样式来源（哪条规则设置的 display:flex），用 chrome_trace_css。'
]
```

---

### Step 2: 注册工具

在 `index.ts` 中添加 import 和注册。

---

## 关键设计决策

### 祖先链只取计算值，不做「声明值 → 计算值」转换

原始设计中想显示 `height:100vh → 1463px`（CSS 声明值 + 计算后像素值），但 `getComputedStyle()` 返回的就已经是计算值了。要拿到声明值需要通过 CDP 的 `CSS.getMatchedStylesForNode`，那属于 `trace_css` 的职责。

check_layout 统一只展示 `getComputedStyle` 的计算值，保持工具职责清晰：
- **trace_css** → 样式来源 + 声明值
- **check_layout** → 计算值 + 尺寸数值

祖先链中如果看到 `height: 1463px`，AI 知道这是计算后的值。如果想知道为什么是 1463px（因为声明了 100vh），那是 trace_css 的事。

---

## 测试清单

### 基本功能
- [ ] 元素布局属性正确收集（display、overflow、height 等）
- [ ] 尺寸数值正确（offset/scroll/client 宽高）
- [ ] 祖先链向上展示 N 层
- [ ] ancestors=0 → 跳过祖先链
- [ ] ancestors=2 → 只查 2 层

### 祖先链边界
- [ ] 每层显示 tag + id + class
- [ ] 到达 `<html>` 时停止（包含 `<html>` 本身）
- [ ] 元素在 body 下直接子元素（祖先链：body → html，共 2 层）
- [ ] 元素在深层嵌套中，ancestors=5 截断正确

### 错误处理
- [ ] selector 匹配 0 个 → 明确报错
- [ ] selector 匹配多个 → 报错 + 附带 nth-child selector 列表
- [ ] 无效 CSS selector → 报错
- [ ] 未连接 Chrome → 由 ensureConnection() 统一处理

### 边界
- [ ] 隐藏元素（display:none）的布局属性
- [ ] 大量属性的元素（输出不截断关键信息）
- [ ] box-sizing 在所有层级正确展示

### iframe 边界
- [ ] 目标元素在 iframe 内 → 返回「未找到匹配元素」

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `tools/check-layout.ts` | 新建 |
| `index.ts` | 添加 import 和注册 |
