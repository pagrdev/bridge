import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AdapterEvent,
  FrameBody,
  JournalMeta,
  MirrorBridge,
  MirrorProject,
  MirrorStatus,
  SessionSummaryV2,
} from '@pagr/bridge-core';
import { getMirrorBridge, MIRROR_ENV, MIRROR_UNREGISTERED_ENV } from '@pagr/bridge-core';
import type { ControlLevel, SessionOrigin, SessionStatus } from '@pagr/protocol';
import type { ChannelMode } from '../channel-mode.js';
import {
  asToolUseResult,
  type ClaudeToolUseResult,
  diffBodyFor,
  EDIT_TOOLS,
  terminalBodyFor,
} from '../diffs.js';
import {
  type AssistantBlock,
  actionTypeForTool,
  blockFrameId,
  mapToolKind,
  previewForTool,
  type UserBlock,
} from '../stream-json.js';
import { type ClaudeProcessInfo, ClaudeProcessWatch, type DiscoveryEvent } from './discovery.js';
import { readSpilledOutput, type TranscriptRecord, UnknownRecordTypes } from './records.js';
import { type TailedRecord, TailerStateStore, TranscriptTailer } from './tailer.js';

/**
 * Mirroring the Claude Code sessions you started yourself.
 *
 * Pagr's own sessions arrive over a pipe the bridge opened. A session you started in your own
 * terminal — or in your IDE's Claude panel — has no pipe, so this module reads what Claude writes
 * down anyway: `~/.claude/sessions/<pid>.json` says a session exists and where, and
 * `~/.claude/projects/<encoded cwd>/<session>.jsonl` says what it is doing. Discovery finds them,
 * the tailer follows them, and the frames they produce are the same frames, in the same shapes,
 * through the same emitters as the stdio path — a phone cannot tell them apart, and should not.
 *
 * What it will not do is overclaim. Three things are true of a mirrored session and all three are
 * reported rather than papered over:
 *
 *   - **Control is not full.** Reading a transcript does not let Pagr take the turn. A terminal
 *     session is `approvals_only` when the permission hook is installed and its directory is a
 *     registered project (the hook can relay its prompts), `mirror_only` when it is registered and
 *     the hook is not, and `full` only when a Pagr channel is actually bound to that Claude
 *     session id — which is opt-in through `pagr claude` and is B8's to finish.
 *   - **An unregistered directory is still a session.** It is reported with
 *     `projectStatus: 'unregistered'`, control `none` and NO frames — nothing of what happens in a
 *     folder you have not registered is journaled or sealed — plus a `repoHandle`, so one tap on
 *     the phone registers the folder and the frames start.
 *   - **A session Pagr started is not mirrored twice.** When the live adapter already owns that
 *     Claude session id, the tailer stays out of it: the stdio reader has the same records first,
 *     with the same `providerRecordId`s, and spilled command output with them.
 */

const enabled = (env: NodeJS.ProcessEnv, key: string): boolean => env[key] !== '0';

/** `claude` (or nothing at all) is a terminal; anything else is a host that embeds it. */
export function originOf(entrypoint: string | undefined): SessionOrigin {
  if (!entrypoint) return 'terminal';
  return entrypoint === 'claude' || entrypoint === 'cli' ? 'terminal' : 'ide';
}

export interface ClaudeMirrorOptions {
  /** `$HOME` holding `.claude`. Tests point this at a temp directory; never the real one. */
  home: string;
  /** `PAGR_HOME`, where `tailer-state.json` lives. Null keeps the state in memory (tests). */
  pagrHome: string | null;
  /** The adapter's own emitter: mirrored frames travel the path every other frame travels. */
  emit: (e: AdapterEvent) => void;
  /** True when a live adapter session already owns that Claude session id. */
  ownsClaudeSession?: (claudeSessionId: string) => boolean;
  /** Whether the Claude permission hook is installed for this user. */
  hookInstalled?: () => boolean;
  /** Channel bindings (ADR 0001 `approved-channel`). Null when channel mode is off. */
  channel?: ChannelMode | null;
  bridge?: MirrorBridge;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;
  /** Test seams. */
  isAlive?: (pid: number) => boolean;
  discoveryPollMs?: number;
  tailPollMs?: number;
  refreshMs?: number;
  orphans?: boolean;
}

