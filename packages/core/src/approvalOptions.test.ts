import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALWAYS_ENV,
  approvalOptions,
  claudeApprovalOptions,
  decisionForOptionKind,
  defaultOptionId,
  isPersistentOptionKind,
} from './approvalOptions.js';

const ids = (o: { optionId: string }[]) => o.map((x) => x.optionId);

describe('approval options', () => {
  it('offers Claude an "allow always" only when the request carried permission suggestions', () => {
    expect(claudeApprovalOptions(true, {})).toEqual([
      { optionId: 'allow_once', kind: 'allow_once', label: 'Allow once' },
      { optionId: 'allow_always', kind: 'allow_always', label: 'Allow always' },
      { optionId: 'reject_once', kind: 'reject_once', label: 'Reject' },
    ]);
    expect(ids(claudeApprovalOptions(false, {}))).toEqual(['allow_once', 'reject_once']);
  });

  it('PAGR_ALLOW_ALWAYS=0 removes the persistent grant everywhere', () => {
    const off = { [ALLOW_ALWAYS_ENV]: '0' };
    expect(ids(claudeApprovalOptions(true, off))).toEqual(['allow_once', 'reject_once']);
    expect(ids(approvalOptions(['allow_always'], off))).toEqual([]);
    // Anything other than the exact string "0" leaves it on: a typo must not silently disable it.
    expect(ids(claudeApprovalOptions(true, { [ALLOW_ALWAYS_ENV]: 'false' }))).toContain(
      'allow_always',
    );
  });

  it('keeps the agent order, de-duplicates, and labels every kind', () => {
    expect(ids(approvalOptions(['reject_once', 'allow_once', 'allow_once'], {}))).toEqual([
      'reject_once',
      'allow_once',
    ]);
    expect(approvalOptions(['allow_session', 'reject_always'], {})).toEqual([
      { optionId: 'allow_session', kind: 'allow_session', label: 'Allow for this session' },
      { optionId: 'reject_always', kind: 'reject_always', label: 'Reject always' },
    ]);
  });

  it('maps kinds to decisions and to persistence', () => {
    expect(decisionForOptionKind('allow_once')).toBe('allow');
    expect(decisionForOptionKind('allow_always')).toBe('allow');
    expect(decisionForOptionKind('allow_session')).toBe('allow');
    expect(decisionForOptionKind('reject_once')).toBe('deny');
    expect(decisionForOptionKind('reject_always')).toBe('deny');

    expect(isPersistentOptionKind('allow_always')).toBe(true);
    expect(isPersistentOptionKind('allow_session')).toBe(true);
    expect(isPersistentOptionKind('allow_once')).toBe(false);
    expect(isPersistentOptionKind('reject_always')).toBe(false);

    // A v1 answer carries no option at all and means "this once", either way.
    expect(defaultOptionId('allow')).toBe('allow_once');
    expect(defaultOptionId('deny')).toBe('reject_once');
    expect(defaultOptionId(null)).toBe('reject_once');
  });
});
