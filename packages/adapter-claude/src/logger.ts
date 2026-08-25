import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only file logger. Callers must never pass credentials; this module only formats.
 * Method names and ids are logged, never `account/*` params or results.
 */
export class FileLogger {
  private stream: fs.WriteStream | null = null;
  constructor(private readonly file: string | null) {}

  log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
    if (!this.file) return;
    try {
      if (!this.stream) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        this.stream = fs.createWriteStream(this.file, { flags: 'a', mode: 0o600 });
        this.stream.on('error', () => {
          this.stream = null;
        });
      }
      const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${
        extra ? ` ${JSON.stringify(extra)}` : ''
      }\n`;
      this.stream.write(line);
    } catch {
      // logging must never break the adapter
    }
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