interface MirroredSession {
  claudeSessionId: string;
  /** `syntheticSessionId('claude', claudeSessionId)` — the same id the permission hook adopts. */
  sessionId: string;
  info: ClaudeProcessInfo;
  project: MirrorProject;
  controlLevel: ControlLevel;
  origin: SessionOrigin;
  tailer: TranscriptTailer | null;
  startedAt: string;
  updatedAt: string;
  /** `tool_use_id` → the call, so a result can be turned into the right kind of frame. */
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>;
}

/** Tool calls one mirrored session remembers while waiting for their results. */
export const MAX_MIRROR_TOOL_CALLS = 512;
/** How often control levels and project registration are re-evaluated. */
export const DEFAULT_REFRESH_MS = 5000;
/**
 * How often a mirrored session is restated even when nothing about it changed.
 *
 * The daemon ages adopted sessions out of `sessions.json` after a day without news, which is right
 * for a terminal somebody closed and wrong for one that has been sitting open since yesterday
 * morning. An hourly restatement is enough to keep such a session real on both sides and far too
 * rare to be noise.
 */
export const SESSION_HEARTBEAT_MS = 60 * 60_000;

export class ClaudeMirror {
  private readonly env: NodeJS.ProcessEnv;
  private readonly bridge: MirrorBridge;
  private readonly now: () => Date;
  private readonly state: TailerStateStore;
  private readonly watch: ClaudeProcessWatch;
  private readonly sessions = new Map<string, MirroredSession>();
  private readonly unknownTypes = new UnknownRecordTypes();
  private refreshTimer: NodeJS.Timeout | null = null;
  private lastFrameAt: string | null = null;
  private started = false;
  /** One-time setup deferred until the bridge is wired (see `live`). */
  private swept = false;

  constructor(private readonly o: ClaudeMirrorOptions) {
    this.env = o.env ?? process.env;
    this.bridge = o.bridge ?? getMirrorBridge();
    this.now = o.now ?? (() => new Date());
    this.state = new TailerStateStore(
      o.pagrHome ? path.join(o.pagrHome, 'tailer-state.json') : null,
    );
    this.watch = new ClaudeProcessWatch({
      home: o.home,
      onEvent: (e) => this.onDiscovery(e),
      ...(o.isAlive ? { isAlive: o.isAlive } : {}),
      ...(o.discoveryPollMs !== undefined ? { pollMs: o.discoveryPollMs } : {}),
      ...(o.orphans !== undefined ? { orphans: o.orphans } : {}),
      now: () => this.now().getTime(),
    });
  }

  get enabled(): boolean {
    return enabled(this.env, MIRROR_ENV);
  }

  /** On, and something has told it what the projects on this Mac are. */
  private get live(): boolean {
    return this.started && this.enabled && this.bridge.wired;
  }

  /** Whether a session outside every registered project is reported at all. */
  get reportsUnregistered(): boolean {
    return enabled(this.env, MIRROR_UNREGISTERED_ENV);
  }

  start(): void {
    if (this.started || !this.enabled) return;
    this.started = true;
    // The discovery watch is driven from this timer rather than its own, so that a mirror waiting
    // for the daemon to wire the bridge is genuinely idle — no watches, no directory reads.
    this.refreshTimer = setInterval(() => this.tick(), this.o.refreshMs ?? DEFAULT_REFRESH_MS);
    this.refreshTimer.unref?.();
    this.report();
  }

  stop(): void {
    this.started = false;
    this.swept = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.watch.stop();
    for (const s of this.sessions.values()) s.tailer?.stop();
    this.sessions.clear();
    this.state.flush();
    this.report();
  }

  /** Force one discovery pass and one read of every transcript. Tests drive the mirror with it. */
  tick(): void {
    if (!this.live) return;
    if (!this.swept) {
      this.swept = true;
      this.state.sweep();
      this.watch.start();
    }
    this.watch.poll();
    for (const s of this.sessions.values()) s.tailer?.poll();
    this.refresh();
  }

  status(): MirrorStatus {
    let filesWatched = 0;
    for (const s of this.sessions.values()) filesWatched += s.tailer?.watchedFiles.length ?? 0;
    return {
      enabled: this.enabled,
      sessions: this.sessions.size,
      filesWatched,
      lastFrameAt: this.lastFrameAt,
      unknownRecordTypes: this.unknownTypes.size,
    };
  }

  // ---------- discovery ----------

