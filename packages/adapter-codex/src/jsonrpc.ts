import type { RpcMessage, RpcNotification, RpcRequest, RpcResponse } from './protocol.js';

export type Classified =
  | { kind: 'request'; msg: RpcRequest }
  | { kind: 'notification'; msg: RpcNotification }
  | { kind: 'response'; msg: RpcResponse }
  | { kind: 'invalid'; raw: string; reason: string };

/** Classify one JSONL line from the app-server. Never throws. */
export function classifyLine(line: string): Classified {
  const raw = line.trim();
  if (raw === '') return { kind: 'invalid', raw, reason: 'empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', raw, reason: 'not json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', raw, reason: 'not an object' };
  }
  const m = parsed as Record<string, unknown>;
  const hasId = typeof m.id === 'number' || typeof m.id === 'string';
  const hasMethod = typeof m.method === 'string';
  if (hasMethod && hasId) return { kind: 'request', msg: m as unknown as RpcRequest };
  if (hasMethod) return { kind: 'notification', msg: m as unknown as RpcNotification };
  if (hasId && ('result' in m || 'error' in m)) {
    return { kind: 'response', msg: m as unknown as RpcResponse };
  }
  return { kind: 'invalid', raw, reason: 'neither request, notification nor response' };
}

/**
 * Re-exported so every `jsonrpc.js` caller keeps its import. The implementation lives in
 * `@pagr/bridge-core` because the Claude channel server needs the same splitter.
 */
export { LineBuffer } from '@pagr/bridge-core';

export function encode(msg: RpcMessage): string {
  return `${JSON.stringify(msg)}\n`;
}
