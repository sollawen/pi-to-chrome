---
name: page-evaluate-context
description: >
  puppeteer page.evaluate 上下文边界规则。编写或修改 puppeteer 工具代码时必须加载。
---

# page.evaluate 上下文边界

`page.evaluate(callback, ...args)` 的 callback 运行在浏览器内，**无法访问 Node.js 端的任何变量、函数、import、常量**。只有通过 args 传入的纯数据（字符串、数字、数组、对象）才能用。

**错误示例：**
```typescript
const SKIP_TAGS = new Set(['SCRIPT']);
function buildNode(el) { ... }

await page.evaluate((sel) => {
  SKIP_TAGS.has(el.tagName);  // ❌ ReferenceError
  buildNode(el);               // ❌ ReferenceError
}, selector);
```

**规则：callback 内部用到的函数和常量，必须全部定义在 callback 内部。** TypeScript 类型（interface/type）可以放外面，因为编译后会被擦除。格式化展示函数放外面也没问题，它们只处理纯数据不需要 DOM API。
