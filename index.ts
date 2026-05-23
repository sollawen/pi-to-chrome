/**
 * chrome-inspect - Chrome Browser Inspection Extension for pi
 * 
 * Provides tools to inspect DOM, CSS styles, console logs, and execute JS
 * in a Chrome browser connected via remote debugging port.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Browser } from 'puppeteer-core';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { spawn } from 'child_process';
import { mkdirSync, existsSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';

import { findElements } from './tools/find-elements';
import { inspectStyles } from './tools/inspect-styles';
import { takeScreenshot } from './tools/take-screenshot';
import { readConsole } from './tools/read-console';
import { executeJS } from './tools/execute-js';

export default async function(pi: ExtensionAPI) {
  // ─── Global State ───
  let browser: Browser | null = null;
  let chromeToolNames: string[] = [];

  // ─── Helper: Check if Chrome is running ───
  async function isChromeRunning(): Promise<boolean> {
    try {
      const response = await fetch('http://localhost:9222/json/version', {
        signal: AbortSignal.timeout(1000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── Helper: Setup debug profile directory ───
  function setupChromeDebugProfile(): void {
    const debugDir = path.join(homedir(), 'Library/Application Support/Google/Chrome-Debug');
    const defaultDir = path.join(homedir(), 'Library/Application Support/Google/Chrome/Default');
    
    // Create debug directory if not exists
    try {
      if (!existsSync(debugDir)) {
        mkdirSync(debugDir, { recursive: true });
      }
      
      // Symlink Default profile to preserve login state
      const defaultLink = path.join(debugDir, 'Default');
      if (!existsSync(defaultLink)) {
        symlinkSync(defaultDir, defaultLink);
      }
    } catch (error: any) {
      console.error('Failed to setup debug profile:', error.message);
    }
  }

  // ─── Helper: Kill existing Chrome ───
  async function killChrome(): Promise<void> {
    return new Promise((resolve) => {
      const kill = spawn('pkill', ['-f', 'Google Chrome'], { 
        stdio: 'ignore',
        shell: true 
      });
      kill.on('close', () => {
        // Wait a bit for Chrome to fully close
        setTimeout(resolve, 500);
      });
      kill.on('error', () => resolve());
    });
  }

  // ─── Helper: Wait for Chrome to be ready ───
  async function waitForChromeReady(timeoutMs: number = 15000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (await isChromeRunning()) {
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  // ─── Helper: Spawn new Chrome ───
  function spawnChrome(): void {
    const debugDir = path.join(homedir(), 'Library/Application Support/Google/Chrome-Debug');
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    
    spawn(chromePath, [
      '--remote-debugging-port=9222',
      `--user-data-dir=${debugDir}`,
      '--start-maximized'
    ], {
      detached: true,
      stdio: 'ignore'
    }).unref();
  }

  // ─── Helper: Get active page ───
  async function getActivePage(): Promise<any> {
    if (!browser) throw new Error('Chrome 未连接');
    
    try {
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
    } catch {
      throw new Error('无法获取当前页面');
    }
    
    throw new Error('无法获取当前页面');
  }

  // ─── Helper: Register Chrome tools ───
  function registerChromeTools(): string[] {
    const names: string[] = [];

    // chrome_find_elements
    pi.registerTool({
      name: 'chrome_find_elements',
      label: 'Chrome Find Elements',
      description: 'Search for elements on the current Chrome page by visible text, CSS selector, or tag name.',
      promptSnippet: 'Search elements by text/CSS selector/tag',
      promptGuidelines: [
        'Use chrome_find_elements when the user asks about elements on the page whose selector is unknown. Search by visible text, CSS selector, or tag name.'
      ],
      parameters: Type.Object({
        text: Type.Optional(Type.String({ description: 'Search by visible text content' })),
        selector: Type.Optional(Type.String({ description: 'Search by CSS selector' })),
        tag: Type.Optional(Type.String({ description: 'Filter by tag name (e.g. button, input)' })),
        visibleOnly: Type.Optional(Type.Boolean({ description: 'Only return visible elements', default: true }))
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!browser) throw new Error('Chrome 未连接，请先执行 /chrome-start');
        const page = await getActivePage();
        if (!page) throw new Error('无法获取当前页面');
        return await findElements(browser, params);
      }
    });
    names.push('chrome_find_elements');

    // chrome_inspect_styles
    pi.registerTool({
      name: 'chrome_inspect_styles',
      label: 'Chrome Inspect Styles',
      description: 'Inspect CSS cascade for an element by selector. Shows matched CSS rules and their sources.',
      promptSnippet: 'Inspect CSS cascade for an element by selector',
      promptGuidelines: [
        'Use chrome_inspect_styles when the user asks about why an element looks a certain way — colors, sizes, layout, or which CSS rules apply. Specify the CSS selector of the element.'
      ],
      parameters: Type.Object({
        selector: Type.String({ description: 'CSS selector of the element to inspect' }),
        includeChildren: Type.Optional(Type.Boolean({ description: 'Include direct children list', default: false }))
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!browser) throw new Error('Chrome 未连接，请先执行 /chrome-start');
        const page = await getActivePage();
        if (!page) throw new Error('无法获取当前页面');
        return await inspectStyles(browser, params);
      }
    });
    names.push('chrome_inspect_styles');

    // chrome_take_screenshot
    pi.registerTool({
      name: 'chrome_take_screenshot',
      label: 'Chrome Take Screenshot',
      description: 'Take a screenshot of the current page. Returns base64 encoded image.',
      promptSnippet: 'Take a screenshot of the current page',
      promptGuidelines: [
        'Use chrome_take_screenshot when the user asks to see what the page looks like visually.'
      ],
      parameters: Type.Object({
        format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('jpeg')])),
        quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100 }))
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!browser) throw new Error('Chrome 未连接，请先执行 /chrome-start');
        const page = await getActivePage();
        if (!page) throw new Error('无法获取当前页面');
        return await takeScreenshot(browser, params);
      }
    });
    names.push('chrome_take_screenshot');

    // chrome_read_console
    pi.registerTool({
      name: 'chrome_read_console',
      label: 'Chrome Read Console',
      description: 'Read console messages from the page. Filter by level (log/warn/error/info).',
      promptSnippet: 'Read console messages from the page',
      promptGuidelines: [
        'Use chrome_read_console when the user asks about errors, warnings, or log output on the page. Filter by level to focus on errors only.'
      ],
      parameters: Type.Object({
        level: Type.Optional(StringEnum(['log', 'warn', 'error', 'info', 'all'])),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, default: 50 }))
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!browser) throw new Error('Chrome 未连接，请先执行 /chrome-start');
        const page = await getActivePage();
        if (!page) throw new Error('无法获取当前页面');
        return await readConsole(browser, params);
      }
    });
    names.push('chrome_read_console');

    // chrome_execute_js
    pi.registerTool({
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
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!browser) throw new Error('Chrome 未连接，请先执行 /chrome-start');
        const page = await getActivePage();
        if (!page) throw new Error('无法获取当前页面');
        return await executeJS(browser, params);
      }
    });
    names.push('chrome_execute_js');

    return names;
  }

  // ─── /chrome-start ───
  pi.registerCommand('chrome-start', {
    description: '连接 Chrome 浏览器并启用页面检查工具',
    handler: async (args: any, ctx: any) => {
      ctx.ui.notify('正在连接 Chrome...', 'info');

      try {
        // 1) Try to connect to existing Chrome
        const puppeteer = await import('puppeteer-core');
        
        try {
          browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
          ctx.ui.notify('✅ 已连接到运行中的 Chrome', 'info');
        } catch {
          // 2) Connection failed - need to start new Chrome
          if (await isChromeRunning()) {
            const ok = await ctx.ui.confirm(
              '关闭 Chrome？',
              '需要关闭现有 Chrome，未保存内容可能丢失。是否继续？'
            );
            if (!ok) {
              ctx.ui.notify('已取消', 'warning');
              return;
            }
            await killChrome();
          }
          
          setupChromeDebugProfile();
          spawnChrome();
          
          if (!(await waitForChromeReady())) {
            ctx.ui.notify('Chrome 启动超时，请手动检查', 'error');
            return;
          }
          
          browser = await puppeteer.connect({ browserURL: 'http://localhost:9222' });
          ctx.ui.notify('✅ Chrome 启动成功', 'info');
        }

        // 3) Set viewport to match screen size (fix puppeteer 800x600 default)
        try {
          const pages = browser.pages();
          for (const p of await pages) {
            const availSize = await p.evaluate(() => ({
              width: screen.availWidth,
              height: screen.availHeight
            }));
            await p.setViewport({
              width: availSize.width,
              height: availSize.height,
              deviceScaleFactor: 1
            });
          }
        } catch (error: any) {
          ctx.ui.notify(`⚠️ Viewport 设置失败: ${error.message}`, 'warning');
        }

        // 4) Dynamically register 5 tools
        chromeToolNames = registerChromeTools();

        ctx.ui.notify('✅ Chrome 检查工具已就绪（5 个工具已注册）', 'info');

      } catch (err: any) {
        ctx.ui.notify('❌ 连接失败: ' + err.message, 'error');
      }
    }
  });

  // ─── /chrome-stop ───
  pi.registerCommand('chrome-stop', {
    description: '断开 Chrome 连接并关闭浏览器',
    handler: async (args: any, ctx: any) => {
      const ok = await ctx.ui.confirm(
        '关闭 Chrome？',
        '将关闭 Chrome 浏览器，是否继续？'
      );
      if (!ok) {
        ctx.ui.notify('已取消', 'warning');
        return;
      }

      // Disable Chrome tools via setActiveTools
      const allActive = pi.getActiveTools();
      const remaining = allActive.filter((name: string) => !chromeToolNames.includes(name));
      pi.setActiveTools(remaining);
      chromeToolNames = [];

      // Clean up
      if (browser) {
        try {
          browser.disconnect();
        } catch {}
        browser = null;
      }
      
      await killChrome();

      ctx.ui.notify('✅ Chrome 已断开并关闭', 'info');
    }
  });

  // ─── /chrome-tabs ───
  pi.registerCommand('chrome-tabs', {
    description: '列出所有 Chrome Tab',
    handler: async (args: any, ctx: any) => {
      if (!browser) {
        ctx.ui.notify('Chrome 未连接', 'error');
        return;
      }

      const pages = await browser.pages();
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        try {
          const title = await p.title();
          const url = p.url();
          ctx.ui.notify(`[${i}] ${title}\n  ${url}`, 'info');
        } catch {}
      }
    }
  });

  // ─── session_shutdown cleanup ───
  pi.on('session_shutdown', async (_event: string, _ctx: any) => {
    if (browser) {
      try {
        browser.disconnect();
      } catch {}
      browser = null;
    }
  });
}