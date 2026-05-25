/**
 * chrome_find_elements - Search for elements on the current Chrome page
 *
 * Uses TreeWalker/XPath for text search (efficient), and querySelectorAll for CSS/tag search.
 */

import type { ToolDefinition } from '../core/types';
import { Type } from '@sinclair/typebox';

export const findElementsTool: ToolDefinition<{
  text?: string;
  selector?: string;
  tag?: string;
  visibleOnly?: boolean;
}> = {
  name: 'chrome_find_elements',
  label: 'Chrome Find Elements',
  description: 'Search for elements on the current Chrome page by visible text, CSS selector, or tag name. Text search is case-insensitive and supports multiple keywords separated by / (e.g. "灯泡/Receiver/lamp" matches any).',
  promptSnippet: 'Search elements by text/CSS selector/tag',
  promptGuidelines: [
    'Use chrome_find_elements when the user asks about elements on the page whose selector is unknown. Search by visible text, CSS selector, or tag name.',
    'IMPORTANT: When searching by text, always provide bilingual keywords separated by / — both Chinese and English terms the element might use. Break keywords into smaller pieces to maximize matches. Example: if user says "开始时间", search "开始时间/开始/时间/startTime/start-time/start/time". If user says "灯泡", search "灯泡/bulb/lamp/light". Cast a wide net — more keywords is better.'
  ],
  parameters: Type.Object({
    text: Type.Optional(Type.String({ description: 'Search by text. Use / for multiple keywords (OR, case-insensitive). Example: "灯泡/Receiver/lamp"' })),
    selector: Type.Optional(Type.String({ description: 'Search by CSS selector' })),
    tag: Type.Optional(Type.String({ description: 'Filter by tag name (e.g. button, input)' })),
    visibleOnly: Type.Optional(Type.Boolean({ description: 'Only return visible elements', default: true }))
  }),
  async execute(page, params) {
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
      // Split keywords by '/' and match any (OR), case-insensitive
      const keywords = params.text.split('/').map(k => k.trim().toLowerCase()).filter(k => k);
      const rawResults: any[] = await page.evaluate((keywords: string[]) => {
        const skipTags = ['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT'];
        const allMatches: Element[] = [];
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          null
        );

        let node: Node | null = walker.currentNode;
        while (node) {
          const el = node as Element;
          if (!skipTags.includes(el.tagName)) {
            const textLower = (el.textContent?.trim() || '').toLowerCase();
            if (keywords.some(kw => textLower.includes(kw))) {
              allMatches.push(el);
            }
          }
          node = walker.nextNode();
        }

        // Deduplicate: keep only the deepest elements (remove ancestors whose descendant also matched)
        const matchSet = new Set(allMatches);
        const leaves = allMatches.filter(el => {
          // Check if any descendant of this element is also in the match set
          for (const child of matchSet) {
            if (child !== el && el.contains(child)) return false;
          }
          return true;
        });

        // Build results from leaf elements only
        const results: any[] = [];
        for (const el of leaves) {
          const rect = el.getBoundingClientRect();
          results.push({
            tagName: el.tagName.toLowerCase(),
            text: (el.textContent?.trim() || '').slice(0, 80),
            id: el.id || null,
            classList: Array.from(el.classList).slice(0, 10),
            visible: (el as any).offsetParent !== null,
            boundingRect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          });
        }

        return results;
      }, keywords);

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
              visible: (target as any).offsetParent !== null
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
};