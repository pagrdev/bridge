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

/** Incremental JSONL splitter: feed chunks, get whole lines back. */
export class LineBuffer {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let i = this.buf.indexOf('\n');
    while (i >= 0) {
      out.push(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
      i = this.buf.indexOf('\n');
    }
    return out;
  }
  flush(): string | null {
    const rest = this.buf;
    this.buf = '';
    return rest.trim() === '' ? null : rest;
  }
}

export function encode(msg: RpcMessage): string {
  return `${JSON.stringify(msg)}\n`;
}
