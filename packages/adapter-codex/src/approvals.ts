import { APPROVAL_OPTION_LABELS } from '@pagr/bridge-core';
import type { ApprovalOption } from '@pagr/protocol';
import type { ApprovalDecision } from './protocol.js';

/**
 * Codex's approval enums, as the option list a phone renders.
 *
 * `optionId === kind` for Codex (BUILD-PLAN § Shared contract, "Approval options"): the agent has
 * no ids of its own, so the bridge's kind IS the id and the mapping below turns it back into the
 * enum value on the wire. What the enums do NOT offer is `reject_always` — neither
 * `CommandExecutionApprovalDecision` nor `FileChangeApprovalDecision` has one — so it is never
 * offered. The phone renders exactly what it is given and never invents an option.
 */

/**
 * The three kinds Codex's enums can express, worded by the ONE table that words them for every
 * agent (`approvalOptions.ts` in core). The same decision must read the same on the phone
 * whichever agent raised it — this file used to say "Don't allow" where Claude's prompts said
 * "Reject", which made one choice look like two.
 */
export const OPTION_LABELS = {
  allow_once: APPROVAL_OPTION_LABELS.allow_once,
  allow_session: APPROVAL_OPTION_LABELS.allow_session,
  reject_once: APPROVAL_OPTION_LABELS.reject_once,
} as const;

const option = (kind: keyof typeof OPTION_LABELS): ApprovalOption => ({
  optionId: kind,
  kind,
  label: OPTION_LABELS[kind],
});

/** `item/commandExecution/requestApproval` → accept | acceptForSession | decline. */
export const commandApprovalOptions = (): ApprovalOption[] => [
  option('allow_once'),
  option('allow_session'),
  option('reject_once'),
];

/** `item/fileChange/requestApproval` → the same three. */
export const fileChangeApprovalOptions = (): ApprovalOption[] => [
  option('allow_once'),
  option('allow_session'),
  option('reject_once'),
];

/**
 * `item/permissions/requestApproval` answers with a grant, not a decision: an empty
 * `permissions` object IS the denial, and `scope` is what "for this session" means there.
 */
export const permissionsApprovalOptions = (): ApprovalOption[] => [
  option('allow_once'),
  option('allow_session'),
  option('reject_once'),
];

/**
 * The enum value to send for a chosen option. `decision` is the v1 fallback and stays
 * authoritative when the cloud sent no `optionId` — a v1 gateway has never heard of options.
 */
export function decisionForOption(
  optionId: string | undefined,
  decision: 'allow' | 'deny',
): ApprovalDecision {
  switch (optionId) {
    case 'allow_once':
      return 'accept';
    case 'allow_session':
      return 'acceptForSession';
    case 'reject_once':
      return 'decline';
    default:
      return decision === 'allow' ? 'accept' : 'decline';
  }
}

/** Permission grants are scoped rather than repeated: "allow for this session" is `session`. */
export function scopeForOption(optionId: string | undefined): 'turn' | 'session' {
  return optionId === 'allow_session' ? 'session' : 'turn';
}
