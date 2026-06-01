/**
 * chrome-inspect - Chrome Browser Inspection Extension for pi
 *
 * Provides tools to inspect DOM, CSS styles, console logs, and execute JS
 * in a Chrome browser connected via remote debugging port.
 */

import { Container, Spacer, Text } from '@earendil-works/pi-tui';

import * as browser from './core/browser';
import { readConnectionState, writeConnectionState, clearConnectionState, isConnectionStateExpired } from './core/connection-state';
import { getToolNames, setToolNames, getConsoleBuffer, setReconnecting } from './core/shared-state';
import { registerChromeStart } from './commands/chrome-start';
import { registerChromeStop } from './commands/chrome-stop';
import { findElementsTool } from './tools/find-elements';
import { traceCssTool } from './tools/trace-css';
import { showDomTreeTool } from './tools/show-dom-tree';
import { readConsoleTool } from './tools/read-console';
import { executeJsTool } from './tools/execute-js';
import { checkLayoutTool } from './tools/check-layout';
import type { ToolDefinition } from './core/types';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// ─── Tool Registration ───

const ALL_TOOLS: ToolDefinition[] = [
  findElementsTool,
  showDomTreeTool,
  traceCssTool,
  readConsoleTool,
  executeJsTool,
  checkLayoutTool,
];

function registerTools(pi: ExtensionAPI, consoleBuffer: any): string[] {
  const names: string[] = [];

  for (const tool of ALL_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        await browser.ensureConnection();
        const page = await browser.getActivePage();
        return tool.execute(page, params, { consoleBuffer });
      }
    });
    names.push(tool.name);
  }

  return names;
}

// ─── Extension ───

export default async function(pi: ExtensionAPI) {
  // ─── Custom message renderers (plain text, no box/background) ───
  for (const customType of ['chrome-disconnected', 'chrome-reconnected']) {
    pi.registerMessageRenderer(customType, (message: any, _options: any, theme: any) => {
      const container = new Container();
      container.addChild(new Spacer(1));
      const text = typeof message.content === 'string' ? message.content : message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      container.addChild(new Text(theme.fg('dim', text), 1, 0));
      return container;
    });
  }

  // ─── Shared: establish connection (register callbacks, tools, notify) ───
  async function establishConnection(ctx: ExtensionContext): Promise<void> {
    // 注册断线回调（在 startListening/registerTools 之前，消除 race window）
    browser.onDisconnected(() => {
      if (getToolNames().length === 0) return;

      getConsoleBuffer().stopListening();
      const allActive = pi.getActiveTools();
      const remaining = allActive.filter((name: string) => !getToolNames().includes(name));
      pi.setActiveTools(remaining);
      setToolNames([]);

      pi.sendMessage({
        customType: 'chrome-disconnected',
        content: '⚠️ Chrome 连接已断开！\n如需查看原因，请立即切换到 Chrome 查看 console 日志\n如需重新连接，请执行 /chrome-start',
        display: true,
      });
    });

    getConsoleBuffer().startListening(browser.getBrowser());

    setToolNames(registerTools(pi, getConsoleBuffer()));
    const currentActive = pi.getActiveTools();
    pi.setActiveTools([...currentActive, ...getToolNames()]);
    ctx.ui.notify('✅ Chrome 检查工具已就绪（6 个工具已注册）', 'info');
  }

  // ─── Register slash commands ───
  registerChromeStart(pi, establishConnection);
  registerChromeStop(pi);

  // ─── session_start: auto-reconnect ───
  pi.on('session_start', async (event, ctx) => {
    if (event.reason === 'startup') return;
    if (event.reason !== 'new' && event.reason !== 'resume' && event.reason !== 'fork' && event.reason !== 'reload') return;

    const state = readConnectionState();
    if (!state) return;

    // 检查过期
    if (isConnectionStateExpired(state)) {
      clearConnectionState();
      return;
    }

    // 恢复连接参数
    browser.configureConnection({
      mode: state.mode,
      host: state.host,
      port: state.port,
    });

    // 检查 Chrome 是否可达
    if (!(await browser.isChromeRunning())) {
      clearConnectionState();
      ctx.ui.notify('ℹ️ Chrome 已不可达，未自动重连', 'info');
      return;
    }

    // 自动重连
    setReconnecting(true);
    try {
      await browser.connectChrome();
      await establishConnection(ctx);
      pi.sendMessage({
        customType: 'chrome-reconnected',
        content: '✅ Chrome 已自动重连',
        display: true,
      });
    } catch (err: any) {
      console.error('[pi-to-chrome] session_start 自动重连失败', err);
      clearConnectionState();
      ctx.ui.notify('ℹ️ Chrome 自动重连失败，连接已清除', 'info');
    } finally {
      setReconnecting(false);
    }
  });

  // ─── session_shutdown: disconnect + conditional flag cleanup ───
  pi.on('session_shutdown', async (event) => {
    if (browser.isConnected()) {
      setToolNames([]);                        // 先清空，防止 disconnectChrome 触发断线回调发送误导通知
      getConsoleBuffer().stopListening();
      await browser.disconnectChrome();
    }

    if (event.reason === 'quit') {
      clearConnectionState();
    }
    // new / resume / fork / reload → 保留标志文件
  });
}
