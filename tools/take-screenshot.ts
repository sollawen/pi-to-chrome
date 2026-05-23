/**
 * chrome_take_screenshot - Take a screenshot of the current page
 * 
 * Automatically scales down large viewports and restores after capture.
 */

import type { Browser, Page } from 'puppeteer-core';

export async function takeScreenshot(
  browser: Browser,
  params: {
    format?: 'png' | 'jpeg';
    quality?: number;
  }
): Promise<{
  content: [{ type: 'text'; text: string }];
  details: { format: string; data: string; sizeBytes: number };
}> {
  const page = await getActivePage(browser);

  const format = params.format || 'jpeg';
  const quality = params.quality ?? 50;

  // Save original viewport
  const originalViewport = page.viewport();

  try {
    // Check viewport size and scale if needed
    let viewport = originalViewport;
    const maxDimension = 2000;

    if (originalViewport) {
      const width = originalViewport.width;
      const height = originalViewport.height;

      if (width > maxDimension || height > maxDimension) {
        const scale = maxDimension / Math.max(width, height);
        viewport = {
          width: Math.round(width * scale),
          height: Math.round(height * scale),
          deviceScaleFactor: originalViewport.deviceScaleFactor * scale
        };
        await page.setViewport(viewport);
      }
    }

    // Take screenshot
    const screenshot = await page.screenshot({
      type: format,
      encoding: 'base64',
      ...(format === 'jpeg' ? { quality } : {})
    });

    // Restore original viewport
    if (originalViewport) {
      await page.setViewport(originalViewport);
    }

    const base64Data = typeof screenshot === 'string' ? screenshot : screenshot.toString('base64');
    const sizeBytes = Math.round(base64Data.length * 0.75); // Approximate decoded size
    const sizeKB = Math.round(sizeBytes / 1024);

    return {
      content: [{ type: 'text', text: `截图已获取 (${format}, ${sizeKB}KB)` }],
      details: {
        format,
        data: base64Data,
        sizeBytes
      }
    };

  } catch (error: any) {
    // Ensure viewport is restored even on error
    if (originalViewport) {
      try {
        await page.setViewport(originalViewport);
      } catch {}
    }
    throw error;
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