/**
 * chrome_take_screenshot - Take a screenshot of the current page
 *
 * Automatically scales down large viewports and restores after capture.
 */

import type { ToolDefinition } from '../core/types';
import { Type } from '@sinclair/typebox';

export const takeScreenshotTool: ToolDefinition<{
  format?: 'png' | 'jpeg';
  quality?: number;
}> = {
  name: 'chrome_take_screenshot',
  label: 'Chrome Take Screenshot',
  description: 'Take a screenshot of the current page. Returns base64 encoded image.',
  promptSnippet: 'Take a screenshot of the current page',
  promptGuidelines: [
    'Use chrome_take_screenshot when the user asks to see what the page looks like visually.'
  ],
  parameters: Type.Object({
    format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('jpeg')])),
    quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100 }))
  }),
  async execute(page, params) {
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
            deviceScaleFactor: (originalViewport.deviceScaleFactor ?? 1) * scale
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

      const base64Data = typeof screenshot === 'string' ? screenshot : Buffer.from(screenshot as any).toString('base64');
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
};