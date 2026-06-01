/**
 * core/shared-state - Shared runtime state for chrome extension
 *
 * Provides module-level state for tool registration and console buffer.
 * Consumed by index.ts (event handlers) and commands/ (slash commands).
 */

import { ConsoleBuffer } from './console-buffer';

let toolNames: string[] = [];
let isReconnecting = false;
const consoleBuffer = new ConsoleBuffer();

export function getToolNames(): string[] {
  return toolNames;
}

export function setToolNames(names: string[]): void {
  toolNames = names;
}

export function getConsoleBuffer(): ConsoleBuffer {
  return consoleBuffer;
}

export function isReconnectingActive(): boolean {
  return isReconnecting;
}

export function setReconnecting(val: boolean): void {
  isReconnecting = val;
}
