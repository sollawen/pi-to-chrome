# find_elements v2 实施计划

> 日期：2026-05-25
> 依据：find-elements-v2-设计方案.md
> 核心逻辑已在调研页面上通过 `chrome_execute_js` 实验证实可行

---

## 1. 项目上下文

### 1.1 改动范围

只改一个文件：`tools/find-elements.ts`，完全重写。

### 1.2 需要了解的现有文件

| 文件 | 作用 | 需要知道的 |
|------|------|-----------|
| `core/types.ts` | 定义 `ToolDefinition<TParams>` 接口 | 提供 `name`, `label`, `description`, `promptSnippet`, `promptGuidelines`, `parameters`, `execute` 字段。`execute` 签名：`(page: Page, params: TParams, deps?: ToolDeps) => Promise<ToolResult>` |
| `tool-registry.ts` | 注册所有工具 | 导入 `findElementsTool` 并放入 `ALL_TOOLS` 数组，已配置好，不需改动 |
| `tools/execute-js.ts` | 同系列工具 | 可参考其结构，但不依赖 |
| `tools/inspect-styles.ts` | 下游工具 | 消费 find-elements 返回的 selector |

### 1.3 导入

```typescript
import type { ToolDefinition } from '../core/types';
import { Type } from '@sinclair/typebox';
```

只需要这两个 import。不依赖其他文件。

---

## 2. 运行时边界

代码运行在两个完全隔离的上下文中：

```
Node 侧（Puppeteer）          浏览器侧（page.evaluate 内）
─────────────────────          ─────────────────────────────
execute()                      ← 一整块闭包注入到浏览器
  │                            ┌─────────────────────────┐
  ├─ 解析 text → keywords     │  searchElements(keywords)│
  ├─ page.evaluate(fn, kws) ─→│    ├─ matchElement()     │
  │                            │    ├─ isVisible()        │
  │                            │    ├─ deduplicate()      │
  │                            │    ├─ rank()             │
  │                            │    ├─ buildSelector()    │
  │                            │    └─ buildResult()      │
  ├─ 格式化 ToolResult  ←─────│  返回 JSON              │
  └─ return                    └─────────────────────────┘
```

**核心原则：所有 DOM 操作都在浏览器侧完成。** Node 侧只做参数解析和结果格式化。

**关键约束：** `page.evaluate(fn, args)` 会把 fn 序列化后注入浏览器执行。fn 内部**不能引用任何外部变量、不能 import**。所有浏览器侧函数必须定义在 fn 内部。

### 工具链定位

```
find-elements  → 不知道 selector，帮我找 → 返回 selector
                    │
                    ↓
execute-js     → 知道 selector，操作它  → 用 selector 定位
inspect-styles → 知道 selector，查样式  → 用 selector 定位
```

find-elements 的唯一职责就是把自然语言描述变成 selector。

---

## 3. 函数清单

### 浏览器侧（page.evaluate 内）

| # | 函数 | 输入 | 输出 | 职责 |
|---|------|------|------|------|
| 1 | `searchElements` | `keywords: string[]` | `FindElementResult[]`（Top 15） | 主入口，串联所有步骤 |
| 2 | `matchElement` | `el: Element, keywords: string[]` | `MatchResult \| null` | 多信号匹配，返回命中档位和详情，未命中返回 null |
| 3 | `isVisible` | `el: Element` | `boolean` | 可见性判断 |
| 4 | `deduplicate` | `matches: MatchWithEl[]` | `MatchWithEl[]` | 子树去重 |
| 5 | `rank` | `matches: MatchWithEl[]` | `void`（原地排序） | 三档排序，档内按面积升序 |
| 6 | `buildAncestorPath` | `el: Element` | `string` | 构建祖先链字符串 |
| 7 | `buildSelector` | `el: Element` | `string` | 生成唯一 CSS selector |
| 8 | `buildResult` | `el: Element, matchInfo: MatchResult` | `FindElementResult` | 组装返回对象 |

