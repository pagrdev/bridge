import {
  InvalidDeviceKeyError,
  LaunchAgentError,
  PagrHomeError,
  PairingError,
  type PairingErrorCode,
  SecretStoreError,
} from '@pagr/bridge-core';

/**
 * Exit codes. Stable contract — scripts and support both read them.
 *
 *   0   ok
 *   1   error (uncategorised)
 *   2   usage / aborted
 *   3   daemon not running
 *   4   not paired
 *   5   precondition failed (doctor failures, registry refusals, launchd refused)
 *   6   the Pagr API could not be used (offline, DNS, refused, 5xx, HTML, wrong URL)
 *   7   pairing did not complete (expired, declined, already used, nobody approved)
 *   8   version mismatch — this CLI is too old (or too new) for that API
 *   9   the device key could not be read or written (Keychain locked/denied/missing)
 *   10  PAGR_HOME is unusable (unwritable, full, read-only, corrupt state file)
 *   130 interrupted (Ctrl-C)
 */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  daemonDown: 3,
  notPaired: 4,
  precondition: 5,
  network: 6,
  pairing: 7,
  unsupported: 8,
  secretStore: 9,
  state: 10,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliErrorOptions {
  hint?: string;
  /** Stable machine-readable slug, surfaced by `--json`. */
  code?: string;
  /** Extra context (an API body excerpt, launchctl's stderr…). Printed dimmed. */
  detail?: string;
  cause?: unknown;
}

export class CliError extends Error {
  readonly hint: string | undefined;
  readonly code: string | undefined;
  readonly detail: string | undefined;
  constructor(
    message: string,
    readonly exitCode: number = EXIT.error,
    hintOrOptions?: string | CliErrorOptions,
  ) {
    super(message);
    this.name = 'CliError';
    const o: CliErrorOptions =
      typeof hintOrOptions === 'string' ? { hint: hintOrOptions } : (hintOrOptions ?? {});
    this.hint = o.hint;
    this.code = o.code;
    this.detail = o.detail;
    if (o.cause !== undefined) this.cause = o.cause;
  }

  toJson(): { ok: false; error: Record<string, unknown> } {
    return {
      ok: false,
      error: {
        code: this.code ?? 'error',
        message: this.message,
        exitCode: this.exitCode,
        ...(this.hint ? { hint: this.hint } : {}),
        ...(this.detail ? { detail: this.detail } : {}),
      },
    };
  }
}

export const daemonDownError = (): CliError =>
  new CliError('the pagr daemon is not running', EXIT.daemonDown, {
    code: 'daemon_down',
    hint: 'start it with `pagr daemon install` (or `pagr daemon run` in the foreground), then `pagr doctor`',
  });

export const notPairedError = (): CliError =>
  new CliError('this Mac is not paired with a Pagr account', EXIT.notPaired, {
    code: 'not_paired',
    hint: 'run `pagr connect`',
  });

export const interruptedError = (): CliError =>
  new CliError('canceled', EXIT.interrupted, {
    code: 'interrupted',
    hint: 'nothing was written — run the command again when you are ready',
  });

/** PairingError code → exit code. Table-driven so the contract is testable in one place. */
export const PAIRING_EXIT: Record<PairingErrorCode, number> = {
  network: EXIT.network,
  server_error: EXIT.network,
  not_found: EXIT.network,
  unauthorized: EXIT.network,
  http: EXIT.network,
  invalid_response: EXIT.network,
  unsupported: EXIT.unsupported,
  expired: EXIT.pairing,
  rejected: EXIT.pairing,
  used: EXIT.pairing,
  timeout: EXIT.pairing,
};

/** Prefix that tells the user which phase of `connect` broke. */
const PAIRING_PREFIX: Record<PairingErrorCode, string> = {
  network: '',
  server_error: '',
  not_found: '',
  unauthorized: '',
  http: '',
  invalid_response: '',
  unsupported: '',
  expired: 'pairing did not complete: ',
  rejected: 'pairing did not complete: ',
  used: 'pairing did not complete: ',
  timeout: 'pairing did not complete: ',
};

const DOCTOR = 'run `pagr doctor` to check the rest of the install';

/**
 * Turn any known domain error into a `CliError` with a plain-language message, an actionable
 * hint and the right exit code. Anything unrecognised keeps exit 1 rather than guessing.
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof PairingError)
    return new CliError(`${PAIRING_PREFIX[err.code]}${err.message}`, PAIRING_EXIT[err.code], {
      code: `pairing_${err.code}`,
      hint: err.hint ?? DOCTOR,
      ...(err.detail ? { detail: err.detail } : {}),
      cause: err,
    });
  if (err instanceof SecretStoreError)
    return new CliError(err.message, EXIT.secretStore, {
      code: `keychain_${err.code}`,
      hint: err.hint ?? DOCTOR,
      cause: err,
    });
  if (err instanceof InvalidDeviceKeyError)
    return new CliError(err.message, EXIT.secretStore, {
      code: 'keychain_invalid_key',
      hint: err.hint,
      cause: err,
    });
  if (err instanceof PagrHomeError)
    return new CliError(err.message, EXIT.state, {
      code: `home_${err.code}`,
      hint: err.hint ?? DOCTOR,
      cause: err,
    });
  if (err instanceof LaunchAgentError)
    return new CliError(err.message, EXIT.precondition, {
      code: `launchd_${err.code}`,
      hint: err.hint ?? DOCTOR,
      ...(err.detail ? { detail: err.detail } : {}),
      cause: err,
    });
  return new CliError(err instanceof Error ? err.message : String(err), EXIT.error, {
    code: 'error',
    cause: err,
  });
}
