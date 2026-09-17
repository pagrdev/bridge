import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { ChannelBridge, getChannelBridge } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';
import {
  CHANNEL_ARMED_DETAIL,
  CHANNEL_FLAG_ENV,
  CHANNEL_PROBE_DETAIL,
  ChannelMode,
  channelModeEnabled,
} from './channel-mode.js';
import { createClaudeAdapter } from './index.js';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));
const SES = 'ses_00000000000000000000000000000001';
const PROJ = 'proj_0000000000000000000000000000000a';

describe('flag', () => {
  it('is on unless PAGR_CLAUDE_CHANNEL is exactly 0', () => {
    expect(channelModeEnabled({})).toBe(true);
    // `=1` was the old opt-in. It has to stay a no-op: a launchd plist installed before MOB-037
    // still carries it, and it must not mean anything different from the default.
    expect(channelModeEnabled({ [CHANNEL_FLAG_ENV]: '1' })).toBe(true);
    expect(channelModeEnabled({ [CHANNEL_FLAG_ENV]: 'true' })).toBe(true);
    expect(channelModeEnabled({ [CHANNEL_FLAG_ENV]: '0' })).toBe(false);
  });
});

describe('ChannelMode targeting', () => {
  it('resolves nothing until a channel has attached the project', () => {
    const bridge = new ChannelBridge();
    const mode = new ChannelMode(bridge);
    const fallback = { cwd: '/code/app', projectId: PROJ };
    expect(mode.resolve(SES, fallback)).toBeNull();
    bridge.attach('/code/app');
    expect(mode.resolve(SES, fallback)).toEqual(fallback);
  });

  it('prefers the daemon binding over what the adapter knows', () => {
    const bridge = new ChannelBridge();
    bridge.attach('/code/other');
    bridge.bindSession(SES, { cwd: '/code/other', projectId: 'prj_other' });
    const mode = new ChannelMode(bridge);
    expect(mode.resolve(SES, { cwd: '/code/app', projectId: PROJ })).toEqual({
      cwd: '/code/other',
      projectId: 'prj_other',
    });
  });

  it('ignores a stale binding whose project is no longer attached', () => {
    const bridge = new ChannelBridge();
    bridge.bindSession(SES, { cwd: '/code/gone', projectId: PROJ });
    expect(new ChannelMode(bridge).resolve(SES)).toBeNull();
  });
});

