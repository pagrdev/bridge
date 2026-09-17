import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createChannelServer } from './server.js';
import type { DaemonLink } from './types.js';

/**
 * The channel server against a fake Claude Code.
 *
 * Every assertion here is a wire shape somebody else parses: the capability keys Claude Code
 * looks for on `initialize`, the `{content, meta}` of a channel notification, and the silence
 * that has to follow a permission request with no decision behind it.
 */

class Peer {
  readonly stdin = new PassThrough();
  readonly lines: Array<Record<string, unknown>> = [];
  readonly out = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n'))
        if (line.trim()) this.lines.push(JSON.parse(line) as Record<string, unknown>);
      return true;
    },
  };
  send(msg: Record<string, unknown>): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }
  /** Poll the recorded lines until one matches; the server answers on microtasks, not timers. */
  async waitFor(
    pred: (m: Record<string, unknown>) => boolean,
    ms = 2000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.lines.find(pred);
      if (hit) return hit;
      if (Date.now() >= deadline) throw new Error('timed out waiting for a line');
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

const method = (name: string) => (m: Record<string, unknown>) => m.method === name;
const idIs = (id: number) => (m: Record<string, unknown>) => m.id === id;

function fakeLink(over: Partial<DaemonLink> = {}): DaemonLink & { outbound_: string[] } {
  const outbound_: string[] = [];
  return {
    outbound_,
    poll: over.poll ?? (async () => new Promise(() => {})),
    outbound:
      over.outbound ??
      (async (text: string) => {
        outbound_.push(text);
      }),
    requestApproval: over.requestApproval ?? (async () => null),
  } as DaemonLink & { outbound_: string[] };
}

function start(link: DaemonLink) {
  const peer = new Peer();
  const server = createChannelServer({ link, input: peer.stdin, output: peer.out });
  server.start();
  return { peer, server };
}

describe('channel server handshake', () => {
  it('declares both channel capabilities and echoes the client protocol version', async () => {
    const { peer, server } = start(fakeLink());
    peer.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    const res = (await peer.waitFor(idIs(1))) as {
      result: {
        protocolVersion: string;
        capabilities: { experimental: Record<string, unknown>; tools: unknown };
        serverInfo: { name: string };
        instructions: string;
      };
    };
    expect(res.result.protocolVersion).toBe('2025-11-25');
    // Presence is what registers the listener; the docs say the value is always `{}`.
    expect(res.result.capabilities.experimental['claude/channel']).toEqual({});
    expect(res.result.capabilities.experimental['claude/channel/permission']).toEqual({});
    expect(res.result.capabilities.tools).toEqual({});
    expect(res.result.serverInfo.name).toBe('pagr');
    expect(res.result.instructions).toContain('<channel source="pagr"');
    server.stop();
  });

  it('offers exactly one tool, `reply`, taking a single `text`', async () => {
    const { peer, server } = start(fakeLink());
    peer.send({ id: 2, method: 'tools/list' });
    const res = (await peer.waitFor(idIs(2))) as {
      result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual(['reply']);
    expect(res.result.tools[0]?.inputSchema.required).toEqual(['text']);
    server.stop();
  });

  it('sends the reply text on to the daemon, truncated to an SMS-sized 1200 chars', async () => {
    const link = fakeLink();
    const { peer, server } = start(link);
    peer.send({
      id: 3,
      method: 'tools/call',
      params: { name: 'reply', arguments: { text: `  ${'x'.repeat(2000)}  ` } },
    });
    await peer.waitFor(idIs(3));
    expect(link.outbound_[0]).toHaveLength(1200);
    server.stop();
  });

  it('rejects an empty reply and an unknown tool without killing the session', async () => {
    const { peer, server } = start(fakeLink());
    peer.send({ id: 4, method: 'tools/call', params: { name: 'reply', arguments: { text: ' ' } } });
    peer.send({ id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    peer.send({ id: 6, method: 'who/knows' });
    expect((await peer.waitFor(idIs(4))).error).toBeDefined();
    expect((await peer.waitFor(idIs(5))).error).toBeDefined();
    expect((await peer.waitFor(idIs(6))).error).toMatchObject({ code: -32601 });
    server.stop();
  });

  it('reports a daemon that is down as a tool error, not a transport failure', async () => {
    const link = fakeLink({
      outbound: async () => {
        throw new Error('ENOENT /tmp/pagr.sock');
      },
    });
    const { peer, server } = start(link);
    peer.send({
      id: 7,
      method: 'tools/call',
      params: { name: 'reply', arguments: { text: 'hi' } },
    });
    const res = (await peer.waitFor(idIs(7))) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]?.text).toContain('ENOENT');
    server.stop();
  });

  it('survives a line that is not JSON, and a response it never asked for', async () => {
    const errors: string[] = [];
    const peer = new Peer();
    const server = createChannelServer({
      link: fakeLink(),
      input: peer.stdin,
      output: peer.out,
      onError: (m) => errors.push(m),
    });
    server.start();
    peer.stdin.write('not json at all\n');
    peer.send({ id: 99, result: {} });
    peer.send({ id: 8, method: 'tools/list' });
    await peer.waitFor(idIs(8));
    expect(errors.some((e) => e.includes('not JSON'))).toBe(true);
    server.stop();
  });
});

describe('channel notifications', () => {
  it('pushes one `notifications/claude/channel` per queued text, with identifier-safe meta', async () => {
    let served = false;
    const link = fakeLink({
      poll: async () => {
        if (served) return new Promise(() => {});
        served = true;
        return {
          cursor: 2,
          messages: [
            { seq: 1, text: 'rebase onto main', followupId: 'fu_0123456789abcdef' },
            { seq: 2, text: 'and run the tests' },
          ],
        };
      },
    });
    const { peer, server } = start(link);
    // Polling starts on `initialized`, exactly as Claude Code drives it.
    peer.send({ method: 'notifications/initialized' });
    await peer.waitFor(method('notifications/claude/channel'));
    const sent = peer.lines.filter(method('notifications/claude/channel')) as Array<{
      params: { content: string; meta: Record<string, string> };
    }>;
    expect(sent).toHaveLength(2);
    expect(sent[0]?.params.content).toBe('rebase onto main');
    // Keys must be identifiers — anything with a hyphen is silently dropped by Claude Code.
    expect(sent[0]?.params.meta).toEqual({
      origin: 'pagr',
      seq: '1',
      followup: 'fu_0123456789abcdef',
    });
    for (const key of Object.keys(sent[0]?.params.meta ?? {})) expect(key).toMatch(/^\w+$/);
    // No follow-up id (a message that is not a tracked delivery) carries no `followup` attribute.
    expect(sent[1]?.params.meta).toEqual({ origin: 'pagr', seq: '2' });
    server.stop();
  });

  it('does not poll until Claude Code says it is initialized', async () => {
    let polls = 0;
    const link = fakeLink({
      poll: async () => {
        polls++;
        return new Promise(() => {});
      },
    });
    const { peer, server } = start(link);
    peer.send({ id: 1, method: 'initialize', params: {} });
    await peer.waitFor(idIs(1));
    expect(polls).toBe(0);
    peer.send({ method: 'notifications/initialized' });
    await new Promise((r) => setTimeout(r, 10));
    expect(polls).toBe(1);
    server.stop();
  });
});

describe('permission relay', () => {
  const request = {
    method: 'notifications/claude/channel/permission_request',
    params: {
      request_id: 'ediwn',
      tool_name: 'Bash',
      description: 'Create empty file q6.txt',
      input_preview: '{ "command": "touch /tmp/q6.txt" }',
    },
  };

  it('answers with the phone’s verdict when there is one', async () => {
    const seen: string[] = [];
    const link = fakeLink({
      requestApproval: async (req) => {
        seen.push(req.request_id);
        return 'allow';
      },
    });
    const { peer, server } = start(link);
    peer.send(request);
    const verdict = (await peer.waitFor(method('notifications/claude/channel/permission'))) as {
      params: { request_id: string; behavior: string };
    };
    expect(seen).toEqual(['ediwn']);
    expect(verdict.params).toEqual({ request_id: 'ediwn', behavior: 'allow' });
    server.stop();
  });

  /**
   * The whole point of the relay: no decision means SILENCE, so the dialog in the terminal keeps
   * control. Inventing a `deny` would reject a call on the user's behalf that they never saw.
   */
  it('says nothing at all when no decision came back', async () => {
    const { peer, server } = start(fakeLink({ requestApproval: async () => null }));
    peer.send(request);
    peer.send({ id: 1, method: 'tools/list' });
    await peer.waitFor(idIs(1)); // ordering barrier: the relay was handled before this reply
    expect(peer.lines.filter(method('notifications/claude/channel/permission'))).toEqual([]);
    server.stop();
  });

  it('stays silent when the daemon throws, and reports why on stderr', async () => {
    const errors: string[] = [];
    const peer = new Peer();
    const server = createChannelServer({
      link: fakeLink({
        requestApproval: async () => {
          throw new Error('socket closed');
        },
      }),
      input: peer.stdin,
      output: peer.out,
      onError: (m) => errors.push(m),
    });
    server.start();
    peer.send(request);
    peer.send({ id: 1, method: 'tools/list' });
    await peer.waitFor(idIs(1));
    expect(peer.lines.filter(method('notifications/claude/channel/permission'))).toEqual([]);
    expect(errors.some((e) => e.includes('socket closed'))).toBe(true);
    server.stop();
  });

  it('ignores a malformed permission_request rather than guessing at it', async () => {
    let asked = 0;
    const errors: string[] = [];
    const peer = new Peer();
    const server = createChannelServer({
      link: fakeLink({
        requestApproval: async () => {
          asked++;
          return 'allow';
        },
      }),
      input: peer.stdin,
      output: peer.out,
      onError: (m) => errors.push(m),
    });
    server.start();
    peer.send({
      method: 'notifications/claude/channel/permission_request',
      params: { tool_name: 'Bash' },
    });
    peer.send({ id: 1, method: 'tools/list' });
    await peer.waitFor(idIs(1));
    expect(asked).toBe(0);
    expect(errors.some((e) => e.includes('request_id'))).toBe(true);
    server.stop();
  });
});
