/**
 * chrome_trace_css - Trace CSS style sources for an element
 *
 * Uses CSSOM (document.styleSheets) to accurately identify which file
 * each CSS rule comes from. No CDP session required.
 */

import type { ToolDefinition } from '../core/types';
import { validateSelectorUniqueness } from '../core/selector-utils';
import { Type } from '@sinclair/typebox';

export const traceCssTool: ToolDefinition<{
  selector: string;
}> = {
  name: 'chrome_trace_css',
  label: 'Chrome Trace CSS',
  description: '追踪元素的 CSS 样式来源：查看完整层叠链，每条规则标注来源文件。',
  promptSnippet: '追踪元素 CSS 样式来源',
  promptGuidelines: [
    '【查样式来源】当需要知道某条 CSS 规则写在哪个文件、被什么覆盖时使用。先用 chrome_find_elements 定位元素，再用 chrome_trace_css 追踪样式来源。',
    '返回结果按优先级排列（inline > CSS class > user-agent）。',
    '来源格式：文件名、<style> 标签、inline style、user-agent 浏览器默认。',
  ],
  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector，应定位到唯一元素' })
  }),
  async execute(page, params) {
    // Validate selector uniqueness
    const validation = await validateSelectorUniqueness(page, params.selector);
    if (!validation.ok) {
      if (validation.kind === 'not_found') {
        throw new Error(`❌ 未找到匹配 "${params.selector}" 的元素`);
      }
      if (validation.kind === 'invalid') {
        throw new Error(`❌ 无效的 CSS selector: ${params.selector}\n${validation.message}`);
      }
      if (validation.kind === 'multiple') {
        const list = validation.items.map((item, i) =>
          `${i + 1}. <${item.tag}> "${item.text}"\n   → ${item.nthSelector}`
        ).join('\n');
        throw new Error(`❌ 该 selector 匹配了 ${validation.count} 个元素，请指定唯一元素:\n\n${list}`);
      }
    }

    // Get element info
    const elementInfo = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;

      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: el.className
          ? Array.from(el.classList).filter(c => typeof c === 'string').slice(0, 10)
          : [],
        text: (el.textContent || '').trim().slice(0, 100).replace(/\s+/g, ' '),
        boundingRect: (() => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()
      };
    }, params.selector);

    // Collect CSS rules using CSSOM
    const cssRules = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;

      const rules: Array<{
        type: 'inline' | 'regular';
        source: string;
        selector: string;
        properties: string;
        propertiesDetailed?: Array<{ name: string; value: string; important: boolean }>;
      }> = [];

      // Helper: extract meaningful properties (skip initial/inherit/unset/revert)
      const SKIP_VALUES = new Set(['initial', 'inherit', 'unset', 'revert', '']);
      function extractProps(style: CSSStyleDeclaration): Array<{ name: string; value: string; important: boolean }> {
        const result: Array<{ name: string; value: string; important: boolean }> = [];
        for (let i = 0; i < style.length; i++) {
          const name = style[i];
          const value = style.getPropertyValue(name);
          if (SKIP_VALUES.has(value)) continue;
          const priority = style.getPropertyPriority(name);
          result.push({ name, value, important: priority === 'important' });
        }
        return result;
      }

      // 1. Inline style
      if (el instanceof HTMLElement && el.style && el.style.cssText) {
        rules.push({
          type: 'inline',
          source: 'inline style',
          selector: '<inline>',
          properties: el.style.cssText,
          propertiesDetailed: extractProps(el.style)
        });
      }

      // 2. Traverse document.styleSheets to find matching rules
      for (const sheet of Array.from(document.styleSheets)) {
        // Determine source filename
        let source = '<style>';
        if (sheet.href) {
          // Try to get a clean filename
          const urlParts = sheet.href.split('/');
          source = urlParts[urlParts.length - 1] || sheet.href;
          // Remove query params if any
          source = source.split('?')[0];
        }

        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSStyleRule) {
              try {
                if (el.matches(rule.selectorText)) {
                  rules.push({
                    type: 'regular',
                    source: source,
                    selector: rule.selectorText,
                    properties: rule.style.cssText,
                    propertiesDetailed: extractProps(rule.style)
                  });
                }
              } catch {
                // Selector might have compatibility issues with el.matches()
              }
            }
          }
        } catch {
          // Cross-origin stylesheet, cannot access cssRules
        }
      }

      return rules;
    }, params.selector);

    if (!cssRules) {
      throw new Error(`❌ 未找到匹配 "${params.selector}" 的元素`);
    }

    if (cssRules.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `元素 <${elementInfo!.tagName}> 没有匹配的 CSS 规则（无 inline style，无 class 样式）`
        }],
        details: { element: elementInfo, cssRules: [] }
      };
    }

    // Build summary
    const summaryLines: string[] = [
      `元素 <${elementInfo!.tagName}> 的 CSS 层叠链 (${cssRules.length} 条规则):`
    ];

    cssRules.forEach((rule, i) => {
      summaryLines.push(`  ${i + 1}. [${rule.type}] ${rule.source}`);
      summaryLines.push(`     选择器: ${rule.selector}`);

      if (rule.propertiesDetailed && rule.propertiesDetailed.length > 0) {
        const propLines = rule.propertiesDetailed.map(p =>
          `  ${p.name}: ${p.value}${p.important ? ' !important' : ''}`
        );
        summaryLines.push(`     属性:`);
        summaryLines.push(...propLines.map(l => `    ${l}`));
      } else {
        summaryLines.push(`     属性: ${rule.properties}`);
      }
    });

    return {
      content: [{ type: 'text', text: summaryLines.join('\n') }],
      details: { element: elementInfo, cssRules }
    };
  }
};