  private onDiscovery(e: DiscoveryEvent): void {
    if (e.kind === 'ended') {
      this.end(e.sessionId);
      return;
    }
    const info = e.session;
    // A session Pagr started reaches the dispatcher over its own pipe, with the same record ids.
    // Tailing it as well would be work done twice for frames the journal would throw away.
    if (this.o.ownsClaudeSession?.(info.sessionId)) return;
    const project = this.bridge.projectFor(info.cwd);
    if (!project) return;
    if (project.status === 'unregistered' && !this.reportsUnregistered) return;

    const existing = this.sessions.get(info.sessionId);
    if (existing) {
      existing.info = info;
      existing.project = project;
      this.applyControl(existing);
      return;
    }
    const ts = this.now().toISOString();
    const s: MirroredSession = {
      claudeSessionId: info.sessionId,
      sessionId: syntheticClaudeSessionId(info.sessionId),
      info,
      project,
      controlLevel: 'none',
      origin: originOf(info.entrypoint),
      tailer: null,
      startedAt: ts,
      updatedAt: ts,
      toolCalls: new Map(),
    };
    this.sessions.set(info.sessionId, s);
    this.o.log?.('info', 'mirroring a Claude session this bridge did not start', {
      sessionId: s.sessionId,
      origin: s.origin,
      projectStatus: project.status,
    });
    this.applyControl(s, { force: true });
  }

  private end(claudeSessionId: string): void {
    const s = this.sessions.get(claudeSessionId);
    if (!s) return;
    s.tailer?.stop();
    this.sessions.delete(claudeSessionId);
    s.updatedAt = this.now().toISOString();
    this.emitSession(s, 'stopped');
    this.report();
  }

  /**
   * Re-evaluate every session's project and control level.
   *
   * This is what makes the one-tap path work: registering the folder from the phone changes the
   * answer `projectFor` gives, and the next refresh notices, starts the tailer and tells the phone
   * the session is now `approvals_only` — without anybody restarting anything.
   */
  private refresh(): void {
    for (const s of [...this.sessions.values()]) {
      const project = this.bridge.projectFor(s.info.cwd);
      if (!project) continue;
      const changedProject =
        project.projectId !== s.project.projectId || project.status !== s.project.status;
      s.project = project;
      const stale = this.now().getTime() - Date.parse(s.updatedAt) >= SESSION_HEARTBEAT_MS;
      this.applyControl(s, { force: changedProject || stale });
    }
    this.report();
  }

  /** Work out what Pagr may do with this session, and tell the phone when the answer changes. */
  private applyControl(s: MirroredSession, opts: { force?: boolean } = {}): void {
    const level = this.controlLevelFor(s);
    const changed = level !== s.controlLevel;
    s.controlLevel = level;
    if (level === 'none') {
      // Nothing inside an unregistered directory is read, journaled or sealed.
      s.tailer?.stop();
      s.tailer = null;
    } else if (!s.tailer) {
      s.tailer = new TranscriptTailer({
        home: this.o.home,
        cwd: s.info.cwd,
        claudeSessionId: s.claudeSessionId,
        state: this.state,
        onRecord: (t) => this.onTailed(s, t),
        onError: (err, file) =>
          this.o.log?.('warn', 'could not read a Claude transcript', {
            error: err.message,
            file: path.basename(file),
          }),
        ...(this.o.tailPollMs !== undefined ? { pollMs: this.o.tailPollMs } : {}),
      });
      s.tailer.start();
    }
    if (changed || opts.force) {
      s.updatedAt = this.now().toISOString();
      this.emitSession(s, 'idle');
    }
  }

  /**
   * `full` → `approvals_only` → `mirror_only` → `none`, in the order the facts settle it.
   *
   * A bound channel is the only thing that makes a session Pagr did not start steerable, so it is
   * checked first. Failing that, the hook can relay the session's permission prompts, but only for
   * a directory that is a registered project — the hook maps a cwd to a project and has nowhere to
   * send a prompt without one. Registered with no hook is `mirror_only`: the phone can watch and
   * can do nothing else, which is exactly what is true. Unregistered is `none`.
   */
  private controlLevelFor(s: MirroredSession): ControlLevel {
    if (s.project.status === 'unregistered') return 'none';
    const bound = this.o.channel?.resolve(s.sessionId, {
      cwd: s.project.path,
      projectId: s.project.projectId,
    });
    if (bound) return 'full';
    return this.o.hookInstalled?.() ? 'approvals_only' : 'mirror_only';
  }

