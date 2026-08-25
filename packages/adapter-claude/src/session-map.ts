import fs from 'node:fs';
import path from 'node:path';

export interface PersistedSession {
  claudeSessionId: string;
  projectId: string;
  projectPath: string;
  displayName?: string;
  startedAt: string;
  updatedAt: string;
  lastStatus: string;
}

/**
 * Cloud session id (`ses_…`) → Claude Code session id (UUID) map, persisted as JSON under PAGR_HOME.
 * Contains no secrets: ids, the registered project path, and timestamps only.
 */
export class SessionMap {
  private data: Record<string, PersistedSession> = {};
  constructor(private readonly file: string) {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as Record<string, PersistedSession>;
      }
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(sessionId: string): PersistedSession | undefined {
    return this.data[sessionId];
  }
  set(sessionId: string, s: PersistedSession): void {
    this.data[sessionId] = s;
    this.save();
  }
  update(sessionId: string, patch: Partial<PersistedSession>): void {
    const cur = this.data[sessionId];
    if (!cur) return;
    this.data[sessionId] = { ...cur, ...patch };
    this.save();
  }
  entries(): Array<[string, PersistedSession]> {
    return Object.entries(this.data);
  }
  findByClaudeId(claudeSessionId: string): string | undefined {
    for (const [sid, s] of Object.entries(this.data))
      if (s.claudeSessionId === claudeSessionId) return sid;
    return undefined;
  }
}
