/**
 * The paste path runs its OWN citation linker (resources/js/paste/utils/citation-linker.ts), a
 * second implementation of the same scan the server-side pipeline does in
 * app/Python/digestion/citationLinking/citation_link_rules.py. Both carried the same two defects;
 * these pin the paste side.
 *
 * Found live on book_1789025680384 (the Chacko article, pasted from Sage): "in Modi's first term
 * (2014-2019)" minted <a href="#modi2014">2014</a> — a date span turned into a citation to a
 * speech the author never cited there, which the citation-review study then reviewed and flagged
 * against the author. The multi-year half was invisible on that book only because Sage anchors
 * each year itself; on any source without publisher anchors every year after the first was lost.
 */
import { describe, it, expect } from 'vitest';
import { processInTextCitations } from '../../../resources/js/paste/utils/citation-linker';

const MAP = new Map(Object.entries({
  modi2014: 'modi2014', modi2019: 'modi2019', modi2023: 'modi2023',
  modi2024a: 'modi2024a', modi2024b: 'modi2024b', shah2024: 'shah2024',
  smith2001: 'smith2001', smith1990: 'smith1990', leibniz1646: 'leibniz1646',
  chacko2018: 'chacko2018',
}));

const anchors = (html) => [...html.matchAll(/<a href="#([^"]+)" class="in-text-citation">([^<]*)<\/a>/g)]
  .map((m) => [m[2], m[1]]);

const link = (html) => processInTextCitations(html, MAP, [], 'sage');

describe('paste citation linker — year ranges are date spans, not citations', () => {
  it('leaves a range after a possessive author entirely alone', () => {
    const out = link("<p>Rhetoric in Modi's first term (2014-2019) intensified.</p>");
    expect(anchors(out)).toEqual([]);
    expect(out).toContain('(2014-2019)');
  });

  it('handles every dash variant and the abbreviated tail form', () => {
    for (const span of ['1646-1716', '1646–1716', '1646—1716', '1646–47', '1646 - 1716']) {
      const out = link(`<p>Leibniz (${span}) was a polymath.</p>`);
      expect(anchors(out), span).toEqual([]);
    }
  });

  it('still links a genuine adjacent citation, possessive and all', () => {
    const out = link("<p>Modi's speech (Modi, 2019) and Chacko's (2018) argument.</p>");
    expect(anchors(out)).toEqual([['2019', 'modi2019'], ['2018', 'chacko2018']]);
  });

  it('does not suppress a real year because a PAGE range looks year-shaped', () => {
    const out = link('<p>As shown (Smith, 2001: 1990-1994).</p>');
    expect(anchors(out)).toEqual([['2001', 'smith2001']]);
    expect(out).toContain('1990-1994');
  });
});

describe('paste citation linker — one author, several works', () => {
  it('resolves every year of a multi-year list, not just the first', () => {
    const out = link('<p>He framed it thus (Modi, 2019, 2023).</p>');
    expect(anchors(out)).toEqual([['2019', 'modi2019'], ['2023', 'modi2023']]);
  });

  it('keeps letter-suffixed years apart', () => {
    const out = link('<p>As claimed (Modi, 2024a, 2024b).</p>');
    expect(anchors(out)).toEqual([['2024a', 'modi2024a'], ['2024b', 'modi2024b']]);
  });

  it('reproduces the live paragraph both defects were found in', () => {
    const out = link(
      "<p>While this rhetoric mostly took 'dog whistle' forms in Modi's first term (2014-2019), "
      + 'it intensified in its second term (2019-2024), spurred by crises '
      + '(Modi, 2024a, 2024b; Shah, 2024). He fashioned himself thus (Modi, 2019, 2023).</p>');
    expect(anchors(out)).toEqual([
      ['2024a', 'modi2024a'], ['2024b', 'modi2024b'], ['2024', 'shah2024'],
      ['2019', 'modi2019'], ['2023', 'modi2023'],
    ]);
    expect(out).toContain('(2014-2019)');
    expect(out).toContain('(2019-2024)');
  });
});
