/**
 * utilities/localCopyCompleteness — "IndexedDB holds only a FRAGMENT of this book".
 *
 * Prod 2026-11-22 (`john2005restorative`): the browser held 400 of 3,062 nodes because a
 * background download never finished, and every later visit rendered that fragment as
 * the whole book — any non-empty local copy was assumed complete. It surfaced as a false
 * "server/IDB divergence" report while the server had lost nothing.
 *
 * What this pins: the marker's POLARITY (absent = assume whole, so a locally created /
 * pasted / imported book is never mistaken for a fragment), that it is per book, that it
 * survives storage throwing, and that the marker's storage keys live in ONE file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  markLocalCopyPartial,
  markLocalCopyComplete,
  isLocalCopyPartial,
  shortRepairAlreadyTried,
  noteShortRepairAttempt,
  clearShortRepairAttempt,
} from '../../../resources/js/utilities/localCopyCompleteness';

describe('localCopyCompleteness', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('a book nobody marked is NOT partial (new / pasted / imported books are whole)', () => {
    expect(isLocalCopyPartial('book_never_marked')).toBe(false);
    expect(isLocalCopyPartial(null)).toBe(false);
    expect(isLocalCopyPartial('')).toBe(false);
  });

  it('partial until a full download says otherwise', () => {
    markLocalCopyPartial('book_p1');
    expect(isLocalCopyPartial('book_p1')).toBe(true);

    markLocalCopyComplete('book_p1');
    expect(isLocalCopyPartial('book_p1')).toBe(false);
  });

  it('is per book — a sub-book and its parent are separate copies', () => {
    markLocalCopyPartial('book_p2');
    expect(isLocalCopyPartial('book_p2/Fn3')).toBe(false);
    expect(isLocalCopyPartial('book_p3')).toBe(false);
  });

  it('survives a reload (it is in localStorage, not module state)', () => {
    markLocalCopyPartial('book_p4');
    expect(Object.keys(localStorage).some((k) => k.endsWith('book_p4'))).toBe(true);
  });

  it('still works for the session when storage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });

    expect(() => markLocalCopyPartial('book_p5')).not.toThrow();
    expect(isLocalCopyPartial('book_p5')).toBe(true);
    expect(() => markLocalCopyComplete('book_p5')).not.toThrow();
    expect(isLocalCopyPartial('book_p5')).toBe(false);
  });

  it('a count-triggered repair is remembered per server count', () => {
    expect(shortRepairAlreadyTried('book_r1', 3062)).toBe(false);

    noteShortRepairAttempt('book_r1', 3062);
    expect(shortRepairAlreadyTried('book_r1', 3062)).toBe(true);
    // The book changed server-side — that is a new shortfall, worth a new attempt.
    expect(shortRepairAlreadyTried('book_r1', 3070)).toBe(false);
    expect(shortRepairAlreadyTried('book_r2', 3062)).toBe(false);

    clearShortRepairAttempt('book_r1');
    expect(shortRepairAlreadyTried('book_r1', 3062)).toBe(false);
  });
});

describe('the marker has ONE accessor', () => {
  const ROOT = resolve(__dirname, '../../../resources/js');
  const ACCESSOR = join(ROOT, 'utilities/localCopyCompleteness.ts');

  function sourceFiles(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.(ts|js)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('no other file spells the storage keys', () => {
    const offenders = sourceFiles(ROOT)
      .filter((f) => f !== ACCESSOR)
      .filter((f) => /localCopyPartial_|localCopyShortRepair_/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the accessor stays a zero-import leaf (data layer and page-load layer both read it)', () => {
    expect(readFileSync(ACCESSOR, 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});
