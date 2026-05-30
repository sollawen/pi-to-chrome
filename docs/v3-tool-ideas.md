# pi-to-chrome v3 工具改进计划

---

## 设计原则

**工具没有智商。** 所有需要智力判断的事情交给使用工具的 AI 来做。工具只负责：收集数据、格式化输出、原样返回。不做诊断、不做推测、不做标注。

在这个前提下，从 AI 实际调试工作流出发，按"AI 遇到问题时的决策树"设计：

```
"我需要找到元素"           → find_elements
"我需要看子树结构"         → show_dom_tree
"我需要知道样式写在哪个文件" → trace_css
"我需要检查布局/溢出/尺寸"  → check_layout
```

每个问题对应唯一一个工具。AI 不犹豫、不混淆，遇到问题就知道该调哪个。

---

## 工具全景（6 个）

| 工具 | 一句话定位 | 回答什么问题 |
|------|-----------|-------------|
| `find_elements` | **定位** | "元素在哪？" |
| `show_dom_tree` | **看结构** | "子树长什么样？" |
| `trace_css` | **查来源** | "这条样式写在哪个文件？" |
| `check_layout` | **量效果** | "布局对不对？溢出了吗？" |
| `execute_js` | **万能补** | 上面都不够用时 |
| `read_console` | **看日志** | 控制台输出 |

### 为什么是这 6 个

AI 调试时本质上只问 4 类问题：

| 问题 | 数据来源 | 对应工具 |
|------|----------|----------|
| "元素在哪？" | DOM 搜索 | find_elements |
| "结构是什么样？" | DOM 树 | show_dom_tree |
| "样式从哪来？" | CSS 层叠链 | trace_css |
| "实际效果是什么？" | 运行时计算 | check_layout |

问题 3 和 4 的区别是关键：
- "`overflow:hidden` **写在哪个文件**？" → CSS 层叠链能回答
- "`scrollHeight` 比 `clientHeight` 大吗？" → CSS 层叠链**永远回答不了**，这是浏览器布局引擎的运行时计算结果

### 工具链路：selector 传递设计

所有工具以 CSS selector 为纽带串联。关键约束：**show_dom_tree、trace_css、check_layout 都要求 selector 定位到唯一元素**。

传递链路：
```
find_elements("关键词")
  → 返回带有 :nth-child() 的唯一 selector
    → 直接传给 show_dom_tree / trace_css / check_layout
```

如果 AI 传入了一个匹配多个元素的 selector：
- **show_dom_tree** → 报错，附带匹配元素列表 + 每个元素的 `:nth-child()` selector
- **trace_css** → 同上
- **check_layout** → 同上

错误消息格式统一（见「错误处理原则」），AI 可以直接从错误消息中拿到精确 selector，不需要再调一次 find_elements。

### 关键决策：show_dom_tree 只做 down，up 归 check_layout

- **show_dom_tree** → 只做向下展开子树（看结构）
- **check_layout** → 包含祖先链信息收集（向上查布局属性 + 尺寸数值）

理由：向上查的核心场景是排查布局问题，几乎没人会纯粹为了看标签名而向上查。find_elements 已返回压缩的 ancestor path，能满足"外面套了什么"的结构性需求。这样两个工具零重叠。

---

## 错误处理原则

所有工具统一遵循以下错误处理规则：

| 情况 | 返回内容 |
|------|----------|
| selector 匹配 0 个元素 | `❌ 未找到匹配该 selector 的元素` + 原样返回 selector |
| selector 匹配多个元素 | `❌ 该 selector 匹配了 N 个元素` + 附带每个元素的 tag/text/`:nth-child()` selector |
| selector 语法无效 | `❌ 无效的 CSS selector` + 原样返回 selector + 语法错误信息 |
| 目标页面未连接 | `❌ 未连接到任何页面，请先打开目标页面` |
| JS 执行超时（5s） | `❌ 执行超时` + 已完成的部分结果（如有） |

错误消息的格式化原则：
- 包含足够信息让 AI 自行修正（如附带 `:nth-child()` selector），不需要额外调用工具
- 不做推测（如不建议"你是不是想查..."），诊断交给 AI

### iframe 处理

v3 所有工具只操作主页面（top-level frame），不穿透 iframe。如果目标元素在 iframe 内，工具会返回 "未找到匹配元素"。如需操作 iframe 内元素，可通过 `execute_js` 手动获取 iframe 的 contentDocument。

---

## 改动清单

| # | 改动 | 类型 | 优先级 |
|---|------|------|--------|
| 0 | trace_css 动态样式表验证 | 验证 | P0-前置 |
| 1 | trace_css 修复样式来源（原 inspect_styles） | 修 bug | P0 |
| 2 | 新增 show_dom_tree（仅 down） | 新功能 | P0 |
| 3 | 新增 check_layout（信息收集 + 祖先链展示） | 新功能 | P1 |
| 4 | find_elements summary 展示优化 | 小改动 | P1 |

---

## 一、chrome_trace_css — 修复样式来源（P0）

