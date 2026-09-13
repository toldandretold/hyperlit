import { describe, it, expect } from 'vitest';
import {
  hasMetadataDrift, isAttempted, isFailed, needsMetadataDecision,
} from '../../../resources/js/maintainerJournalImport/articleFilters.ts';

const lanes = (...hasNodes) => ({ lanes: hasNodes.map((has_nodes) => ({ has_nodes })) });

describe('journal-import article filters', () => {
  it('a work with no lanes has not been attempted, and is not a failure', () => {
    expect(isAttempted(lanes())).toBe(false);
    // "Nobody has tried this yet" is a different state from "we tried and got nothing" — lumping
    // them together would make an un-run journal look like a catastrophe.
    expect(isFailed(lanes())).toBe(false);
  });

  it('a work whose only lane is empty has failed', () => {
    expect(isFailed(lanes(false))).toBe(true);
  });

  it('a work with any lane that has content has NOT failed', () => {
    expect(isFailed(lanes(true))).toBe(false);
    expect(isFailed(lanes(true, true))).toBe(false);
  });

  /**
   * The regression this module exists for. html-first tries the free publisher page per work and
   * falls back to the PDF, so a successful fallback leaves an EMPTY html stub beside a good pdf
   * lane. The old predicate ("some lane is empty") matched those, which on the 944-of-960 tripleC
   * run meant "failed only" listed most of the journal instead of the 9 works that actually failed.
   */
  it('an empty html stub beside a successful pdf lane is not a failure', () => {
    expect(isFailed(lanes(false, true))).toBe(false);
    expect(isFailed(lanes(true, false))).toBe(false);
  });

  it('every lane empty is still a failure, however many were tried', () => {
    expect(isFailed(lanes(false, false))).toBe(true);
  });

  /**
   * The metadata flag covers two different things and only one of them is work: a DISPUTE the
   * machine refused to settle (both years plausible, someone must choose) and an AUDIT RECORD of
   * a correction it already made. A journal-wide repair can leave a thousand of the second, so
   * treating them alike would bury the handful that need a person — the same trap `isFailed` has.
   */
  const drift = (needs_decision) => ({ lanes: [{ has_nodes: true, metadata_drift: { needs_decision } }] });

  it('a work with no metadata flag is not drifted', () => {
    expect(hasMetadataDrift(lanes(true))).toBe(false);
    expect(needsMetadataDecision(lanes(true))).toBe(false);
  });

  it('an applied correction is drift, but is not a decision', () => {
    expect(hasMetadataDrift(drift(false))).toBe(true);
    expect(needsMetadataDecision(drift(false))).toBe(false);
  });

  it('a dispute is both', () => {
    expect(hasMetadataDrift(drift(true))).toBe(true);
    expect(needsMetadataDecision(drift(true))).toBe(true);
  });

  it('a flag on any lane counts, since lanes share one canonical', () => {
    const mixed = { lanes: [{ has_nodes: true }, { has_nodes: true, metadata_drift: { needs_decision: true } }] };
    expect(needsMetadataDecision(mixed)).toBe(true);
  });
});
