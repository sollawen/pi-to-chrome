# find_elements v2 设计方案

> 日期：2026-05-25

---

## 1. 一个问题

pi 看到页面，用户说「左边的命令卡片」或「那个绿色灯泡」，pi 需要找到这个元素。

**本质上就是：一个搜索词 → 一组匹配元素。**

## 2. 接口

```typescript
findElements(text: string)
```

就这一个参数。

- `/` 分隔多关键词（OR），如 `"灯泡/lamp/bulb"`
- 同时搜 textContent、className、id、tagName、aria-label 等属性，不需要告诉工具搜哪个维度
- 默认只返回可见元素，不需要参数控制

没有 `selector`、没有 `tag`、没有 `mode`、没有 `visibleOnly`。
pi 如果知道精确 selector，直接用 `execute_js` 就行，不需要这个工具。

## 3. 搜索逻辑

全部在 `page.evaluate()` 内一次完成：

1. **遍历** — TreeWalker 遍历 body 下所有元素，跳过 script/style/meta
2. **匹配** — 每个元素对关键词列表同时检查 5 个维度（见下），任意命中即保留
3. **过滤** — 去掉不可见的（display:none / 面积 0x0 / offsetParent 为 null）
4. **去重** — 祖先和后代同时命中时，只保留后代（最具体的）
5. **排序** — 三档排序，取 Top 15

### 搜索维度

| 维度 | 匹配字段 | 示例 |
|------|---------|------|
| textContent | `el.textContent` | "下次唤醒" 命中标签文字 |
| className | `el.classList` 每个 class | "lamp" 命中 "status-lamp" |
| id | `el.id` | "wake" 命中 "nextWakeTime" |
| tagName | `el.tagName` | "button" 命中 `<button>` |
| 语义属性 | `aria-label` / `title` / `placeholder` / `alt` | "搜索" 命中 `placeholder="搜索..."` |

### 排序：三档

不做复杂公式，分三档排序。档内按面积从小到大（面积小 = 更具体的元素）。

| 优先级 | 条件 | 为什么 |
|--------|------|--------|
| 🥇 精准命中 | id 命中，或 textContent 精确匹配 | id 唯一最精准；精确文本说明找对了 |
| 🥈 语义命中 | className 命中，或语义属性命中 | class 和 aria-label 都是开发者有意命名的语义标识 |
| 🥉 模糊命中 | textContent 子串匹配，或 tagName 命中 | 覆盖面广但可能有噪音 |

档内排序：面积从小到大。灯泡 12×12 排在容器 720×510 前面。

## 4. 返回结构

```typescript
interface FindElementResult {
  // 用于后续操作的唯一 selector
  selector: string;       // "#guardianLamp" 或 ".status-lamp.green" 等

  // 人类可读描述
  tag: string;            // "div"
  id: string | null;      // "guardianLamp"
  classes: string[];      // ["status-lamp", "green"]
  text: string;           // textContent 截断 80 字符

  // 上下文
  ancestors: string;      // "body > div.main-container > div#statusScreen"

  // 位置
  rect: { x: number; y: number; w: number; h: number } | null;
}
```

**返回值：**

```typescript
{
  content: [{ type: 'text', text: "找到 3 个匹配「灯泡/lamp」的元素" }],
  details: {
    total: 3,
    results: FindElementResult[]
  }
}
```

## 5. selector 的生成策略

返回给 pi 的 `selector` 字段需要能唯一定位该元素：

1. 有 id → `"#id"`
2. 无 id → `"tag.class1.class2"`（组合 tag + 全部 class）
3. 以上不唯一 → 加上祖先路径，如 `"#statusScreen > div > span.value"`

这个 selector 直接喂给 `execute_js` 或 `inspect_styles` 使用。

## 6. 完整流程

```
text = "灯泡/lamp/bulb"
  ↓
page.evaluate() 内：
  ├── TreeWalker 遍历所有元素
  ├── 多信号匹配（text / class / id / tag / aria属性）
  ├── 可见性过滤
  ├── 子树去重
  └── 三档排序 + 档内按面积排序
  ↓
Top 15 → 构建结果（含祖先链 + selector）
  ↓
返回给 pi
```

一次 `page.evaluate()`，不需要多次来回。

## 7. promptGuidelines

```
- 用 chrome_find_elements 查找页面上用户描述的元素
- text 参数用 / 分隔中英文关键词，尽量多给变体。例：「灯泡」→ "灯泡/lamp/bulb/light"
- 拆成小词提高命中：「命令卡片列表」→ "命令卡片/命令/卡片/list/card/command"
- 返回的 selector 可直接用于 execute_js 和 inspect_styles
```

## 8. 改动范围

只改一个文件：`tools/find-elements.ts`。完全重写。

类型定义、tool-registry、其他工具不动。
