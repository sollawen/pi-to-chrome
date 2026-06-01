/**
 * commands/chrome-start.ts - /chrome-start command
 *
 * Connects to Chrome browser and enables page inspection tools.
 * Supports --remote, --host, --port arguments.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as browser from '../core/browser';
import { writeConnectionState, clearConnectionState } from '../core/connection-state';
import { getToolNames, setToolNames, isReconnectingActive } from '../core/shared-state';

export function registerChromeStart(
  pi: ExtensionAPI,
  establishConnection: (ctx: ExtensionContext) => Promise<void>
): void {
  pi.registerCommand('chrome-start', {
    description: '连接 Chrome 浏览器并启用页面检查工具 (--remote 用于 SSH 隧道连接)',
    handler: async (args: any, ctx: any) => {
      if (isReconnectingActive()) {
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
}
