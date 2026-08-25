import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ChannelServer, createChannelServer, REPLY_TOOL } from './channel.mjs';
import type { ChannelPollResponse, DaemonLink } from './daemon-link.mjs';
import {
  CHANNEL_CAPABILITY,
  CHANNEL_NOTIFICATION,
  CHANNEL_PERMISSION_CAPABILITY,
  PERMISSION_REQUEST_NOTIFICATION,
  PERMISSION_VERDICT_NOTIFICATION,
  type PermissionBehavior,
  type PermissionRequest,
} from './protocol.mjs';

/** Fake daemon: a queue the test drives directly, plus recorders for the other two calls. */
class FakeLink implements DaemonLink {
  outbound_calls: string[] = [];
  approvals: PermissionRequest[] = [];
  verdict: PermissionBehavior | null = null;
  approvalError: Error | null = null;
  private queue: Array<{ seq: number; text: string }> = [];
  private wake: (() => void) | null = null;
  private seq = 0;

  push(text: string): void {
    this.seq += 1;
    this.queue.push({ seq: this.seq, text });
    this.wake?.();
  }

  async poll(cursor: number): Promise<ChannelPollResponse> {
    const take = () => this.queue.filter((m) => m.seq > cursor);
    if (take().length === 0)
      await new Promise<void>((r) => {
        this.wake = () => {
          this.wake = null;
          r();
        };
      });
    const messages = take();
    return { cursor: messages[messages.length - 1]?.seq ?? cursor, messages };
  }

  async outbound(text: string): Promise<void> {
    this.outbound_calls.push(text);
  }

  async requestApproval(req: PermissionRequest): Promise<PermissionBehavior | null> {
    this.approvals.push(req);
    if (this.approvalError) throw this.approvalError;
    return this.verdict;
  }
}

const ChannelEvent = z.object({
  method: z.literal(CHANNEL_NOTIFICATION),
  params: z.object({ content: z.string(), meta: z.record(z.string()).optional() }),
});
const Verdict = z.object({
  method: z.literal(PERMISSION_VERDICT_NOTIFICATION),
  params: z.object({ request_id: z.string(), behavior: z.enum(['allow', 'deny']) }),
});

interface Wired {
  client: Client;
  channel: ChannelServer;
  link: FakeLink;
  events: Array<{ content: string; meta?: Record<string, string> }>;
  verdicts: Array<{ request_id: string; behavior: string }>;
}

async function wire(): Promise<Wired> {
  const link = new FakeLink();
  const channel = createChannelServer({ link, retryMs: 5, maxRetryMs: 10 });
  const client = new Client({ name: 'fake-claude-code', version: '0.0.1' }, { capabilities: {} });
  const events: Wired['events'] = [];
  const verdicts: Wired['verdicts'] = [];
  client.setNotificationHandler(ChannelEvent, (n) => void events.push(n.params));
  client.setNotificationHandler(Verdict, (n) => void verdicts.push(n.params));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([channel.connect(serverT), client.connect(clientT)]);
  return { client, channel, link, events, verdicts };
}

const until = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let wired: Wired | null = null;
afterEach(async () => {
  await wired?.channel.close();
  await wired?.client.close();
  wired = null;
});

describe('capability declaration', () => {
  it('declares both experimental channel capabilities and tools', async () => {
    wired = await wire();
    const caps = wired.client.getServerCapabilities();
    // "Required. Always {}. Presence registers the notification listener."
    expect(caps?.experimental?.[CHANNEL_CAPABILITY]).toEqual({});
    // "Set it to {} to declare that this channel can receive permission relay requests."
    expect(caps?.experimental?.[CHANNEL_PERMISSION_CAPABILITY]).toEqual({});
    expect(caps?.tools).toEqual({});
  });

  it('ships instructions that tell Claude to use the reply tool', async () => {
    wired = await wire();
    expect(wired.client.getInstructions()).toContain(REPLY_TOOL);
  });
});

describe('inbound queue → channel notification', () => {
  it('emits notifications/claude/channel for each queued text', async () => {
    wired = await wire();
    wired.link.push('ship the fix');
    await until(() => wired?.events.length === 1);
    expect(wired.events[0]?.content).toBe('ship the fix');
    // Meta keys must be identifiers; hyphenated keys are silently dropped by Claude Code.
    expect(wired.events[0]?.meta).toEqual({ origin: 'pagr', seq: '1' });
    for (const k of Object.keys(wired.events[0]?.meta ?? {})) expect(k).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('advances the cursor so a text is injected exactly once', async () => {
    wired = await wire();
    wired.link.push('one');
    await until(() => wired?.events.length === 1);
    wired.link.push('two');
    await until(() => wired?.events.length === 2);
    expect(wired.events.map((e) => e.content)).toEqual(['one', 'two']);
  });
});

describe('reply tool', () => {
  it('is advertised', async () => {
    wired = await wire();
    const { tools } = await wired.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([REPLY_TOOL]);
    expect(tools[0]?.inputSchema.required).toEqual(['text']);
  });

  it('forwards the text to the daemon', async () => {
    wired = await wire();
    const res = await wired.client.callTool({
      name: REPLY_TOOL,
      arguments: { text: 'build is green' },
    });
    expect(wired.link.outbound_calls).toEqual(['build is green']);
    expect(res.content).toEqual([{ type: 'text', text: 'sent' }]);
  });

  it('rejects an empty reply and an unknown tool', async () => {
    wired = await wire();
    await expect(
      wired.client.callTool({ name: REPLY_TOOL, arguments: { text: '  ' } }),
    ).rejects.toThrow();
    await expect(wired.client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow();
  });
});

describe('permission relay', () => {
  const request = (over: Partial<PermissionRequest> = {}) => ({
    method: PERMISSION_REQUEST_NOTIFICATION,
    params: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run shell command',
      input_preview: '{"command":"git push origin main"}',
      ...over,
    },
  });

  it('round-trips an allow verdict with the same request_id', async () => {
    wired = await wire();
    wired.link.verdict = 'allow';
    await wired.client.notification(request());
    await until(() => wired?.verdicts.length === 1);
    expect(wired.verdicts[0]).toEqual({ request_id: 'abcde', behavior: 'allow' });
    expect(wired.link.approvals[0]?.tool_name).toBe('Bash');
  });

  it('round-trips a deny verdict', async () => {
    wired = await wire();
    wired.link.verdict = 'deny';
    await wired.client.notification(request({ request_id: 'qwrty', tool_name: 'Write' }));
    await until(() => wired?.verdicts.length === 1);
    expect(wired.verdicts[0]).toEqual({ request_id: 'qwrty', behavior: 'deny' });
  });

  it('stays SILENT when no decision arrives, leaving the terminal dialog in control', async () => {
    wired = await wire();
    wired.link.verdict = null;
    await wired.client.notification(request());
    await until(() => wired?.link.approvals.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(wired.verdicts).toEqual([]);
  });

  it('stays silent when the daemon call throws', async () => {
    const errors: string[] = [];
    const link = new FakeLink();
    link.approvalError = new Error('socket gone');
    const channel = createChannelServer({ link, onError: (m) => errors.push(m) });
    const client = new Client({ name: 'c', version: '0' }, { capabilities: {} });
    const verdicts: unknown[] = [];
    client.setNotificationHandler(Verdict, (n) => void verdicts.push(n.params));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([channel.connect(st), client.connect(ct)]);
    await client.notification(request());
    await until(() => link.approvals.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(verdicts).toEqual([]);
    expect(errors.join(' ')).toContain('socket gone');
    await channel.close();
    await client.close();
  });
});
