/**
 * core/browser - Browser lifecycle and utilities
 *
 * All browser-related logic centralized here:
 * - Lifecycle (connect/disconnect/spawn/kill)
 * - Page utilities (getActivePage)
 * - Proxy bypass
 * - Profile management
 */

import type { Browser, Page } from 'puppeteer-core';
import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';

// ─── Connection mode ───
export type ConnectionMode = 'local' | 'remote';

// ─── Configurable state ───
let connectionMode: ConnectionMode = 'local';
let debugHost: string = '127.0.0.1';
let debugPort: number = 9222;

// ─── Chrome paths (local mode only) ───
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_PROFILE_DIR = path.join(homedir(), 'Library/Application Support/Google/Chrome');
export const DEBUG_PROFILE_DIR = path.join(homedir(), 'Library/Application Support/Google/Chrome-Debug');

// ─── Module state ───
let browser: Browser | null = null;

// ─── Connection configuration ───
export function configureConnection(options: {
  mode?: ConnectionMode;
  host?: string;
  port?: number;
}): void {
  if (options.mode !== undefined) connectionMode = options.mode;
  if (options.host !== undefined) debugHost = options.host;
  if (options.port !== undefined) debugPort = options.port;
}

export function getMode(): ConnectionMode {
  return connectionMode;
}

export function getDebugUrl(): string {
  return `http://${debugHost}:${debugPort}`;
}

export function isConnected(): boolean {
  return browser !== null;
}

export function getBrowser(): Browser {
  if (!browser) throw new Error('Chrome 未连接，请先执行 /chrome-start');
  return browser;
}

// ─── Proxy bypass ───
export async function fetchChromeDebug(urlPath: string, init?: RequestInit): Promise<Response> {
  const prevNoProxy = process.env.NO_PROXY;
  const prevNoProxy2 = process.env.no_proxy;
  process.env.NO_PROXY = '127.0.0.1';
  process.env.no_proxy = '127.0.0.1';
  try {
    return await fetch(`${getDebugUrl()}${urlPath}`, init);
  } finally {
    if (prevNoProxy !== undefined) process.env.NO_PROXY = prevNoProxy;
    else delete process.env.NO_PROXY;
    if (prevNoProxy2 !== undefined) process.env.no_proxy = prevNoProxy2;
    else delete process.env.no_proxy;
  }
}

// ─── Profile management ───
export function ensureDebugProfile(): void {
  try {
    if (!existsSync(DEBUG_PROFILE_DIR)) {
      mkdirSync(DEBUG_PROFILE_DIR, { recursive: true });
    }
    const defaultDataDir = path.join(DEFAULT_PROFILE_DIR, 'Default');
    const debugDefaultLink = path.join(DEBUG_PROFILE_DIR, 'Default');
    if (!existsSync(debugDefaultLink) && existsSync(defaultDataDir)) {
      symlinkSync(defaultDataDir, debugDefaultLink);
    }
  } catch (error: any) {
    console.error('Failed to setup debug profile:', error.message);
  }
}

// ─── Page utilities ───
export async function getActivePage(): Promise<Page> {
  const b = getBrowser();

  try {
    const pages = await b.pages();
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
  } catch {}

  throw new Error('无法获取当前页面');
}

// ─── Lifecycle ───
export async function isChromeRunning(): Promise<boolean> {
  try {
    const response = await fetchChromeDebug('/json/version', {
      signal: AbortSignal.timeout(1000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function killChrome(): Promise<void> {
  return new Promise((resolve) => {
    const kill = spawn('pkill', ['-f', 'Google Chrome'], {
      stdio: 'ignore',
      shell: true
    });
    kill.on('close', async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const out = execSync('pgrep -f "Google Chrome"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
          if (!out.trim()) break;
        } catch { break; }
        await new Promise(r => setTimeout(r, 300));
      }
      resolve();
    });
    kill.on('error', () => resolve());
  });
}

export function spawnChrome(): void {
  ensureDebugProfile();

  spawn(CHROME_PATH, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${DEBUG_PROFILE_DIR}`,
    '--restore-last-session'
  ], {
    detached: true,
    stdio: 'ignore'
  }).unref();
}

export async function waitForChromeReady(timeoutMs: number = 15000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await isChromeRunning()) {
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function connectChrome(): Promise<Browser> {
  const puppeteer = await import('puppeteer-core');
  browser = await puppeteer.connect({ browserURL: getDebugUrl(), defaultViewport: null });
  return browser;
}

export async function disconnectChrome(): Promise<void> {
  if (browser) {
    try {
      browser.disconnect();
    } catch {}
    browser = null;
  }
}