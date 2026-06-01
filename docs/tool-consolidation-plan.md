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
├── commands/              # 斜杠命令
│   ├── chrome-start.ts
│   └── chrome-stop.ts
├── core/                  # 核心功能（已有）
│   ├── browser.ts
│   ├── console-buffer.ts
│   ├── connection-state.ts
│   └── selector-utils.ts
├── tools/                 # 所有 tools 程序
│   ├── chrome-inspect.ts  # 合并后的单一 tool
│   └── scripts/           # JS 脚本（可独立在浏览器控制台运行）
│       ├── find-elements.js
│       ├── trace-css.js
│       ├── show-dom-tree.js
│       ├── execute-js.js
│       └── check-layout.js
└── docs/
```

---

## 核心设计

### index.ts

```typescript
import { registerChromeInspectTool } from './tools/chrome-inspect';

export default async function(pi) {
  const consoleBuffer = new ConsoleBuffer();
  
  // 注册单一 tool
  registerChromeInspectTool(pi, consoleBuffer);
  
  // 注册斜杠命令
  pi.registerCommand('chrome-start', { ... });
  pi.registerCommand('chrome-stop', { ... });
  
  // ...
}
```

### tools/chrome-inspect.ts

```typescript
import { Type } from 'typebox';
import { loadScript } from '../core/script-loader';
import { formatConsoleMessages } from '../core/formatters';
import type { ConsoleLevel } from '../core/console-buffer';

export function registerChromeInspectTool(pi, consoleBuffer) {
  pi.registerTool({
    name: 'chrome_inspect',
    label: 'Chrome Inspect',
    description: 'Chrome 页面检查工具：搜索元素、追踪CSS、查看DOM、读取console、执行JS、检查布局',
    
    promptGuidelines: [
      // ===== 搜索元素 =====
      'Use chrome_inspect with action="find_elements" to search for elements by text keywords. Match against text, class, id, tag name simultaneously.',
      'text 参数用 / 分隔中英文关键词，尽量多给变体。例：「灯泡」→ "灯泡/lamp/bulb/light"',
      '拆成小词提高命中：「命令卡片列表」→ "命令卡片/命令/卡片/list/card/command"',
      '返回的 selector 可直接传给 trace_css / show_dom_tree / check_layout。',
      
      // ===== 追踪 CSS =====
      'Use chrome_inspect with action="trace_css" to trace CSS style sources for an element.',
      '先用 find_elements 定位元素，再用 trace_css 追踪样式来源。',
      '返回结果按优先级排列（inline > CSS class > user-agent）。',
      
      // ===== 查看 DOM 树 =====
      'Use chrome_inspect with action="show_dom_tree" to view DOM subtree structure.',
      '返回树状图展示嵌套关系、标签名、class、id 和文本内容。',
      
      // ===== 读取 Console =====
      'Use chrome_inspect with action="read_console" to read console messages from the buffer.',
      '排错时的第一反应：action="read_console", level="error" 查看 JS 报错。',
      'level 参数：debug/log/warn/error/info/all，limit 默认 50。',
      
      // ===== 执行 JS =====
      'Use chrome_inspect with action="execute_js" to execute JavaScript in page context.',
      '获取精确数据：offsetHeight、scrollHeight、getBoundingClientRect、scrollTop 等。',
      '代码中不能使用 const/let，请用 var 或 IIFE 包裹。',
      
      // ===== 检查布局 =====
      'Use chrome_inspect with action="check_layout" to check layout issues for an element.',
      '检测 overflow、z-index、position、flex/grid 等布局相关属性。',
    ],
    
    parameters: Type.Object({
      action: StringEnum([
        'find_elements',
        'trace_css', 
        'show_dom_tree',
        'read_console',
        'execute_js',
        'check_layout'
      ] as const),
      
      // 通用参数（某些 action 会用到）
      text: Type.Optional(Type.String()),
      selector: Type.Optional(Type.String()),
      expression: Type.Optional(Type.String()),
      level: Type.Optional(Type.Union([
        Type.Literal('debug'),
        Type.Literal('log'),
        Type.Literal('warn'),
        Type.Literal('error'),
        Type.Literal('info'),
        Type.Literal('all')
      ])),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 })),
      depth: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 3 })),
    }),
    
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await browser.ensureConnection();
      const page = await browser.getActivePage();
      
      switch (params.action) {
        case 'find_elements':
          const findScript = await loadScript('find-elements.js');
          return page.evaluate(findScript, {
            keywords: params.text?.split('/').map(k => k.trim()).filter(k => k),
            debug: false
          });
        
        case 'trace_css':
          const traceScript = await loadScript('trace-css.js');
          return page.evaluate(traceScript, { selector: params.selector });
        
        case 'show_dom_tree':
          const treeScript = await loadScript('show-dom-tree.js');
          return page.evaluate(treeScript, { 
            selector: params.selector,
            depth: params.depth ?? 3 
          });
        
        case 'read_console':
          // 特殊处理：读 ConsoleBuffer，不走 page.evaluate
          const level = (params.level || 'all') as ConsoleLevel | 'all';
          const limit = params.limit ?? 50;
          const messages = consoleBuffer.getMessages(level, limit);
          return formatConsoleMessages(messages, consoleBuffer.count);
        
        case 'execute_js':
          const wrappedCode = wrapJsExpression(params.expression);
          return page.evaluate(wrappedCode);
        
        case 'check_layout':
          const layoutScript = await loadScript('check-layout.js');
          return page.evaluate(layoutScript, { selector: params.selector });
      }
    }
  });
}
```

### core/script-loader.ts

```typescript
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const scriptCache = new Map<string, string>();

