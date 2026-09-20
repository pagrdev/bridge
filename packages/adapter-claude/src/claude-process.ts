import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { FileLogger } from './logger.js';
import {
  controlResponseLine,
  legacyEvent,
  parseStreamRecord,
  type StreamEvent,
  type StreamRecord,
  userMessageLine,
} from './stream-json.js';

export interface ClaudeProcessOptions {
  /** Base command, default `['claude']`; tests pass `['node', fixture]`. */
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** New session: `--session-id`; resumed: `--resume`. */
  session: { kind: 'new'; id: string } | { kind: 'resume'; id: string };
  readOnly: boolean;
  /** Overrides whichever list the mode below would pick; see `PAGR_CLAUDE_SETTING_SOURCES`. */
  settingSources?: string;
  /** Opt-in sealed mode for untrusted checkouts; see `SEALED_SETTING_SOURCES`. */
  sealed?: boolean;
  /**
   * `--allowedTools`: the permission rules this process may use WITHOUT raising a prompt.
   *
   * Only a headless one-shot run passes it (`run-once.ts`). A session started for a person
   * passes nothing, because the person's own settings and their own answers decide what that
   * session may do — narrowing a conversation to a fixed list would mean every ordinary tool
   * call raised a prompt on their phone.
   *
   * It is an ALLOW list, not a restriction: a tool outside it still raises a `can_use_tool`
   * prompt rather than being refused outright. What makes it a boundary for a one-shot run is
   * that the run auto-denies every prompt it is asked.
   */
  allowedTools?: string[];
  logger: FileLogger;
}

/**
 * Setting sources a bridge-spawned session loads (`--setting-sources`).
 *
 * All three, which is what the person's own `claude` loads. Pagr does not get to pick which of
 * someone's Claude Code settings count: a project's `.claude/settings.json` is a file their team
 * wrote and they chose to check out, and a session the bridge starts in that project should
 * behave the way the same session started in their terminal does. Overriding it meant a bridge
 * session silently ignored permission rules, hooks and tool settings that worked everywhere else.
 *
 * The cost is real and is not hidden: see `SEALED_SETTING_SOURCES` and docs/SECURITY.md.
 */
export const DEFAULT_SETTING_SOURCES = 'user,project,local';

/**
 * Sealed mode (`PAGR_CLAUDE_SEALED=1`): what to load in a checkout you do not trust.
 *
 * `project` is dropped, so the repository's own `.claude/settings.json` cannot ship
 * `permissions.allow: ["Bash(*)"]`, or a PreToolUse hook that returns `allow`, and have a
 * bridge-started session act on it with no prompt ever raised. `--strict-mcp-config` rides the
 * same switch, because a repo that cannot grant itself a permission through `settings.json`
 * should not be able to hand itself a tool through `.mcp.json` either — they are the same attack
 * with two filenames, so they are one setting.
 *
 * `local` (`.claude/settings.local.json`) is kept: it is where a person puts their own
 * per-checkout settings and it is gitignored by convention. It still lives inside the project
 * directory, so a repo that commits one anyway can grant permissions to a session started in it —
 * set `PAGR_CLAUDE_SETTING_SOURCES=user` to drop that too.
 */
export const SEALED_SETTING_SOURCES = 'user,local';

export const SEALED_MODE_ENV = 'PAGR_CLAUDE_SEALED';

/** Sealed mode is off unless the operator set `PAGR_CLAUDE_SEALED=1`. */
export function sealedModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SEALED_MODE_ENV] === '1';
}

/**
 * Tools a read-only session may not use.
 *
 * `Bash` is the one that matters. Without it in this list a "read-only" session could still
 * `sed -i`, `tee`, `> file` or `git checkout` its way to a write — while `concurrency.ts` recorded
 * it as `writeCapable: false` and happily let a second write-capable session into the same
 * checkout, which is the race the one-writer guard exists to prevent. `Task`/`Agent` go too,
 * because a subagent is a fresh tool budget; `BashOutput`/`KillShell` are Bash's companions.
 *
 * `MultiEdit` is not a tool name Claude Code 2.1.220 knows (it warns, harmlessly, on stderr) but
 * is kept for older installs where it is one: a stale deny entry costs nothing, a missing one
 * costs a write.
 */
export const READ_ONLY_DISALLOWED_TOOLS =
  'Bash,BashOutput,KillShell,Edit,Write,MultiEdit,NotebookEdit,Task,Agent';

export interface ClaudeProcessEvents {
  /** The collapsed, one-per-line view every status listener has always read. */
  event: [StreamEvent];
  /**
   * The same line with nothing collapsed — every content block, and the `tool_use_result` sidecar.
   *
   * Emitted after `event` for the same line, so a listener of both sees the summary it has always
   * seen before the frames that elaborate on it. Parsed once; the two are two views, not two reads.
   */
  record: [StreamRecord];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
}

