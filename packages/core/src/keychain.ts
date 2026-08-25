import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './jsonFile.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';

/** Keychain service name used for every bridge secret. */
export const KEYCHAIN_SERVICE = 'dev.pagr.bridge';

export interface SecretStore {
  readonly kind: 'keyring' | 'security-cli' | 'file' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------- @napi-rs/keyring ----------

interface KeyringEntryLike {
  getPassword(): string | null;
  setPassword(v: string): void;
  deleteCredential(): boolean;
}
type KeyringEntryCtor = new (service: string, username: string) => KeyringEntryLike;

export class KeyringSecretStore implements SecretStore {
  readonly kind = 'keyring' as const;
  constructor(
    private readonly Entry: KeyringEntryCtor,
    private readonly service: string = KEYCHAIN_SERVICE,
  ) {}

  static async load(service = KEYCHAIN_SERVICE): Promise<KeyringSecretStore | null> {
    try {
      const mod = (await import('@napi-rs/keyring')) as { Entry: KeyringEntryCtor };
      return new KeyringSecretStore(mod.Entry, service);
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return new this.Entry(this.service, key).getPassword();
    } catch {
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    new this.Entry(this.service, key).setPassword(value);
  }
  async delete(key: string): Promise<void> {
    try {
      new this.Entry(this.service, key).deleteCredential();
    } catch {
      // missing entry is fine
    }
  }
}

// ---------- /usr/bin/security fallback ----------

export type ExecFn = (file: string, args: string[]) => string;

const defaultExec: ExecFn = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export class SecurityCliSecretStore implements SecretStore {
  readonly kind = 'security-cli' as const;
  static readonly BIN = '/usr/bin/security';
  constructor(
    private readonly exec: ExecFn = defaultExec,
    private readonly service: string = KEYCHAIN_SERVICE,
  ) {}

  static available(): boolean {
    return process.platform === 'darwin' && existsSync(SecurityCliSecretStore.BIN);
  }

  async get(key: string): Promise<string | null> {
    try {
      const out = this.exec(SecurityCliSecretStore.BIN, [
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        key,
        '-w',
      ]);
      return out.replace(/\n$/, '');
    } catch {
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    // -U updates in place if present. Value passed as an argv element, never via a shell.
    this.exec(SecurityCliSecretStore.BIN, [
      'add-generic-password',
      '-U',
      '-s',
      this.service,
      '-a',
      key,
      '-w',
      value,
    ]);
  }
  async delete(key: string): Promise<void> {
    try {
      this.exec(SecurityCliSecretStore.BIN, [
        'delete-generic-password',
        '-s',
        this.service,
        '-a',
        key,
      ]);
    } catch {
      // not found
    }
  }
}

// ---------- insecure file store (explicit opt-in only) ----------

export class FileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  private readonly file: string;
  constructor(home: string, logger: Logger = silentLogger) {
    this.file = join(home, 'secrets.json');
    logger.warn('PAGR_INSECURE_FILE_STORE=1: secrets stored in plaintext file (0600)', {
      file: this.file,
    });
  }
  private read(): Record<string, string> {
    return readJson<Record<string, string>>(this.file, {});
  }
  async get(key: string): Promise<string | null> {
    return this.read()[key] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const all = this.read();
    all[key] = value;
    writeJson(this.file, all);
  }
  async delete(key: string): Promise<void> {
    const all = this.read();
    delete all[key];
    writeJson(this.file, all);
  }
}

// ---------- memory (tests) ----------

export class MemorySecretStore implements SecretStore {
  readonly kind = 'memory' as const;
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export interface CreateSecretStoreOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Test hooks. */
  loadKeyring?: () => Promise<SecretStore | null>;
  securityAvailable?: () => boolean;
}

/**
 * Pick the best available store: Keychain via @napi-rs/keyring → `security` CLI →
 * plaintext file only if `PAGR_INSECURE_FILE_STORE=1`. Throws otherwise.
 */
export async function createSecretStore(opts: CreateSecretStoreOptions): Promise<SecretStore> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? silentLogger;
  if (env.PAGR_INSECURE_FILE_STORE === '1') return new FileSecretStore(opts.home, logger);
  const keyring = await (opts.loadKeyring ?? (() => KeyringSecretStore.load()))();
  if (keyring) return keyring;
  if ((opts.securityAvailable ?? SecurityCliSecretStore.available)()) {
    logger.warn('@napi-rs/keyring unavailable; falling back to /usr/bin/security');
    return new SecurityCliSecretStore();
  }
  throw new Error(
    'No secure secret store available. Install on macOS, or set PAGR_INSECURE_FILE_STORE=1 (not recommended).',
  );
}
