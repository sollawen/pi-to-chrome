# v3 Step 0: CDP API 动态样式表验证报告

> 验证日期: 2026-05-28
> 测试页面: `ryuutei`、`calitools`、`teabox_player2`（均为纯外部 CSS，共 20+ 个 `<link>` 样式表）
> 测试元素: `div.msg-card`、`a.nav-link.active` 等

---

## 最终结论：使用 CSSOM 方案，无需 CDP 监听器

通过 `page.evaluate` + 浏览器原生 `document.styleSheets` API 获取文件名，完全不需要 CDP 监听器。

---

## 验证结果

### ✅ CSSOM 方案实测

```
元素 a.nav-link.active 的匹配结果:

  style2.css       选择器: *             属性: margin: 0px; padding: 0px; box-sizing: border-box;
  NavBar2.css      选择器: .nav-link     属性: text-decoration: none; color: rgb(0, 0, 0); ...
  NavBar2.css      选择器: .nav-link.active  属性: color: rgb(0, 0, 0); font-weight: 500; ...
```

文件名通过 `sheet.href` 获取，`<style>` 标签时 `href` 为空标记为 `<style>`。

### ✅ 跨域样式表处理

跨域样式表访问 `cssRules` 会抛异常 → try-catch 跳过即可（如 CDN 引入的 CSS）。

### ✅ inline style

通过 `el.style.cssText` 直接获取，无需遍历样式表。

### ✅ 覆盖范围

| 场景 | CSSOM 方案 | 状态 |
|------|-----------|------|
| 外部 CSS (`<link>`) | `sheet.href` → 文件名 | ✅ 已验证 |
| `<style>` 标签 | `sheet.href` 为空 → `<style>` | ✅ 自动覆盖 |
| CSS-in-JS | 同 `<style>` 逻辑 | ✅ 自动覆盖 |
| inline style | `el.style.cssText` | ✅ 已验证 |
| 跨域样式表 | try-catch 跳过 | ✅ 已验证 |
| user-agent 样式 | 不在 `document.styleSheets` 中 | 单独处理 |

---

## CDP 方案调查记录（备查）

### 为什么不用 CDP 监听器方案

1. **`rule.rule.sourceURL` 永远为 `undefined`** — 即使外部 CSS 文件也是空，这是当前 `inspect-styles.ts` 显示 `inline` 的 bug 根因
2. **CDP 没有 `CSS.getStyleSheetInfo` / `CSS.getAllStyleSheets`** — 无法按需查询
3. **唯一途径是 `CSS.styleSheetAdded` 事件** — 需要注册持久监听器，增加复杂度
4. **行号需要额外计算** — `header.startLine + style.range.startLine + 1`

### CDP 行号验证（已确认精确）

```
公式: header.startLine + style.range.startLine + 1
NavBar2.css:230 → 实际内容 ".msg-card {" ✅ 精确匹配
```

如未来需要行号功能，可再引入 CDP 方案。

---

## 实现策略（Step 1 依据）

### 核心方案：纯 CSSOM（无监听器）

在 `page.evaluate` 内完成所有样式来源匹配：

```typescript
const matchedRules = await page.evaluate((selector: string) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const results = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const fileName = sheet.href ? sheet.href.split('/').pop() : '<style>';
    try {
      for (const rule of sheet.cssRules) {
        if (rule instanceof CSSStyleRule) {
          try {
            if (el.matches(rule.selectorText)) {
              results.push({
                source: fileName,
                selector: rule.selectorText,
                properties: rule.style.cssText,
              });
            }
          } catch {}
        }
      }
    } catch {} // cross-origin
  }
  // inline style
  if (el.style.cssText) {
    results.unshift({ source: 'inline style', selector: '<inline>', properties: el.style.cssText });
  }
  return results;
}, selector);
```

### source 显示格式

```
[inline] inline style
  属性: top: 71px

[regular] NavBar2.css
  选择器: .msg-card
  属性: position: fixed; right: 30px; ...

[regular] style2.css
  选择器: *
  属性: margin: 0px; padding: 0px; ...
```
