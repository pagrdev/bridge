import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterEvent } from '@pagr/bridge-core';
import { ChannelBridge } from '@pagr/bridge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './adapter.js';
import {
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
  it('is off unless PAGR_CLAUDE_CHANNEL is exactly 1', () => {
    expect(channelModeEnabled({})).toBe(false);
    expect(channelModeEnabled({ [CHANNEL_FLAG_ENV]: 'true' })).toBe(false);
    expect(channelModeEnabled({ [CHANNEL_FLAG_ENV]: '1' })).toBe(true);
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

  it('probe reports approved-channel with live external messages', async () => {
    const adapter = build(true);
    const s = await adapter.probe();
    expect(s.mode).toBe('approved-channel');
    expect(s.capabilities.canReceiveLiveExternalMessages).toBe(true);
    expect(s.capabilities.canSteerActiveTurn).toBe(true);
    expect(s.detail).toContain('dangerously-load-development-channels');
    expect(s.detail).toContain(CHANNEL_PROBE_DETAIL);
    await adapter.shutdown();
  });

  it('probe stays cli-hooks with the flag off (ADR 0001 default)', async () => {
    const adapter = build(false);
    const s = await adapter.probe();
    expect(s.mode).toBe('cli-hooks');
    expect(s.capabilities.canReceiveLiveExternalMessages).toBe(false);
    expect(s.capabilities.canSteerActiveTurn).toBe(false);
    await adapter.shutdown();
  });

  it('steers an attached session by enqueueing for the channel, not spawning claude', async () => {
    const adapter = build(true);
    bridge.attach(project);
    bridge.bindSession(SES, { cwd: project, projectId: PROJ });
    const res = await adapter.sendInstruction({
      sessionId: SES,
      instruction: 'switch to the other branch',
      mode: 'steer',
      localImagePaths: [],
    });
    expect(res).toEqual({ delivered: 'steered' });
    const polled = await bridge.poll(project, 0, 0);
    expect(polled.messages.map((m) => m.text)).toEqual(['switch to the other branch']);
    expect(events.some((e) => e.kind === 'session_event' && e.type === 'followup_delivered')).toBe(
      true,
    );
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

  it('queues instead of steering when the flag is off, even with a live channel', async () => {
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
  it('turns channel mode on from the environment', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pagr-chanenv-'));
    try {
      const on = createClaudeAdapter({
        home,
        claudeCommand: ['node', FIXTURE],
        processEnv: { [CHANNEL_FLAG_ENV]: '1' },
      });
      expect((await on.probe()).mode).toBe('approved-channel');
      await on.shutdown();
      const off = createClaudeAdapter({
        home,
        claudeCommand: ['node', FIXTURE],
        processEnv: {},
      });
      expect((await off.probe()).mode).toBe('cli-hooks');
      await off.shutdown();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
