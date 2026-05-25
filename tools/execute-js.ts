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
  description: 'Execute JavaScript in the page context. Use to query page state or compute values.',
  promptSnippet: 'Execute JavaScript in the page context',
  promptGuidelines: [
    'Use chrome_execute_js to query page state, get DOM data, or compute values in the browser. Prefer it over guessing when you need exact page data.'
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