/**
 * One long-lived `claude -p` child per session, driven over stdin/stdout with
 * `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`.
 *
 * Flags re-verified 2026-09-14 against Claude Code 2.1.220 (`claude --help`, plus running each
 * one): -p/--print, --input-format stream-json, --output-format stream-json, --verbose,
 * --session-id <uuid>, --resume <id>, --permission-mode default, --permission-prompt-tool stdio,
 * --disallowedTools, --setting-sources <user,project,local>, --strict-mcp-config.
 *
 * Two of these are not in `--help` on 2.1.220 and were confirmed by invocation instead:
 * `--permission-prompt-tool` is undocumented but accepted, and `--permission-mode default` is
 * accepted even though `--help` lists only acceptEdits/auto/bypassPermissions/manual/dontAsk/plan
 * (an unrecognised value is a hard argument error, so this is a real, still-supported alias).
 *
 * The process keeps running after each `result` until stdin is closed, so follow-up user messages
 * reuse the same process (no re-spawn needed while it is alive).
 */
export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private child: ChildProcess | null = null;
  private buf = '';
  private stderrTail = '';
  private exited = false;

  constructor(private readonly opts: ClaudeProcessOptions) {
    super();
  }

  get alive(): boolean {
    return this.child !== null && !this.exited;
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    const [bin, ...rest] = this.opts.command;
    if (!bin) throw new Error('claude command is empty');
    const sealed = this.opts.sealed ?? false;
    const args = [
      ...rest,
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
      '--permission-prompt-tool',
      'stdio',
      // Their configuration, not ours — unless they asked for sealed mode, which drops the
      // project's own settings and its MCP servers together (see SEALED_SETTING_SOURCES).
      '--setting-sources',
      this.opts.settingSources ?? (sealed ? SEALED_SETTING_SOURCES : DEFAULT_SETTING_SOURCES),
    ];
    // With no `--mcp-config` alongside it, this leaves a sealed session with no MCP servers at
    // all. Outside sealed mode the person's own servers load exactly as they do in their terminal.
    if (sealed) args.push('--strict-mcp-config');
    if (this.opts.session.kind === 'new') args.push('--session-id', this.opts.session.id);
    else args.push('--resume', this.opts.session.id);
    // Both tool flags are variadic. `--allowedTools` is safe here because the next argument is
    // either `--disallowedTools` (a flag, which ends it) or nothing at all.
    if (this.opts.allowedTools?.length) args.push('--allowedTools', ...this.opts.allowedTools);
    // `--disallowedTools` is variadic, so it stays last: anything after it would be swallowed.
    if (this.opts.readOnly) args.push('--disallowedTools', READ_ONLY_DISALLOWED_TOOLS);

    const child = spawn(bin, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.opts.logger.log('info', 'claude spawned', {
      pid: child.pid ?? null,
      session: this.opts.session,
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.buf += chunk;
      let i = this.buf.indexOf('\n');
      while (i >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const record = parseStreamRecord(line);
        if (record.type !== 'invalid') {
          this.emit('event', legacyEvent(record));
          this.emit('record', record);
        }
        i = this.buf.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on('error', (err) => {
      this.opts.logger.log('error', 'claude spawn error', { message: err.message });
      if (!this.exited) {
        this.exited = true;
        this.emit('exit', { code: null, signal: null });
      }
    });
    child.on('exit', (code, signal) => {
      if (this.exited) return;
      this.exited = true;
      this.opts.logger.log(code === 0 ? 'info' : 'warn', 'claude exited', {
        code,
        signal,
        stderr: code === 0 ? undefined : this.stderrTail.slice(-500),
      });
      this.emit('exit', { code, signal });
    });
  }

  get lastStderr(): string {
    return this.stderrTail;
  }

  sendUser(text: string): void {
    this.write(userMessageLine(text));
  }

  answerPermission(
    requestId: string,
    decision:
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string },
  ): void {
    this.write(controlResponseLine(requestId, decision));
  }

  private write(line: string): void {
    if (!this.alive || !this.child?.stdin?.writable) throw new Error('claude process not running');
    this.child.stdin.write(line);
  }

  /** SIGINT ends the current turn; escalate to SIGTERM then SIGKILL if it lingers. */
  async stop(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t1);
        clearTimeout(t2);
        resolve();
      };
      child.once('exit', done);
      try {
        child.kill('SIGINT');
      } catch {
        /* already gone */
      }
      const t1 = setTimeout(() => child.kill('SIGTERM'), graceMs);
      const t2 = setTimeout(() => {
        child.kill('SIGKILL');
        done();
      }, graceMs + 2000);
      t1.unref();
      t2.unref();
    });
  }

  /** Close stdin so an idle process exits cleanly. */
  end(): void {
    this.child?.stdin?.end();
  }
}
