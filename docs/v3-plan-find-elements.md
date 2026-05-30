# v3 实施计划: chrome_find_elements summary 展示优化

> 依赖：建议在 trace_css、show_dom_tree、check_layout 完成后实施，promptGuidelines 需要引用新工具名。

---

## 目标

优化 `chrome_find_elements` 的 `content.text`（AI 主要看的字段），从一行摘要改为包含每个结果的标签、class、文本、selector 的列表。AI 一眼就能判断目标元素，拿到 selector 直接传给其他工具。

---

## 现状分析

### 当前代码位置
- `tools/find-elements.ts`

### 当前 summary（一行）

```
找到 3 个匹配「tab-item」的元素
```

所有信息在 `details.results` 中，但 AI 主要看 `content.text`，需要额外调用才能看到每个结果的详情。

### 当前返回结构

```typescript
return {
  content: [{ type: 'text', text: summary }],  // 只有一行
  details: { total: results.length, results }   // 完整信息在这里
};
```

---

## 改动内容

### 只改 summary 输出格式和 promptSnippet/promptGuidelines，不改返回数据结构

```
找到 3 个匹配「tab-item」的元素:

1. <div.tab-item.active> "Dashboard"
   selector: div.tab-item:nth-child(1)
2. <div.tab-item> "Tea Diary"
   selector: div.tab-item:nth-child(2)
3. <div.tab-item> "店铺编辑器"
   selector: div.tab-item:nth-child(3)
```

### 关键点

1. **selector 使用 `:nth-child()` 保证唯一性** — AI 可直接传给 trace_css / show_dom_tree / check_layout
2. **每个结果显示 tag + class + text** — AI 一眼判断是否为目标
3. **details 结构不变** — 向后兼容

---

## 实施步骤

### Step 1: 修改 `tools/find-elements.ts` 中的 summary 构建

#### 当前代码（在 execute 末尾）

```typescript
const summary = `找到 ${results.length} 个匹配「${params.text}」的元素`;

return {
  content: [{ type: 'text', text: summary }],
  details: { total: results.length, results }
};
```

#### 改为

```typescript
const summaryLines = [`找到 ${results.length} 个匹配「${params.text}」的元素:`, ''];

for (let i = 0; i < results.length; i++) {
  const r = results[i];

  // 标签描述: <tag.class1.class2#id>
  let label = `<${r.tag}`;
  if (r.classes.length > 0) {
    label += '.' + r.classes.slice(0, 3).join('.');
  }
  if (r.id) {
    label += '#' + r.id;
  }
  label += '>';

  // 文本内容（截断 40 字符）
  const text = r.text ? ` "${r.text.slice(0, 40)}"` : '';

  summaryLines.push(`${i + 1}. ${label}${text}`);
  summaryLines.push(`   selector: ${r.selector}`);
}

const summary = summaryLines.join('\n');

return {
  content: [{ type: 'text', text: summary }],
  details: { total: results.length, results }
};
```

### Step 2: 更新 promptSnippet

```
旧: '按关键词搜索页面元素'
新: '定位元素的 CSS selector'
```

更准确地描述工具的产出——不仅仅是「搜索」，而是给后续工具提供可直接使用的 selector。

### Step 3: 更新 promptGuidelines

```typescript
promptGuidelines: [
  '【定位元素的第一步】当你需要调试页面问题时，先用 chrome_find_elements 找到目标元素的 CSS selector，再用 chrome_trace_css 查样式来源、chrome_show_dom_tree 查结构、chrome_check_layout 查布局。',
  'text 参数用 / 分隔中英文关键词，尽量多给变体。例：「灯泡」→ "灯泡/lamp/bulb/light"',
  '拆成小词提高命中：「命令卡片列表」→ "命令卡片/命令/卡片/list/card/command"',
  '返回的 selector 可直接传给 chrome_trace_css / chrome_show_dom_tree / chrome_check_layout。',
  '如果返回了多个结果，挑选目标元素对应的 selector 使用。'
]
```

### Step 4: buildSelector 无需改动

当前 `buildSelector` 已有多级 fallback 保证唯一性：
1. id → 2. tag + all classes → 3. ancestor path → 4. nth-child

搜索 `tab-item` 返回 3 个 `<div class="tab-item">` 时：
- Strategy 2: `div.tab-item` → 3 个 → 不唯一 → 继续
- Strategy 3: ancestor path → 如果同层仍不唯一 → 继续
- Strategy 4: 加 `:nth-child()`

**结论**：多元素场景下一定会走到 `:nth-child()`，满足需求。无需改动。

---

## 测试清单

### summary 格式
- [ ] 1 个结果 → 显示标签 + selector
- [ ] 多个结果 → 编号列表，每项标签 + selector
- [ ] 无 id 的元素 → 只显示 class
- [ ] 有 id 的元素 → 显示 #id
- [ ] 文本为空 → 不显示引号部分
- [ ] 文本超长 → 截断到 40 字符

### selector 唯一性
- [ ] 同名多元素的 selector 一定包含 `:nth-child()`
- [ ] 唯一元素的 selector 不包含冗余的 `:nth-child()`

### 回归
- [ ] details 结构不变（total + results）
- [ ] 搜索结果排序不变（tier → area → y）
- [ ] 0 结果时仍抛出 error（不是改 summary）
- [ ] 搜索逻辑本身不变

### 与其他工具的集成
- [ ] 返回的 selector 传给 trace_css → 能正常工作
- [ ] 返回的 selector 传给 show_dom_tree → 能正常工作
- [ ] 返回的 selector 传给 check_layout → 能正常工作
- [ ] 多元素时从 summary 拿 nth-child selector → 传给其他工具 → 正常工作

### iframe 边界
- [ ] iframe 内的元素 → 不被搜索到（当前行为，确认不变）

---

## 涉及文件

| 文件 | 操作 |
|------|------|
| `tools/find-elements.ts` | 修改 summary 构建逻辑 + promptSnippet + promptGuidelines |
