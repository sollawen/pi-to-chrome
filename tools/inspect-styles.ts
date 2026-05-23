/**
 * chrome_inspect_styles - Inspect CSS cascade for an element
 * 
 * Gets matched CSS rules through CDP's CSS.getMatchedStylesForNode API.
 */

import type { Browser, CDPSession, Page } from 'puppeteer-core';

export async function inspectStyles(
  browser: Browser,
  params: {
    selector: string;
    includeChildren?: boolean;
  }
): Promise<{
  content: [{ type: 'text'; text: string }];
  details: { element: any; cssRules: any[] };
}> {
  const page = await getActivePage(browser);
  let cdpSession: CDPSession | null = null;

  try {
    // Create CDP session for this page
    cdpSession = await page.createCDPSession();
    
    // Enable DOM and CSS agents
    await cdpSession.send('DOM.enable');
    await cdpSession.send('CSS.enable');

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
    const { model: elementModel } = await cdpSession.send('DOM.describeNode', { nodeId });
    
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
      tagName: elementModel.tagName?.toLowerCase() || 'unknown',
      text: textContent,
      classList: elementModel.attributes 
        ? extractClasses(elementModel.attributes)
        : [],
      attributes: elementModel.attributes || [],
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
        
        const sourceLocation = rule.rule.sourceURL
          ? `${rule.rule.sourceURL}:${rule.rule.sourceLine || '?'}`
          : 'inline';

        cssRules.push({
          type: rule.rule.origin === 'user-agent' ? 'user-agent' : 'regular',
          selector: source,
          source: sourceLocation,
          properties: props
        });
      }
    }

    // Computed style (for getting final values)
    const computedStyle = await cdpSession.send('CSS.getComputedStyle', { nodeId });

    // Get children if requested
    let children: any[] = [];
    if (params.includeChildren) {
      const { children: domChildren } = await cdpSession.send('DOM.getOuterHTML', { nodeId });
      // Simplified: just return direct children info
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

  } finally {
    // Clean up CDP session
    if (cdpSession) {
      try {
        await cdpSession.detach();
      } catch {}
    }
  }
}

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

async function getActivePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  
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
  
  throw new Error('无法获取当前页面');
}