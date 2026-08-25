import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './jsonFile.js';
import type { Logger } from './logging.js';
import { silentLogger } from './logging.js';

/** Keychain service name used for every bridge secret. */
export const KEYCHAIN_SERVICE = 'dev.pagr.bridge';

export type SecretStoreErrorCode =
  /** The Keychain exists but is locked. */
  | 'locked'
  /** The user clicked Deny on the Keychain prompt, or no UI is available to ask. */
  | 'denied'
  /** No usable store at all: native module missing/wrong arch, not macOS, no `security`. */
  | 'unavailable'
  /** The store answered, but the operation failed for another reason. */
  | 'io';

export class SecretStoreError extends Error {
  readonly hint: string | undefined;
  constructor(
    readonly code: SecretStoreErrorCode,
    message: string,
    o: { hint?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'SecretStoreError';
    this.hint = o.hint;
    if (o.cause !== undefined) this.cause = o.cause;
  }
}

export interface SecretStore {
  readonly kind: 'keyring' | 'security-cli' | 'file' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Classify a Keychain failure. This matters more than it looks: treating "access denied" or
 * "keychain locked" as "no entry" makes `loadOrCreateIdentity` mint a BRAND NEW device key and
 * overwrite the real one, silently breaking an existing pairing. Only a genuine miss returns
 * `not_found`.
 */
export function classifyKeychainError(raw: string): SecretStoreErrorCode | 'not_found' {
  const s = raw.toLowerCase();
  if (
    s.includes('no matching entry') ||
    s.includes('nomatchingentry') ||
    s.includes('not found') ||
    s.includes('could not be found') ||
    s.includes('errsecitemnotfound') ||
    s.includes('-25300')
  )
    return 'not_found';
  if (s.includes('locked') || s.includes('-25629') || s.includes('errseckeychainlocked'))
    return 'locked';
  if (
    s.includes('user interaction is not allowed') ||
    s.includes('interactionnotallowed') ||
    s.includes('-25308') ||
    s.includes('user canceled') ||
    s.includes('user cancelled') ||
    s.includes('usercanceled') ||
    s.includes('-128') ||
    s.includes('authorization') ||
    s.includes('denied')
  )
    return 'denied';
  if (
    s.includes('cannot find module') ||
    s.includes('mach-o') ||
    s.includes('incompatible architecture') ||
    s.includes('no native build') ||
    s.includes('err_dlopen_failed')
  )
    return 'unavailable';
  return 'io';
}

const KEYCHAIN_HINTS: Record<SecretStoreErrorCode, string> = {
  locked:
    'unlock your login Keychain (Keychain Access → File → Unlock login), then run `pagr connect` again',
  denied:
    'macOS blocked access to the pagr device key — re-run and click "Always Allow", or delete the "dev.pagr.bridge" item in Keychain Access and run `pagr connect` again',
  unavailable:
    'reinstall with `npm i -g @pagr/cli`; on a headless/CI machine set PAGR_INSECURE_FILE_STORE=1 (not recommended on a Mac you use)',
  io: 'run `pagr doctor` for details',
};

export const keychainHint = (code: SecretStoreErrorCode): string => KEYCHAIN_HINTS[code];

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

function keychainError(op: string, key: string, err: unknown): SecretStoreError | null {
  const raw = describe(err);
  const code = classifyKeychainError(raw);
  if (code === 'not_found') return null;
  return new SecretStoreError(code, `keychain ${op} failed for "${key}": ${raw}`, {
    hint: KEYCHAIN_HINTS[code],
    cause: err,
  });
}

// ---------- @napi-rs/keyring ----------

interface KeyringEntryLike {
  getPassword(): string | null;
  setPassword(v: string): void;
  deleteCredential(): boolean;
}
type KeyringEntryCtor = new (service: string, username: string) => KeyringEntryLike;

let keyringLoadError: string | null = null;
/** Why the native keyring could not be loaded, for `pagr doctor`. */
export const lastKeyringLoadError = (): string | null => keyringLoadError;

export class KeyringSecretStore implements SecretStore {
  readonly kind = 'keyring' as const;
  constructor(
    private readonly Entry: KeyringEntryCtor,
    private readonly service: string = KEYCHAIN_SERVICE,
  ) {}