### 痛点

返回的样式规则来源全部显示为 `unknown` 或 `inline`，无法知道某条 CSS 规则出自哪个文件、哪一行。一个 session 里大概有 30% 的时间在 grep 找文件。

### 根因

代码中已有 `sourceURL` + `sourceLine` 的拼接逻辑，但处理不完整：
- 外部 CSS 文件：`sourceURL` 可用，拼接 `sourceLine` 即可
- `<style>` 标签：`sourceURL` 为空，被 fallback 成 `'inline'`

### 实现方案

1. 对每条 matched rule，用 `styleSheetId` 调用 `CSS.getStyleSheetInfo` 拿到 `sourceURL`
2. 拼接 `sourceLine`（0-indexed，显示时 +1）
3. `<style>` 标签的规则：标记为 `<style>` + 来源 HTML 文件
4. user-agent 样式表：保持原样标记为 `user-agent`

### 动态样式表处理（CSS-in-JS / 运行时注入）

SPA 项目中常见 styled-components、Emotion、CSS Modules 等运行时注入的 `<style>` 标签。这些样式表的特征：
- `sourceURL` 为空或指向一个虚拟路径
- `styleSheetId` 存在，但 `CSS.getStyleSheetInfo` 返回的 `origin` 可能为 `regular`

处理策略：
1. 先用 `styleSheetId` 调用 `CSS.getStyleSheetInfo` 拿到 `sourceURL`
2. 如果 `sourceURL` 为空，尝试通过 `styleSheetId` 在 `CSS.getAllStyleSheets` 中匹配 `ownerNode` 的位置信息
3. 如果仍无法定位文件来源，标记为 `[dynamic]` + 所在 `<style>` 标签在 DOM 中的序号

> ⚠️ **开发前必须先做 Step 0 验证**：用 CodeMirror / Monaco Editor 等常见 CSS-in-JS 项目实测 `CSS.getStyleSheetInfo` 的返回值，确认上述策略可行。成本很低，但能避免实现后发现策略不可行导致的返工。
>
> **Step 0 验证报告**：验证完成后，在项目文档中记录以下信息，方便后续维护：
> - 测试的 CSS-in-JS 库及版本
> - `CSS.getStyleSheetInfo` 的实际返回值样例
> - 最终采用的策略及原因

### 期望输出格式

```
[regular] dashboard-container.css:60
  属性: padding: 10px 24px, cursor: pointer, ...

[regular] <style> index.html:45
  属性: display: flex, ...

[dynamic] <style> #2
  属性: background: #f0f0f0, ...

[inline] inline style
  属性: color: red, ...

[user-agent] user-agent
  属性: display: block, ...
```

---

## 二、新增 chrome_show_dom_tree 工具（P0）

### 痛点

想看"这个元素下面的 DOM 长什么样"时，只能用 `execute_js` 写 `outerHTML`，返回一坨 HTML 字符串，嵌套深了很难读。

### 定位

**只做向下展开子树**。看结构、看子元素关系、看嵌套层级。向上查归 check_layout。

### 使用流程

```
find_elements("关键词") → 拿到 selector → show_dom_tree(selector)
```

### 输入参数

- `selector`（必填）：CSS 选择器，应定位到**唯一一个元素**
- `depth`（可选）：最大展开深度，默认 3

### selector 匹配多个元素时

**报错，不自动取第一个**。但错误消息附带匹配元素列表，避免 AI 还要再调一次 find_elements：

```
❌ 该 selector 匹配了 3 个元素，请指定唯一元素:

1. <div.status-item> "自动模式"
   → div.status-item:nth-child(1)
2. <div.status-item> "手动模式"
   → div.status-item:nth-child(2)
3. <div.status-item> "关闭"
   → div.status-item:nth-child(3)
```

AI 可以直接从错误消息中拿到精准 selector，不需要再调一次 find_elements。自动取第一个可能取错元素导致误导。

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
       ...
```

信息：
- 标签名 + class + id
- 树状缩进，嵌套关系清晰
- 叶子节点附带文本内容（截断 40 字符）

### Shadow DOM 限制

`querySelector` 默认不穿透 Shadow DOM boundary。当目标页面使用 Web Components 时：
- 树展开会在 shadow boundary 处停止
- 如果遇到 shadow root，显示 `[shadow-root]` 标记，不继续展开
- v3 暂不支持穿透 shadow DOM
- 如需查看 shadow DOM 内部结构，AI 可通过 `execute_js` 使用 `element.shadowRoot.querySelector()` 手动穿透

### 大子树保护

同级兄弟超过 5 个时截断：

```
<ul.command-list>
  ├─ <li.command-item> "命令1"
  ├─ <li.command-item> "命令2"
  ├─ <li.command-item> "命令3"
  ├─ <li.command-item> "命令4"
  ├─ <li.command-item> "命令5"
  └─ ... 还有 23 个子节点省略
