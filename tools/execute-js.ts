/**
 * chrome_execute_js - Execute JavaScript in the page context
 *
 * Uses IIFE wrapper to support both expressions and statements.
 */

import type { ToolDefinition } from '../core/types';
import { Type } from '@sinclair/typebox';

export const executeJsTool: ToolDefinition<{ expression: string }> = {
  name: 'chrome_execute_js',
  label: 'Chrome Execute JS',
  description: '在页面上下文中执行 JavaScript 表达式，用于查询 DOM 状态、获取计算样式、测量元素尺寸等。',
  promptSnippet: '在页面上下文中执行 JavaScript',
  promptGuidelines: [
    '【获取精确数据的工具】当你需要元素的精确数值（offsetHeight、scrollHeight、getBoundingClientRect、scrollTop 等）时，用 chrome_execute_js 获取，不要猜测。',
    '调试布局问题时的常用查询：检查 scrollHeight vs clientHeight（判断是否溢出）、遍历父容器链的 overflow/display/height（定位高度约束断裂点）。',
    '可以用 JSON.stringify() 包裹返回值来获取可读输出。',
    '注意：代码中不能使用 const/let 等块级声明语句，请用 var 或 IIFE 包裹。例：JSON.stringify((function(){ var x = 1; return x })())'
  ],
  parameters: Type.Object({
    expression: Type.String({ description: 'JavaScript code to execute' })
  }),
  async execute(page, params) {
    // Wrap in IIFE: expression-body for simple values, block-body for statements
    //   `(() => location.href)()`          → expression, returns value directly
    //   `(() => { const x = 1; return x; })()`  → block, supports return/multi-line
    const trimmed = params.expression.trim();
    // If it starts with { or a statement keyword, use block form
    // 语句: return, const, let, var, if, for, while, try, switch, throw, function, class
    const statementKeywords = ['return ', 'const ', 'let ', 'var ', 'if ', 'for ', 'while ', 'try ', 'switch ', 'throw ', 'function ', 'class ', 'async '];
    const isBlock = trimmed.startsWith('{') || statementKeywords.some(kw => trimmed.startsWith(kw));
    const wrappedCode = isBlock
      ? `(() => { ${params.expression} })()`
      : `(() => ${params.expression})()`;

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
};