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

/** Minimal stderr spinner; prints a single line when not a TTY. */
export function spinner(ctx: CliContext, text: string): { stop(final?: string): void } {
  if (!ctx.isTTY) {
    ctx.err(`… ${text}`);
    return { stop: (final) => final && ctx.err(final) };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const tick = () =>
    process.stderr.write(`\r${pc.cyan(frames[i++ % frames.length] ?? '')} ${text}`);
  tick();
  const timer = setInterval(tick, 80);
  return {
    stop(final) {
      clearInterval(timer);
      process.stderr.write(`\r\x1b[2K`);
      if (final) ctx.err(final);
    },
  };
}
