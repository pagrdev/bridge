import type { BridgeConfig, OnboardingFacts } from '@pagr/bridge-core';
import { readOnboarding } from '@pagr/bridge-core';
import type { CliContext } from './context.js';
import { configuredApiUrl } from './urls.js';

/**
 * The account-side half of "is Pagr working": is a phone linked, is there a trial.
 *
 * Neither fact lives on this Mac, and a Mac has no session to ask with. What it has is the
 * pairing id `connect` recorded, which the api answers for indefinitely — see `readOnboarding`.
 * Every way of not knowing is a *reason*, never a false "no": a Mac paired before the id was
 * recorded, a deployment whose api predates the field, an api that cannot be reached right now.
 * `doctor` and `status` both print the reason instead of guessing.
 */
export interface AccountFacts {
  onboarding: OnboardingFacts | null;
  productNumber: string | null;
  /** Why the facts are missing, in the words the report shows. Null when they are present. */
  unavailable: string | null;
}

const unknown = (why: string): AccountFacts => ({
  onboarding: null,
  productNumber: null,
  unavailable: why,
});

export interface ReadAccountOptions {
  /** Skip the network round-trip entirely (`doctor --offline`). */
  offline?: boolean;
  requestTimeoutMs?: number;
}

export async function readAccount(
  ctx: CliContext,
  config: BridgeConfig,
  opts: ReadAccountOptions = {},
): Promise<AccountFacts> {
  if (opts.offline) return unknown('--offline');
  if (!config.deviceId) return unknown('not paired yet — run `pagr connect`');
  if (!config.pairingId) return unknown('this Mac was paired before pagr recorded the pairing id');
  const apiUrl = configuredApiUrl(ctx.env, undefined, config);
  if (!apiUrl) return unknown('no API URL configured yet — run `pagr connect`');
  try {
    const status = await readOnboarding({
      apiUrl,
      pairingId: config.pairingId,
      requestTimeoutMs: opts.requestTimeoutMs ?? 8000,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
    if (!status.onboarding) return unknown('this Pagr deployment does not report account state');
    return { ...status, unavailable: null };
  } catch (err) {
    return unknown(`could not ask ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * What a deployment with no published number is, in the words every command uses.
 *
 * Pagr is inbound-first: iMessage providers forbid a business texting someone first, so a phone
 * is only ever linked by the person sending Pagr the first text. With no number there is nothing
 * to send it to, and no dashboard button or other route that would "text you" instead.
 */
export const TEXTING_NOT_SET_UP = "texting isn't set up on this Pagr deployment yet";

/** The one thing that finishes the phone link, given what we know about the deployment. */
export const linkPhoneFix = (productNumber: string | null): string =>
  productNumber
    ? `text Hi Pagr to ${productNumber} from the phone on your account`
    : `${TEXTING_NOT_SET_UP} — there is no number to text`;
