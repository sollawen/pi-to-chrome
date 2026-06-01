/**
 * commands/chrome-stop.ts - /chrome-stop command
 *
 * Disconnects from Chrome browser (browser itself stays open).
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import * as browser from '../core/browser';
import { clearConnectionState } from '../core/connection-state';
import { getToolNames, setToolNames, getConsoleBuffer } from '../core/shared-state';

export function registerChromeStop(pi: ExtensionAPI): void {
  pi.registerCommand('chrome-stop', {
    description: '断开 Chrome 连接（浏览器不关闭）',
    handler: async (_args: any, ctx: any) => {
      const allActive = pi.getActiveTools();
      const remaining = allActive.filter((name: string) => !getToolNames().includes(name));
      pi.setActiveTools(remaining);
      setToolNames([]);

      getConsoleBuffer().stopListening();
      await browser.disconnectChrome();
      clearConnectionState();

      ctx.ui.notify('✅ Chrome 已断开连接（浏览器未关闭）', 'info');
    }
  });
}
