/**
 * chrome_read_console - Read console messages from the current page
 * 
 * Extracts messages from Chrome DevTools Console panel DOM.
 * Works intuitively: whatever you see in DevTools Console, the tool returns.
 */

import type { Browser, Page } from 'puppeteer-core';

// Console message types
type ConsoleLevel = 'log' | 'warn' | 'error' | 'info';

interface ConsoleMessage {
  type: ConsoleLevel;
  message: string;
  source: string;
  timestamp: number;
}

/**
 * Read console messages from the current page's DevTools Console DOM.
 */
export async function readConsole(
  browser: Browser,
  params: {
    level?: ConsoleLevel | 'all';
    limit?: number;
  }
): Promise<{
  content: [{ type: 'text'; text: string }];
  details: { count: number; messages: ConsoleMessage[] };
}> {
  let page = await getActivePage(browser);

  const level = params.level || 'all';
  const limit = params.limit ?? 50;

  // Helper: extract console messages from a page via DOM
  async function extractFromPage(p: Page): Promise<ConsoleMessage[]> {
    return await p.evaluate((filterLevel: string, maxCount: number) => {
      const results: ConsoleMessage[] = [];
      const messageEls = document.querySelectorAll('.console-message');
      if (messageEls.length === 0) return results;

      for (const el of messageEls) {
        let msgType: ConsoleLevel = 'log';
        if (el.classList.contains('console-error-level')) msgType = 'error';
        else if (el.classList.contains('console-warning-level')) msgType = 'warn';
        else if (el.classList.contains('console-info-level')) msgType = 'info';

        if (filterLevel !== 'all' && msgType !== filterLevel) continue;

        const textEl = el.querySelector('.console-message-text');
        const text = textEl?.textContent?.trim() || el.textContent?.trim() || '';
        const sourceEl = el.querySelector('.console-message-location');
        const source = sourceEl?.textContent?.trim() || '';

        results.push({
          type: msgType,
          message: text.slice(0, 5000),
          source: source.slice(0, 200),
          timestamp: Date.now()
        });
      }

      return results.slice(-maxCount);
    }, filterLevel, maxCount);
  }

  // Try active page first
  let messages = await extractFromPage(page);

  // If no console messages found, look for DevTools pages
  if (messages.length === 0) {
    const allPages = await browser.pages();
    for (const p of allPages) {
      if (p === page) continue;
      try {
        const url = p.url();
        if (url.startsWith('devtools://')) {
          messages = await extractFromPage(p);
          if (messages.length > 0) {
            page = p;
            break;
          }
        }
      } catch {}
    }
  }

  // Build output
  const typeLabel: Record<string, string> = { log: '📝', warn: '⚠️', error: '❌', info: 'ℹ️' };
  const lines = messages.map(m => {
    const src = m.source ? ` (${m.source})` : '';
    return `${typeLabel[m.type] || '📝'} ${m.message}${src}`;
  });

  const errorCount = messages.filter(m => m.type === 'error').length;
  const warnCount = messages.filter(m => m.type === 'warn').length;

  // Pagination: if too many lines, use truncateHead/truncateTail
  const fullText = `${messages.length} 条消息 (${errorCount} errors, ${warnCount} warnings)\n\n${lines.join('\n')}`;
  // Limit overall output to ~10000 chars to avoid token waste
  const truncated = fullText.length > 10000
    ? fullText.slice(0, 10000) + `\n\n... (${fullText.length - 10000} more chars truncated, use limit= for fewer items)`
    : fullText;

  return {
    content: [{ type: 'text', text: truncated }],
    details: {
      count: messages.length,
      messages
    }
  };
}

async function getActivePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();

  for (const page of pages) {
    try {
      const visibilityState = await page.evaluate(() => document.visibilityState);
      if (visibilityState === 'visible') {
        return page;
      }
    } catch {}
  }

  if (pages.length > 0) {
    return pages[0];
  }

  throw new Error('无法获取当前页面');
}
