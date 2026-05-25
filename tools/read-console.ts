/**
 * chrome_read_console - Read console messages from the buffer
 *
 * Returns messages captured via CDP event listener since chrome-start.
 * No DevTools window needed.
 */

import type { ToolDefinition, ToolDeps } from '../core/types';
import { Type } from '@sinclair/typebox';
import type { ConsoleLevel } from '../console-buffer';

export const readConsoleTool: ToolDefinition<{
  level?: ConsoleLevel | 'all';
  limit?: number;
}> = {
  name: 'chrome_read_console',
  label: 'Chrome Read Console',
  description: 'Read console messages from the page. Filter by level (log/warn/error/info).',
  promptSnippet: 'Read console messages from the page',
  promptGuidelines: [
    'Use chrome_read_console when the user asks about errors, warnings, or log output on the page. Filter by level to focus on errors only.'
  ],
  parameters: Type.Object({
    level: Type.Optional(Type.Union([
      Type.Literal('log'),
      Type.Literal('warn'),
      Type.Literal('error'),
      Type.Literal('info'),
      Type.Literal('all')
    ])),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 }))
  }),
  async execute(page, params, deps?: ToolDeps) {
    const consoleBuffer = deps?.consoleBuffer;
    if (!consoleBuffer) throw new Error('ConsoleBuffer not available');

    const level = (params.level || 'all') as ConsoleLevel | 'all';
    const limit = params.limit ?? 50;

    const messages = consoleBuffer.getMessages(level, limit);

    const typeEmoji: Record<string, string> = {
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

    const totalCount = consoleBuffer.count;
    const filtered = messages.length;
    const errorCount = messages.filter(m => m.type === 'error').length;
    const warnCount = messages.filter(m => m.type === 'warn').length;

    const header = `缓冲区 ${totalCount} 条 | 返回 ${filtered} 条 (${errorCount} errors, ${warnCount} warnings)`;
    const fullText = `${header}\n\n${lines.join('\n')}`;

    const truncated = fullText.length > 10000
      ? fullText.slice(0, 10000) + `\n\n... (截断，用更小的 limit 缩小范围)`
      : fullText;

    return {
      content: [{ type: 'text', text: truncated || '暂无 console 日志（只捕获连接后的输出）' }],
      details: { count: totalCount, filtered }
    };
  }
};