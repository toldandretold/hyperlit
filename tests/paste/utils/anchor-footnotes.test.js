/**
 * Universal internal-link footnote detection.
 *
 * Regression source: book_1787965215968 — common-wealth.org named its anchors
 * `footnote-N`, which was not in the engine's five-word vocabulary, so 54
 * perfectly-formed footnotes went unlinked.
 */

import { describe, it, expect } from 'vitest';
import {
  applyAnchorFootnotes,
  extractFragment,
  maskDigits,
  parseMarkerNumber,
  resolveAnchorFootnotes,
} from '../../../resources/js/paste/utils/anchor-footnotes';

const domOf = (html) => {
  const dom = document.createElement('div');
  dom.innerHTML = html;
  return dom;
};

/** Body paragraphs long enough to look like prose, each carrying one marker. */
function bodyWithMarkers(markerHtml, count) {
  return Array.from({ length: count }, (_, i) =>
    `<p>Paragraph ${i + 1} makes a substantive claim about the subject at hand and cites a source for it${markerHtml(i + 1)}</p>`
  ).join('');
}

describe('parseMarkerNumber', () => {
  it.each([
    ['1', '1'],
    ['[1]', '1'],
    ['(1)', '1'],
    ['1.', '1'],
    ['1)', '1'],
    ['01', '1'],
    ['¹', '1'],
    ['¹²', '12'],
    ['*1', '1'],
    [' [12] ', '12'],
  ])('reads %s as %s', (input, expected) => {
    expect(parseMarkerNumber(input)).toBe(expected);
  });

  it.each(['', '   ', null, undefined, 'note', '†', '1a', '12345', 'see above'])(
    'returns null for %s',
    (input) => {
      expect(parseMarkerNumber(input)).toBeNull();
    },
  );
});

describe('extractFragment', () => {
  it('reads a bare fragment', () => {
    expect(extractFragment('#footnote-1')).toBe('footnote-1');
  });

  it('reads a fragment off an ABSOLUTE url — the case that broke common-wealth', () => {
    expect(extractFragment('https://www.common-wealth.org/publications/us-big-tech#footnote-1'))
      .toBe('footnote-1');
  });

  it.each(['#_ftn1', '#fn:1', '#cite_note-:0-12', '#fnref.1'])('accepts %s', (href) => {
    expect(extractFragment(href)).not.toBeNull();
  });

  it.each(['/publications/us-big-tech', '', null, '#', '#1numeric'])('rejects %s', (href) => {
    expect(extractFragment(href)).toBeNull();
  });
});

describe('maskDigits', () => {
  it('collapses a fragment to its family', () => {
    expect(maskDigits('pub-footnote-12')).toBe('pub-footnote-N');
    expect(maskDigits('cite_note-:0-12')).toBe('cite_note-:N-N');
    expect(maskDigits('_ftn1')).toBe('_ftnN');
  });
});

