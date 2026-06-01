/**
 * chrome_inspect - Consolidated Chrome page inspection tool
 *
 * Combines 6 tools into 1:
 * - find_elements: Search elements by text keywords
 * - trace_css: Trace CSS style sources
 * - show_dom_tree: Show DOM subtree structure
 * - read_console: Read console buffer messages
 * - execute_js: Execute JavaScript in page context
 * - check_layout: Check element layout properties
 */

import { Type } from '@sinclair/typebox';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'puppeteer-core';
import { validateSelectorUniqueness } from '../core/selector-utils';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Script Loading Cache ──────────────────────────────────────────────────
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
  // Indirect eval via (0, eval) to ensure function is defined on globalThis
  return page.evaluate(
    (src: string, fn: string, args: any) => { (0, eval)(src); return globalThis[fn](args); },
    code, fnName, params
  );
}

// ─── IIFE Wrapper for execute_js ──────────────────────────────────────────
function wrapJsExpression(code: string): string {
  const trimmed = code.trim();
  const statementKeywords = ['return ', 'const ', 'let ', 'var ', 'if ', 'for ', 'while ', 'try ', 'switch ', 'throw ', 'function ', 'class ', 'async '];
  const isBlock = trimmed.startsWith('{') || statementKeywords.some(kw => trimmed.startsWith(kw));
  return isBlock
    ? `(() => { ${code} })()`
    : `(() => ${code})()`;
}

// ─── Tool Registration ──────────────────────────────────────────────────────
export function registerChromeInspectTool(pi: any, consoleBuffer: any): void {
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

    async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
      const browser = await import('../core/browser');

      await browser.ensureConnection();
      const page = await browser.getActivePage();

      switch (params.action) {
        case 'find_elements':
          return runScript(page, 'find-elements.js', 'findElements', { text: params.text, debug: params.debug ?? false });

        case 'trace_css': {
          const validation = await validateSelectorUniqueness(page, params.selector);
          if (!validation.ok) {
            if (validation.kind === 'not_found') {
              throw new Error(`未找到匹配 "${params.selector}" 的元素`);
            }
            if (validation.kind === 'multiple') {
              throw new Error(`selector "${params.selector}" 匹配了 ${validation.count} 个元素，请更精确`);
            }
            throw new Error(`无效的 selector: ${validation.message}`);
          }
          return runScript(page, 'trace-css.js', 'traceCss', { selector: params.selector });
        }

        case 'show_dom_tree': {
          const validation = await validateSelectorUniqueness(page, params.selector);
          if (!validation.ok) {
            if (validation.kind === 'not_found') {
              throw new Error(`未找到匹配 "${params.selector}" 的元素`);
            }
            if (validation.kind === 'multiple') {
              throw new Error(`selector "${params.selector}" 匹配了 ${validation.count} 个元素，请更精确`);
            }
            throw new Error(`无效的 selector: ${validation.message}`);
          }
          return runScript(page, 'show-dom-tree.js', 'showDomTree',
            { selector: params.selector, depth: params.depth ?? 3 });
        }

        case 'read_console': {
          // Direct read from ConsoleBuffer (no page.evaluate)
          const level = params.level ?? 'error';
          const limit = params.limit ?? 50;
          const messages = consoleBuffer.getMessages(level, limit);

          const typeEmoji: Record<string, string> = {
            log: '📝',
            warn: '⚠️',
            error: '❌',
            info: 'ℹ️'
          };

          const lines = messages.map((m: any) => {
            const time = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
            const shortUrl = m.url.length > 60 ? m.url.slice(0, 57) + '...' : m.url;
            return `${typeEmoji[m.type] || '📝'} [${time}] ${m.text} (${shortUrl})`;
          });

          const totalCount = consoleBuffer.count;
          const errorCount = messages.filter((m: any) => m.type === 'error').length;
          const warnCount = messages.filter((m: any) => m.type === 'warn').length;
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

          try {
            const result = await page.evaluate(wrappedCode);

            // Serialize result
            let serializedResult: string;
            let rawResult = result;

            if (result === undefined) {
              serializedResult = 'undefined';
            } else if (result === null) {
              serializedResult = 'null';
            } else if (typeof result === 'string') {
              serializedResult = result.length > 5000 ? result.slice(0, 5000) + '...' : result;
            } else if (typeof result === 'number' || typeof result === 'boolean') {
              serializedResult = String(result);
            } else if (Array.isArray(result)) {
              serializedResult = `Array(${result.length})`;
            } else if (typeof result === 'object') {
              serializedResult = 'Object';
            } else {
              serializedResult = JSON.stringify(result)?.slice(0, 5000) || String(result);
            }

            return {
              content: [{ type: 'text', text: serializedResult }],
              details: { raw: rawResult }
            };
          } catch (error: any) {
            throw new Error(error.message);
          }
        }

        case 'check_layout': {
          const validation = await validateSelectorUniqueness(page, params.selector);
          if (!validation.ok) {
            if (validation.kind === 'not_found') {
              throw new Error(`未找到匹配 "${params.selector}" 的元素`);
            }
            if (validation.kind === 'multiple') {
              throw new Error(`selector "${params.selector}" 匹配了 ${validation.count} 个元素，请更精确`);
            }
            throw new Error(`无效的 selector: ${validation.message}`);
          }
          return runScript(page, 'check-layout.js', 'checkLayout',
            { selector: params.selector, ancestors: params.ancestors ?? 5 });
        }

        default:
          throw new Error(`[chrome_inspect] Unknown action: ${params.action}`);
      }
    }
  });
}