### Node 侧

| # | 函数 | 输入 | 输出 | 职责 |
|---|------|------|------|------|
| 9 | `execute` | `page: Page, params: { text: string }` | `ToolResult` | 解析参数，调 page.evaluate，格式化返回 |

---

## 4. 核心数据结构

```typescript
// matchElement 的返回值
interface MatchResult {
  tier: 1 | 2 | 3;        // 命中档位
  matchedBy: string;       // 命中的维度，如 "id:guardianLamp", "class:status-lamp", "text-exact", "text-substr", "tag:button", "attr:placeholder"
  matchedKeyword: string;  // 命中的那个关键词
}

// 搜索过程中间态
interface MatchWithEl {
  el: Element;
  match: MatchResult;
}

// 最终返回给 Node 的结构
interface FindElementResult {
  selector: string;
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  ancestors: string;
  rect: { x: number; y: number; w: number; h: number } | null;
  _debug?: {                 // 仅 DEBUG=true 时输出
    tier: number;
    matchedBy: string;
    matchedKeyword: string;
    area: number;
  };
}
```

---

## 5. 调用关系

```
execute(page, params)                              // Node 侧入口
  │
  │  keywords = params.text.split('/')...toLowerCase
  │
  ├→ page.evaluate(searchElements, keywords)       // 注入浏览器
  │     │
  │     ├→ TreeWalker 遍历 body
  │     │    └→ matchElement(el, keywords)          // 逐元素检查
  │     │         返回 MatchResult 或 null
  │     │
  │     ├→ 过滤掉 matchElement 返回 null 的
  │     ├→ 过滤掉 isVisible(el) === false 的
  │     │
  │     ├→ deduplicate(matches)                    // 子树去重
  │     │
  │     ├→ rank(matches)                           // 原地排序
  │     │
  │     ├→ 取前 15 个
  │     │
  │     └→ 对每个调 buildResult(el, match)          // 含 buildSelector + buildAncestorPath
  │
  ├→ 格式化 summary 文案
  └→ return { content, details }
```

---

## 6. 各函数详细逻辑

### 6.1 `execute(page, params)` — Node 侧

```
输入: page, { text }
逻辑:
  1. text 为空 → throw "请提供搜索关键词"
  2. keywords = text.split('/').map(k => k.trim().toLowerCase()).filter(k => k.length > 0)
  3. keywords 为空 → throw "请提供搜索关键词"
  4. results = await page.evaluate(searchElements, keywords)
  5. summary = `找到 ${results.length} 个匹配「${text}」的元素`
  6. return { content: [{ type: 'text', text: summary }], details: { total: results.length, results } }
```

### 6.2 `searchElements(keywords)` — 浏览器侧主入口

```
输入: keywords: string[]  (已小写化)
逻辑:
  1. TreeWalker(body, SHOW_ELEMENT) 遍历所有元素
     跳过: SCRIPT, STYLE, LINK, META, HEAD, NOSCRIPT
  2. 对每个元素:
     result = matchElement(el, keywords)
     if result !== null && isVisible(el):
       收集 { el, match: result }
  3. deduplicate(matches)
  4. rank(matches)
  5. 取前 15 个
  6. 对每个调 buildResult(el, match)
输出: FindElementResult[]
```

### 6.3 `matchElement(el, keywords)` — 多信号匹配（核心）

**设计要点：遍历所有关键词 × 所有维度，找最高 tier（数字最小），不短路。**

