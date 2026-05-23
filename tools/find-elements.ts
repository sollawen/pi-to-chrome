/**
 * chrome_find_elements - Search for elements on the current Chrome page
 * 
 * Uses TreeWalker/XPath for text search (efficient), and querySelectorAll for CSS/tag search.
 */

import type { Browser } from 'puppeteer-core';

export async function findElements(
  browser: Browser,
  params: {
    text?: string;
    selector?: string;
    tag?: string;
    visibleOnly?: boolean;
  }
): Promise<{
  content: [{ type: 'text'; text: string }];
  details: { total: number; results: any[] };
}> {
  const page = await getActivePage(browser);
  
  // Must provide at least one search criterion
  if (!params.text && !params.selector && !params.tag) {
    throw new Error('必须提供 text、selector 或 tag 至少一个搜索条件');
  }

  let elements: any[] = [];

  if (params.selector) {
    // CSS selector search
    elements = await page.$$(params.selector);
  } else if (params.tag) {
    // Tag name search
    elements = await page.$$(params.tag.toLowerCase());
  } else if (params.text) {
    // Text content search using TreeWalker (efficient)
    // NOTE: evaluate 返回纯 JSON — DOM 元素不可序列化
    const rawResults: any[] = await page.evaluate((searchText: string) => {
      const skipTags = ['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT'];
      const results: any[] = [];
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
        null
      );
      
      let node: Node | null = walker.currentNode;
      while (node) {
        const el = node as Element;
        if (!skipTags.includes(el.tagName)) {
          const text = el.textContent?.trim() || '';
          if (text.includes(searchText)) {
            const rect = el.getBoundingClientRect();
            results.push({
              tagName: el.tagName.toLowerCase(),
              text: text.slice(0, 80),
              id: el.id || null,
              classList: Array.from(el.classList).slice(0, 10),
              visible: el.offsetParent !== null,
              boundingRect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              }
            });
          }
        }
        node = walker.nextNode();
      }
      
      return results;
    }, params.text);
    
    elements = rawResults;
  }

  // Filter and collect element info
  const visibleOnly = params.visibleOnly !== false;
  const isTextSearch = !!params.text;
  const results: any[] = [];
  
  for (const item of elements.slice(0, 20)) { // Max 20 results
    try {
      if (isTextSearch) {
        // Text search: items are pre-built JSON objects
        if (visibleOnly && !item.visible) continue;
        if (visibleOnly && item.boundingRect && (item.boundingRect.width === 0 || item.boundingRect.height === 0)) continue;
        results.push(item);
      } else {
        // Selector / tag: puppeteer ElementHandle → evaluate in page
        const rect = await (item as any).boundingBox();
        if (visibleOnly && rect && (rect.width === 0 || rect.height === 0)) continue;

        const info = await page.evaluate((target: Element) => {
          const skipTags = ['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT'];
          if (skipTags.includes(target.tagName)) return null;
          return {
            tagName: target.tagName.toLowerCase(),
            text: (target.textContent || '').trim().slice(0, 80),
            id: target.id || null,
            classList: Array.from(target.classList).slice(0, 10),
            visible: target.offsetParent !== null
          };
        }, item);

        if (!info) continue;

        results.push({
          ...info,
          boundingRect: rect ? {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          } : null
        });
      }
    } catch {}
  }

  const total = results.length;
  const summary = params.selector 
    ? `找到 ${total} 个匹配 "${params.selector}" 的元素`
    : params.tag
    ? `找到 ${total} 个 <${params.tag}> 标签元素`
    : `找到 ${total} 个包含文本 "${params.text}" 的元素`;

  return {
    content: [{ type: 'text', text: summary }],
    details: { total, results }
  };
}

async function getActivePage(browser: Browser) {
  const pages = await browser.pages();
  
  // Find the visible page (user's current tab)
  for (const page of pages) {
    try {
      const visibilityState = await page.evaluate(() => document.visibilityState);
      if (visibilityState === 'visible') {
        return page;
      }
    } catch {}
  }
  
  // Fallback to first page if none visible (e.g., minimized Chrome)
  if (pages.length > 0) {
    return pages[0];
  }
  
  throw new Error('无法获取当前页面');
}