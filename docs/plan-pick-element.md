# 元素拾取器（Element Picker）— 实施计划

## 需求

用户在 Chrome 页面上移动鼠标，元素实时高亮（发光外框），pi 端同步显示当前元素的名称。用户点击某个元素后，该元素的 selector 确认并传给 LLM，拾取结束。

## 交互流程

```
用户: /chrome-pick

Chrome 端:
  鼠标移到元素 A → A 出现发光外框，pi 显示 A 的名字
  鼠标移到元素 B → A 的外框消失，B 出现发光外框，pi 显示 B 的名字
  鼠标在 B 内部移动 → 什么都不发生（同一个元素，不重复发送）
  鼠标移到元素 C → B 的外框消失，C 出现发光外框，pi 显示 C 的名字
  用户在 C 上 click → 外框清除，拾取结束，pi 确认选中 C

pi 端:
  编辑器上方 widget 实时显示当前 hover 的元素名称（原地更新，不刷消息）
  用户 click 后 widget 消失，对话中出现一条最终结果消息
```

## 技术方案

### 命令

新增 `/chrome-pick` 命令。无参数。

### 核心实现

```
/chrome-pick 命令处理器
│
├─ page.exposeFunction('__onHover', data => { ... })   ← 浏览器回调：hover 通知
├─ page.exposeFunction('__onPick', data => { ... })    ← 浏览器回调：click 确认
│
└─ page.evaluate(() => { ... })                         ← 注入拾取脚本
    ├─ 注入 <style> 发光外框样式
    ├─ mousemove (capture)：元素级去重，切换外框，调 __onHover()
    ├─ click (capture)：阻止默认行为，清理，调 __onPick()
    ├─ keydown (capture)：ESC 取消，清理，调 __onPick(null)
    └─ 返回清理函数引用（用于超时等外部清理场景）
```

### Chrome 端注入的 JS

```js
// 注入发光外框样式
const style = document.createElement('style');
style.textContent = '.__pick-outline { outline: 2px solid #00ff88 !important; outline-offset: 2px; }';
document.head.appendChild(style);

let lastEl = null;

// mousemove：元素级去重
document.addEventListener('mousemove', e => {
  if (e.target === lastEl) return;           // 同一个元素，跳过
  lastEl?.classList.remove('__pick-outline'); // 移除旧外框
  lastEl = e.target;
  lastEl.classList.add('__pick-outline');     // 添加新外框
  window.__onHover(buildPickData(lastEl));   // 通知 pi
}, true);

// click：确认选中
document.addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  cleanup();
  window.__onPick(buildPickData(e.target));
}, true);

// ESC：取消
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { cleanup(); window.__onPick(null); }
}, true);

function cleanup() {
  lastEl?.classList.remove('__pick-outline');
  style.remove();
  // 移除三个监听器（用引用，不用匿名函数）
}
```

### 构建元素信息（buildPickData）

在浏览器端执行，复用 `find_elements` 中已有的 `buildSelector` 逻辑：

```ts
{
  selector: string;      // 唯一 CSS selector
  tag: string;           // 标签名
  id: string | null;     // id
  classes: string[];     // class 列表
  text: string;          // 文本摘要
  label: string;         // 格式化标签：<tag.class#id>
}
```

### pi 端显示

| 阶段 | API | 说明 |
|------|-----|------|
| hover 时 | `ctx.ui.setWidget("chrome-pick", lines)` | 编辑器上方，原地更新 |
| click 确认 | `ctx.ui.setWidget("chrome-pick", undefined)` | 清除 widget |
| click 确认 | `pi.sendMessage({ customType: 'element-picked', ... })` | 最终结果写入对话，LLM 可见 |
| ESC 取消 | `ctx.ui.setWidget("chrome-pick", undefined)` | 清除 widget，不发消息 |

### 取消和超时

- **ESC 键**：浏览器端 keydown 监听，清理后调 `__onPick(null)`，pi 端取消
- **超时**：30 秒无操作自动取消，`page.evaluate()` 清理样式和监听器

### 自定义消息渲染

注册 `element-picked` 类型的渲染器，简洁显示最终选中结果。

## 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `tools/pick-element.ts` | 新建 | `/chrome-pick` 命令的实现（注入脚本 + 命令逻辑） |
| `index.ts` | 修改 | 注册 `/chrome-pick` 命令，注册 `element-picked` 消息渲染器 |
| `core/selector-utils.ts` | 修改 | 提取 `buildSelector` 为可导出的独立函数，供 pick 复用 |

## 复用现有代码

| 现有代码 | 复用方式 |
|----------|----------|
| `find_elements` 中的 `buildSelector()` | 提取到 `selector-utils.ts`，pick 脚本在 `page.evaluate` 内内联相同逻辑 |
| `selector-utils.ts` 的 `formatElementLabel()` | 直接 import |
| `browser.ts` 的 `ensureConnection()` + `getActivePage()` | 命令处理器中调用 |
| `index.ts` 已有的 `registerMessageRenderer` 模式 | 参考实现 |

## 实施步骤

1. **提取 `buildSelector`**：从 `find_elements` 的 `page.evaluate` 内部逻辑提取为 `selector-utils.ts` 中的独立函数
2. **创建 `tools/pick-element.ts`**：实现注入脚本和命令逻辑
3. **修改 `index.ts`**：注册命令和消息渲染器
4. **测试**：
   - 基本 hover → 外框切换 → pi 显示
   - click → 确认 → 消息写入对话
   - ESC → 取消
   - 超时 → 自动取消
   - 切换标签页后重新执行
