/**
 * The reviewer's two questions, and the one label derived from them.
 *
 * The workbench asks (1) is the cited work REAL and cited correctly, and (2) does it SUPPORT
 * the claim. Each answer is stored in its own field. The scored label — what ground truth and
 * the metrics read — is DERIVED from the two, never picked: see deriveLabel.
 *
 * Mirrors App\Services\CitationStudy\AdjudicationStore (REFERENCE_STATUSES, REFERENCE_ERRORS,
 * deriveLabel). The server's derivation is the one that is stored; this copy exists only so the
 * form can show "scored as …" before saving. Both are pinned to
 * tests/fixtures/study/verdictDerivation.json. A zero-import leaf.
 */

export interface Choice {
  value: string;
  text: string;
  desc: string;
}

/** Question 1 — is the cited work real, and is it cited correctly? */
export const REFERENCES: Choice[] = [
  { value: 'verified', text: 'real — cited correctly',
    desc: 'The cited work exists, and the citation describes it correctly (author, title, year, venue). Says nothing about whether it supports the claim — that is question 2.' },
  { value: 'details_wrong', text: 'real — but cited wrongly',
    desc: 'The work exists, but the citation gets something about it wrong: the wrong author, title, year or venue. Tick what is wrong and put the correct value in the note.' },
  { value: 'fabricated', text: 'fabricated — no such work',
    desc: 'The cited work does not exist.' },
  { value: 'unverifiable', text: "can't confirm it exists",
    desc: 'You could not establish whether the work exists (grey literature, "copy on file with author", an unreachable source). Not scored.' },
  { value: 'suspect', text: 'suspect',
    desc: "Something is off but you can't pin it down. Not scored." },
  { value: 'not_a_citation', text: 'not a citation',
    desc: "The reviewed pairing isn't in the author's text — a phantom or mislinked anchor, or a footnote that cites nothing. Nothing to verify. Not scored; pairs with the citation-mislink cause." },
];

/** What a "real — but cited wrongly" citation gets wrong. */
export const REFERENCE_ERRORS: Array<{ value: string; text: string }> = [
  { value: 'author', text: 'author' },
  { value: 'title', text: 'title' },
  { value: 'year', text: 'year' },
  { value: 'venue', text: 'venue / publisher' },
];

/** The answers to question 1 that mean "the work exists" — the only ones question 2 applies to. */
export function isRealReference(reference: string | null | undefined): boolean {
  return reference === 'verified' || reference === 'details_wrong';
}

/** The scored label the two answers produce. Mirrors AdjudicationStore::deriveLabel. */
export function deriveLabel(reference: string, scope: string | null, fromOtherWork = false): string {
  if (!isRealReference(reference)) {
    return reference === 'fabricated' ? 'fabricated_reference' : reference;
  }
  if (scope === 'none') return fromOtherWork ? 'source_swap' : 'claim_distortion';
  if (scope === 'undetermined') return 'unverifiable';
  return 'verified_intact';
}

/** What each derived label means for scoring, in words. */
export const SCORING: Record<string, string> = {
  intact: 'intact — the AI should PASS it',
  verified_intact: 'verified intact — the AI should PASS it',
  claim_distortion: 'claim distortion — the AI should FLAG it',
  source_swap: 'source swap — the AI should FLAG it',
  fabricated_reference: 'fabricated reference — the AI should FLAG it',
  unverifiable: 'unverifiable — not scored',
  suspect: 'suspect — not scored',
  not_a_citation: 'not a citation — not scored',
};