describe('ClaudeAdapter in channel mode', () => {
  let home: string;
  let project: string;
  let bridge: ChannelBridge;
  let events: AdapterEvent[];

  const build = (channel: boolean) => {
    const adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      channel,
      channelBridge: bridge,
      env: { FAKE_CLAUDE_ARGS_FILE: path.join(home, 'args.json') },
    });
    adapter.subscribe((e) => events.push(e));
    return adapter;
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-chan-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-chanproj-'));
    bridge = new ChannelBridge();
    events = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('probe reports approved-channel once a channel is actually attached', async () => {
    const adapter = build(true);
    bridge.attach(project);
    const s = await adapter.probe();
    expect(s.mode).toBe('approved-channel');
    expect(s.capabilities.canReceiveLiveExternalMessages).toBe(true);
    expect(s.capabilities.canQueueIntoActiveTurn).toBe(true);
    // Never `canSteerActiveTurn`: a channel event renders instantly and is acted on when the
    // running turn ends (spike MOB-045), which is a queue, not an interruption.
    expect(s.capabilities.canSteerActiveTurn).toBe(false);
    expect(s.detail).toContain(CHANNEL_PROBE_DETAIL);
    await adapter.shutdown();
  });

  it('does NOT claim a reachable channel while nothing is attached', async () => {
    const adapter = build(true);
    const s = await adapter.probe();
    // Accepting channels only means the daemon would answer one. Claiming the capability here
    // would tell the phone it can reach a terminal that is not running the channel server.
    expect(s.mode).toBe('cli-hooks');
    expect(s.capabilities.canQueueIntoActiveTurn).toBe(false);
    expect(s.capabilities.canReceiveLiveExternalMessages).toBe(false);
    expect(s.detail).toContain(CHANNEL_ARMED_DETAIL);
    expect(s.detail).toContain('pagr claude');
    await adapter.shutdown();
  });

  it('stops claiming a channel once it stops polling (TTL = two missed long polls)', async () => {
    let clock = 1_000_000;
    const ttlBridge = new ChannelBridge(() => clock, 1000);
    const adapter = new ClaudeAdapter({
      home,
      claudeCommand: ['node', FIXTURE],
      channel: true,
      channelBridge: ttlBridge,
    });
    ttlBridge.attach(project);
    expect((await adapter.probe()).capabilities.canQueueIntoActiveTurn).toBe(true);
    clock += 2000;
    expect((await adapter.probe()).capabilities.canQueueIntoActiveTurn).toBe(false);
    await adapter.shutdown();
  });

  it('probe stays cli-hooks with the flag off (ADR 0001 default)', async () => {
    const adapter = build(false);
    const s = await adapter.probe();
    expect(s.mode).toBe('cli-hooks');
    expect(s.capabilities.canReceiveLiveExternalMessages).toBe(false);
    expect(s.capabilities.canQueueIntoActiveTurn).toBe(false);
    await adapter.shutdown();
  });

  it('delivers to an attached session by enqueueing for the channel, not spawning claude', async () => {
    const adapter = build(true);
    bridge.attach(project);
    bridge.bindSession(SES, { cwd: project, projectId: PROJ });
    const res = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'switch to the other branch',
      mode: 'steer',
      localImagePaths: [],
    });
    // `queued`, never `steered`: it lands at the next turn boundary, and the phone is shown it
    // moving queued → picked_up → delivered instead of being told the turn was interrupted.
    expect(res).toEqual({ delivered: 'queued' });
    const queued = events.find((e) => e.kind === 'frame' && e.meta?.delivery?.state === 'queued');
    if (queued?.kind !== 'frame') throw new Error('no queued delivery frame');
    const followupId = queued.meta?.delivery?.followupId;
    expect(followupId).toMatch(/^fu_[0-9a-f]{16}$/);
    const polled = await bridge.poll(project, 0, 0);
    expect(polled.messages.map((m) => m.text)).toEqual(['switch to the other branch']);
    expect(polled.messages[0]?.followupId).toBe(followupId);
    // The poll handed it out, so it is no longer merely queued.
    expect(
      events.some(
        (e) =>
          e.kind === 'frame' &&
          e.meta?.delivery?.state === 'picked_up' &&
          e.meta.delivery.followupId === followupId,
      ),
    ).toBe(true);
    await adapter.shutdown();
  });

  it('prefixes attachment paths in the steered text', async () => {
    const adapter = build(true);
    bridge.attach(project);
    bridge.bindSession(SES, { cwd: project, projectId: PROJ });
    await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'what is wrong here',
      mode: 'steer',
      localImagePaths: ['/tmp/shot.png'],
    });
    const polled = await bridge.poll(project, 0, 0);
    expect(polled.messages[0]?.text).toBe('See screenshot at /tmp/shot.png\n\nwhat is wrong here');
    await adapter.shutdown();
  });

  it('falls back to the cli-hooks path when nothing is attached', async () => {
    const adapter = build(true);
    await expect(
      adapter.sendInstruction({
        sessionId: SES,
        instruction: 'hello',
        mode: 'steer',
        localImagePaths: [],
      }),
      // No channel and no known session → the ordinary `unknown session` error, i.e. we did not
      // silently swallow the instruction into a queue nobody is reading.
    ).rejects.toThrow(/unknown session/);
    await adapter.shutdown();
  });

  it('ignores a live channel entirely when channel mode is off', async () => {
    const adapter = build(false);
    bridge.attach(project);
    bridge.bindSession(SES, { cwd: project, projectId: PROJ });
    await expect(
      adapter.sendInstruction({
        sessionId: SES,
        instruction: 'hello',
        mode: 'steer',
        localImagePaths: [],
      }),
    ).rejects.toThrow(/unknown session/);
    expect((await bridge.poll(project, 0, 0)).messages).toEqual([]);
    await adapter.shutdown();
  });
});

describe('createClaudeAdapter', () => {
  it('has channel mode on by default and off under PAGR_CLAUDE_CHANNEL=0', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-chanenv-'));
    try {
      const on = createClaudeAdapter({
        home,
        claudeCommand: ['node', FIXTURE],
        processEnv: {},
      });
      // Armed but nothing polling: the mode only flips once a channel is really there.
      expect((await on.probe()).detail).toContain(CHANNEL_ARMED_DETAIL);
      getChannelBridge().attach(home);
      expect((await on.probe()).mode).toBe('approved-channel');
      getChannelBridge().reset();
      await on.shutdown();
      const off = createClaudeAdapter({
        home,
        claudeCommand: ['node', FIXTURE],
        processEnv: { [CHANNEL_FLAG_ENV]: '0' },
      });
      expect((await off.probe()).mode).toBe('cli-hooks');
      await off.shutdown();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
