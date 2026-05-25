# find_elements v2 设计思路

## 核心定位

find_elements 本质是一个**小型 DOM 搜索引擎**。

它的使命是：把用户用自然语言描述的意图，映射到页面上具体的 DOM 元素。

用户的描述是模糊的（"那个灯泡"、"开关"、"开始时间"），而 DOM 元素是精确的（`div.status-lamp`、`input[type="checkbox"]#autoStart`）。中间的鸿沟就是这个搜索引擎要填的。

## 现在的问题

### 1. 搜索维度单一
现在只能按 textContent 搜。但页面上大量元素没有文字——灯泡是 `div.status-lamp`，开关是 `input[type="checkbox"]`，图标是 SVG。这些纯视觉元素，textContent 搜不到。

### 2. 结果缺乏上下文
搜"Ready"找到了 `div.screen-text`，但不知道它住在哪个区域里。还得手动往上找 parentElement 才能定位到 `div#infoScreen`。

### 3. 三种搜索模式互斥
text、selector、tag 是 else if 关系，只能选一个。但真实场景经常需要组合——"文本含 Receiver 的 div"。

## 设计方向

### 方向一：多信号召回

不应该只看 textContent。一个 DOM 元素身上有很多信号：

- **textContent**：页面可见的文字
- **className**：开发者起的语义化名字（status-lamp、command-list）
- **id**：最有信息量的标识符
- **tagName**：input、button、svg
- **属性值**：placeholder、title、aria-label、type

其中 className 和 id 特别重要——它们是开发者对这个元素的命名，天然带有语义。`status-lamp` 就是"状态灯"，`receiverLamp` 就是"接收器灯"。这些信号比纯文本匹配更有指向性。

但不是所有信号都同等重要。需要多信号组合，按相关性打分。

### 方向二：可组合的搜索条件

text + className + tag 应该可以组合（AND 关系），而不是互斥。

比如搜"灯泡"：
- text 里搜 "灯泡/bulb/lamp" → 召回一些
- className 里搜 "lamp/bulb/light" → 召回另一些
- 两者取并集（OR），扩大召回率

比如搜"Receiver 旁边的灯泡"：
- text 搜 "Receiver" → 一批候选
- className 搜 "lamp" → 一批候选
- 取交集（AND）缩小范围

但这个灵活性可能过度设计。对于 LLM 调用场景，更实际的做法可能是：**所有关键词都在所有信号维度上搜**——同一个关键词同时搜 text、className、id，命中任意一个就算匹配。这样接口简单（还是一个 text 参数），但召回面广。

### 方向三：结果带祖先链

每个结果不仅返回自身，还返回祖先链（5-6层），每层只取 tag/id/class。

这就像 Chrome DevTools 的面包屑。好处：
- 立刻知道元素住在哪里（上下文）
- 祖先链上的 id 暴露出区域名称（infoScreen、statusScreen）
- 几乎不增加成本（每层 3 个字段）

### 方向四：智能排序

多个结果时，最有用的排前面。排序信号：

- **有 id**：排前面（id 是最有信息量的）
- **面积小**：排前面（具体控件 > 大容器）
- **文本精确匹配**：排前面（"Ready" 精确匹配 > "Ready to go" 子串）
- **可见**：排前面

### 方向五：搜索结果上限与摘要

当结果很多时，返回所有没有意义。应该：
- 默认返回前 10-15 个（按相关性排序后的）
- 给出摘要：共多少个匹配，分布在哪里

## 开放问题

1. **className 搜索要不要作为独立参数？** 还是让同一个关键词同时搜 text 和 class？后者接口更简单，但可能噪音更多。

2. **组合搜索的语义？** 多个关键词之间是 OR（扩大召回）还是允许 AND（精确筛选）？对于 LLM 调用场景，OR + 排序可能就够了。

3. **搜索粒度？** 要不要支持搜 placeholder、aria-label 这些属性？优先级不高，但某些场景有用。

4. **和 selector 搜索的关系？** selector 是精确匹配，完全不同的搜索模式。是保持分离，还是也纳入统一的搜索框架？

## 待讨论

- 方向二里的"同一关键词搜所有维度"vs"独立参数"哪个更好？
- 排序策略是否足够？还是需要更精细的？
- 还有没有遗漏的搜索场景？
