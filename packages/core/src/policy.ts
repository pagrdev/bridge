import { z } from 'zod';
import { readJson, writeJson } from './jsonFile.js';

/**
 * Public, user-visible policy synced from the cloud (`settings.sync_public_policy`).
 *
 * How long a prompt waits is the only thing left here. The bridge used to carry a
 * `smartApprovalsTierA` flag that let it answer "obviously safe" prompts itself; that is gone.
 * Claude Code and Codex already have their own approval settings, and the bridge adding a second
 * layer of judgement on top of them was a second thing to configure and a second thing to get
 * wrong. An older Mac's `policy.json`, and an older cloud's command, may still carry the flag:
 * zod drops unknown keys, so it is read and discarded rather than honoured.
 */
export const PublicPolicy = z.object({
  approvalTimeoutSeconds: z.number().int().min(30).max(3600).default(600),
});
export type PublicPolicy = z.infer<typeof PublicPolicy>;

export function readPolicy(file?: string): PublicPolicy {
  if (!file) return PublicPolicy.parse({});
  const parsed = PublicPolicy.safeParse(readJson<unknown>(file, {}));
  return parsed.success ? parsed.data : PublicPolicy.parse({});
}

export function writePolicy(file: string | undefined, policy: PublicPolicy): void {
  if (file) writeJson(file, policy);
}
