import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { FileLogger } from './logger.js';
import {
  controlResponseLine,
  parseStreamLine,
  type StreamEvent,
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
  logger: FileLogger;
}

export interface ClaudeProcessEvents {
  event: [StreamEvent];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
}

/**
 * One long-lived `claude -p` child per session, driven over stdin/stdout with
 * `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio`.
 *
 * Flags verified 2026-08-24 against Claude Code 2.1.220 (`claude --help`, /docs/en/cli-reference):
 *   -p/--print, --input-format stream-json, --output-format stream-json, --verbose,
 *   --session-id <uuid>, --resume <id>, --permission-mode default, --permission-prompt-tool stdio,
 *   --disallowedTools. The process keeps running after each `result` until stdin is closed, so
 *   follow-up user messages reuse the same process (no re-spawn needed while it is alive).
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
    ];
    if (this.opts.session.kind === 'new') args.push('--session-id', this.opts.session.id);
    else args.push('--resume', this.opts.session.id);
    if (this.opts.readOnly) args.push('--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit');

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
        const ev = parseStreamLine(line);
        if (ev.type !== 'invalid') this.emit('event', ev);
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
