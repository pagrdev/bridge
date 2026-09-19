import { z } from 'zod';
import { inspectJson, type JsonFileProblem, readJson, writeJson } from './jsonFile.js';

/** `~/.pagr/config.json` — never contains secrets. */
export const BridgeConfig = z.object({
  deviceId: z.string().optional(),
  userId: z.string().optional(),
  /**
   * The id of the pairing that produced this device. Kept so `status`, `doctor` and a re-run of
   * `connect` can read the account-side onboarding facts (phone linked, trial started) from the
   * public pair-status route: the API has no device-signed HTTP auth, and this id is the only
   * credential-free handle the Mac holds. Absent on any Mac paired before it was persisted —
   * those print "skip", never a wrong answer.
   */
  pairingId: z.string().optional(),
  gatewayUrl: z.string().url().optional(),
  apiUrl: z.string().url().optional(),
  deviceName: z.string().optional(),
  /** keyId → base64url raw Ed25519 public key, pinned from pairing / auth.result. */
  serverKeys: z.record(z.string()).default({}),
  /**
   * kid → base64url raw X25519 public key: the phones every sealed frame is encrypted for.
   * Pinned from `auth.result.recipientKeys` / the gateway's `keys.updated`, under the same
   * acceptance rule as `serverKeys` (SEC-7). Empty means no phone is paired, which means
   * nothing is sealed and nothing is sent.
   */
  recipientKeys: z.record(z.string()).default({}),
  /** When the pinned recipient set last changed, for `pagr status` and `pagr doctor`. */
  recipientKeysUpdatedAt: z.string().optional(),
  pairedAt: z.string().optional(),
});
export type BridgeConfig = z.infer<typeof BridgeConfig>;

export function readConfig(file: string): BridgeConfig {
  const parsed = BridgeConfig.safeParse(readJson<unknown>(file, {}));
  return parsed.success ? parsed.data : BridgeConfig.parse({});
}

/**
 * `readConfig` with the reason it fell back. A `config.json` that is corrupt or of the wrong
 * shape reads as an empty config, i.e. "not paired" — which sends users down completely the
 * wrong path. `doctor` and `connect` use this so they can say what actually happened.
 */
export function inspectConfig(file: string): { config: BridgeConfig; problem?: JsonFileProblem } {
  const raw = inspectJson<unknown>(file, {});
  if (raw.problem) return { config: BridgeConfig.parse({}), problem: raw.problem };
  const parsed = BridgeConfig.safeParse(raw.value);
  if (parsed.success) return { config: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    config: BridgeConfig.parse({}),
    problem: {
      code: 'wrong_shape',
      file,
      message: `${file} is not a valid pagr config${
        issue ? ` (${issue.path.join('.') || '(root)'}: ${issue.message})` : ''
      }`,
      hint: 're-pair with `pagr connect --force`, or delete the file and run `pagr connect`',
    },
  };
}

export function writeConfig(file: string, cfg: BridgeConfig): void {
  writeJson(file, BridgeConfig.parse(cfg));
}

export function updateConfig(file: string, patch: Partial<BridgeConfig>): BridgeConfig {
  const next = { ...readConfig(file), ...patch };
  writeConfig(file, next);
  return next;
}
