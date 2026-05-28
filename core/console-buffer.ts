/**
 * ConsoleBuffer - Ring buffer for Chrome console messages
 *
 * Listens to CDP console events via puppeteer's page.on('console') API.
 * Captures log/warn/error/info from ALL tabs automatically.
 */

import type { Browser, Page, ConsoleMessage } from 'puppeteer-core';

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info';

export interface BufferedConsoleMessage {
  type: ConsoleLevel;
  text: string;
  url: string;
  timestamp: number;
}

const MAX_BUFFER_SIZE = 1000;

export class ConsoleBuffer {
  private buffer: BufferedConsoleMessage[] = [];
  private listeners: Array<{ page: Page; handler: (msg: ConsoleMessage) => void }> = [];
  private browser: Browser | null = null;

  /**
   * Start listening to console events from all current and future pages.
   */
  startListening(browser: Browser): void {
    this.browser = browser;

    // Listen to all existing pages
    browser.pages().then(pages => {
      for (const page of pages) {
        this.attachPageListener(page);
      }
    }).catch((error) => {
      console.error('[pi-to-chrome] console-buffer: browser.pages() 失败', error);
    });

    // Listen to new pages opened after connection
    browser.on('targetcreated', async (target) => {
      if (target.type() === 'page') {
        try {
          const page = await target.page();
          if (page) {
            this.attachPageListener(page);
          }
        } catch (error) {
          console.error('[pi-to-chrome] console-buffer: targetcreated page() 失败', error);
        }
      }
    });
  }

  /**
   * Stop all listeners and clear buffer.
   */
  stopListening(): void {
    for (const { page, handler } of this.listeners) {
      try {
        page.off('console', handler);
      } catch (error) {
        console.error('[pi-to-chrome] console-buffer: page.off() 失败', error);
      }
    }
    this.listeners = [];
    this.browser = null;
    this.buffer = [];
  }

  /**
   * Get messages from buffer, optionally filtered by level and limited.
   */
  getMessages(level: ConsoleLevel | 'all' = 'all', limit = 50): BufferedConsoleMessage[] {
    let filtered = this.buffer;
    if (level !== 'all') {
      filtered = filtered.filter(m => m.type === level);
    }
    return filtered.slice(-limit);
  }

  /**
   * Clear all buffered messages.
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Total number of messages in buffer.
   */
  get count(): number {
    return this.buffer.length;
  }

  private attachPageListener(page: Page): void {
    const handler = (msg: ConsoleMessage) => {
      const type = msg.type() as ConsoleLevel;
      if (!['log', 'warn', 'error', 'info'].includes(type)) return;

      this.addMessage({
        type,
        text: msg.text(),
        url: page.url(),
        timestamp: Date.now()
      });
    };

    page.on('console', handler);
    this.listeners.push({ page, handler });
  }

  private addMessage(msg: BufferedConsoleMessage): void {
    this.buffer.push(msg);
    // Ring buffer: drop oldest when over capacity
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
  }
}
