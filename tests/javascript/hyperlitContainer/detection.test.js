/**
 * Characterization tests for hyperlitContainer content-type detection — pins the
 * click-classification logic (footnote / citation / hypercite-citation / highlight)
 * that the container orchestrator depends on, BEFORE the JS→TS conversion.
 * These are the DOM-pure detectors; detectHypercites' IDB fallback is left to e2e.
 */
import { describe, it, expect } from 'vitest';

import {
  detectFootnote,
  detectCitation,
  detectHyperciteCitation,
  detectHighlights,
  detectContentTypes,
} from '../../../resources/js/hyperlitContainer/detection';

function mount(html) {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('detectFootnote', () => {
  it('detects a new-format sup[fn-count-id] and reads id + count + parent book', () => {
    const root = mount('<div data-book-id="book_42"><sup fn-count-id="3" id="b_Fn9" class="footnote-ref">3</sup></div>');
    const sup = root.querySelector('sup');
    const data = detectFootnote(sup);
    expect(data).toMatchObject({
      type: 'footnote',
      fnCountId: '3',
      footnoteId: 'b_Fn9',
      parentBookId: 'book_42',
    });
    expect(data.element).toBe(sup);
  });

  it('detects an old-format anchor inside a sup and returns the sup as element', () => {
    const root = mount('<sup fn-count-id="2" id="b_Fn1"><a class="footnote-ref" href="#b_Fn1">2</a></sup>');
    const anchor = root.querySelector('a');
    const data = detectFootnote(anchor);
    expect(data.type).toBe('footnote');
    expect(data.element).toBe(root.querySelector('sup'));
    expect(data.fnCountId).toBe('2');
  });

  it('falls back to the closest sup when clicking a wrapper inside it', () => {
    const root = mount('<sup fn-count-id="5" id="b_Fn5" class="footnote-ref"><span>5</span></sup>');
    const span = root.querySelector('span');
    expect(detectFootnote(span).footnoteId).toBe('b_Fn5');
  });

  it('returns null when there is no footnote', () => {
    const root = mount('<p>plain</p>');
    expect(detectFootnote(root.querySelector('p'))).toBeNull();
  });
});

describe('detectCitation', () => {
  it('detects an old-style in-text-citation with a # href', () => {
    const root = mount('<a class="in-text-citation" href="#Ref123" data-refs="Ref123,Ref124">(x)</a>');
    const data = detectCitation(root.querySelector('a'));
    expect(data).toMatchObject({ type: 'citation', referenceId: 'Ref123' });
    expect(data.referenceIds).toEqual(['Ref123', 'Ref124']);
  });

  it('detects a new-style Ref-id citation-ref anchor', () => {
    const root = mount('<a id="Ref999" class="citation-ref">2020</a>');
    expect(detectCitation(root.querySelector('a')).referenceId).toBe('Ref999');
  });

  it('detects when clicking inside an in-text-citation', () => {
    const root = mount('<a class="in-text-citation" href="#Ref7"><em>e</em></a>');
    expect(detectCitation(root.querySelector('em')).referenceId).toBe('Ref7');
  });

  it('returns null for a non-citation anchor', () => {
    const root = mount('<a href="/somewhere">link</a>');
    expect(detectCitation(root.querySelector('a'))).toBeNull();
  });
});

describe('detectHyperciteCitation', () => {
  it('extracts the hypercite id and target book from a #hypercite_ link', () => {
    const root = mount('<a href="http://localhost/book_77/2#hypercite_abc">cite</a>');
    const data = detectHyperciteCitation(root.querySelector('a'));
    expect(data).toMatchObject({
      type: 'hypercite-citation',
      targetBook: 'book_77',
      targetHyperciteId: 'hypercite_abc',
      isHyperlightURL: false,
    });
  });

  it('flags a hyperlight URL and counts HL_ depth', () => {
    const root = mount('<a href="http://localhost/book_77/2/HL_aaa/HL_bbb#hypercite_xyz">cite</a>');
    const data = detectHyperciteCitation(root.querySelector('a'));
    expect(data.targetBook).toBe('book_77');
    expect(data.isHyperlightURL).toBe(true);
    expect(data.hlDepth).toBe(2);
  });

  it('for a non-footnote link, targetSubBook equals targetBook', () => {
    const root = mount('<a href="http://localhost/book_77/2#hypercite_abc">cite</a>');
    const data = detectHyperciteCitation(root.querySelector('a'));
    expect(data.targetSubBook).toBe('book_77');
  });

  // Regression: a hypercite INSIDE a footnote is keyed under the sub-book
  // (`foundation/Fn…`), not the foundation. Resolving it against the foundation
  // 404'd → "This citation record no longer exists" on a record that exists.
  it('resolves a footnote hypercite to its sub-book id (foundation/Fn…)', () => {
    const root = mount('<a href="http://localhost/halloweenI/Fn1784511004812_pcrr#hypercite_l9w16cl">cite</a>');
    const data = detectHyperciteCitation(root.querySelector('a'));
    expect(data.isFootnoteURL).toBe(true);
    expect(data.targetBook).toBe('halloweenI');
    expect(data.targetSubBook).toBe('halloweenI/Fn1784511004812_pcrr');
  });

  it('drops page-number and HL_ segments from a footnote sub-book id', () => {
    const root = mount('<a href="http://localhost/book_77/2/Fn123_abc/HL_zzz#hypercite_q">cite</a>');
    const data = detectHyperciteCitation(root.querySelector('a'));
    expect(data.isFootnoteURL).toBe(true);
    expect(data.targetBook).toBe('book_77');
    expect(data.targetSubBook).toBe('book_77/Fn123_abc');
  });

  it('returns null when no #hypercite_ hash is present', () => {
    const root = mount('<a href="http://localhost/book_77/2">x</a>');
    expect(detectHyperciteCitation(root.querySelector('a'))).toBeNull();
  });
});

describe('detectHighlights', () => {
  it('reads HL_ classes off a clicked mark', async () => {
    const root = mount('<mark class="HL_aaa HL_bbb other">t</mark>');
    const data = await detectHighlights(root.querySelector('mark'));
    expect(data.type).toBe('highlight');
    expect(data.highlightIds).toEqual(['HL_aaa', 'HL_bbb']);
  });

  it('climbs to a parent mark when clicking inside it', async () => {
    const root = mount('<mark class="HL_zzz"><span>t</span></mark>');
    const data = await detectHighlights(root.querySelector('span'));
    expect(data.highlightIds).toEqual(['HL_zzz']);
    expect(data.element).toBe(root.querySelector('mark'));
  });

  it('honours provided highlight ids without touching the DOM', async () => {
    const root = mount('<p>plain</p>');
    const data = await detectHighlights(root.querySelector('p'), ['HL_given']);
    expect(data.highlightIds).toEqual(['HL_given']);
  });

  it('returns null when there is no highlight', async () => {
    const root = mount('<p>plain</p>');
    expect(await detectHighlights(root.querySelector('p'))).toBeNull();
  });
});

describe('detectContentTypes (orchestrator)', () => {
  it('collects a footnote AND a highlight present on the same clicked element', async () => {
    const root = mount('<mark class="HL_q"><sup fn-count-id="1" id="b_Fn1" class="footnote-ref">1</sup></mark>');
    const mark = root.querySelector('mark');
    const types = await detectContentTypes(mark);
    const kinds = types.map(t => t.type).sort();
    expect(kinds).toEqual(['footnote', 'highlight']);
  });
});
