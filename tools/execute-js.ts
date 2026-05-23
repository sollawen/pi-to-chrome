/**
 * chrome_execute_js - Execute JavaScript in the page context
 * 
 * Uses IIFE wrapper to support both expressions and statements.
 */

import type { Browser, Page } from 'puppeteer-core';

export async function executeJS(
  browser: Browser,
  params: {
    expression: string;
  }
): Promise<{
  content: [{ type: 'text'; text: string }];
  details: { raw: any };
}> {
  const page = await getActivePage(browser);

  // Wrap in IIFE: expression-body for simple values, block-body for statements
  //   `(() => location.href)()`          → expression, returns value directly
  //   `(() => { const x = 1; return x; })()`  → block, supports return/multi-line
  const trimmed = params.expression.trim();
  // If it starts with { or a statement keyword, use block form
  // 语句: return, const, let, var, if, for, while, try, switch, throw, function, class
  const statementKeywords = ['return ', 'const ', 'let ', 'var ', 'if ', 'for ', 'while ', 'try ', 'switch ', 'throw ', 'function ', 'class ', 'async '];
  const isBlock = trimmed.startsWith('{') || statementKeywords.some(kw => trimmed.startsWith(kw));
  const wrappedCode = isBlock
    ? `(() => { ${params.expression} })()`
    : `(() => ${params.expression})()`;

  try {
    const result = await page.evaluate(wrappedCode);

    // Serialize result
    let serializedResult: string;
    let rawResult = result;

    if (result === undefined) {
      serializedResult = 'undefined';
    } else if (result === null) {
      serializedResult = 'null';
    } else if (typeof result === 'string') {
      serializedResult = result.length > 5000 ? result.slice(0, 5000) + '...' : result;
    } else if (typeof result === 'number' || typeof result === 'boolean') {
      serializedResult = String(result);
    } else if (Array.isArray(result)) {
      serializedResult = `Array(${result.length})`;
    } else if (typeof result === 'object') {
      serializedResult = 'Object';
    } else {
      serializedResult = JSON.stringify(result)?.slice(0, 5000) || String(result);
    }

    return {
      content: [{ type: 'text', text: serializedResult }],
      details: { raw: rawResult }
    };

  } catch (error: any) {
    // Re-throw to mark as error
    throw new Error(error.message);
  }
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