```
输入: el, keywords
逻辑:

  初始化: bestTier = 99, matchedBy = '', matchedKeyword = ''
  预计算:
    textContent = el.textContent.trim().toLowerCase()
    idLower = el.id.toLowerCase()
    tagLower = el.tagName.toLowerCase()
    classes = Array.from(el.classList)

  对每个 keyword in keywords:
    // ── Tier 1: 精准 ──
    if idLower 包含 keyword:
      if 1 < bestTier: bestTier = 1, matchedBy = "id:" + el.id, matchedKeyword = keyword
    if textContent === keyword:  // 精确匹配（完全相等）
      if 1 < bestTier: bestTier = 1, matchedBy = "text-exact", matchedKeyword = keyword

    // ── Tier 2: 语义 ──
    if bestTier > 2:
      遍历 classes:
        if class.toLowerCase() 包含 keyword:
          if 2 < bestTier: bestTier = 2, matchedBy = "class:" + 该class, matchedKeyword = keyword
      遍历 ['aria-label', 'title', 'placeholder', 'alt']:
        val = el.getAttribute(attr)
        if val && val.toLowerCase() 包含 keyword:
          if 2 < bestTier: bestTier = 2, matchedBy = "attr:" + attr, matchedKeyword = keyword

    // ── Tier 3: 模糊 ──
    if textContent 包含 keyword:  // 子串匹配
      if 3 < bestTier: bestTier = 3, matchedBy = "text-substr", matchedKeyword = keyword
    if tagLower === keyword:  // 精确匹配 tag 名
      if 3 < bestTier: bestTier = 3, matchedBy = "tag:" + tagLower, matchedKeyword = keyword

  遍历结束:
    if bestTier === 99 → return null（未命中）
    else → return { tier: bestTier, matchedBy, matchedKeyword }

关键：不短路。必须检查所有关键词×所有维度，才能保证找到最高 tier。
比如 keyword "lamp" 可能同时命中 id (tier 1) 和 class (tier 2)，要保留 tier 1。
```

### 6.4 `isVisible(el)` — 可见性判断

```
输入: el
逻辑:
  1. el.tagName === 'BODY' → true
  2. el.offsetParent === null → false
  3. rect = el.getBoundingClientRect()
     rect.width === 0 || rect.height === 0 → false
  4. 否则 → true
输出: boolean
```

### 6.5 `deduplicate(matches)` — 子树去重

```
输入: matches: MatchWithEl[]
逻辑:
  返回 matches 中满足以下条件的项 m:
    不存在另一个项 n，使得 m.el.contains(n.el) 且 m !== n
  即：如果 A 是 B 的祖先，且两者都命中，丢弃 A（保留后代 B）
输出: MatchWithEl[]
```

**为什么保留后代？** 祖先命中通常是因为 textContent 向上冒泡。后代才是用户要找的具体元素。

### 6.6 `rank(matches)` — 排序

```
输入: matches: MatchWithEl[]
逻辑（原地排序）:
  1. 主排序: match.tier 升序（1 → 2 → 3）
  2. 次排序: 面积 (rect.width × rect.height) 升序
  3. 第三排序: rect.y 升序（从上到下）
```

### 6.7 `buildAncestorPath(el)` — 祖先链

```
输入: el
逻辑:
  parts = []
  current = el.parentElement
  while current && current !== document.body && parts.length < 5:
    s = current.tagName.toLowerCase()
    if current.id: s += '#' + current.id
    取 current.classList 前 3 个:
      if 有 class: s += '.' + class1 + '.' + class2 + ...
    parts.push(s)
    current = current.parentElement
  return parts.join(' > ')

输出示例: "div#statusScreen > div.screen-item > span.value"
```

### 6.8 `buildSelector(el)` — 唯一 CSS selector 生成

