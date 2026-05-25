/**
 * core/types - Shared types for chrome extension tools
 */

import type { Page } from 'puppeteer-core';
import type { ConsoleBuffer } from '../console-buffer';
import type { TSchema } from '@sinclair/typebox';

// Tool unified return format
export interface ToolResult {
  content: [{ type: 'text'; text: string }];
  details: Record<string, any>;
}

// Tool dependencies (injected at call time)
export interface ToolDeps {
  consoleBuffer: ConsoleBuffer;
}

// Tool definition object (generic preserves parameter types)
export interface ToolDefinition<TParams = any> {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: TSchema;
  execute: (page: Page, params: TParams, deps?: ToolDeps) => Promise<ToolResult>;
}