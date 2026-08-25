import { z } from 'zod';
import { readJson, writeJson } from './jsonFile.js';

/** Public, user-visible policy synced from the cloud (`settings.sync_public_policy`). */
export const PublicPolicy = z.object({
  smartApprovalsTierA: z.boolean().default(false),
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
