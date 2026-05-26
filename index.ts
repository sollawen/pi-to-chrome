/**
 * chrome-inspect - Chrome Browser Inspection Extension for pi
 *
 * Provides tools to inspect DOM, CSS styles, console logs, and execute JS
 * in a Chrome browser connected via remote debugging port.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { ConsoleBuffer } from './console-buffer';
import * as browser from './core/browser';
import { registerTools } from './tool-registry';

export default async function(pi: ExtensionAPI) {
  const consoleBuffer = new ConsoleBuffer();
  let toolNames: string[] = [];

  // ─── /chrome-start ───
  pi.registerCommand('chrome-start', {
    description: '连接 Chrome 浏览器并启用页面检查工具 (--remote 用于 SSH 隧道连接)',
    handler: async (args: any, ctx: any) => {
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
            return;
          }

          await browser.connectChrome();
          ctx.ui.notify('✅ Chrome 启动成功', 'info');
        }

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
        // 将新注册的工具加入 active tools
        const currentActive = pi.getActiveTools();
        pi.setActiveTools([...currentActive, ...toolNames]);
        ctx.ui.notify('✅ Chrome 检查工具已就绪（4 个工具已注册）', 'info');

      } catch (err: any) {
        ctx.ui.notify('❌ 连接失败: ' + err.message, 'error');
      }
    }
  });

  // ─── /chrome-stop ───
  pi.registerCommand('chrome-stop', {
    description: '断开 Chrome 连接并关闭浏览器',
    handler: async (args: any, ctx: any) => {
      const isRemote = browser.getMode() === 'remote';

      if (isRemote) {
        // 远程模式：只断开连接，不关闭 Chrome
        const allActive = pi.getActiveTools();
        const remaining = allActive.filter((name: string) => !toolNames.includes(name));
        pi.setActiveTools(remaining);
        toolNames = [];

        consoleBuffer.stopListening();
        await browser.disconnectChrome();

        ctx.ui.notify('✅ 已断开远程 Chrome 连接（浏览器未关闭）', 'info');
      } else {
        // 本地模式：断开并关闭
        const ok = await ctx.ui.confirm(
          '关闭 Chrome？',
          '将关闭 Chrome 浏览器，是否继续？'
        );
        if (!ok) {
          ctx.ui.notify('已取消', 'warning');
          return;
        }

        const allActive = pi.getActiveTools();
        const remaining = allActive.filter((name: string) => !toolNames.includes(name));
        pi.setActiveTools(remaining);
        toolNames = [];

        consoleBuffer.stopListening();
        await browser.disconnectChrome();
        await browser.killChrome();

        ctx.ui.notify('✅ Chrome 已断开并关闭', 'info');
      }
    }
  });

  // ─── session_shutdown cleanup ───
  pi.on('session_shutdown', async () => {
    if (browser.isConnected()) {
      toolNames = [];  // 先清空，防止 disconnectChrome 触发断线回调发送误导通知
      consoleBuffer.stopListening();
      await browser.disconnectChrome();
    }
  });
}