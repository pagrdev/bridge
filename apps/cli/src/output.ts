import pc from 'picocolors';
import type { CliContext } from './context.js';

export const ok = (s: string) => `${pc.green('✓')} ${s}`;
export const bad = (s: string) => `${pc.red('✗')} ${s}`;
export const warn = (s: string) => `${pc.yellow('!')} ${s}`;
export const dim = (s: string) => pc.dim(s);
export const bold = (s: string) => pc.bold(s);
export const cyan = (s: string) => pc.cyan(s);

export const shortId = (id: string | undefined, keep = 8): string =>
  id ? `${id.slice(0, id.indexOf('_') + 1 + keep)}…` : '—';

/**
 * Human-facing progress. In `--json` mode stdout must carry the JSON document and NOTHING
 * else, so narration is diverted to stderr instead of being dropped.
 */
export function say(ctx: CliContext, line: string): void {
  if (ctx.json) ctx.err(line);
  else ctx.out(line);
}

/** `[2/6] Waiting for approval` — the spine of the first-run experience. */
export const step = (n: number, total: number, title: string): string =>
  `${pc.dim(`[${n}/${total}]`)} ${pc.bold(title)}`;

/** Left-aligned columns, no borders; wide content never wraps the terminal. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const widths: number[] = [];
  for (const r of all) {
    r.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visible(c));
    });
  }
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c + ' '.repeat((widths[i] ?? 0) - visible(c)))
      .join('  ')
      .trimEnd();
  const lines = all.map(fmt);
  if (header) lines[0] = pc.dim(lines[0] ?? '');
  return lines.join('\n');
}

/** Key/value block: `  key   value`. */
export function kv(pairs: Array<[string, string]>): string {
  return table(pairs.map(([k, v]) => [pc.dim(k), v]));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
const ANSI = /\x1b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, '').length;

export function printJson(ctx: CliContext, value: unknown): void {
  ctx.out(JSON.stringify(value, null, 2));
}

export interface Spinner {
  /** Change what the spinner says it is waiting for. */
  update(text: string): void;
  stop(final?: string): void;
}

/**
 * Minimal stderr spinner. Never touches stdout, so `--json` stays parseable. Without a TTY it
 * degrades to one line per distinct message — a log, not a flicker.
 */
export function spinner(ctx: CliContext, text: string): Spinner {
  let current = text;
  if (!ctx.isTTY) {
    ctx.err(`… ${current}`);
    return {
      update(next) {
        if (next === current) return;
        current = next;
        ctx.err(`… ${next}`);
      },
      stop: (final) => {
        if (final) ctx.err(final);
      },
    };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const tick = () =>
    process.stderr.write(`\r\x1b[2K${pc.cyan(frames[i++ % frames.length] ?? '')} ${current}`);
  tick();
  const timer = setInterval(tick, 80);
  timer.unref?.();
  return {
    update(next) {
      current = next;
    },
    stop(final) {
      clearInterval(timer);
      process.stderr.write(`\r\x1b[2K`);
      if (final) ctx.err(final);
    },
  };
}

/** `1m 05s` — used in the "waiting for approval" spinner so the wait feels bounded. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