  private emitSession(s: MirroredSession, status: SessionStatus): void {
    const session: SessionSummaryV2 = {
      sessionId: s.sessionId,
      projectId: s.project.projectId,
      provider: 'claude',
      // Deliberately never `working`. A transcript says what Claude has written, not whether it is
      // mid-turn, and a session stuck on a live status would hold its working tree against every
      // future Pagr session and hold this Mac awake for as long as the terminal stayed open. The
      // frames are the liveness signal; the status stays the one the bridge can stand behind.
      status,
      activeTurn: false,
      displayName: s.info.name?.trim() || s.project.displayName,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      ...(status === 'stopped' ? { endedAt: s.updatedAt } : {}),
      controlLevel: s.controlLevel,
      origin: s.origin,
      projectStatus: s.project.status,
      ...(s.project.handle ? { repoHandle: s.project.handle } : {}),
    };
    this.o.emit({ kind: 'session', session, adopted: true, localCwd: s.info.cwd });
  }

  private report(): void {
    this.bridge.report(this.status());
  }

  // ---------- frames ----------

  private onTailed(s: MirroredSession, t: TailedRecord): void {
    if (s.controlLevel === 'none') return;
    const rec = t.record;
    // Claude's own bookkeeping — command echoes, hook output, the lines it shows you and never
    // sent to the model. Real, and not a transcript of the work.
    if (rec.isMeta || rec.isVisibleInTranscriptOnly) return;
    switch (rec.body.kind) {
      case 'assistant':
        this.onAssistant(s, rec, rec.body.blocks, t);
        return;
      case 'user':
        this.onUser(s, rec, rec.body.blocks, rec.body.toolUseResult, t);
        return;
      case 'summary':
        if (!rec.isCompactSummary || !rec.body.summary.trim()) return;
        this.frame(
          s,
          { kind: 'system', subtype: 'compact_summary', text: rec.body.summary },
          t,
          {},
          rec.uuid,
          rec.timestamp,
        );
        return;
      case 'unknown':
        if (this.unknownTypes.note(rec.type))
          this.o.log?.('info', 'unrecognised Claude transcript record; no frame made for it', {
            recordType: rec.type,
          });
        return;
      default:
        return;
    }
  }

  private onAssistant(
    s: MirroredSession,
    rec: TranscriptRecord,
    blocks: AssistantBlock[],
    t: TailedRecord,
  ): void {
    blocks.forEach((b, i) => {
      const id = blockFrameId(rec.uuid, i);
      switch (b.type) {
        case 'thinking':
          if (!b.text.trim()) return;
          this.frame(s, { kind: 'thinking', text: b.text }, t, {}, id, rec.timestamp);
          return;
        case 'text':
          if (!b.text.trim()) return;
          this.frame(s, { kind: 'assistant', text: b.text }, t, {}, id, rec.timestamp);
          return;
        case 'tool_use':
          this.rememberCall(s, b.toolUseId, { name: b.name, input: b.input });
          this.frame(
            s,
            {
              kind: 'tool_call',
              toolCallId: b.toolUseId,
              toolName: b.name,
              // `AskUserQuestion` included: B7 owns turning one into a question event, and until
              // then it is an ordinary tool call with an honest `other` kind, exactly as the
              // stdio path reports it.
              toolKind: mapToolKind(b.name),
              title: previewForTool(b.name, b.input, s.project.path),
              input: b.input,
            },
            t,
            { parentFrameId: b.toolUseId, actionType: actionTypeForTool(b.name) },
            b.toolUseId,
            rec.timestamp,
          );
          return;
        default:
          return;
      }
    });
  }

