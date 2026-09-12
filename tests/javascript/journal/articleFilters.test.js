import { describe, it, expect } from 'vitest';
import { isAttempted, isFailed } from '../../../resources/js/maintainerJournalImport/articleFilters.ts';

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
});
