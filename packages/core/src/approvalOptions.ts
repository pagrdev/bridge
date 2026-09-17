import type { ApprovalOption, ApprovalOptionKind, Provider } from '@pagr/protocol';

/**
 * The option list an approval card carries, and the one place the wording lives.
 *
 * The agent decides WHAT it can offer (Claude only offers "allow always" when it handed us
 * `permission_suggestions`; Codex has no forever-grant at all). The bridge decides how those
 * choices are *worded*, because the phone renders them verbatim and a label that read
 * "Yes, and don't ask again" in one agent and "Always allow Bash(git push:*)" in another would
 * make the same decision look like two different ones.
 *
 * `optionId` equals `kind` for Claude and Codex, which is what the mobile contract expects; an
 * ACP agent that supplies its own ids later keeps them, and only the label comes from here.
 */
export const APPROVAL_OPTION_LABELS: Record<ApprovalOptionKind, string> = {
  allow_once: 'Allow once',
  allow_always: 'Allow always',
  allow_session: 'Allow for this session',
  reject_once: 'Reject',
  reject_always: 'Reject always',
};

/** Every kind, in the order the labels declare them. */
export const APPROVAL_OPTION_KINDS = Object.keys(
  APPROVAL_OPTION_LABELS,
) as readonly ApprovalOptionKind[];

/**
 * What an answer that carried no option id is reported as. A v1 phone sends `decision` alone and
 * means exactly "this once", which is what every agent does with a bare allow.
 */
export const defaultOptionId = (decision: 'allow' | 'deny' | null): ApprovalOptionKind =>
  decision === 'allow' ? 'allow_once' : 'reject_once';

/**
 * `PAGR_ALLOW_ALWAYS=0` removes the persistent-grant option everywhere: from the list the phone
 * is shown, and from every list an adapter builds. A grant that writes a rule into the agent's own
 * settings outlives the session it was made in, so the user gets one switch that takes it away.
 */
export const ALLOW_ALWAYS_ENV = 'PAGR_ALLOW_ALWAYS';

export const allowAlwaysEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[ALLOW_ALWAYS_ENV] !== '0';

/** An option that survives this one prompt: a rule in the agent's settings, or a session grant. */
export const isPersistentOptionKind = (kind: ApprovalOptionKind): boolean =>
  kind === 'allow_always' || kind === 'allow_session';

/** The allow/deny the option means on the wire, where `decision` is still the required field. */
export const decisionForOptionKind = (kind: ApprovalOptionKind): 'allow' | 'deny' =>
  kind === 'reject_once' || kind === 'reject_always' ? 'deny' : 'allow';

/** Build options in the order given, dropping `allow_always` when this Mac has it switched off. */
export function approvalOptions(
  kinds: readonly ApprovalOptionKind[],
  env: NodeJS.ProcessEnv = process.env,
): ApprovalOption[] {
  const allowAlways = allowAlwaysEnabled(env);
  const seen = new Set<ApprovalOptionKind>();
  const out: ApprovalOption[] = [];
  for (const kind of kinds) {
    if (kind === 'allow_always' && !allowAlways) continue;
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push({ optionId: kind, kind, label: APPROVAL_OPTION_LABELS[kind] });
  }
  return out;
}

/**
 * Claude Code's options. "Allow always" appears only when the `can_use_tool` request carried
 * `permission_suggestions` — those suggestions ARE the rules the allow would write, so without
 * them there is nothing to persist and offering the button would be a lie.
 */
export function claudeApprovalOptions(
  hasSuggestions: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ApprovalOption[] {
  return approvalOptions(
    hasSuggestions ? ['allow_once', 'allow_always', 'reject_once'] : ['allow_once', 'reject_once'],
    env,
  );
}

/**
 * Codex's own option list and enum mapping live with the adapter that speaks to it
 * (`@pagr/bridge-adapter-codex`'s `approvals.ts`): they are that protocol's enums, not a shared
 * vocabulary, and one table in two packages is how the two drift apart.
 */
