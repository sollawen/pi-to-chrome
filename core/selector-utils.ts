/**
 * core/selector-utils - Shared utilities for selector validation and formatting
 */

import type { Page } from 'puppeteer-core';

/** 验证结果 */
export type ValidateResult =
  | { ok: true }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'multiple'; count: number; items: Array<{ tag: string; text: string; nthSelector: string }> }
  | { ok: false; kind: 'invalid'; message: string };

/**
 * 验证 selector 是否定位到唯一元素。
 * 全部在 page.evaluate 内完成，一次 round-trip。
 * 多元素时附带每个元素的 tag / text / nth-child selector。
 */
export async function validateSelectorUniqueness(page: Page, selector: string): Promise<ValidateResult> {
  const result = await page.evaluate((sel: string) => {
    try {
      const matches = Array.from(document.querySelectorAll(sel));

      if (matches.length === 0) {
        return { ok: false, kind: 'not_found' as const };
      }

      if (matches.length > 1) {
        const items = matches.slice(0, 10).map((el, i) => {
          // Build nth-child selector
          let nthSelector = sel;
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children);
            const index = siblings.indexOf(el) + 1;
            const tag = el.tagName.toLowerCase();
            nthSelector = `${sel} > ${tag}:nth-child(${index})`;
          }

          // Get text content (truncated)
          const text = (el.textContent || '').trim().slice(0, 50).replace(/\s+/g, ' ');

          return {
            tag: el.tagName.toLowerCase(),
            text: text || '(无文本)',
            nthSelector
          };
        });

        return { ok: false, kind: 'multiple' as const, count: matches.length, items };
      }

      return { ok: true };
    } catch (err: any) {
      return { ok: false, kind: 'invalid' as const, message: err.message };
    }
  }, selector);

  return result as ValidateResult;
}

/**
 * 格式化元素标签: "<tag.class1.class2#id>"
 * @param maxClasses 最多显示的 class 数量，默认 3
 */
export function formatElementLabel(
  tag: string,
  id?: string | null,
  classes?: string[],
  maxClasses = 3
): string {
  let label = tag;

  if (id) {
    label += `#${id}`;
  }

  if (classes && classes.length > 0) {
    const shown = classes.slice(0, maxClasses);
    label += '.' + shown.join('.');
    if (classes.length > maxClasses) {
      label += ` +${classes.length - maxClasses}`;
    }
  }

  return `<${label}>`;
}