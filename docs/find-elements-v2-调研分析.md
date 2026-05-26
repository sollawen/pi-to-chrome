# find_elements v2 调研分析

> 调研日期：2026-05-25
> 调研页面：盗梦空间 控制中心 (http://192.168.110.208:16080/control-center)

## 1. 调研目标

用真实页面验证 plan-find-elements-v2.md 中提出的设计方向，回答开放问题，发现遗漏场景。

## 2. 调研页面结构

页面是"盗梦空间"系统的控制中心，分为三个区域：

```
body.ControlCenter-page
  ├── div.main-container
  │   ├── div#controlTabBar          ← 顶部 tab 栏
  │   │   ├── .tab-item.active "Dashboard"
  │   │   ├── .tab-item "Tea Diary"
  │   │   └── .tab-item "店铺编辑器"
  │   └── div#dashboardContainer
  │       ├── div#dashboardLeftPanel.dashboard-left   ← 左侧命令卡片列表
  │       │   └── div.command-list
  │       │       ├── .card "自动守护" / "切换到自动调度模式"
  │       │       ├── .card "人工接管" / "切换到手动模式"
  │       │       ├── .card "人工启动主算法"
  │       │       ├── .card "人工停止主算法"
  │       │       ├── .card "守护状态"
  │       │       ├── .card "teaOperator.log"
  │       │       ├── .card "teaSimmer.log"
  │       │       ├── .card "刷新storeConfig.yaml"
  │       │       └── .card "重置启动计数器"
  │       └── div#dashboardRightPanel.dashboard-right  ← 右侧状态面板
  │           ├── div#statusScreen      ← 状态指示区
  │           │   ├── #guardianLamp .status-lamp.green + "自动模式"
  │           │   ├── #senderLamp .status-lamp + "Sender"
  │           │   ├── #receiverLamp .status-lamp + "Receiver"
  │           │   ├── #makerLamp .status-lamp + "Maker"
  │           │   ├── "下次唤醒" + #nextWakeTime "08:00:00"
  │           │   ├── "启动次数" + #startOkCount "4"
  │           │   └── #lastUpdateTime "updated - 14:20:27"
  │           └── div#infoScreen        ← 信息显示区
  │               └── "Ready."
  └── div#msgCard.msg-card   ← 右下角消息卡片（浮动）
      └── "14:16:31 - ⏳ 正在加载店铺数据..."
          "14:16:31 - ✅ 加载成功"
```

页面共 83 个可见且有内容的 DOM 元素。

## 3. 需求场景验证

需求文档列出了典型用户描述，下面逐一分析现有搜索能否命中：

### 场景 A：「有个"店铺编辑"的地方」

- 目标：`div.tab-item` (text="店铺编辑器")
- 搜 "店铺编辑" → 子串匹配 textContent → ✅ 能命中
- 但返回的是 `div` 没有祖先链，pi 不知道它在 `#controlTabBar` 里

> 这时候，拆关键词应该是 店铺编辑/店铺/编辑/store-edit/store/edit

### 场景 B：「左边有一排的命令卡片列表」

- 目标：`div.command-list` 或其中的 `.card`
- 搜 "命令卡片" → textContent 里没有这个文字 → ❌ 搜不到
- 搜 "command" → 命中 className `command-list` → 需要多信号
- 搜 "card" → 命中 className `card`，但 10 张卡片全命中，需要排序筛选
- **结论：className 搜索是刚需，不是可选增强**

> 这时候，关键启应该是 left/command/card/list/左/命令/卡片/列表/命令卡片/命令卡片列表

### 场景 C：「主要显示区域里面，有个显示"下次唤醒"时间的地方」

- 目标：`span#nextWakeTime` (text="08:00:00")
- 搜 "下次唤醒" → 命中 `span.screen-text-secondary` (text="下次唤醒")
- 但用户要的是旁边的 `#nextWakeTime`，不是 label 本身
- 如果结果带祖先链：两者都在 `div.screen-screen-item` 下，pi 可以推断关联
- **结论：祖先链 + 同级元素信息有助于定位"标签+值"型组件**

> 下次唤醒/下次/唤醒/next/wake/wakeup

### 场景 D：「那个绿色的灯泡 / 状态指示灯」（需求文档中提到但页面隐含的场景）

- 目标：`div#guardianLamp.status-lamp.green`、`#senderLamp`、`#receiverLamp`、`#makerLamp`
- 这些元素的 textContent **全部为空**
- 唯一的标识信号：
  - className: `status-lamp`、`green`
  - id: `guardianLamp`、`senderLamp`、`receiverLamp`、`makerLamp`
- 搜 "lamp/灯泡/状态灯" → 必须搜 className 或 id
- **结论：纯 textContent 搜索完全失效，这是 v1 最大的盲区**

> green/lamp/绿色/灯泡/绿色灯泡

### 场景 E：「右下角的那个消息提示」

- 目标：`div#msgCard.msg-card`
- 搜 "消息/message" → 需要搜 className `msg-card` / `msg-item`
- 搜 "加载成功" → 能命中 `.msg-text`，但不知道它在消息卡片里
- **结论：textContent 部分能覆盖，className 搜索更精准**

> 右下角肯定是指方位了，肯定不是关键词了。那么关键词就只能是 message/msg/msg-info/msg-prompt....

### 场景 F：「那个 Ready 状态」

- 目标：`div.screen-text` (text="Ready.")，住在 `div#infoScreen` 里
- 搜 "Ready" → textContent 匹配 → ✅ 能命中
- 但页面上可能有多处 "Ready"，没有祖先链分不清是哪个区域的
- **结论：祖先链解决歧义问题**

> 这个关键词只能是 Ready/status 了

## 4. 搜索维度覆盖分析

| 元素类型 | textContent | className | id | 示例 |
|---------|:-----------:|:---------:|:--:|------|
| Tab 标签 | ✅ "店铺编辑器" | — | — | `.tab-item` |
| 命令卡片标题 | ✅ "自动守护" | — | — | `.card h3` |
| 命令卡片描述 | ✅ "切换到自动调度模式" | `.desc` | — | `.card p.desc` |
| 按钮 | ⚠️ "→" | `.btn-icon` | — | `button.btn-icon` |
| 状态灯 | ❌ 空 | ✅ `.status-lamp` | ✅ `#senderLamp` | 灯泡组件 |
| 数值显示 | ⚠️ "08:00:00" | `.screen-text` | ✅ `#nextWakeTime` | 时间显示 |
| 标签文字 | ✅ "下次唤醒" | `.screen-text-secondary` | — | label |
| 信息区域 | ✅ "Ready." | `.screen-text` | — | 位于 `#infoScreen` |
| 消息卡片 | ✅ "加载成功" | `.msg-card` | ✅ `#msgCard` | 浮动提示 |

**统计：83 个可见元素中，约 40% 的关键元素主要靠 className/id 标识，textContent 为空或无意义。**

## 5. 对 v2 计划的验证与修正建议

### 5.1 方向一（多信号召回）— 验证通过，需要补充

计划中说 className 和 id "特别重要"，调研证实了这一点。补充：

- **className 的语义价值不均**：`status-lamp`、`command-list`、`msg-card` 语义强，但 `screen-text`、`desc`、`content-col` 语义弱。搜索时应该**优先匹配语义强的 className**（如包含 lamp/card/list/tab 等常见组件词的），降低语义弱 className 的权重。
- **id 的价值极高且稳定**：`guardianLamp`、`nextWakeTime`、`statusScreen`，几乎总是最精准的命中。命中 id 应给最高权重。
- **tagName 在这个页面上区分度低**：绝大多数是 `div`，只有 `h3`、`p`、`button`、`span` 有区分度。但 button 和 input 确实有用——搜"按钮"时限定 `button`/`input` tag 可以过滤掉大量 div 噪音。

### 5.2 方向二（可组合搜索）— 建议简化

计划中在纠结"独立参数 vs 统一关键词搜所有维度"。调研结论：

**建议采用"统一关键词搜所有维度"方案**。理由：

- 这个页面上的用户描述都是单一概念（"灯泡"、"命令卡片"、"下次唤醒"），不存在需要 AND 组合两个不同维度的场景
- LLM 调用者只需传一个 text 参数，降低了工具使用门槛
- 召回面广，排序来解决噪音问题

但同时建议**保留一个 mode 参数**来区分两种搜索风格：
- `mode: "smart"`（默认）：关键词同时搜 text + className + id，模糊匹配
- `mode: "selector"`：用 CSS selector 精确匹配（保持现有能力）

### 5.3 方向三（祖先链）— 验证通过，补充建议

祖先链的实际价值：

1. **区域定位**：搜 "Ready" 返回的元素祖先链中有 `#infoScreen`，立刻知道是信息区的 Ready
2. **消除歧义**：同一页面可能有多个相同文本（不同 tab 里的同名按钮），祖先链区分
3. **帮助 pi 理解页面结构**：pi 不需要再调一次 inspect_styles 来找父元素

补充建议：

- 祖先链不需要太深。这个页面最深也就 8 层，返回 5 层足够覆盖到有意义的区域容器（如 `#statusScreen`、`#dashboardLeftPanel`）
- 祖先链每层只取 `tag#id.class` 就够，不要返回更多信息

### 5.4 方向四（智能排序）— 验证通过，补充权重建议

根据调研，排序权重建议（从高到低）：

| 信号 | 权重 | 理由 |
|------|------|------|
| id 命中 | 最高 | id 唯一，最精准。`#nextWakeTime` 比 `.screen-text` 有用得多 |
| className 语义命中 | 高 | `status-lamp`、`command-list` 比文本更具指向性 |
| 面积小 | 中高 | 具体控件（灯泡 12x12）比容器（main-container 720x510）有用 |
| 文本精确匹配 | 中 | "Ready." 精确 > "Ready to go" 子串 |
| 可见 | 基础门槛 | 不可见的直接过滤，不参与排序 |

### 5.5 方向五（结果上限）— 验证通过

83 个元素中，搜 "card" 会命中 10 个 `.card`。返回 10 个没问题，但需要摘要告诉 pi "共 10 个卡片，都在 `#dashboardLeftPanel .command-list` 下"。

## 6. 对开放问题的回答

### Q1: className 搜索要不要作为独立参数？

**答：不需要独立参数。** 同一个关键词同时搜 text + className + id，接口保持简单（一个 text 参数）。理由：
- 调研显示，用户描述（"灯泡"、"命令卡片"）并不区分"我要搜文字还是搜 class"
- LLM 也不擅长判断该用哪个参数
- 噪音通过排序解决，不需要通过参数拆分来解决

### Q2: 组合搜索的语义？

**答：单关键词搜所有维度（OR），不需要 AND。** 理由：
- 真实场景都是单一概念搜索，没有遇到需要 AND 的场景
- 如果 LLM 需要精确筛选，可以用 selector 模式
- 多关键词场景（如 "Receiver 旁边的灯泡"）应该由 LLM 分两次调用解决，不需要工具内置 AND 语义

### Q3: 要不要搜 placeholder、aria-label？

**答：暂不需要，优先级低。** 当前页面上没有用到这些属性。但实现时建议预留扩展点——在信号列表里加一个 `attrs` 信号，以后可以按需开启。

### Q4: selector 搜索的关系？

**答：保持分离，作为独立 mode。** selector 是精确匹配，逻辑完全不同。建议接口：
- `text` + `mode: "smart"`（默认）= 模糊搜索，多信号召回
- `text` + `mode: "selector"` = CSS selector 精确匹配

## 7. 发现的额外需求

### 7.1 按钮识别

页面上的 `button.btn-icon` 只有 "→" 作为文本，这个文字对搜索没有帮助。但 pi 可能会问"那个按钮/箭头"。建议：
- `tagName: button` 应该作为一个排序加分项
- 搜索 "按钮/button" 时，优先返回 `button` 和 `input[type=button/submit]` 元素

### 7.2 去重：同一张卡片的多个子元素

搜 "自动守护" 会同时命中 `.card`、`.content-col`、`h3`。这三个其实是同一张卡片的不同层级。建议：
- 结果去重：如果多个命中元素在同一棵子树里，只返回最具体的那个（深度最大的）

### 7.3 浮动元素的标注

`#msgCard` 是固定定位的浮动消息卡片。如果搜索结果能标注元素的定位方式（fixed/absolute），pi 能更好地理解元素是否"浮动在页面上方"。
- 这个优先级不高，但值得记录。

## 8. 总结

这次调研用真实页面验证了 v2 计划的核心判断，结论是**计划方向正确，需要细化和简化**：

1. ✅ 多信号召回是刚需（40% 关键元素无 textContent）
2. ✅ 祖先链解决上下文和歧义问题
3. ✅ 智能排序解决多信号召回带来的噪音
4. 🔧 可组合搜索建议简化为"单关键词搜所有维度"
5. 🔧 新增需求：结果去重（同一子树只返回最具体的）