```
输入: el
逻辑:

  // 策略 1: 用 id
  if el.id:
    candidate = '#' + el.id
    if querySelectorAll(candidate).length === 1 → return candidate

  // 策略 2: 用 tag + 全部 class
  tag = el.tagName.toLowerCase()
  if el.classList.length > 0:
    candidate = tag + '.' + Array.from(el.classList).join('.')
    if querySelectorAll(candidate).length === 1 → return candidate
  else:
    // 无 class，跳到策略 3

  // 策略 3: 从祖先往下拼路径
  // 从 el 开始，逐层向上构建 CSS 路径，直到路径唯一
  path = [tag + (el.classList.length > 0 ? '.' + Array.from(el.classList).join('.') : '')]
  current = el.parentElement
  while current && current !== document.body:
    level = current.tagName.toLowerCase()
    if current.id:
      level += '#' + current.id
    else if current.classList.length > 0:
      level += '.' + Array.from(current.classList).join('.')
    path.unshift(level)
    candidate = path.join(' > ')
    if querySelectorAll(candidate).length === 1 → return candidate
    current = current.parentElement

  // 策略 4: 兜底 nth-child
  // 用策略 3 最终拼出的完整路径 + nth-child
  // 注意: nth-child 是相对于父元素的，所以只在 path 最后一段加
  parentChildren = el.parentElement.children
  index = Array.from(parentChildren).indexOf(el) + 1
  return path.join(' > ') + ':nth-child(' + index + ')'

输出: string，保证 querySelectorAll 结果为 1
```

### 6.9 `buildResult(el, matchInfo)` — 组装返回对象

```
输入: el, matchInfo: MatchResult
逻辑:
  rect = el.getBoundingClientRect()
  result = {
    selector:  buildSelector(el),
    tag:       el.tagName.toLowerCase(),
    id:        el.id || null,
    classes:   Array.from(el.classList).slice(0, 10),
    text:      el.textContent.trim().slice(0, 80),
    ancestors: buildAncestorPath(el),
    rect:      { x: Math.round(rect.x), y: Math.round(rect.y),
                 w: Math.round(rect.width), h: Math.round(rect.height) }
  }

  // DEBUG 模式（硬编码开关）
  if (DEBUG) {
    result._debug = {
      tier: matchInfo.tier,
      matchedBy: matchInfo.matchedBy,
      matchedKeyword: matchInfo.matchedKeyword,
      area: Math.round(rect.width * rect.height)
    }
  }

  return result
```

---

## 7. 代码组织

整个文件的结构：

```typescript
import type { ToolDefinition } from '../core/types';
import { Type } from '@sinclair/typebox';

const DEBUG = false;  // 开发调试时改为 true

export const findElementsTool: ToolDefinition<{ text: string }> = {
  name: 'chrome_find_elements',
  label: 'Chrome Find Elements',
  description: '...',    // 见第 8 节
  promptSnippet: '...',
  promptGuidelines: [...],
  parameters: Type.Object({
    text: Type.String({ description: '...' })
  }),

  async execute(page, params) {
    // ── Node 侧逻辑 ──
    // 1. 解析参数
    // 2. page.evaluate(...)
    // 3. 格式化返回
    return { content, details };
  }
};
```

**浏览器侧代码在 execute 内部的 page.evaluate 闭包中：**

```typescript
async execute(page, params) {
  // 参数解析...
  const keywords = ...;

  const results = await page.evaluate((keywords) => {
    // ╔══════════════════════════════════════════════╗
    // ║  以下所有代码运行在浏览器中，不能引用外部变量  ║
    // ╚══════════════════════════════════════════════╝

    function matchElement(el, keywords) { ... }
    function isVisible(el) { ... }
    function deduplicate(matches) { ... }
    function rank(matches) { ... }
    function buildAncestorPath(el) { ... }
    function buildSelector(el) { ... }
    function buildResult(el, matchInfo) { ... }

    function searchElements(keywords) {
      // 主流程
      // ...
      return top15.map(m => buildResult(m.el, m.match));
    }

    return searchElements(keywords);
  }, keywords);

  // 格式化返回...
}
```

**注意：** `DEBUG` 变量在 page.evaluate 闭包外部定义。page.evaluate 内部**无法读取**它。解决方案：把 DEBUG 作为第二个参数传入。