export async function loadScript(name: string): Promise<string> {
  if (scriptCache.has(name)) {
    return scriptCache.get(name)!;
  }
  
  const path = resolve(import.meta.dirname, '../tools/scripts', name);
  const content = await readFile(path, 'utf-8');
  scriptCache.set(name, content);
  return content;
}
```

### core/formatters.ts

```typescript
export function formatConsoleMessages(messages: ConsoleMessage[], totalCount: number) {
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

### commands/chrome-start.ts

```typescript
export function registerChromeStartCommand(pi, { consoleBuffer }) {
  pi.registerCommand('chrome-start', {
    description: '连接 Chrome 浏览器并启用页面检查工具',
    async handler(args, ctx) {
      // 连接 Chrome...
      // 建立连接后注册 tool
      registerChromeInspectTool(pi, consoleBuffer);
      pi.setActiveTools(['chrome_inspect']);
    }
  });
}
```

---

## 实现步骤

### Phase 1: 创建 JS 脚本

1. 创建 `tools/scripts/` 目录
2. 从现有 tool 文件中提取 JS 逻辑，保存为独立 `.js` 文件
3. 确保每个脚本可以独立在浏览器控制台运行

### Phase 2: 创建工具函数

1. 创建 `core/script-loader.ts` - 脚本加载和缓存
2. 创建 `core/formatters.ts` - 格式化函数

### Phase 3: 创建合并 Tool

1. 创建 `tools/chrome-inspect.ts` - 单一 tool 注册
2. 实现 action 分发逻辑
3. 实现 read_console 特殊处理

### Phase 4: 拆分命令

1. 创建 `commands/chrome-start.ts`
2. 创建 `commands/chrome-stop.ts`
3. 更新 `index.ts` 的 import 和调用

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

原有的 `chrome_execute_js` 有 IIFE wrapper 逻辑：

```javascript
// 如果是表达式：(() => expression)()
// 如果是语句：(() => { statements })()
```

这个逻辑需要保留在主 tool 里。

### read_console 不走 page.evaluate

这是唯一一个不走 `page.evaluate` 的 action，需要特殊分支处理。

### 脚本可独立运行

JS 脚本应该：
- 不依赖外部变量
- 不使用 import
- 函数签名自包含

这样可以直接复制到浏览器控制台运行调试。
