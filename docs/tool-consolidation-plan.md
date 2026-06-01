# 工具合并方案：6 → 1

## 背景

当前扩展注册了 6 个独立的 tools：

| Tool | 功能 | 实现方式 |
|------|------|----------|
| `chrome_find_elements` | 搜索元素 | `page.evaluate(js)` |
| `chrome_trace_css` | 追踪CSS | `page.evaluate(js)` |
| `chrome_show_dom_tree` | 查看DOM树 | `page.evaluate(js)` |
| `chrome_read_console` | 读console | 读 ConsoleBuffer |
| `chrome_execute_js` | 执行JS | `page.evaluate(js)` |
| `chrome_check_layout` | 查布局 | `page.evaluate(js)` |

### 问题

1. **Token 浪费**：6 个 tool schema 每次请求都发送到 LLM
2. **维护分散**：JS 逻辑散落在各 tool 文件里
3. **功能类似**：5 个都是往 Chrome 扔 JS，只有 `read_console` 特殊

### 收益

- 6 个 tool schema → 1 个
- JS 脚本集中管理，可独立测试
- 对用户更简单：一个 tool，action 参数区分功能

---

## 新目录结构

```
项目根目录/
├── index.ts              # 入口，连接管理，工具注册
├── commands/              # 斜杠命令（已完成）
│   ├── chrome-start.ts
│   └── chrome-stop.ts
├── core/                  # 核心功能
│   ├── browser.ts
│   ├── console-buffer.ts
│   ├── connection-state.ts
│   ├── selector-utils.ts
│   ├── shared-state.ts
│   ├── types.ts
├── tools/                 # 待合并：6 → 1
│   ├── find-elements.ts
│   ├── trace-css.ts
│   ├── show-dom-tree.ts
│   ├── read-console.ts
│   ├── execute-js.ts
│   ├── check-layout.ts
│   └── chrome-inspect.ts  # 合并目标（新增）
├── scripts/               # JS 脚本（新增，从 tools/ 提取）
│   ├── find-elements.js
│   ├── trace-css.js
│   ├── show-dom-tree.js
│   ├── execute-js.js
│   └── check-layout.js
└── docs/
```

---

## 核心设计

### index.ts 合并后改动

将 6 个 tool import 替换为单一 `registerChromeInspectTool`：

```typescript
import { registerChromeInspectTool } from './tools/chrome-inspect';

// 在 establishConnection 中调用：
registerChromeInspectTool(pi, consoleBuffer);
```
其余（commands、session 事件等）不变。

### tools/chrome-inspect.ts

