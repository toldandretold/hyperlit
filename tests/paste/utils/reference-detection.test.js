/**
 * Reference detection: is this block a bibliography entry, or is it body prose?
 *
 * The truth tables are ported alongside the implementation, from the conversion
 * pipeline's pytest suite:
 *   - tests/conversion/unit/test_refkeys.py
 *   - tests/conversion/unit/test_article_chrome.py
 *   - tests/conversion/unit/test_bibliography.py
 */

import { describe, it, expect } from 'vitest';
import {
  collectReferenceRun,
  hasEarlyYear,
  hasReferenceStructure,
  isArticleChrome,
  isReferenceShaped,
} from '../../../resources/js/paste/utils/reference-detection';

/** Build a container whose direct children are <p> with the given texts. */
function paragraphs(...texts) {
  const dom = document.createElement('div');
  dom.innerHTML = texts.map((t) => `<p>${t}</p>`).join('');
  return Array.from(dom.querySelectorAll('p'));
}

// The four paragraphs that book_1788040795553 turned into a "References" section.
// Every one starts with a capital and carries a four-digit year, which is all the
// old predicate asked for. This is the regression lock for the whole change.
const BUG_REPORT_PROSE = [
  "The lesson of the East India Company is not only that corporations can behave monstrously abroad. It is that they can flex their powers at home, too. Burke understood this in the 1780s.",
  'Gallup found that nearly four in 10 Americans said A.I. did more harm than good, up sharply from a year earlier. In the first three months of 2026 alone, organized local opposition blocked or delayed 75 major projects.',
  "The East India Company's directors faced something similar in 1773 when Parliament passed the Regulating Act, an early attempt at state control.",
  "The most sweeping regulatory assault in the history of corporate China followed. Mr. Ma resurfaced in February 2025 to shake Mr. Xi's hand at a televised symposium.",
];

const REAL_ENTRIES = [
  'Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.',
  'Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.',
  'Dalrymple, William. The Anarchy. London: Bloomsbury, 2019.',
  '[1] Author, A. (2023). A paper about things. Journal of Things, 15(2), 123-145.',
  'von Neumann, J. (1944) Theory of Games and Economic Behavior.',
  '—. 2019. A Second Book By The Same Author. Verso.',
];

describe('hasReferenceStructure — the strict, start-anchored predicate', () => {
  it.each(BUG_REPORT_PROSE)('rejects body prose containing a year: %s', (text) => {
    expect(hasReferenceStructure(text)).toBe(false);
  });

  it.each(REAL_ENTRIES)('accepts a real entry: %s', (text) => {
    expect(hasReferenceStructure(text)).toBe(true);
  });

  it('accepts a numbered bibliography entry by stripping the enumerator', () => {
    expect(hasReferenceStructure('1. Caso, R. (2019). Open access and the law.')).toBe(true);
  });

  it('rejects a numbered PROSE list item — the enumerator alone is never enough', () => {
    expect(hasReferenceStructure('3. In 2019 we surveyed every participating household.')).toBe(false);
  });

  it('accepts Vancouver style, where the colon sits near the front', () => {
    expect(
      hasReferenceStructure('Adger W, Barnett J, Brown K: Title of the paper. Nat Clim Change 2013, 3:112-117'),
    ).toBe(true);
  });

  it('rejects a prose sentence that merely opens "Surname AB," with a far-off colon', () => {
    const text =
      'Johnson AB, writing at length about the difficulty of measuring anything at all in ' +
      'a field this crowded, eventually reached a conclusion in 1998 that few accepted: it was wrong.';
    expect(hasReferenceStructure(text)).toBe(false);
  });

  it('rejects text with a buried "(2001)" — a reference declares its shape up front', () => {
    expect(
      hasReferenceStructure(
        'It took several decades before the doctrine was applied consistently across the ' +
          'circuits, and only the later ruling (2001) settled the question for good.',
      ),
    ).toBe(false);
  });

  it('rejects empty and whitespace input', () => {
    expect(hasReferenceStructure('')).toBe(false);
    expect(hasReferenceStructure('   ')).toBe(false);
    expect(hasReferenceStructure(null)).toBe(false);
  });
});

