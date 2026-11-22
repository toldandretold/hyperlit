/**
 * The study workbench asks the reviewer two questions — is the cited work real, does it
 * support the claim — and DERIVES the scored label from the two answers. The stored
 * derivation is PHP (AdjudicationStore::deriveLabel); the form mirrors it only to show
 * "scored as …" before saving. Both are pinned to one table so the preview can never
 * promise a label the server will not store.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REFERENCES,
  REFERENCE_ERRORS,
  SCORING,
  deriveLabel,
  isRealReference,
} from '../../../resources/js/workbenches/study/verdictAxes';

const table = JSON.parse(
  readFileSync(resolve(__dirname, '../../fixtures/study/verdictDerivation.json'), 'utf8'),
);
const storeSrc = readFileSync(
  resolve(__dirname, '../../../app/Services/CitationStudy/AdjudicationStore.php'),
  'utf8',
);

/** The string members of a `public const NAME = [ … ];` list, comments ignored. */
function phpList(name) {
  const body = storeSrc.match(new RegExp(`public const ${name} = \\[([\\s\\S]*?)\\];`))[1];
  return [...body.replace(/\/\/.*$/gm, '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('study verdict axes', () => {
  it.each(table)('$reference + $scope (other work: $from_other_work) scores as $label', (row) => {
    expect(deriveLabel(row.reference, row.scope, row.from_other_work)).toBe(row.label);
  });

  it('the table covers every answer to question 1', () => {
    const covered = new Set(table.map((r) => r.reference));
    for (const r of REFERENCES) expect(covered.has(r.value)).toBe(true);
  });

  it('offers exactly the server vocabulary', () => {
    expect(REFERENCES.map((r) => r.value)).toEqual(phpList('REFERENCE_STATUSES'));
    expect(REFERENCE_ERRORS.map((e) => e.value)).toEqual(phpList('REFERENCE_ERRORS'));
    expect(REFERENCES.map((r) => r.value).filter(isRealReference)).toEqual(phpList('REAL_REFERENCES'));
  });

  it('a real work that supports none of the claim is never scored as sound', () => {
    // The bug this split exists for: "verified intact · supports none of it" scored as a pass.
    for (const reference of ['verified', 'details_wrong']) {
      expect(deriveLabel(reference, 'none')).not.toBe('verified_intact');
      expect(deriveLabel(reference, 'undetermined')).not.toBe('verified_intact');
    }
  });

  it('a wrongly-cited real work scores by claim support, exactly like a correctly-cited one', () => {
    for (const scope of ['whole_claim', 'fragment_only', 'none', 'undetermined']) {
      expect(deriveLabel('details_wrong', scope)).toBe(deriveLabel('verified', scope));
    }
  });

  it('every label the derivation can produce has scoring wording', () => {
    for (const row of table) expect(SCORING[row.label]).toBeTruthy();
  });
});
