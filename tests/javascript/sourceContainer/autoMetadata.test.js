/**
 * autoMetadata/local — the FREE tier of the source panel's wand. Pure functions,
 * no DOM mounting and no mocks: call them with a library record and an array of
 * node records.
 *
 * The load-bearing assertion here is the `titleIsUsable` table, which pins the
 * client predicate to CanonicalSourceMatcher::hasUsableTitle(). The wand's whole
 * job is flipping that server gate from false to true, so if the two drift the
 * feature either refuses to help or hands the canonical matcher junk.
 */
import { describe, it, expect } from 'vitest';

import {
  titleIsUsable,
  headingIsPlausibleTitle,
  headingCandidate,
  truncateToWords,
  copyrightYear,
  authorIsDefault,
  proposeLocalMetadata,
  proposeFromAi,
} from '../../../resources/js/components/sourceContainer/autoMetadata/local';

import * as titleQuality from '../../../resources/js/utilities/titleQuality';

const node = (content, i = 0) => ({ book: 'b', startLine: i, chunk_id: i, node_id: `n${i}`, content });
const field = (proposal, name) => proposal.fields.find((f) => f.field === name);

describe('the title bar is shared, not copied', () => {
  // The wand and the typing-time first-node sync (indexedDB/core/library.ts)
  // must apply the SAME rules — they didn't originally, which is how a
  // half-typed heading got locked in as a book's title while the wand then
  // refused to touch the result. Both import utilities/titleQuality; this fails
  // if someone re-inlines a private copy into either side.
  it('local.ts re-exports the shared predicates rather than defining its own', () => {
    expect(titleIsUsable).toBe(titleQuality.titleIsUsable);
    expect(headingIsPlausibleTitle).toBe(titleQuality.headingIsPlausibleTitle);
    expect(truncateToWords).toBe(titleQuality.truncateToWords);
  });
});

describe('titleIsUsable — must agree with CanonicalSourceMatcher::hasUsableTitle', () => {
  // One row per branch of the PHP predicate, in its order.
  it.each([
    ['', false, 'empty'],
    ['   ', false, 'whitespace only'],
    ['abc', false, 'under 5 bytes'],
    ['Untitled', false, 'the new-book placeholder'],
    ['untitled', false, 'placeholder, case-insensitive'],
    ['New Book', false, 'placeholder variant'],
    ['new document', false, 'placeholder variant'],
    ['draft', false, 'placeholder variant'],
    ['test', false, 'placeholder variant'],
    ['sample', false, 'placeholder variant'],
    ['12345', false, 'all digits'],
    ['  42  99 ', false, 'digits and spaces'],
    ['aaaaaa', false, 'one repeated character'],
    ['Capital', true, 'an ordinary word over 5 bytes'],
    ['The Wretched of the Earth', true, 'a real title'],
    ['Untitled Symphony No. 3', true, 'starts with the junk word but is not it'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(titleIsUsable(input)).toBe(expected);
  });

  it('counts BYTES like PHP strlen, not UTF-16 units', () => {
    // 4 CJK characters = 12 UTF-8 bytes, so the server accepts it; the client
    // must too, or it would refuse to propose a title PHP would have taken.
    expect(titleIsUsable('資本論だ')).toBe(true);
  });
});

describe('headingIsPlausibleTitle — the structural blocklist', () => {
  it.each([
    'Contents',
    'Table of Contents',
    'Introduction',
    'Preface',
    'Abstract',
    'Bibliography',
    'References',
    'Works Cited',
    'Acknowledgements',
    'Acknowledgments',
    'Appendix',
    'Chapter 3',
    'Chapter IV',
    'Part II',
    'Section 4.2',
    'Skip to content',
  ])('rejects the structural heading %s', (h) => {
    expect(headingIsPlausibleTitle(h)).toBe(false);
  });

  it('rejects short all-caps nav chrome but keeps a long all-caps title', () => {
    expect(headingIsPlausibleTitle('MENU')).toBe(false);
    expect(headingIsPlausibleTitle('LOG IN')).toBe(false);
    expect(headingIsPlausibleTitle('THE COMMUNIST MANIFESTO')).toBe(true);
  });

  it('rejects a heading longer than 300 chars', () => {
    expect(headingIsPlausibleTitle('a b '.repeat(200))).toBe(false);
  });

  it('accepts a title that merely CONTAINS a structural word', () => {
    // The blocklist is anchored — only the bare word is chrome.
    expect(headingIsPlausibleTitle('Introduction to Political Economy')).toBe(true);
    expect(headingIsPlausibleTitle('Notes on the Synthesis of Form')).toBe(true);
  });
});

describe('headingCandidate', () => {
  it('takes the first h1', () => {
    const got = headingCandidate([node('<p>preamble</p>'), node('<h1>The Dispossessed</h1>', 1)]);
    expect(got).toEqual({ text: 'The Dispossessed', level: 1 });
  });

  it('falls back to an h2 when there is no h1', () => {
    const got = headingCandidate([node('<h2>Capital, Volume One</h2>')]);
    expect(got).toEqual({ text: 'Capital, Volume One', level: 2 });
  });

  it('prefers a later h1 over an earlier h2', () => {
    const got = headingCandidate([node('<h2>Front Matter Blurb</h2>'), node('<h1>Orientalism</h1>', 1)]);
    expect(got).toEqual({ text: 'Orientalism', level: 1 });
  });

  it('does NOT fall back to an h3 — it is almost always a sub-sub heading', () => {
    expect(headingCandidate([node('<h3>Some Minor Subsection</h3>')])).toBeNull();
  });

  it('skips a junk h1 and keeps looking', () => {
    const got = headingCandidate([node('<h1>Contents</h1>'), node('<h1>The Wretched of the Earth</h1>', 1)]);
    expect(got).toEqual({ text: 'The Wretched of the Earth', level: 1 });
  });

  it('strips footnote sups and hypercite arrows from the heading text', () => {
    const got = headingCandidate([node('<h1>Orientalism<sup class="footnote-marker">1</sup></h1>')]);
    expect(got.text).toBe('Orientalism');
  });

  it('returns null for an empty book', () => {
    expect(headingCandidate([])).toBeNull();
  });

  it('only scans the opening — an h1 far in is not the title', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => node('<p>body</p>', i));
    nodes.push(node('<h1>A Late Heading</h1>', 40));
    expect(headingCandidate(nodes)).toBeNull();
  });
});