```

---

## 三、新增 chrome_check_layout 工具（P1）

### 痛点

调试布局问题时，最常查的是 `overflow`、`display`、`height`、`flex` 这些计算值，以及 `scrollHeight vs clientHeight`（判断是否溢出）。目前要手写 `execute_js` 用 `getComputedStyle()` 去取。

### 定位

**测量布局效果 + 祖先链信息收集**。回答"布局对不对？各层的布局属性是什么？"。不涉及样式来源（那是 trace_css 的活）。

**不做自动诊断，只返回数据**。flex 嵌套、overflow 正常用途等边界情况下自动判断容易误判，诊断交给 AI 做更可靠。

### 输入参数

- `selector`（必填）：CSS 选择器
- `ancestors`（可选）：沿祖先链向上排查的层数，默认 `5`，设为 `0` 则跳过祖先链诊断

### 输出格式

```
== 布局信息: <div#statusScreen> ==

元素布局属性:
  display: flex
  overflow: hidden
  height: 688px
  position: relative
  flex-direction: column

尺寸数值:
  垂直: offsetHeight=688  scrollHeight=1200  clientHeight=688
  水平: offsetWidth=300   scrollWidth=300    clientWidth=300

== 祖先链 (向上 5 层) ==

<body> [display:block, overflow:visible, height:auto → 1463px]
  └─ <div#page-container> [display:flex, overflow:hidden, height:100vh → 1463px]
       └─ <div#main> [display:block, overflow:auto, height:calc(100vh-60px) → 1403px]
            └─ <div#statusScreen> [display:flex, overflow:hidden, height:688px]
```

关键信息：
- 元素布局属性：display、overflow-x/y、position、height、flex-direction、flex-wrap
- 尺寸数值：offset/scroll/client（宽+高），原样返回
- 祖先链每层收集的属性：display、overflow、height、min-height、max-height、position、box-sizing
  - 同时显示 CSS 声明值 + 计算后像素值（如 `height:100vh → 1463px`）
- 不做自动诊断，只呈现数据，诊断由 AI 完成

---

## 四、chrome_find_elements — summary 展示优化（P1）

### 痛点

搜索结果的详细信息（tag、class、id、text）在 `details` 中已返回，但 `content.text` 只有一行 `找到 N 个匹配「xxx」的元素`。LLM 主要看 `content.text`，看不到每个结果的具体信息。

### 实现方案

**只改 summary 输出格式**，不改返回数据结构：

```
找到 3 个匹配「tab-item」的元素:

1. <div.tab-item.active> "Dashboard"
   selector: div.tab-item:nth-child(1)
2. <div.tab-item> "Tea Diary"
   selector: div.tab-item:nth-child(2)
3. <div.tab-item> "店铺编辑器"
   selector: div.tab-item:nth-child(3)
```

每个结果的 selector 使用 `:nth-child()` 保证唯一性，AI 可直接拿去调用 show_dom_tree / trace_css / check_layout，无需再手动构造。一眼就能判断是否为目标元素，减少后续查询。

---

## 典型场景验证

### 场景 A："按钮颜色不对"
```
find_elements("按钮") → trace_css(selector) → 改文件
```
2 次调用。定位 → 溯源。

### 场景 B："内容被截断了"
```
find_elements("区域") → check_layout(selector) → trace_css(问题容器) → 改文件
```
3 次调用。定位 → 诊断 → 溯源。check_layout 一步完成溢出确认 + 哪层有问题。

### 场景 C："结构不对，少了元素"
```
find_elements("区域") → show_dom_tree(selector) → 改 HTML
```
2 次调用。定位 → 看结构。

### 场景 D："flex 布局没生效"
```
find_elements("容器") → check_layout(selector) → trace_css(selector) → 改文件
```
3 次调用。定位 → 量效果 → 溯源。

每个场景都走直线：`定位 → 诊断 → 溯源`，没有犹豫，没有来回。

### 对比现状

| 场景 | 现状调用次数 | 新设计调用次数 | 改善 |
|------|------------|--------------|------|
| A: 样式来源 | 2（但来源全是 unknown） | 2（来源准确） | 质变 |
| B: 溢出排查 | 4-5（反复 execute_js） | 3 | -40% |
| C: 看结构 | 3（execute_js + 人工解读） | 2 | -33% |
| D: flex 问题 | 4（execute_js 测量 + 查来源） | 3 | -25% |

---

## 实施顺序

| 阶段 | 内容 | 说明 |
|------|------|------|
| Step 0 | trace_css 动态样式表验证 | 开发前验证，避免返工 |
| Step 1 | trace_css 修 bug | 解决最大痛点 |
| Step 2 | show_dom_tree | 依赖最少，独立性最强 |
| Step 3 | check_layout | 信息收集 + 祖先链展示 |
| Step 4 | find_elements summary 优化 | 影响所有场景，紧跟 check_layout |

---

## 本次不改动（v3 维持现状）

| 工具 | 说明 |
|------|------|
| `execute_js` | 功能完备，本次无改动 |
| `read_console` | 功能完备，本次无改动 |