  private onUser(
    s: MirroredSession,
    rec: TranscriptRecord,
    blocks: UserBlock[],
    toolUseResult: unknown,
    t: TailedRecord,
  ): void {
    const results = blocks.filter((b) => b.type === 'tool_result');
    // `toolUseResult` describes THE tool call the line carries. On a line with two results there
    // is no way to say which one it belongs to, so it belongs to neither.
    const sidecar = results.length === 1 ? asToolUseResult(toolUseResult) : null;
    const images = blocks.filter((b) => b.type === 'image').length;
    blocks.forEach((b, i) => {
      const id = blockFrameId(rec.uuid, i);
      if (b.type === 'text') {
        // What the person typed. On the stdio path the bridge already knows, because it sent it;
        // here it is the only record of the half of the conversation Pagr did not write.
        if (!b.text.trim()) return;
        this.frame(
          s,
          { kind: 'user', text: b.text, ...(images ? { images } : {}) },
          t,
          {},
          id,
          rec.timestamp,
        );
        return;
      }
      if (b.type !== 'tool_result') return;
      this.frame(
        s,
        { kind: 'tool_result', toolCallId: b.toolUseId, content: b.content, isError: b.isError },
        t,
        { parentFrameId: b.toolUseId, status: b.isError ? 'error' : 'ok' },
        `${b.toolUseId}:result`,
        rec.timestamp,
      );
      const call = s.toolCalls.get(b.toolUseId);
      if (!call) return;
      if (call.name === 'Bash') this.emitTerminal(s, b, call.input, sidecar, t, rec.timestamp);
      else if (EDIT_TOOLS.has(call.name)) {
        const body = diffBodyFor({ toolName: call.name, input: call.input, result: sidecar });
        if (body)
          this.frame(
            s,
            body,
            t,
            { parentFrameId: b.toolUseId },
            `${b.toolUseId}:diff`,
            rec.timestamp,
          );
      }
    });
  }

  private emitTerminal(
    s: MirroredSession,
    res: Extract<UserBlock, { type: 'tool_result' }>,
    input: Record<string, unknown>,
    sidecar: ClaudeToolUseResult | null,
    t: TailedRecord,
    at?: string,
  ): void {
    const spillPath = sidecar?.persistedOutputPath;
    const spilled =
      typeof spillPath === 'string' ? readSpilledOutput(spillPath, this.o.home) : null;
    const body = terminalBodyFor({
      command: typeof input.command === 'string' ? input.command : '',
      content: res.content,
      isError: res.isError,
      result: sidecar,
      spilled,
    });
    this.frame(
      s,
      body,
      t,
      {
        parentFrameId: res.toolUseId,
        status: body.interrupted ? 'interrupted' : res.isError ? 'error' : 'ok',
      },
      `${res.toolUseId}:terminal`,
      at,
    );
  }

  private rememberCall(
    s: MirroredSession,
    id: string,
    call: { name: string; input: Record<string, unknown> },
  ): void {
    if (!id) return;
    s.toolCalls.set(id, call);
    while (s.toolCalls.size > MAX_MIRROR_TOOL_CALLS) {
      const oldest = s.toolCalls.keys().next();
      if (oldest.done) break;
      s.toolCalls.delete(oldest.value);
    }
  }

  private frame(
    s: MirroredSession,
    body: FrameBody,
    t: TailedRecord,
    meta: Omit<Partial<JournalMeta>, 'source'>,
    providerRecordId?: string,
    at?: string,
  ): void {
    const subagent = t.subagent;
    // A subagent's frames hang off the `Task` call that spawned it, so the phone can fold the
    // whole side-thread under the one line that started it.
    const parentFrameId = meta.parentFrameId ?? t.parentFrameId;
    this.o.emit({
      kind: 'frame',
      sessionId: s.sessionId,
      projectId: s.project.projectId,
      body,
      meta: {
        ...meta,
        ...(parentFrameId ? { parentFrameId } : {}),
        ...(subagent ? { subagent } : {}),
        source: 'transcript',
      },
      ...(providerRecordId ? { providerRecordId: scoped(providerRecordId, subagent) } : {}),
      ...(at ? { at } : {}),
    });
    this.lastFrameAt = this.now().toISOString();
  }
}

/**
 * A subagent's ids live in its own transcript, so they are scoped before they become a dedupe key.
 * Without it a `tool_use_id` reused across two subagents of one session would collide and the
 * second one's frames would be silently thrown away as duplicates.
 */
const scoped = (id: string, subagent?: { id: string }): string =>
  subagent ? `agent:${subagent.id}:${id}` : id;

/**
 * The same `ses_…` the daemon mints for a hook-adopted session (`syntheticSessionId` in
 * `@pagr/bridge-core`), so a session found by the permission hook and the same session found by
 * the mirror are ONE session on the phone rather than two cards for one terminal.
 *
 * Duplicated rather than imported because it is a wire-visible identity: if the daemon's minting
 * ever changes, this must fail a test rather than follow it silently.
 */
export function syntheticClaudeSessionId(claudeSessionId: string): string {
  // Kept in step with `packages/core/src/daemon.ts`; `mirror.test.ts` asserts the two agree.
  return `ses_${createHash('sha256').update(`claude:${claudeSessionId}`).digest('hex').slice(0, 32)}`;
}
