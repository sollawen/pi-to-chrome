/**
 * tool-registry - Data-driven tool registration
 *
 * Replaces the ~120-line registerChromeTools() function with a declarative loop.
 * New tools only need: add to ALL_TOOLS array.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from './core/types';
import type { ConsoleBuffer } from './console-buffer';
import { ensureConnection, getActivePage } from './core/browser';

import { findElementsTool } from './tools/find-elements';
import { inspectStylesTool } from './tools/inspect-styles';
// import { takeScreenshotTool } from './tools/take-screenshot';
import { readConsoleTool } from './tools/read-console';
import { executeJsTool } from './tools/execute-js';

const ALL_TOOLS: ToolDefinition[] = [
  findElementsTool,
  inspectStylesTool,
  // takeScreenshotTool,
  readConsoleTool,
  executeJsTool,
];

export function registerTools(pi: ExtensionAPI, consoleBuffer: ConsoleBuffer): string[] {
  const names: string[] = [];

  for (const tool of ALL_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        await ensureConnection();
        const page = await getActivePage();
        return tool.execute(page, params, { consoleBuffer });
      }
    });
    names.push(tool.name);
  }

  return names;
}