```typescript
import { Type } from 'typebox';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';

// ─── 脚本加载 + 执行（内嵌） ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptCache = new Map<string, string>();

async function runScript(page: Page, scriptName: string, fnName: string, params: any): Promise<any> {
  if (!scriptCache.has(scriptName)) {
    const path = resolve(__dirname, '../scripts', scriptName);
    try {
      scriptCache.set(scriptName, await readFile(path, 'utf-8'));
    } catch {
      throw new Error(`[chrome_inspect] Script not found: ${scriptName}`);
    }
  }
  const code = scriptCache.get(scriptName)!;
  return page.evaluate(
    (src, fn, args) => { (0, eval)(src); return globalThis[fn](args); },
    code, fnName, params
  );
}

// ─── IIFE wrapper（从 execute-js.ts 迁移）──────────────────────────────────
// 表达式 → (() => expr)()，语句 → (() => { stmts })()
function wrapJsExpression(code: string): string {
  const trimmed = code.trim();
  const statementKeywords = ['return ', 'const ', 'let ', 'var ', 'if ', 'for ', 'while ', 'try ', 'switch ', 'throw ', 'function ', 'class ', 'async '];
  const isBlock = trimmed.startsWith('{') || statementKeywords.some(kw => trimmed.startsWith(kw));
  return isBlock
    ? `(() => { ${code} })()`
    : `(() => ${code})()`;
}

export function registerChromeInspectTool(pi, consoleBuffer) {
  pi.registerTool({
    name: 'chrome_inspect',
    label: 'Chrome Inspect',
    description: 'Chrome 页面检查工具：搜索元素、追踪CSS、查看DOM、读取console、执行JS、检查布局',
    
    promptGuidelines: [
      '【定位元素的第一步】当你需要调试页面问题时，先用 action="find_elements" 找到目标元素的 CSS selector，再用 trace_css / show_dom_tree / check_layout 操作。',
      '【元素找不到】当 trace_css / show_dom_tree / check_layout 返回空结果或报错时，说明 selector 无效，先退回到 find_elements 重新搜索。',
      '【查看元素结构】当需要了解某个容器内部的 HTML 结构、子元素关系时使用 show_dom_tree。返回树状图（标签、class、id、文本内容）。',
      '【查样式来源】当需要知道某条 CSS 规则写在哪个文件、被什么覆盖时使用 trace_css。返回 CSS 级联链（选择器、属性、来源文件）。',
      '【排错时的第一反应】当页面行为异常或功能不工作时，先用 read_console 查看 error 级别日志，定位 JS 报错。',
      '【获取精确数据的工具】当你需要元素的精确数值（offsetHeight、scrollHeight、getBoundingClientRect 等）或需要调用页面 API 时，用 execute_js。',
      '【排查布局问题】当内容溢出、滚动条异常、尺寸不对、flex/grid 不生效时，用 check_layout。返回计算后的布局属性、尺寸和祖先链。',
    ],
    
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('find_elements'),
        Type.Literal('trace_css'), 
        Type.Literal('show_dom_tree'),
        Type.Literal('read_console'),
        Type.Literal('execute_js'),
        Type.Literal('check_layout')
      ], { description: '操作类型：find_elements(搜索元素) → trace_css(样式来源)/show_dom_tree(结构)/check_layout(布局) 需要其输出的 selector；read_console(错误日志) 用于调试；execute_js(自定义 JS) 用于获取精确数据或调用页面 API' }),
      
      // find_elements
      text: Type.Optional(Type.String({ description: '搜索关键词，/ 分隔中英文变体。例："灯泡/lamp/bulb/light"' })),
      debug: Type.Optional(Type.Boolean({ default: false, description: '调试模式，返回额外调试信息' })),
      
      // trace_css / show_dom_tree / check_layout
      selector: Type.Optional(Type.String({ description: 'CSS selector，应从 find_elements 的输出中获取。需定位到唯一元素，否则可能返回多选一或报错' })),
      
      // show_dom_tree
      depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 3, description: '最大展开深度' })),
      
      // check_layout
      ancestors: Type.Optional(Type.Number({ minimum: 0, maximum: 20, default: 5, description: '向上排查祖先链的层数，默认 5，设为 0 跳过' })),
      
      // read_console
      level: Type.Optional(Type.Union([
        Type.Literal('log'),
        Type.Literal('warn'),
        Type.Literal('error'),
        Type.Literal('info'),
        Type.Literal('all')
      ], { default: 'error' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 })),
      
      // execute_js
      expression: Type.Optional(Type.String({ description: 'JavaScript 代码，在页面上下文执行。返回值会被序列化。不能使用 const/let，用 var 或 IIFE 包裹。可调用 document.*、window.* 等页面 API' })),
    }),
    
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await browser.ensureConnection();
      const page = await browser.getActivePage();
      
      switch (params.action) {
        case 'find_elements':
          return runScript(page, 'find-elements.js', 'findElements', { text: params.text });
        
        case 'trace_css':
          return runScript(page, 'trace-css.js', 'traceCss', { selector: params.selector });
        
        case 'show_dom_tree':
          return runScript(page, 'show-dom-tree.js', 'showDomTree', 
            { selector: params.selector, depth: params.depth ?? 3 });
        
        case 'read_console': {
          // 直接读 ConsoleBuffer，不走 page.evaluate（逻辑从 read-console.ts 迁移）
          const level = params.level ?? 'all';
          const limit = params.limit ?? 50;
          const messages = consoleBuffer.getMessages(level, limit);
          
          const typeEmoji = { log: '📝', warn: '⚠️', error: '❌', info: 'ℹ️' };
          const lines = messages.map(m => {
            const time = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
            const shortUrl = m.url.length > 60 ? m.url.slice(0, 57) + '...' : m.url;
            return `${typeEmoji[m.type] || '📝'} [${time}] ${m.text} (${shortUrl})`;
          });
          
          const totalCount = consoleBuffer.count;
          const errorCount = messages.filter(m => m.type === 'error').length;
          const warnCount = messages.filter(m => m.type === 'warn').length;
          const header = `缓冲区 ${totalCount} 条 | 返回 ${messages.length} 条 (${errorCount} errors, ${warnCount} warnings)`;
          const fullText = `${header}\n\n${lines.join('\n')}`;
          const truncated = fullText.length > 10000
            ? fullText.slice(0, 10000) + '\n\n... (截断，用更小的 limit 缩小范围)'
            : fullText;
          
          return {
            content: [{ type: 'text', text: truncated || '暂无 console 日志' }],
            details: { count: totalCount, filtered: messages.length }
          };
        }
        
        case 'execute_js': {
          const wrappedCode = wrapJsExpression(params.expression);
          return page.evaluate(wrappedCode);
        }
        
        case 'check_layout':
          return runScript(page, 'check-layout.js', 'checkLayout', 
            { selector: params.selector, ancestors: params.ancestors ?? 5 });
        
        default:
          throw new Error(`[chrome_inspect] Unknown action: ${params.action}`);
      }
    }
  });
}
```