```typescript
const results = await page.evaluate((keywords, debug) => {
  // ...
  // 在 buildResult 里使用传入的 debug 参数
  // ...
  return searchElements(keywords);
}, keywords, DEBUG);
```

---

## 8. ToolDefinition 元数据

```typescript
{
  name: 'chrome_find_elements',
  label: 'Chrome Find Elements',
  description: '搜索当前页面上的元素。关键词同时匹配文本、class、id、标签名等，智能排序返回最相关的结果。',
  promptSnippet: '按关键词搜索页面元素',
  promptGuidelines: [
    '用 chrome_find_elements 查找用户描述的页面元素。',
    'text 参数用 / 分隔中英文关键词，尽量多给变体。例：「灯泡」→ "灯泡/lamp/bulb/light"',
    '拆成小词提高命中：「命令卡片列表」→ "命令卡片/命令/卡片/list/card/command"',
    '返回的 selector 可直接用于 chrome_inspect_styles 和 chrome_execute_js。'
  ],
  parameters: Type.Object({
    text: Type.String({
      description: '搜索关键词，/ 分隔多关键词（OR）。同时匹配文本、class、id、标签名等。'
    })
  })
}
```

---

## 9. 验证清单

部署后在控制中心页面 (http://192.168.110.208:16080/control-center) 逐条验证：

| # | 输入 | 期望命中 | 期望 tier | 验证点 |
|---|------|---------|-----------|--------|
| A | `店铺编辑/店铺/编辑/store/edit` | `.tab-item` "店铺编辑器" | 3 (text子串) | 文本子串匹配 |
| B | `命令卡片/命令/卡片/list/card/command` | 多个 `.card` | 2 (class命中) | className 搜索覆盖了 text 搜不到的场景 |
| C | `下次唤醒/下次/唤醒/next/wake` | `#nextWakeTime` | 1 (id命中) | id 命中排最前 |
| D | `绿色/灯泡/green/lamp/light` | `#guardianLamp.status-lamp.green` | 1 (id) | textContent 为空但 id 命中 |
| E | `消息/message/msg/card/info` | `#msgCard.msg-card` | 1 (id) | 浮动元素正常返回 |
| F | `Ready/ready/status` | `div.screen-text` "Ready." | 1 (text精确) | 祖先链含 `#infoScreen` |

### 边界场景

| 场景 | 输入 | 期望 |
|------|------|------|
| 空输入 | `""` | 报错 |
| 无匹配 | `"xyzabc"` | total = 0，空数组 |
| 子树去重 | `"自动守护"` | 只返回 1 条（不返回父和子元素） |
| selector 唯一性 | 任意结果 | `querySelectorAll(result.selector).length === 1` |

---

## 10. 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| 大页面 TreeWalker 慢 | 低 | 实测 357 节点遍历 + 匹配 < 10ms；加 `matches.length > 500` 提前截断保护 |
| className 子串匹配噪音大 | 中 | Tier 2 排在 Tier 1 之后；Top 15 截断；档内面积排序让小元素优先 |
| selector 生成不唯一 | 低 | 最终兜底 nth-child |
| 无 id 无 class 的匿名元素 | 低 | 生成 nth-child 路径，可接受 |

---

## 11. 实验证证记录

核心搜索逻辑已在当前页面上通过 `chrome_execute_js` 验证通过：

| 测试 | 关键词 | 结果 |
|------|--------|------|
| 灯泡 | `绿色/灯泡/lamp/green/light` | ✅ 4 个灯泡全找到，Tier 1（id 命中），面积排序正确 |
| 下次唤醒 | `下次唤醒/下次/唤醒/next/wake` | ✅ label + #nextWakeTime 都找到，Tier 1 |
| 命令卡片 | `命令卡片/命令/卡片/list/card/command` | ✅ 9 张 .card 全找到，Tier 2（class 命中） |
| Ready | `ready/status` | ✅ status-lamp + Ready 文本，排序正确 |