describe('isReferenceShaped — the loose predicate', () => {
  it('is LOOSE by design: prose with a year passes, which is why the cohort gate exists', () => {
    expect(isReferenceShaped('Smith (1999) argued that markets fail under information asymmetry.')).toBe(true);
  });

  it('still requires a four-digit year', () => {
    expect(isReferenceShaped('This is ordinary body prose without a year.')).toBe(false);
  });

  it('rejects a lowercase opener that matches no other rule', () => {
    expect(isReferenceShaped('and then the story continued for a while in 1990.')).toBe(false);
  });

  it('accepts a lowercase-branded author before the year', () => {
    expect(isReferenceShaped('1. ephemera collective. 2021. Organising in the ruins.')).toBe(true);
  });
});

describe('isArticleChrome — journal front/back matter is never an entry', () => {
  it.each([
    'Article copyright 2019 by the authors.',
    'Copyright: © 2019 The Authors.',
    '© 2019 Published under a Creative Commons licence.',
    'ORCID: 0000-0002-1825-0097',
    'How to cite this article: Lawson, S. Access, ethics and piracy. Insights, 2017, 30(1), 25-30.',
    'Competing interests: the author declares none.',
    'Correspondence: s.lawson@example.ac.uk',
    'E-mail: someone@example.com',
    'Submitted on 5 November 2018 and published later that year.',
    'This is an open-access article distributed under the terms of the licence, 2019.',
  ])('rejects chrome: %s', (text) => {
    expect(isArticleChrome(text)).toBe(true);
    expect(isReferenceShaped(text)).toBe(false);
  });

  it.each([
    // Deliberate near-misses: real entries that merely OPEN with a chrome word.
    'Received Wisdom and Other Essays, A. Author, 1998.',
    'Published Papers of the Royal Society, volume 12, 1904.',
    'Copyrighting Culture, Ronald Bettig, 1996.',
  ])('does not reject a real entry that opens with a chrome word: %s', (text) => {
    expect(isArticleChrome(text)).toBe(false);
  });
});

describe('hasEarlyYear', () => {
  it('is true when the year is near the start, as in a real entry', () => {
    expect(hasEarlyYear('Marcuse, H. 1964. One-Dimensional Man.')).toBe(true);
  });

  it('is false when the year is buried far into body prose', () => {
    expect(
      hasEarlyYear(
        'The doctrine developed slowly through a long series of appellate decisions that ' +
          'nobody at the time regarded as especially significant, and only much later, in 1990, ' +
          'did it acquire its present name.',
      ),
    ).toBe(false);
  });
});

describe('collectReferenceRun — heading-less', () => {
  it('extracts NOTHING from the bug report prose', () => {
    expect(collectReferenceRun(paragraphs(...BUG_REPORT_PROSE))).toHaveLength(0);
  });

  it('discards a short unstructured tail — the lone-junk-reference case', () => {
    const blocks = paragraphs(
      'The doctrine developed through the 1970s and beyond.',
      'Nor should we have much confidence in the manner it was applied after 1990.',
    );
    expect(collectReferenceRun(blocks)).toHaveLength(0);
  });

  it('keeps a real heading-less bibliography run and leaves the body alone', () => {
    const blocks = paragraphs(
      'This closing body paragraph discusses the commons at length and mentions 1990 in passing.',
      ...REAL_ENTRIES.slice(0, 3),
    );
    const found = collectReferenceRun(blocks);
    expect(found).toHaveLength(3);
    expect(found[0].textContent).toContain('Marcuse');
  });

  it('discards a structured run shorter than the density floor', () => {
    expect(collectReferenceRun(paragraphs(...REAL_ENTRIES.slice(0, 2)))).toHaveLength(0);
  });

  it('rescues a yearless in-press entry sandwiched inside the run', () => {
    const blocks = paragraphs(
      'Body prose that should stay out of the bibliography entirely.',
      'Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.',
      'Walz A, Braendle J. Experience from customising IPCC scenarios (in press).',
      'Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.',
      'Dalrymple, William. The Anarchy. London: Bloomsbury, 2019.',
    );
    const found = collectReferenceRun(blocks);
    expect(found).toHaveLength(4);
    expect(found[1].textContent).toContain('Walz');
  });

  it('does not let body prose in as a tolerated miss — the run ends there', () => {
    const blocks = paragraphs(
      'Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.',
      'The doctrine developed through the 1970s and beyond, and was applied after 1990.',
      'Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.',
      'Dalrymple, William. The Anarchy. London: Bloomsbury, 2019.',
      'Scott, James C. (1998) Seeing Like a State. Yale University Press.',
    );
    const found = collectReferenceRun(blocks);
    // The run grows backwards and stops at the prose, so the Marcuse entry above
    // it is NOT reached — prose is a wall, not a tolerated gap.
    expect(found).toHaveLength(3);
    expect(found.some((el) => el.textContent.includes('The doctrine developed'))).toBe(false);
    expect(found.some((el) => el.textContent.includes('Marcuse'))).toBe(false);
  });

  it('discards everything when prose leaves the surviving run below the density floor', () => {
    const blocks = paragraphs(
      'Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.',
      'The doctrine developed through the 1970s and beyond, and was applied after 1990.',
      'Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.',
      'Dalrymple, William. The Anarchy. London: Bloomsbury, 2019.',
    );
    expect(collectReferenceRun(blocks)).toHaveLength(0);
  });
});

