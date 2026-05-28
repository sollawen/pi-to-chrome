/**
 * chrome-inspect - Chrome Browser Inspection Extension for pi
 *
 * Provides tools to inspect DOM, CSS styles, console logs, and execute JS
 * in a Chrome browser connected via remote debugging port.
 */

import { Container, Spacer, Text } from '@earendil-works/pi-tui';

import { ConsoleBuffer } from './core/console-buffer';
import * as browser from './core/browser';
import { readConnectionState, writeConnectionState, clearConnectionState, isConnectionStateExpired } from './core/connection-state';
import { findElementsTool } from './tools/find-elements';
import { inspectStylesTool } from './tools/inspect-styles';
import { readConsoleTool } from './tools/read-console';
import { executeJsTool } from './tools/execute-js';
import type { ToolDefinition } from './core/types';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// ─── Tool Registration ───

const ALL_TOOLS: ToolDefinition[] = [
  findElementsTool,
  inspectStylesTool,
  readConsoleTool,
  executeJsTool,
];

function registerTools(pi: ExtensionAPI, consoleBuffer: ConsoleBuffer): string[] {
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
  const consoleBuffer = new ConsoleBuffer();
  let toolNames: string[] = [];
  let isReconnecting = false;

  // ─── Custom message renderers (plain text, no box/background) ───
  for (const customType of ['chrome-disconnected', 'chrome-reconnected']) {
    pi.registerMessageRenderer(customType, (message, _options, theme) => {
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
      if (toolNames.length === 0) return;

      consoleBuffer.stopListening();
      const allActive = pi.getActiveTools();
      const remaining = allActive.filter((name: string) => !toolNames.includes(name));
      pi.setActiveTools(remaining);
      toolNames = [];

      pi.sendMessage({
        customType: 'chrome-disconnected',
        content: '⚠️ Chrome 连接已断开！\n如需查看原因，请立即切换到 Chrome 查看 console 日志\n如需重新连接，请执行 /chrome-start',
        display: true,
      });
    });

    consoleBuffer.startListening(browser.getBrowser());

    toolNames = registerTools(pi, consoleBuffer);
    const currentActive = pi.getActiveTools();
    pi.setActiveTools([...currentActive, ...toolNames]);
    ctx.ui.notify('✅ Chrome 检查工具已就绪（4 个工具已注册）', 'info');
  }

  // ─── /chrome-start ───
  pi.registerCommand('chrome-start', {
    description: '连接 Chrome 浏览器并启用页面检查工具 (--remote 用于 SSH 隧道连接)',
    handler: async (args: any, ctx: any) => {
      // 并发保护
      if (isReconnecting) {
        ctx.ui.notify('⏳ 正在自动重连中，请稍后再试', 'warning');
        return;
      }

      // Parse args: --remote, --host <value>, --port <value>
      const argStr = typeof args === 'string' ? args : '';
      const argParts = argStr.trim().split(/\s+/);
      let isRemote = false;
      let host = '127.0.0.1';
      let port = 9222;

      for (let i = 0; i < argParts.length; i++) {
        const part = argParts[i];
        if (part === '--remote' || part === '-r') {
          isRemote = true;
        } else if (part === '--host' && i + 1 < argParts.length) {
          host = argParts[++i];
        } else if (part === '--port' && i + 1 < argParts.length) {
          const parsed = parseInt(argParts[++i], 10);
          if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
            ctx.ui.notify('❌ 无效端口号，范围: 1-65535', 'error');
            return;
          }
          port = parsed;
        }
      }

      // Configure connection mode (always reset all fields to avoid stale state)
      browser.configureConnection({
        mode: isRemote ? 'remote' : 'local',
        host: isRemote ? host : '127.0.0.1',
        port: isRemote ? port : 9222,
      });

      ctx.ui.notify(isRemote ? '正在连接远程 Chrome...' : '正在连接 Chrome...', 'info');

      try {
        try {
          await browser.connectChrome();
          ctx.ui.notify('✅ 已连接到运行中的 Chrome', 'info');
        } catch {
          if (isRemote) {
            ctx.ui.notify(
              '❌ 无法连接到远程 Chrome，请确认：\n' +
              '1. Mac 上 Chrome 已启动（--remote-debugging-port=9222）\n' +
              '2. SSH 隧道已建立（ssh -R 9222:127.0.0.1:9222 ...）',
              'error'
            );
            clearConnectionState();
            return;
          }

          if (await browser.isChromeRunning()) {
            const ok = await ctx.ui.confirm(
              '关闭 Chrome？',
              '需要关闭现有 Chrome，未保存内容可能丢失。是否继续？'
            );
            if (!ok) {
              ctx.ui.notify('已取消', 'warning');
              return;
            }
            await browser.killChrome();
          }

          browser.spawnChrome();

          if (!(await browser.waitForChromeReady())) {
            ctx.ui.notify('Chrome 启动超时，请手动检查', 'error');
            clearConnectionState();
            return;
          }

          await browser.connectChrome();
          ctx.ui.notify('✅ Chrome 启动成功', 'info');
        }

        // 连接成功，写标志文件
        writeConnectionState({
          mode: isRemote ? 'remote' : 'local',
          host: isRemote ? host : '127.0.0.1',
          port: isRemote ? port : 9222,
        });

        await establishConnection(ctx);

      } catch (err: any) {
        ctx.ui.notify('❌ 连接失败: ' + err.message, 'error');
        clearConnectionState();
      }
    }
  });

  // ─── /chrome-stop ───
  pi.registerCommand('chrome-stop', {
    description: '断开 Chrome 连接（浏览器不关闭）',
    handler: async (args: any, ctx: any) => {
      const allActive = pi.getActiveTools();
      const remaining = allActive.filter((name: string) => !toolNames.includes(name));
      pi.setActiveTools(remaining);
      toolNames = [];

      consoleBuffer.stopListening();
      await browser.disconnectChrome();
      clearConnectionState();

      ctx.ui.notify('✅ Chrome 已断开连接（浏览器未关闭）', 'info');
    }
  });

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
    isReconnecting = true;
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
      isReconnecting = false;
    }
  });

  // ─── session_shutdown: disconnect + conditional flag cleanup ───
  pi.on('session_shutdown', async (event) => {
    if (browser.isConnected()) {
      toolNames = [];  // 先清空，防止 disconnectChrome 触发断线回调发送误导通知
      consoleBuffer.stopListening();
      await browser.disconnectChrome();
    }

    if (event.reason === 'quit') {
      clearConnectionState();
    }
    // new / resume / fork / reload → 保留标志文件
  });
}
