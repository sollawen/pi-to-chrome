/**
 * core/connection-state - Persistent connection intent via flag file
 *
 * Persists the user's "connection intent" to a JSON file so that
 * session_start can auto-reconnect after /new, /resume, /fork, /reload.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';

export interface ConnectionState {
  mode: 'local' | 'remote';
  host: string;
  port: number;
  timestamp: number;
}

const STATE_DIR = path.join(homedir(), '.pi', 'tmp');
const STATE_FILE = path.join(STATE_DIR, 'chrome-connection.json');

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export function readConnectionState(): ConnectionState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw) as ConnectionState;
  } catch {
    return null;
  }
}

export function writeConnectionState(state: Omit<ConnectionState, 'timestamp'>): void {
  try {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }
    const full: ConnectionState = { ...state, timestamp: Date.now() };
    writeFileSync(STATE_FILE, JSON.stringify(full, null, 2), 'utf8');
  } catch (error) {
    console.error('[pi-to-chrome] writeConnectionState 失败', error);
  }
}

export function clearConnectionState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
    }
  } catch (error) {
    console.error('[pi-to-chrome] clearConnectionState 失败', error);
  }
}

export function isConnectionStateExpired(state: ConnectionState): boolean {
  return Date.now() - state.timestamp > EXPIRY_MS;
}