describe('collectReferenceRun — heading-anchored', () => {
  const opts = { headingAnchored: true };

  it('trusts the loose predicate once a heading has vouched for location', () => {
    const blocks = paragraphs('Anonymous pamphlet on the commons, 1732, publisher unknown.');
    expect(collectReferenceRun(blocks, opts)).toHaveLength(1);
  });

  it('accepts a single entry — no density floor applies', () => {
    expect(collectReferenceRun(paragraphs(REAL_ENTRIES[0]), opts)).toHaveLength(1);
  });

  it('skips a non-entry inside the section without ending it', () => {
    const blocks = paragraphs(
      'Marcuse, H. 1964. One-Dimensional Man.',
      'see the appendix for the full dataset.',
      'Ostrom, Elinor (1990) Governing the Commons.',
    );
    const found = collectReferenceRun(blocks, opts);
    expect(found).toHaveLength(2);
    expect(found.some((el) => el.textContent.includes('appendix'))).toBe(false);
  });

  it('rejects the article self-citation that follows a "To cite this article" label', () => {
    const dom = document.createElement('div');
    dom.innerHTML =
      '<p>How to cite this article:</p>' +
      '<p>Lawson, S. Access, ethics and piracy. Insights, 2017, 30(1), 25-30.</p>';
    const blocks = Array.from(dom.querySelectorAll('p'));
    expect(collectReferenceRun(blocks, opts)).toHaveLength(0);
  });

  it('accepts the identical line when no label precedes it', () => {
    const blocks = paragraphs('Lawson, S. Access, ethics and piracy. Insights, 2017, 30(1), 25-30.');
    expect(collectReferenceRun(blocks, opts)).toHaveLength(1);
  });
});

describe('collectReferenceRun — ordinal density gate', () => {
  const opts = { headingAnchored: true };

  it('keeps a dense numbered bibliography', () => {
    const blocks = paragraphs(
      '1. Caso, R. (2019). Open access and the law.',
      '2. Marcuse, H. (1964). One-Dimensional Man.',
      '3. Ostrom, E. (1990). Governing the Commons.',
      '4. Dalrymple, W. (2019). The Anarchy.',
    );
    expect(collectReferenceRun(blocks, opts)).toHaveLength(4);
  });

  it('drops sparse ordinals — those are endnotes, not references', () => {
    const blocks = paragraphs(
      '42. Caso, R. (2019). Open access and the law.',
      '64. Marcuse, H. (1964). One-Dimensional Man.',
      '68. Ostrom, E. (1990). Governing the Commons.',
      '81. Dalrymple, W. (2019). The Anarchy.',
    );
    expect(collectReferenceRun(blocks, opts)).toHaveLength(0);
  });

  it('leaves unnumbered entries untouched when the ordinal subset is dropped', () => {
    const blocks = paragraphs(
      '42. Caso, R. (2019). Open access and the law.',
      '64. Marcuse, H. (1964). One-Dimensional Man.',
      '81. Dalrymple, W. (2019). The Anarchy.',
      'Ostrom, Elinor (1990) Governing the Commons.',
    );
    const found = collectReferenceRun(blocks, opts);
    expect(found).toHaveLength(1);
    expect(found[0].textContent).toContain('Ostrom');
  });
});
