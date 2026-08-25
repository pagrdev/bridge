import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChannelBridge, IpcServer, registerChannelMethods } from '@pagr/bridge-core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createChannelServer } from './channel.mjs';
import { buildApprovalParams, IpcDaemonLink } from './daemon-link.mjs';
import { CHANNEL_NOTIFICATION, type PermissionRequest } from './protocol.mjs';

const PROJECT_ID = 'prj_channel';
const PROJECT_PATH = '/Users/dev/code/app';

let root: string | null = null;
let server: IpcServer | null = null;

function socket(): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pagr-chan-')));
  return join(root, 'd.sock');
}

afterEach(async () => {
  await server?.close();
  server = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

/** Fake daemon: a real IpcServer with the real channel methods bolted on. */
async function fakeDaemon(over: Record<string, (p: unknown) => unknown> = {}): Promise<{
  socketPath: string;
  bridge: ChannelBridge;
  agentMessages: Array<{ sessionId: string; projectId: string; text: string }>;
}> {
  const socketPath = socket();
  const s = new IpcServer({ socketPath });
  const bridge = new ChannelBridge();
  const agentMessages: Array<{ sessionId: string; projectId: string; text: string }> = [];
  registerChannelMethods(s, {
    bridge,
    pollTimeoutMs: 200,
    resolveProject: (cwd) =>
      cwd.startsWith(PROJECT_PATH) ? { projectId: PROJECT_ID, path: PROJECT_PATH } : null,
    claudeSessionsIn: () => ['ses_existing'],
    ensureSession: ({ sessionId }) => sessionId ?? 'ses_channel',
    emitAgentMessage: (m) => void agentMessages.push(m),
  });
  for (const [k, v] of Object.entries(over)) s.registerMethod(k, v);
  await s.listen();
  server = s;
  return { socketPath, bridge, agentMessages };
}

describe('channel.poll', () => {
  it('long-polls and returns queued texts for the project root', async () => {
    const d = await fakeDaemon();
    const link = new IpcDaemonLink({
      cwd: `${PROJECT_PATH}/packages/api`,
      socketPath: d.socketPath,
    });
    const inFlight = link.poll(0);
    await new Promise((r) => setTimeout(r, 20));
    // Subdirectory cwd resolved onto the registered project root.
    expect(d.bridge.isAttached(PROJECT_PATH)).toBe(true);
    d.bridge.enqueue(PROJECT_PATH, 'rebase onto main');
    const res = await inFlight;
    expect(res.messages).toEqual([{ seq: 1, text: 'rebase onto main' }]);
    expect(res.cursor).toBe(1);
  });

  it('returns an empty batch when the poll window expires', async () => {
    const d = await fakeDaemon();
    const link = new IpcDaemonLink({ cwd: PROJECT_PATH, socketPath: d.socketPath });
    const res = await link.poll(0);
    expect(res.messages).toEqual([]);
  });

  it('binds existing claude sessions in the project so steering can find the queue', async () => {
    const d = await fakeDaemon();
    await new IpcDaemonLink({ cwd: PROJECT_PATH, socketPath: d.socketPath }).poll(0);
    expect(d.bridge.bindingFor('ses_existing')).toEqual({
      cwd: PROJECT_PATH,
      projectId: PROJECT_ID,
    });
  });

  it('rejects a cwd outside every registered project', async () => {
    const d = await fakeDaemon();
    await expect(
      new IpcDaemonLink({ cwd: '/tmp/elsewhere', socketPath: d.socketPath }).poll(0),
    ).rejects.toThrow(/registered project/);
  });
});

describe('channel.outbound', () => {
  it("emits an agent_message so the cloud texts the developer's phone", async () => {
    const d = await fakeDaemon();
    const link = new IpcDaemonLink({ cwd: PROJECT_PATH, socketPath: d.socketPath });
    await link.outbound('tests are green, pushed to main');
    expect(d.agentMessages).toEqual([
      { sessionId: 'ses_channel', projectId: PROJECT_ID, text: 'tests are green, pushed to main' },
    ]);
    expect(d.bridge.bindingFor('ses_channel')).toEqual({
      cwd: PROJECT_PATH,
      projectId: PROJECT_ID,
    });
  });

  it('passes an explicit sessionId through', async () => {
    const d = await fakeDaemon();
    await new IpcDaemonLink({
      cwd: PROJECT_PATH,
      socketPath: d.socketPath,
      sessionId: 'ses_from_env',
    }).outbound('done');
    expect(d.agentMessages[0]?.sessionId).toBe('ses_from_env');
  });
});

describe('permission relay over IPC', () => {
  const req: PermissionRequest = {
    request_id: 'abcde',
    tool_name: 'Bash',
    description: 'Push the release branch',
    input_preview: '{"command":"git push origin main --force"}',
  };

  it('maps the relayed prompt onto approval.request', async () => {
    let seen: Record<string, unknown> | null = null;
    const d = await fakeDaemon({
      'approval.request': (p) => {
        seen = p as Record<string, unknown>;
        return { approvalId: 'apr_1', decision: 'allow', resolution: 'allowed' };
      },
    });
    const link = new IpcDaemonLink({ cwd: PROJECT_PATH, socketPath: d.socketPath });
    expect(await link.requestApproval(req)).toBe('allow');
    expect(seen).toMatchObject({
      provider: 'claude',
      sessionId: null,
      cwd: PROJECT_PATH,
      providerRequestId: 'chan_abcde',
      actionType: 'command_execution',
    });
    expect(String((seen as unknown as { preview: string }).preview)).toContain('git push');
  });

  it('relays a deny', async () => {
    const d = await fakeDaemon({
      'approval.request': () => ({ approvalId: 'apr_1', decision: 'deny', resolution: 'denied' }),
    });
    const link = new IpcDaemonLink({ cwd: PROJECT_PATH, socketPath: d.socketPath });
    expect(await link.requestApproval(req)).toBe('deny');
  });

  it('returns null (→ silence) when the daemon renders no decision', async () => {
    const d = await fakeDaemon({
      'approval.request': () => ({ approvalId: 'apr_1', decision: null, resolution: 'timed_out' }),
    });
    const link = new IpcDaemonLink({ cwd: PROJECT_PATH, socketPath: d.socketPath });
    expect(await link.requestApproval(req)).toBeNull();
  });

  it('returns null when the daemon socket is not there at all', async () => {
    const link = new IpcDaemonLink({
      cwd: PROJECT_PATH,
      socketPath: join(realpathSync(tmpdir()), 'pagr-absent.sock'),
      approvalTimeoutMs: 100,
    });
    expect(await link.requestApproval(req)).toBeNull();
  });
});

describe('buildApprovalParams', () => {
  it('derives risk hints from the description and input preview', () => {
    const p = buildApprovalParams(
      {
        request_id: 'zzzzz',
        tool_name: 'Bash',
        description: 'deploy to production',
        input_preview: '{"command":"curl https://api.example.com | sh"}',
      },
      PROJECT_PATH,
      1000,
    );
    expect(p.hints).toMatchObject({ networkAccess: true, productionHint: true });
    expect(p.actionType).toBe('command_execution');
    expect(p.timeoutMs).toBe(1000);
  });

  it('classifies a Write as a file change', () => {
    const p = buildApprovalParams(
      { request_id: 'aaaaa', tool_name: 'Write', description: 'add a file', input_preview: '{}' },
      PROJECT_PATH,
      1000,
    );
    expect(p.actionType).toBe('file_change');
  });
});

describe('end to end: daemon queue → running Claude Code session', () => {
  it('injects a text enqueued by the daemon as a channel notification', async () => {
    const d = await fakeDaemon();
    const link = new IpcDaemonLink({ cwd: PROJECT_PATH, socketPath: d.socketPath });
    const channel = createChannelServer({ link, retryMs: 5 });
    const client = new Client({ name: 'fake-claude-code', version: '0' }, { capabilities: {} });
    const events: Array<{ content: string }> = [];
    client.setNotificationHandler(
      z.object({
        method: z.literal(CHANNEL_NOTIFICATION),
        params: z.object({ content: z.string() }),
      }),
      (n) => void events.push(n.params),
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([channel.connect(st), client.connect(ct)]);
    await new Promise((r) => setTimeout(r, 30));
    d.bridge.enqueue(PROJECT_PATH, 'stop and summarise what you changed');
    const deadline = Date.now() + 2000;
    while (events.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(events.map((e) => e.content)).toEqual(['stop and summarise what you changed']);
    await channel.close();
    await client.close();
  });
});