  static async load(service = KEYCHAIN_SERVICE): Promise<KeyringSecretStore | null> {
    try {
      const mod = (await import('@napi-rs/keyring')) as { Entry: KeyringEntryCtor };
      keyringLoadError = null;
      return new KeyringSecretStore(mod.Entry, service);
    } catch (err) {
      keyringLoadError = describe(err);
      return null;
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      return new this.Entry(this.service, key).getPassword();
    } catch (err) {
      const e = keychainError('read', key, err);
      if (e) throw e;
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    try {
      new this.Entry(this.service, key).setPassword(value);
    } catch (err) {
      const classified = classifyKeychainError(describe(err));
      const code = classified === 'not_found' ? 'io' : classified;
      throw new SecretStoreError(code, `keychain write failed for "${key}": ${describe(err)}`, {
        hint: KEYCHAIN_HINTS[code],
        cause: err,
      });
    }
  }
  async delete(key: string): Promise<void> {
    try {
      new this.Entry(this.service, key).deleteCredential();
    } catch (err) {
      // A missing entry is fine; anything else the caller should know about.
      const e = keychainError('delete', key, err);
      if (e) throw e;
    }
  }
}

// ---------- /usr/bin/security fallback ----------

export type ExecFn = (file: string, args: string[]) => string;

const defaultExec: ExecFn = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * `security find-generic-password` exits 44 for a genuine miss. Every other non-zero exit
 * (48 = locked, 51 = authorization denied, 36 = interaction not allowed) is a real failure and
 * must NOT be reported as "no key".
 */
export const SECURITY_NOT_FOUND_STATUS = 44;

function securityError(op: string, key: string, err: unknown): SecretStoreError | null {
  const status = (err as { status?: unknown }).status;
  const raw = `${String((err as { stderr?: unknown }).stderr ?? '')} ${describe(err)}`.trim();
  if (status === SECURITY_NOT_FOUND_STATUS) return null;
  const code = classifyKeychainError(raw);
  if (code === 'not_found') return null;
  return new SecretStoreError(code, `security ${op} failed for "${key}": ${raw}`, {
    hint: KEYCHAIN_HINTS[code],
    cause: err,
  });
}

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
    } catch (err) {
      const e = securityError('read', key, err);
      if (e) throw e;
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    // -U updates in place if present. Value passed as an argv element, never via a shell.
    try {
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
    } catch (err) {
      const raw = `${String((err as { stderr?: unknown }).stderr ?? '')} ${describe(err)}`.trim();
      const classified = classifyKeychainError(raw);
      const code = classified === 'not_found' ? 'io' : classified;
      throw new SecretStoreError(code, `security write failed for "${key}": ${raw}`, {
        hint: KEYCHAIN_HINTS[code],
        cause: err,
      });
    }
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
    } catch (err) {
      const e = securityError('delete', key, err);
      if (e) throw e;
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
    try {
      writeJson(this.file, all);
    } catch (err) {
      throw new SecretStoreError('io', `could not write ${this.file}: ${describe(err)}`, {
        hint: 'check that PAGR_HOME exists and is writable, then retry',
        cause: err,
      });
    }
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
  platform?: NodeJS.Platform;
}

/**
 * Pick the best available store: Keychain via @napi-rs/keyring → `security` CLI →
 * plaintext file only if `PAGR_INSECURE_FILE_STORE=1`. Throws a `SecretStoreError` otherwise.
 */
export async function createSecretStore(opts: CreateSecretStoreOptions): Promise<SecretStore> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? silentLogger;
  if (env.PAGR_INSECURE_FILE_STORE === '1') return new FileSecretStore(opts.home, logger);
  const keyring = await (opts.loadKeyring ?? (() => KeyringSecretStore.load()))();
  if (keyring) return keyring;
  if ((opts.securityAvailable ?? SecurityCliSecretStore.available)()) {
    logger.warn('@napi-rs/keyring unavailable; falling back to /usr/bin/security', {
      ...(keyringLoadError ? { reason: keyringLoadError } : {}),
    });
    return new SecurityCliSecretStore();
  }
  const platform = opts.platform ?? process.platform;
  const because =
    platform === 'darwin'
      ? `the native Keychain module did not load${keyringLoadError ? ` (${keyringLoadError})` : ''} and /usr/bin/security is missing`
      : `this is ${platform}, not macOS — there is no Keychain here`;
  throw new SecretStoreError('unavailable', `no secure secret store available: ${because}`, {
    hint:
      platform === 'darwin'
        ? 'reinstall the CLI with `npm i -g @pagr/cli`; the bridge will not keep your device key in plaintext by default'
        : 'the pagr bridge targets macOS. For CI, set PAGR_INSECURE_FILE_STORE=1 to keep the key in a 0600 file under PAGR_HOME',
  });
}

export type SecretStoreProbe =
  | { ok: true }
  | { ok: false; code: SecretStoreErrorCode; message: string; hint: string };

/**
 * Prove the store can actually round-trip a value — the only way to catch a locked Keychain or
 * a denied prompt before it breaks pairing. Leaves no residue.
 */
export async function probeSecretStore(store: SecretStore): Promise<SecretStoreProbe> {
  const key = 'diagnostics.probe';
  const value = `probe-${Date.now()}`;
  try {
    await store.set(key, value);
    const back = await store.get(key);
    await store.delete(key);
    if (back !== value)
      return {
        ok: false,
        code: 'io',
        message: `${store.kind} did not return the value it just stored`,
        hint: KEYCHAIN_HINTS.io,
      };
    return { ok: true };
  } catch (err) {
    if (err instanceof SecretStoreError)
      return {
        ok: false,
        code: err.code,
        message: err.message,
        hint: err.hint ?? KEYCHAIN_HINTS[err.code],
      };
    return { ok: false, code: 'io', message: describe(err), hint: KEYCHAIN_HINTS.io };
  }
}
