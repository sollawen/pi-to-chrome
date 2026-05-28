/**
 * core/browser - Browser lifecycle and utilities
 *
 * All browser-related logic centralized here:
 * - Lifecycle (connect/disconnect/spawn/kill)
 * - Page utilities (getActivePage)
 * - Proxy bypass
 * - Profile management
 */

import type { Browser, Page, CDPSession } from 'puppeteer-core';
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

// ─── CDP Session 池 ───
// 以 Page 为 key 缓存共享的 CDP session。
// Page 对象在连接生命周期内引用不变（Target.page() 有 pagePromise 缓存），可安全用作 Map key。
const cdpSessions = new Map<Page, CDPSession>();

// ─── CDP Session 互斥锁 ───
// per-page：同一 page 的 CDP 调用串行，不同 page 互不影响
// 注：page 通常复用，不会无限增长；若需彻底清理，page close 时可 delete cdpLocks.get(page)
const cdpLocks = new Map<Page, Promise<void>>();

// ─── 断线回调 ───
let disconnectedCallback: (() => void) | null = null;
let isDisconnecting = false;

// ─── 健康检查缓存 ───
let lastHealthCheckTime = 0;
let lastHealthCheckResult = true;
const HEALTH_CHECK_TTL_MS = 5000; // 5 秒内有效

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

/** 注册断线回调（由 index.ts 调用，回调中无 pi ctx，只有 pi 可用） */
export function onDisconnected(cb: () => void): void {
  disconnectedCallback = cb;
}

/** 清理所有 CDP sessions（断线/断开时调用） */
export function destroyAllCdpSessions(): void {
  for (const [, session] of cdpSessions) {
    try {
      session.detach().catch(() => {});
    } catch (error) {
      // 断线时底层 WebSocket 已关，detach 失败属正常
      console.debug('[pi-to-chrome] destroyAllCdpSessions: detach 失败（可能已断线）', error);
    }
  }
  cdpSessions.clear();
}

/** 获取 page 对应的共享 CDP session（懒创建，首次调用时建立） */
export async function getCdpSession(page: Page): Promise<CDPSession> {
  const existing = cdpSessions.get(page);
  if (existing && !existing.detached) return existing;

  // 旧 session 已失效，先清理
  if (existing) cdpSessions.delete(page);

  // 创建新 session 并启用 DOM / CSS agent
  const session = await page.createCDPSession();

  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
  } catch (error) {
    // agent 启用失败，清理并抛出
    cdpSessions.delete(page);
    try { await session.detach(); } catch (detachError) {
      console.debug('[pi-to-chrome] getCdpSession: enable 失败后 detach 也失败', detachError);
    }
    throw error;
  }

  // session 被关闭时自动从池中移除，下次 getCdpSession 会重建
  // 动态导入，延迟加载 puppeteer-core（避免启动时 ~110ms 的模块解析开销）
  const { CDPSessionEvent } = await import('puppeteer-core');
  session.on(CDPSessionEvent.SessionDetached, () => {
    cdpSessions.delete(page);
  });

  cdpSessions.set(page, session);
  return session;
}

/**
 * 获取共享 CDP session 并执行回调，同一 page 的调用自动串行。
 * 所有需要 CDP session 的工具都应通过此函数访问，不要直接调用 getCdpSession()。
 */
export async function withCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>
): Promise<T> {
  // 排队：等前一个调用完成
  const prev = cdpLocks.get(page) || Promise.resolve();
  let release: (() => void) | undefined;
  const wait = new Promise<void>(r => { release = r; });
  cdpLocks.set(page, wait);
  await prev;

  // 执行
  const session = await getCdpSession(page);
  try {
    return await fn(session);
  } finally {
    release?.();
  }
}

// ─── 健康检查缓存 ───
/** 健康检查：确认 browser 连接有效。失败则 throw 明确错误。 */
export async function ensureConnection(): Promise<void> {
  if (!browser) {
    throw new Error('Chrome 连接已断开，请执行 /chrome-start 重连');
  }

  // 利用缓存避免并发工具调用时重复 CDP 请求
  const now = Date.now();
  if (now - lastHealthCheckTime < HEALTH_CHECK_TTL_MS && lastHealthCheckResult) {
    return;
  }

  try {
    await browser.version();
    lastHealthCheckTime = now;
    lastHealthCheckResult = true;
  } catch (error) {
    lastHealthCheckResult = false;
    console.error('[pi-to-chrome] ensureConnection: browser.version() 失败', error);
    throw new Error('Chrome 连接已断开，请执行 /chrome-start 重连');
  }
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
/** 判断是否为 Chrome 内部页面（非用户页面） */
function isChromeInternalPage(url: string): boolean {
  return url.startsWith('chrome://') ||
    url.startsWith('chrome-search://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('devtools://');
}

export async function getActivePage(): Promise<Page> {
  const b = getBrowser();

  try {
    const pages = await b.pages();

    // 优先从用户页面中找 visible 的
    for (const page of pages) {
      if (isChromeInternalPage(page.url())) continue;
      try {
        const visibilityState = await page.evaluate(() => document.visibilityState);
        if (visibilityState === 'visible') {
          return page;
        }
      } catch (error) {
        console.error(`[pi-to-chrome] getActivePage: page.evaluate() 失败 (url=${page.url()})`, error);
      }
    }

    // 没有 visible 的用户页面，返回第一个用户页面
    const userPage = pages.find(p => !isChromeInternalPage(p.url()));
    if (userPage) return userPage;

    // 兜底：只有内部页面时返回第一个
    if (pages.length > 0) {
      return pages[0];
    }
  } catch (error) {
    console.error('[pi-to-chrome] getActivePage: b.pages() 失败', error);
  }

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

  // 注册断线监听
  browser.on('disconnected', () => {
    if (isDisconnecting) return;             // 主动断开时跳过，由 disconnectChrome 统一清理
    console.error('[pi-to-chrome] browser disconnected 事件触发');
    browser = null;                          // 直接置 null，不做任何 CDP 请求
    lastHealthCheckResult = false;           // 失效化健康检查缓存
    destroyAllCdpSessions();                 // 清理 CDP sessions
    disconnectedCallback?.();                // 通知 index.ts 做清理和通知
  });

  return browser;
}

export async function disconnectChrome(): Promise<void> {
  if (!browser) return;
  isDisconnecting = true;
  try {
    destroyAllCdpSessions();                 // 先清理 CDP sessions
    browser.disconnect();
  } catch {
    // transport 已断开时 disconnect/detach 可能抛出 TargetCloseError，属正常
  } finally {
    browser = null;
    lastHealthCheckResult = false;
    isDisconnecting = false;
  }
}