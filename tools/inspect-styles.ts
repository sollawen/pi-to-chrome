/**
 * chrome_inspect_styles - Inspect CSS cascade for an element
 *
 * Gets matched CSS rules through CDP's CSS.getMatchedStylesForNode API.
 */

import type { ToolDefinition } from '../core/types';
import { withCdpSession } from '../core/browser';
import { Type } from '@sinclair/typebox';

export const inspectStylesTool: ToolDefinition<{
  selector: string;
  includeChildren?: boolean;
}> = {
  name: 'chrome_inspect_styles',
  label: 'Chrome Inspect Styles',
  description: '查看元素的完整 CSS 样式层叠链：包括 inline style、class 样式、user-agent 样式，以及每条规则的来源文件和优先级。',
  promptSnippet: '查看元素的 CSS 样式层叠链',
  promptGuidelines: [
    '【调试布局问题的核心工具】当元素显示异常（溢出、滚动条不出现、尺寸不对、布局错乱）时，立即用 chrome_inspect_styles 检查该元素及其父容器的样式层叠链，确认 inline style 是否覆盖了 CSS 规则、overflow 是否被意外设为 hidden 等。',
    '调试滚动条问题时：依次检查 滚动容器 → 父容器 → 祖先容器的 overflow、display、height、flex 属性，定位哪一层断了高度约束链。',
    '返回结果会按优先级排列（inline > CSS class > user-agent），注意 inline style 会覆盖 CSS 文件中的规则。',
    '指定 CSS selector 来定位元素，例如 "#dashboardContainer"、".command-list"、"div > .card"。'
  ],
  parameters: Type.Object({
    selector: Type.String({ description: 'CSS selector of the element to inspect' }),
    includeChildren: Type.Optional(Type.Boolean({ description: 'Include direct children list', default: false }))
  }),
  async execute(page, params) {
    return withCdpSession(page, async (cdpSession) => {

      // Get document and find node
      const { root } = await cdpSession.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await cdpSession.send('DOM.querySelector', {
        selector: params.selector,
        nodeId: root.nodeId
      });

      if (!nodeId) {
        throw new Error(`未找到匹配 "${params.selector}" 的元素`);
      }

      // Get element info
      const { node: nodeInfo } = await cdpSession.send('DOM.describeNode', { nodeId });

      // Get bounding rect
      const boundingRect = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, params.selector);

      // Get text content (truncated)
      const textContent = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return (el?.textContent || '').trim().slice(0, 200);
      }, params.selector);

      // Build element info
      const elementInfo = {
        tagName: nodeInfo.localName?.toLowerCase() || 'unknown',
        text: textContent,
        classList: nodeInfo.attributes
          ? extractClasses(nodeInfo.attributes)
          : [],
        attributes: nodeInfo.attributes || [],
        boundingRect
      };

      // Get matched styles
      const matchedStyles = await cdpSession.send('CSS.getMatchedStylesForNode', { nodeId });

      // Process CSS rules
      const cssRules: any[] = [];

      // Inline style
      if (matchedStyles.inlineStyle) {
        const inlineProps = processStyleProperties(matchedStyles.inlineStyle.cssProperties, matchedStyles.inlineStyle.shorthandEntries);
        if (Object.keys(inlineProps).length > 0) {
          cssRules.push({
            type: 'inline',
            selector: '<inline style>',
            source: 'inline style',
            properties: inlineProps
          });
        }
      }

      // Regular matched rules
      if (matchedStyles.matchedCSSRules) {
        for (const rule of matchedStyles.matchedCSSRules) {
          const props = processStyleProperties(rule.rule.style.cssProperties, rule.rule.style.shorthandEntries);

          // Build source string
          const source = rule.rule.origin === 'user-agent'
            ? 'user-agent'
            : rule.rule.selectorList?.selectors?.map((s: any) => s.value).join(', ') || 'unknown';

          const sourceLocation = (rule.rule as any).sourceURL
            ? `${(rule.rule as any).sourceURL}:${(rule.rule as any).sourceLine || '?'}`
            : 'inline';

          cssRules.push({
            type: rule.rule.origin === 'user-agent' ? 'user-agent' : 'regular',
            selector: source,
            source: sourceLocation,
            properties: props
          });
        }
      }

      // Build summary
      const summary = `元素 <${elementInfo.tagName}> 的 CSS 层叠链:\n` +
        cssRules.map((rule, i) =>
          `  ${i + 1}. [${rule.type}] ${rule.selector}\n     来源: ${rule.source}\n` +
          (rule.properties.length > 0
            ? `     属性: ${rule.properties.slice(0, 5).map((p: any) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`).join(', ')}${rule.properties.length > 5 ? '...' : ''}\n`
            : '')
        ).join('');

      return {
        content: [{ type: 'text', text: summary }],
        details: { element: elementInfo, cssRules }
      };

    });
  }
};

function extractClasses(attributes: string[]): string[] {
  const classes: string[] = [];
  for (let i = 0; i < attributes.length - 1; i += 2) {
    if (attributes[i] === 'class') {
      return attributes[i + 1].split(/\s+/).filter(c => c).slice(0, 10);
    }
  }
  return classes;
}

function processStyleProperties(
  cssProperties: any[],
  shorthandEntries: any[]
): any[] {
  if (!cssProperties) return [];

  const result: any[] = [];
  const seenShorthands = new Set<string>();

  // Track which shorthands are explicitly set
  for (const entry of shorthandEntries || []) {
    if (entry.value > 0) {
      seenShorthands.add(cssProperties[entry.value]?.name || '');
    }
  }

  for (const prop of cssProperties) {
    // Skip empty values
    if (!prop.value || prop.value === '') continue;

    // Skip inherit/initial/unset unless it's the only value (shorthand)
    const isInheritOrInitial = ['inherit', 'initial', 'unset', 'revert'].includes(prop.value);

    // Keep the property if:
    // 1. It's a shorthand property (entry in shorthandEntries)
    // 2. It's not a longhand of an explicitly set shorthand
    // 3. It's inherit/initial/unset with no shorthand entry
    const isShorthand = shorthandEntries?.some((e: any) =>
      e.value === cssProperties.indexOf(prop) && e.value >= 0
    );

    if (isShorthand) {
      result.push({
        name: prop.name,
        value: prop.value,
        important: prop.important || false
      });
    } else if (!isInheritOrInitial) {
      result.push({
        name: prop.name,
        value: prop.value,
        important: prop.important || false
      });
    }
  }

  return result;
}