---

## 实现步骤

### Phase 1: 创建 JS 脚本 ✅ 已完成

1. ✅ 从现有 tool 文件中提取 JS 逻辑为独立 `.js` 文件
2. ✅ 4 个脚本已通过浏览器注入测试

### Phase 2: 创建合并 Tool

1. 创建 `tools/chrome-inspect.ts` — 包含脚本加载缓存、runScript、wrapJsExpression、action 分发、read_console 格式化

（不再需要单独的 script-runner.ts 或 formatters.ts）

### Phase 3: 拆分命令 ✅ 已完成

### Phase 4: 测试

1. 手动测试每个 action
2. 验证返回结果格式
3. 验证 promptGuidelines 能正确引导 LLM

### Phase 5: 清理

1. 删除旧的 tool 文件（`tools/*.ts` 除了新文件）
2. 更新 `index.ts` 的 import
3. 更新文档

---

## 注意事项

### execute_js 的 wrapper 逻辑

已包含在 `chrome-inspect.ts` 的 `wrapJsExpression()` 函数中。逻辑从 `execute-js.ts` 直接迁移：
- 表达式 → `(() => expr)()`
- 语句（以 `{` 或语句关键字开头）→ `(() => { stmts })()`

### read_console 不走 page.evaluate

这是唯一一个不走 `page.evaluate` 的 action。格式化逻辑从 `read-console.ts` 直接内联到 `read_console` case 中，不需要单独的 formatters 文件。

### 脚本注入方式：单次 page.evaluate + 间接 eval

通过函数模式 `page.evaluate(fn, ...args)` 一次 round trip 完成。

**关键：必须用间接 eval `(0, eval)(src)` 而不是直接 `eval(src)`。**
直接 eval 在局部作用域执行，函数定义不会挂到 `globalThis`；间接 eval 在全局作用域执行，确保定义可被 `globalThis[fnName]` 访问到。

```typescript
return page.evaluate(
  (src, fn, args) => { (0, eval)(src); return globalThis[fn](args); },
  code, 'findElements', { text: params.text }
);
```

封装为 `runScript()` 后每个 case 只需一行。已内嵌在 `chrome-inspect.ts` 中。

### 脚本可独立运行

JS 脚本应该：
- 不依赖外部变量
- 不使用 import
- 函数签名自包含
- 只定义一个全局函数（不自动执行）

这样可以直接复制到浏览器控制台运行调试。

### 语法验证

提取后先用 `new Function(scriptContent)` 在 Node 端验证语法，再注入浏览器。避免注入时才发现语法错误。

### trace-css.js 的 el.matches() 安全

提取脚本时须保留原有 try/catch：`el.matches(rule.selectorText)` 对某些 CSS 选择器（如 vendor-prefixed pseudo）会抛异常，需静默跳过。
