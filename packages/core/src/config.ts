import { z } from 'zod';
import { readJson, writeJson } from './jsonFile.js';

/** `~/.pagr/config.json` — never contains secrets. */
export const BridgeConfig = z.object({
  deviceId: z.string().optional(),
  userId: z.string().optional(),
  gatewayUrl: z.string().url().optional(),
  apiUrl: z.string().url().optional(),
  deviceName: z.string().optional(),
  /** keyId → base64url raw Ed25519 public key, pinned from pairing / auth.result. */
  serverKeys: z.record(z.string()).default({}),
  pairedAt: z.string().optional(),
});
export type BridgeConfig = z.infer<typeof BridgeConfig>;

export function readConfig(file: string): BridgeConfig {
  const parsed = BridgeConfig.safeParse(readJson<unknown>(file, {}));
  return parsed.success ? parsed.data : BridgeConfig.parse({});
}

export function writeConfig(file: string, cfg: BridgeConfig): void {
  writeJson(file, BridgeConfig.parse(cfg));
}

export function updateConfig(file: string, patch: Partial<BridgeConfig>): BridgeConfig {
  const next = { ...readConfig(file), ...patch };
  writeConfig(file, next);
  return next;
}