describe('truncateToWords — mirrors the server\'s 15-word cap', () => {
  it('leaves a short title alone', () => {
    expect(truncateToWords('The Dispossessed')).toBe('The Dispossessed');
  });

  it('cuts at 15 words and marks the cut, byte-for-byte as the server does', () => {
    // Server: implode(' ', array_slice($words, 0, 15)) . '...' — the ellipsis
    // hangs off the 15th word, so there are 15 space-separated tokens.
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    const got = truncateToWords(long);
    expect(got.split(' ').length).toBe(15);
    expect(got.endsWith('w14...')).toBe(true);
    expect(got.startsWith('w0 w1')).toBe(true);
    expect(got).not.toContain('w15');
  });
});

describe('copyrightYear', () => {
  it('reads a © line', () => {
    expect(copyrightYear('Some front matter\n© 1972 Penguin Books\nmore')).toBe('1972');
  });

  it('reads the word "copyright"', () => {
    expect(copyrightYear('Copyright 1867 by the author')).toBe('1867');
  });

  it('reads a bare year alone on its line', () => {
    expect(copyrightYear('Verso\n\n1989\n\nLondon')).toBe('1989');
  });

  it('ignores a date inside prose — that is not a publication year', () => {
    expect(copyrightYear('I remember the summer of 1968 very clearly indeed.')).toBeNull();
  });

  it('returns null when there is no year at all', () => {
    expect(copyrightYear('just some words')).toBeNull();
  });
});

