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
  description: '读取页面的 console 日志消息，支持按级别过滤（log/warn/error/info）。',
  promptSnippet: '读取页面的 console 日志',
  promptGuidelines: [
    '【排错时的第一反应】当页面行为异常或功能不工作时，先用 chrome_read_console 查看 error 级别日志，定位 JS 报错。',
    '用 level 参数过滤：调试 JS 报错用 "error"，查警告用 "warn"，看完整日志用 "all"。',
    '在修改代码后刷新页面，再用 chrome_read_console 确认错误是否消失。'
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