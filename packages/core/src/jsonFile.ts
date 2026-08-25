import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Read a JSON file, returning `fallback` when missing or unparsable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export type JsonFileProblemCode =
  /** The file exists but is not valid JSON (a truncated or hand-edited write). */
  | 'corrupt'
  /** Valid JSON, but not the shape this version expects. */
  | 'wrong_shape'
  /** The file could not be read at all (permissions). */
  | 'unreadable';

export interface JsonFileProblem {
  code: JsonFileProblemCode;
  file: string;
  message: string;
  hint: string;
}

/**
 * Read a JSON file and say WHY it fell back. `readJson` swallowing a corrupt `config.json`
 * turns "your pairing is damaged" into a silent "not paired", which is the single most
 * confusing state a user can land in.
 */
export function inspectJson<T>(file: string, fallback: T): { value: T; problem?: JsonFileProblem } {
  if (!existsSync(file)) return { value: fallback };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return {
      value: fallback,
      problem: {
        code: 'unreadable',
        file,
        message: `${file} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        hint: `fix its permissions (\`chmod 600 ${file}\`) or delete it and run \`pagr connect\``,
      },
    };
  }
  if (text.trim() === '') return { value: fallback };
  try {
    return { value: JSON.parse(text) as T };
  } catch (err) {
    return {
      value: fallback,
      problem: {
        code: 'corrupt',
        file,
        message: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        hint: `delete it and run \`pagr connect\` (a partial write, usually from a crash or a full disk)`,
      },
    };
  }
}

/**
 * Atomic 0600 JSON write: write a unique temp file in the same directory, then rename over the
 * target. A crash mid-write leaves the previous file intact, never a half-written one.
 */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never written
    }
    throw err;
  }
}
