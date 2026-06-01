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
│   └── types.ts
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
import { loadScript } from '../core/script-loader';
import { formatConsoleMessages } from '../core/formatters';
import type { BufferedConsoleMessage } from '../core/console-buffer';

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
      // ===== 通用 =====
      '先用 action="find_elements" 找到目标元素的 selector，再用 trace_css / show_dom_tree / check_layout 操作。',
      
      // ===== find_elements =====
      'Use action="find_elements" to search for elements by text keywords. Match against text, class, id, tag name simultaneously.',
      'text 参数用 / 分隔中英文关键词，尽量多给变体。例：「灯泡」→ "灯泡/lamp/bulb/light"',
      '拆成小词提高命中：「命令卡片列表」→ "命令卡片/命令/卡片/list/card/command"',
      
      // ===== trace_css =====
      'Use action="trace_css" to trace CSS style sources for an element.',
      '返回结果按优先级排列（inline > CSS class > user-agent）。',
      
      // ===== show_dom_tree =====
      'Use action="show_dom_tree" to view DOM subtree structure.',
      '返回树状图展示嵌套关系、标签名、class、id 和文本内容。',
      
      // ===== read_console =====
      'Use action="read_console" to read console messages from the buffer.',
      '排错时的第一反应：action="read_console", level="error" 查看 JS 报错。',
      'level 参数：debug/log/warn/error/info/all，limit 默认 50。',
      
      // ===== execute_js =====
      'Use action="execute_js" to execute JavaScript in page context.',
      '获取精确数据：offsetHeight、scrollHeight、getBoundingClientRect、scrollTop 等。',
      '代码中不能使用 const/let，请用 var 或 IIFE 包裹。例：JSON.stringify((function(){ var x = 1; return x })())',
      
      // ===== check_layout =====
      'Use action="check_layout" to check layout issues for an element.',
      '检测 overflow、z-index、position、flex/grid 等布局相关属性。',
      '默认沿祖先链向上查 5 层，ancestors 参数可调整（0 跳过）。',
    ],
    
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('find_elements'),
        Type.Literal('trace_css'), 
        Type.Literal('show_dom_tree'),
        Type.Literal('read_console'),
        Type.Literal('execute_js'),
        Type.Literal('check_layout')
      ]),
      
      // find_elements
      text: Type.Optional(Type.String({ description: '搜索关键词，/ 分隔' })),
      debug: Type.Optional(Type.Boolean({ default: false, description: 'find_elements 调试模式' })),
      
      // trace_css / show_dom_tree / check_layout
      selector: Type.Optional(Type.String({ description: 'CSS selector' })),
      
      // show_dom_tree
      depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 3 })),
      
      // check_layout
      ancestors: Type.Optional(Type.Number({ minimum: 0, maximum: 20, default: 5 })),
      
      // read_console
      level: Type.Optional(Type.Union([
        Type.Literal('log'),
        Type.Literal('warn'),
        Type.Literal('error'),
        Type.Literal('info'),
        Type.Literal('all')
      ])),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 })),
      
      // execute_js
      expression: Type.Optional(Type.String({ description: 'JavaScript code' })),
    }),
    
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await browser.ensureConnection();
      const page = await browser.getActivePage();
      
      switch (params.action) {
        case 'find_elements': {
          const script = await loadScript('find-elements.js');
          await page.evaluate(script);  // Step 1: 定义函数
          return page.evaluate(
            (p) => findElements(p),     // Step 2: 函数模式调用
            { text: params.text }
          );
        }
        
        case 'trace_css': {
          const script = await loadScript('trace-css.js');
          await page.evaluate(script);
          return page.evaluate(
            (p) => traceCss(p),
            { selector: params.selector }
          );
        }
        
        case 'show_dom_tree': {
          const script = await loadScript('show-dom-tree.js');
          await page.evaluate(script);
          return page.evaluate(
            (p) => showDomTree(p),
            { selector: params.selector, depth: params.depth ?? 3 }
          );
        }
        
        case 'read_console': {
          // 特殊处理：读 ConsoleBuffer，不走 page.evaluate
          const level = params.level ?? 'all';
          const limit = params.limit ?? 50;
          const messages = consoleBuffer.getMessages(level, limit);
          return formatConsoleMessages(messages, consoleBuffer.count);
        }
        
        case 'execute_js': {
          const wrappedCode = wrapJsExpression(params.expression);
          return page.evaluate(wrappedCode);
        }
        
        case 'check_layout': {
          const script = await loadScript('check-layout.js');
          await page.evaluate(script);
          return page.evaluate(
            (p) => checkLayout(p),
            { selector: params.selector, ancestors: params.ancestors ?? 5 }
          );
        }
        
        default:
          throw new Error(`[chrome_inspect] Unknown action: ${params.action}`);
      }
    }
  });
}
```

### core/script-loader.ts

```typescript
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptCache = new Map<string, string>();

export async function loadScript(name: string): Promise<string> {
  if (scriptCache.has(name)) {
    return scriptCache.get(name)!;
  }
  
  const path = resolve(__dirname, '../scripts', name);
  try {
    const content = await readFile(path, 'utf-8');
    scriptCache.set(name, content);
    return content;
  } catch {
    throw new Error(`[chrome_inspect] Script not found: ${name}`);
  }
}
```

### core/formatters.ts

```typescript
import type { BufferedConsoleMessage } from './console-buffer';

export function formatConsoleMessages(messages: BufferedConsoleMessage[], totalCount: number) {
  const typeEmoji: Record<string, string> = {
    debug: '🔍',
    log: '📝',
    warn: '⚠️',
    error: '❌',
    info: 'ℹ️'
  };

  const lines = messages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const shortUrl = m.url.length > 60 ? m.url.slice(0, 57) + '...' : m.url;
    return `${typeEmoji[m.type] || '📝'} [${time}] ${m.text} (${shortUrl})`;
  });

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
```

---

## 实现步骤

### Phase 1: 创建 JS 脚本

1. 创建 `scripts/` 目录（已存在，当前为空）
2. 从现有 tool 文件中提取 JS 逻辑，保存为独立 `.js` 文件
3. 确保每个脚本可以独立在浏览器控制台运行

### Phase 2: 创建工具函数

1. 创建 `core/script-loader.ts` - 脚本加载和缓存
2. 创建 `core/formatters.ts` - 格式化函数

### Phase 3: 创建合并 Tool

1. 创建 `tools/chrome-inspect.ts` - 单一 tool 注册
2. 实现 action 分发逻辑
3. 实现 read_console 特殊处理

### Phase 4: 拆分命令 ✅ 已完成

### Phase 5: 测试

1. 手动测试每个 action
2. 验证返回结果格式
3. 验证 promptGuidelines 能正确引导 LLM

### Phase 6: 清理

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

这是唯一一个不走 `page.evaluate` 的 action，需要特殊分支处理。

### 脚本注入方式：两步走

`page.evaluate` 有两种模式：
- **字符串模式**：`page.evaluate(jsString)` — 直接执行，但**忽略额外参数**
- **函数模式**：`page.evaluate(fn, args)` — 序列化函数后执行，args 可传入

因此不能用 `page.evaluate(script, args)`（args 会被丢弃）。正确做法是两步：

```typescript
// Step 1: 注入脚本，定义全局函数（幂等，重复调用无害）
const script = await loadScript('find-elements.js');
await page.evaluate(script);

// Step 2: 用函数模式调用，传入参数
return page.evaluate(
  (p) => findElements(p),
  { text: params.text, debug: params.debug }
);
```

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