describe('resolveAnchorFootnotes — reciprocal', () => {
  const commonWealth = domOf(
    bodyWithMarkers(
      (n) => `<sup><a class="footnote" href="https://example.org/article#footnote-${n}" id="pub-footnote-${n}">[${n}]</a></sup>`,
      4,
    )
    + Array.from({ length: 4 }, (_, i) =>
      `<p><span id="footnote-${i + 1}"><a href="https://example.org/article#pub-footnote-${i + 1}">[${i + 1}]</a></span> The note text for entry ${i + 1}, long enough to count as a real note.</p>`
    ).join(''),
  );

  it('resolves the common-wealth shape through absolute hrefs', () => {
    const result = resolveAnchorFootnotes(commonWealth);
    expect(result.tier).toBe('reciprocal');
    expect(result.footnotes).toHaveLength(4);
    expect(result.footnotes.map((f) => f.ordinal)).toEqual(['1', '2', '3', '4']);
  });

  it('picks the BODY end as the marker, not the longer block', () => {
    // Marker paragraphs here are longer than the notes they point at, which is
    // why block text length cannot be the discriminator — document order is.
    const result = resolveAnchorFootnotes(commonWealth);
    result.footnotes.forEach((f) => {
      expect(f.markers[0].closest('sup')).not.toBeNull();
      expect(f.definitionBlock.textContent).toContain('The note text for entry');
    });
  });

  it('finds the identity on a PARENT element (the Wikipedia shape)', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<sup id="cite_ref-${n}"><a href="#cite_note-${n}">[${n}]</a></sup>`, 4)
      + '<ol>' + Array.from({ length: 4 }, (_, i) =>
        `<li id="cite_note-${i + 1}"><a href="#cite_ref-${i + 1}">^</a> A reference entry with enough text to be a real note.</li>`
      ).join('') + '</ol>',
    );
    const result = resolveAnchorFootnotes(dom);
    expect(result.tier).toBe('reciprocal');
    expect(result.footnotes).toHaveLength(4);
  });

  it('resolves ids that are invalid CSS selectors (MkDocs "fn:1")', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<sup id="fnref:${n}"><a href="#fn:${n}">${n}</a></sup>`, 3)
      + '<ol>' + Array.from({ length: 3 }, (_, i) =>
        `<li id="fn:${i + 1}"><p>A note with plenty of text in it. <a href="#fnref:${i + 1}">↩</a></p></li>`
      ).join('') + '</ol>',
    );
    expect(() => resolveAnchorFootnotes(dom)).not.toThrow();
    expect(resolveAnchorFootnotes(dom).footnotes).toHaveLength(3);
  });

  it('resolves ids carried on a[name] with no id (the Word shape)', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<a name="_ftnref${n}" href="#_ftn${n}"><span>[${n}]</span></a>`, 3)
      + Array.from({ length: 3 }, (_, i) =>
        `<div id="ftn${i + 1}"><p><a name="_ftn${i + 1}" href="#_ftnref${i + 1}">[${i + 1}]</a> A footnote with real content in it.</p></div>`
      ).join(''),
    );
    expect(resolveAnchorFootnotes(dom).footnotes).toHaveLength(3);
  });

  it('merges naming variants of ONE system before scoring density', () => {
    // MediaWiki writes plain refs as cite_ref-2 and NAMED refs as
    // cite_ref-auto4_1-0. They mask to different shapes but are one sequence.
    // Scored per variant the named subset here is 1, 3, 5 — density 0.6 on its
    // own, but the real failure is worse on a long article: the named subset of
    // a 21-note page reads 1,3,4,10,11,15 = 0.4 and was discarded, losing 6
    // notes to the reference extractor.
    const named = [1, 3, 5];
    const plain = [2, 4, 6];
    const marker = (id, target, n) => `<sup id="${id}"><a href="https://en.example.org/wiki/X#${target}">[${n}]</a></sup>`;
    const def = (id, target, n) => `<li id="${id}"><a href="https://en.example.org/wiki/X#${target}">^</a> Note number ${n}, with enough text to be real.</li>`;

    const dom = domOf(
      named.map((n) => `<p>Body paragraph making a claim.${marker(`cite_ref-auto${n}_1-0`, `cite_note-auto${n}-1`, n)}</p>`).join('')
      + plain.map((n) => `<p>Body paragraph making a claim.${marker(`cite_ref-${n}`, `cite_note-${n}`, n)}</p>`).join('')
      + '<ol>'
      + named.map((n) => def(`cite_note-auto${n}-1`, `cite_ref-auto${n}_1-0`, n)).join('')
      + plain.map((n) => def(`cite_note-${n}`, `cite_ref-${n}`, n)).join('')
      + '</ol>',
    );

    const result = resolveAnchorFootnotes(dom);
    expect(result.footnotes).toHaveLength(6);
    expect(result.footnotes.map((f) => f.ordinal).sort((a, b) => a - b)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('groups repeat citations onto one note', () => {
    const dom = domOf(
      '<p>First claim.<sup id="r1-0"><a href="#n1">[1]</a></sup> Second claim.<sup id="r1-1"><a href="#n1">[1]</a></sup></p>'
      + '<p>Third claim.<sup id="r2"><a href="#n2">[2]</a></sup></p>'
      + '<p>Fourth claim.<sup id="r3"><a href="#n3">[3]</a></sup></p>'
      + '<ol><li id="n1"><a href="#r1-0">^</a> The first note, cited twice, with real content.</li>'
      + '<li id="n2"><a href="#r2">^</a> The second note, with real content in it.</li>'
      + '<li id="n3"><a href="#r3">^</a> The third note, with real content in it.</li></ol>',
    );
    const result = resolveAnchorFootnotes(dom);
    expect(result.footnotes).toHaveLength(3);
    expect(result.footnotes[0].markers).toHaveLength(2);
  });

  it('rejects a cohort below the minimum size', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<sup><a id="m${n}" href="#d${n}">[${n}]</a></sup>`, 2)
      + '<p><span id="d1"><a href="#m1">1</a></span> A note.</p>'
      + '<p><span id="d2"><a href="#m2">2</a></span> Another note.</p>',
    );
    const result = resolveAnchorFootnotes(dom);
    expect(result.footnotes).toHaveLength(0);
    expect(result.rejected).toBe('cohort');
  });

  it('rejects a cohort whose numbers are too sparse to be a list', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<sup><a id="m${n * 40}" href="#d${n * 40}">[${n * 40}]</a></sup>`, 4)
      + Array.from({ length: 4 }, (_, i) =>
        `<p><span id="d${(i + 1) * 40}"><a href="#m${(i + 1) * 40}">${(i + 1) * 40}</a></span> A note with substantial content here.</p>`
      ).join(''),
    );
    expect(resolveAnchorFootnotes(dom).footnotes).toHaveLength(0);
  });

  it('returns nothing for a document with no internal links at all', () => {
    const dom = domOf('<p>Plain prose.</p><p><a href="https://example.org/">External link</a></p>');
    const result = resolveAnchorFootnotes(dom);
    expect(result.footnotes).toHaveLength(0);
    expect(result.rejected).toBe('no-edges');
  });

  it('is not fooled by an in-page table of contents', () => {
    const dom = domOf(
      '<nav><a href="#s1">One</a><a href="#s2">Two</a><a href="#s3">Three</a><a href="#s4">Four</a></nav>'
      + '<h2 id="s1">One</h2><p>Section text that runs on for a while and says something.</p>'
      + '<h2 id="s2">Two</h2><p>Section text that runs on for a while and says something.</p>'
      + '<h2 id="s3">Three</h2><p>Section text that runs on for a while and says something.</p>'
      + '<h2 id="s4">Four</h2><p>Section text that runs on for a while and says something.</p>',
    );
    expect(resolveAnchorFootnotes(dom).footnotes).toHaveLength(0);
  });
});

describe('resolveAnchorFootnotes — one-way', () => {
  it('resolves markers with no back-link', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<sup><a href="#note-${n}">[${n}]</a></sup>`, 4)
      + '<h2>Notes</h2>'
      + Array.from({ length: 4 }, (_, i) =>
        `<p id="note-${i + 1}">The note text for entry ${i + 1}, long enough to count as a real note.</p>`
      ).join(''),
    );
    const result = resolveAnchorFootnotes(dom);
    expect(result.tier).toBe('one-way');
    expect(result.footnotes).toHaveLength(4);
  });

  it('accepts a BARE number marker superscripted by CSS rather than <sup>', () => {
    // progressive.international: <a href="https://…/en/#ref-1" style="top:-4px">1</a>.
    // No <sup>, no back-link, no decoration. Rejecting a bare digit per-element
    // was right about a lone link and wrong about a cohort — the dense run into
    // substantial tail blocks is the evidence.
    const dom = domOf(
      Array.from({ length: 4 }, (_, i) =>
        `<p>A paragraph making a substantive claim and citing a source for it.<a href="https://example.org/article/en/#ref-${i + 1}" style="top: -4px">${i + 1}</a></p>`
      ).join('')
      + '<h2>References</h2>'
      + Array.from({ length: 4 }, (_, i) =>
        `<div id="ref-${i + 1}"><span>0${i + 1}</span><div>Bret Benjamin, "Bookend to Bandung," Humanity 6, no. 1 (2015), 44.</div></div>`
      ).join(''),
    );
    const result = resolveAnchorFootnotes(dom);
    expect(result.tier).toBe('one-way');
    expect(result.footnotes).toHaveLength(4);
  });

  it('does NOT treat a "References" heading alone as proof of a bibliography', () => {
    // Chicago notes lead with a forename ("Bret Benjamin,") or with "See…";
    // bibliography entries lead "Surname, Forename". The heading is the same
    // word either way, so the entries have to corroborate.
    const dom = domOf(
      Array.from({ length: 4 }, (_, i) =>
        `<p>A paragraph making a substantive claim and citing a source.<a href="#ref-${i + 1}">${i + 1}</a></p>`
      ).join('')
      + '<h2>References</h2>'
      + '<p id="ref-1">See the special issue, "Toward a History of the New International Economic Order."</p>'
      + '<p id="ref-2">Bret Benjamin, "Bookend to Bandung," Humanity 6, no. 1 (2015), 44.</p>'
      + '<p id="ref-3">See Jorge Alberto Lozoya and Hector Cuadra, eds, Africa and the NIEO (New York: Pergamon, 1980).</p>'
      + '<p id="ref-4">"Summary of Address Given at the 92nd Plenary Meeting, April 19, 1972."</p>',
    );
    expect(resolveAnchorFootnotes(dom).footnotes).toHaveLength(4);
  });

  it('DEFERS to the reference extractor when the targets are a bibliography', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<a href="#ref-${n}">[${n}]</a>`, 4)
      + '<h2>References</h2>'
      + '<p id="ref-1">Ostrom, Elinor (1990) Governing the Commons. Cambridge University Press.</p>'
      + '<p id="ref-2">Marcuse, H. 1964. One-Dimensional Man. Boston: Beacon Press.</p>'
      + '<p id="ref-3">Scott, James C. (1998) Seeing Like a State. Yale University Press.</p>'
      + '<p id="ref-4">Dalrymple, William. The Anarchy. London: Bloomsbury, 2019.</p>',
    );
    const result = resolveAnchorFootnotes(dom);
    expect(result.footnotes).toHaveLength(0);
    expect(result.rejected).toBe('bibliography');
  });
});

describe('applyAnchorFootnotes', () => {
  it('rewrites markers to the canonical <sup fn-count-id> shape', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<sup><a href="#d${n}" id="m${n}">[${n}]</a></sup>`, 3)
      + Array.from({ length: 3 }, (_, i) =>
        `<p><span id="d${i + 1}"><a href="#m${i + 1}">^</a></span> A note with real content in it.</p>`
      ).join(''),
    );
    const resolved = resolveAnchorFootnotes(dom).footnotes;
    applyAnchorFootnotes(resolved);

    const markers = dom.querySelectorAll('sup[fn-count-id]');
    expect(markers).toHaveLength(3);
    expect(markers[0].getAttribute('fn-count-id')).toBe('1');
    expect(markers[0].textContent).toBe('1');
    // No leftover anchor, and no <sup> nested inside a <sup>.
    expect(markers[0].querySelector('a')).toBeNull();
    expect(dom.querySelector('sup sup')).toBeNull();
  });

  it('prunes the back-link and the husk it leaves behind', () => {
    const dom = domOf(
      bodyWithMarkers((n) => `<sup><a href="#d${n}" id="m${n}">[${n}]</a></sup>`, 3)
      + Array.from({ length: 3 }, (_, i) =>
        `<p><span id="d${i + 1}"><a href="#m${i + 1}">^</a></span> A note with real content in it.</p>`
      ).join(''),
    );
    const resolved = resolveAnchorFootnotes(dom).footnotes;
    applyAnchorFootnotes(resolved);

    resolved.forEach((f) => {
      expect(f.definitionBlock.querySelector('a')).toBeNull();
      // The empty <span> wrapper goes with it, so the note doesn't start with a stray "^".
      expect(f.definitionBlock.textContent.trim()).toMatch(/^A note with real content/);
    });
  });
});