describe('authorIsDefault', () => {
  it.each([
    [{ author: '' }, true, 'empty'],
    [{ author: 'anon' }, true, 'the anonymous placeholder'],
    [{ author: 'Anonymous' }, true, 'the anonymous placeholder, cased'],
    [{ author: 'alice', creator: 'alice' }, true, 'still equal to the creator'],
    [{ author: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' }, true, 'a leaked creator token'],
    [{ author: 'Ursula K. Le Guin', creator: 'alice' }, false, 'a name a human chose'],
  ])('%#: %s', (record, expected) => {
    expect(authorIsDefault(record)).toBe(expected);
  });
});

describe('proposeLocalMetadata', () => {
  const fresh = { book: 'b1', title: 'Untitled', author: 'anon', year: '2026', creator: 'alice' };

  it('proposes the first heading as the title of a fresh book', () => {
    const p = proposeLocalMetadata(fresh, [node('<h1>The Dispossessed</h1>')], 'alice');
    expect(field(p, 'title')).toMatchObject({
      current: 'Untitled',
      suggested: 'The Dispossessed',
      confidence: 'high',
      provenance: 'first heading',
    });
  });

  // Offered, because the heading really is the document's own title — but
  // UNTICKED, because replacing something deliberate should take a decision.
  it('offers to replace a deliberate title, but leaves the row unticked', () => {
    const p = proposeLocalMetadata(
      { ...fresh, title: 'A Title I Typed Myself' },
      [node('<h1>Some Other Heading</h1>')],
      'alice',
    );
    expect(field(p, 'title')).toMatchObject({
      current: 'A Title I Typed Myself',
      suggested: 'Some Other Heading',
      checked: false,
    });
  });

  it('ticks the title row when it is filling a placeholder', () => {
    const p = proposeLocalMetadata(fresh, [node('<h1>The Dispossessed</h1>')], 'alice');
    expect(field(p, 'title').checked).toBe(true);
  });

  it('says so when the title already matches the heading', () => {
    const p = proposeLocalMetadata(
      { ...fresh, title: 'The Dispossessed' },
      [node('<h1>The Dispossessed</h1>')],
      'alice',
    );
    expect(field(p, 'title')).toBeUndefined();
    expect(p.notes.join(' ')).toMatch(/already matches the heading/i);
  });

  // A short title is the user's business, full stop. Not everyone is writing an
  // academic text — someone who just wants their own details right must not be
  // lectured about OpenAlex, so the card says nothing about the lookup floor.
  it.each([['Aura'], ['It'], ['1984'], ['mmmm']])('accepts the short title %s without comment', (title) => {
    const p = proposeLocalMetadata(fresh, [node(`<h1>${title}</h1>`)], 'alice');
    expect(field(p, 'title')).toMatchObject({ suggested: title });
    const note = p.notes.join(' ');
    expect(note).not.toMatch(/can.t be used as a title/i);
    expect(note).not.toMatch(/bibliographic databases|too short|check source/i);
  });

  it('truncates a long heading exactly as the server would store it', () => {
    const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const p = proposeLocalMetadata(fresh, [node(`<h1>${long}</h1>`)], 'alice');
    expect(field(p, 'title').suggested).toBe(truncateToWords(long));
  });

  it('proposes the username as author when the viewer is the creator', () => {
    const p = proposeLocalMetadata(fresh, [node('<h1>The Dispossessed</h1>')], 'alice');
    expect(field(p, 'author')).toMatchObject({ suggested: 'alice', provenance: 'your account' });
  });

  it('never puts your name on someone else\'s card', () => {
    const p = proposeLocalMetadata({ ...fresh, creator: 'bob' }, [node('<h1>The Dispossessed</h1>')], 'alice');
    expect(field(p, 'author')).toBeUndefined();
  });

  it('leaves an author the user typed alone', () => {
    const p = proposeLocalMetadata({ ...fresh, author: 'Ursula K. Le Guin' }, [node('<h1>x</h1>')], 'alice');
    expect(field(p, 'author')).toBeUndefined();
  });

  it('prefers a copyright year over the year the book was created', () => {
    // Without this the citation line keeps saying (2026) for a pasted 1972 essay
    // — the wrongest field on the card.
    const p = proposeLocalMetadata(fresh, [node('<h1>Ways of Seeing</h1>'), node('<p>© 1972 Penguin</p>', 1)], 'alice');
    expect(field(p, 'year')).toMatchObject({ current: '2026', suggested: '1972', provenance: 'copyright line' });
  });

  it('does not propose a year when the record already has one and the text states none', () => {
    const p = proposeLocalMetadata(fresh, [node('<h1>Ways of Seeing</h1>')], 'alice');
    expect(field(p, 'year')).toBeUndefined();
  });

  it('proposes nothing but explains itself for an empty book', () => {
    const p = proposeLocalMetadata(fresh, [], 'alice');
    expect(field(p, 'title')).toBeUndefined();
    expect(p.notes.join(' ')).toMatch(/no text yet/i);
  });

  it('explains itself when the text has no heading at all', () => {
    const p = proposeLocalMetadata(fresh, [node('<p>just a paragraph</p>')], 'alice');
    expect(field(p, 'title')).toBeUndefined();
    expect(p.notes.join(' ')).toMatch(/no heading/i);
  });

  // "No heading found" is a lie when the document plainly opens with one — say
  // what was found and why it was turned down.
  it.each([
    ['<h1>Introduction</h1>', 'Introduction', /section heading/i],
    ['<h1>Contents</h1>', 'Contents', /section heading/i],
    ['<h1>Untitled</h1>', 'Untitled', /placeholder/i],
    ['<h1>MAIN MENU</h1>', 'MAIN MENU', /navigation label/i],
    [`<h1>${'word '.repeat(120)}</h1>`, 'word', /paragraph rather than a title/i],
  ])('names the heading it rejected and why: %s', (html, text, reasonRe) => {
    const p = proposeLocalMetadata(fresh, [node(html)], 'alice');
    expect(field(p, 'title')).toBeUndefined();
    const note = p.notes.join(' ');
    expect(note).toContain(text);
    expect(note).toMatch(reasonRe);
    expect(note).not.toMatch(/no heading found/i);
  });

  it('never emits a row with an empty suggestion (so Apply can never clear a field)', () => {
    const p = proposeLocalMetadata(fresh, [node('<h1>The Dispossessed</h1>')], 'alice');
    expect(p.fields.length).toBeGreaterThan(0);
    for (const f of p.fields) expect(f.suggested).not.toBe('');
  });
});

describe('proposeFromAi', () => {
  const fresh = { book: 'b1', title: 'Untitled', author: 'anon', year: '2026', creator: 'alice' };
  const ai = (over = {}) => ({
    title: null, author: null, year: null, type: null, journal: null,
    publisher: null, self_authored: false, confidence: 'high', ...over,
  });

  it('drops null fields', () => {
    const p = proposeFromAi(fresh, ai({ title: 'Ways of Seeing' }), 'alice');
    expect(field(p, 'title').suggested).toBe('Ways of Seeing');
    expect(field(p, 'journal')).toBeUndefined();
    expect(field(p, 'publisher')).toBeUndefined();
  });

  it('uses the author the text names', () => {
    const p = proposeFromAi(fresh, ai({ author: 'John Berger' }), 'alice');
    expect(field(p, 'author')).toMatchObject({ suggested: 'John Berger', provenance: 'read from the text' });
  });

  it('falls back to your account when the text is your own unsigned note', () => {
    // self_authored is the "these are somebody's notes and no author is named"
    // signal — the model must not invent a byline for it.
    const p = proposeFromAi(fresh, ai({ author: 'Someone Invented', self_authored: true }), 'alice');
    expect(field(p, 'author')).toMatchObject({ suggested: 'alice', provenance: 'your account' });
  });

  it('forces type=article when a journal comes back', () => {
    // generateBibtexFromForm filters keys by type, and `misc` drops journal —
    // without this the journal would silently vanish from the bibtex.
    const p = proposeFromAi(fresh, ai({ journal: 'New Left Review' }), 'alice');
    expect(field(p, 'journal').suggested).toBe('New Left Review');
    expect(field(p, 'type').suggested).toBe('article');
  });

  it('forces type=book when a publisher comes back on an untyped record', () => {
    const p = proposeFromAi({ ...fresh, type: 'misc' }, ai({ publisher: 'Verso' }), 'alice');
    expect(field(p, 'type').suggested).toBe('book');
  });

  it('still refuses a junk title from the AI', () => {
    const p = proposeFromAi(fresh, ai({ title: 'Contents' }), 'alice');
    expect(field(p, 'title')).toBeUndefined();
  });

  it('offers a replacement for a title the user typed, but unticked', () => {
    const p = proposeFromAi({ ...fresh, title: 'My Own Title' }, ai({ title: 'Something Else' }), 'alice');
    expect(field(p, 'title')).toMatchObject({ suggested: 'Something Else', checked: false });
  });

  it('ticks the title row when filling a placeholder', () => {
    const p = proposeFromAi(fresh, ai({ title: 'Ways of Seeing' }), 'alice');
    expect(field(p, 'title').checked).toBe(true);
  });
});
