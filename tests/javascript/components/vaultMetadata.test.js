// Vault metadata: what a dropped folder SAYS about its notes, and what the
// importer does with it. Fixtures are real excerpts from a vault exported by
// Hyperlit ("Decolonising Security"). Pins:
//  - parseFrontMatter reads the exporter's scalars + lists, returns the body
//    without the block, and refuses anything that only LOOKS like one (a
//    document opening with a horizontal rule must not lose its first section);
//  - parseBibFile splits a multi-entry file with nested braces;
//  - metadataForNote: front matter wins per field, the .bib fills gaps, the
//    stored bibtex drops the vault-only `file` field and never keeps the
//    ORIGINAL book's Hyperlit URL as the work's url;
//  - identity hints (book / hyperlit URL / DOI / hypercite targets) and the
//    export-hub README test;
//  - buildIngestPlan wiring: .bib is metadata not an upload, the hub README
//    and empty notes are skipped AND reported, manifest.json still wins;
//  - the resolve step: forced-existing for hypercite-involved books, the
//    existing/own split, and a failed lookup degrading to "all new";
//  - the uploader: existing_books on the register call, version_of + the new
//    metadata keys on the file POST, and an all-existing drop making ZERO
//    uploads.
//  - a SINGLE note: forceBatch plans it as one bundle (metadata + identity
//    intact), decideSingleNote offers existing / own, withholds "own" when the
//    note carries hypercites, and stays silent for a note we don't hold;
//    "existing" with no open shelf files the book on "Imported works".

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  parseFrontMatter,
  parseBibFile,
  indexBibEntries,
  bibEntryFor,
  metadataForNote,
  identityForNote,
  isExportHubNote,
  hyperciteTargetsIn,
  normaliseDoi,
} from '../../../resources/js/components/importQueue/vaultMetadata';
import { buildIngestPlan } from '../../../resources/js/components/importQueue/folderIngest';
import {
  resolveExistingBooks,
  forcedExisting,
  applyChoice,
  decideSingleNote,
} from '../../../resources/js/components/importQueue/vaultResolve';
import { uploadBatch } from '../../../resources/js/components/importQueue/batchUploader';

const GABRIEL_NOTE = `---
title: "Abolition as Method"
citekey: "gabriel2022abolition"
aliases:
  - "@gabriel2022abolition"
authors:
  - "Kay Gabriel"
year: "2022"
publisher: "Dissent Magazine"
source: "https://www.dissentmagazine.org/article/abolition-as-method/"
license: "CC-BY-SA-4.0-NO-AI"
hyperlit: "https://hyperlit.io/abolition-as-method-gabriel-2022"
archive: "https://hyperlit.io/a/decolonising-security"
exported: "2026-11-15"
---

# Abolition as Method

Ruth Wilson Gilmore’s *Abolition Geography* is written to be used.
`;

const LANGLEY_NOTE = `---
title: "Platform capitalism: The intermediation and capitalisation of digital economic circulation"
citekey: "langley2017platform"
authors:
  - "Paul Langley"
  - "Andrew Leyshon"
year: "2017"
journal: "Finance and Society"
volume: "3"
issue: "1"
doi: "10.2218/finsoc.v3i1.1936"
source: "https://doi.org/10.2218/finsoc.v3i1.1936"
language: "en"
license: "CC-BY-NC-ND-4.0"
hyperlit: "https://hyperlit.io/4c86a05c-5746-4da2-8307-bb5388dda134"
book: "4c86a05c-5746-4da2-8307-bb5388dda134"
---

Body text.[^1]

[^1]: Black Panther Party, “[October 1966 Platform](https://hyperlit.io/book_1761013446163#hypercite_oleuzq0)”, 1966.
`;

const README_HUB = `---
title: "Decolonising Security"
hyperlit: "https://hyperlit.io/a/decolonising-security"
exported: "2026-11-15"
---

Welcome. See the [course overview](Overview.md).
`;

const REFERENCES_BIB = `@misc{chacko2026decolonising,
  author = {Hyperlit \\& Priya Chacko},
  title = {Decolonising Security: Digital Commons},
  year = {2026},
  url = {https://hyperlit.io/decolonising-security-digital-commons-2026},
  file = {Hyperlit & Priya Chacko - Decolonising Security Digital Commons.md},
}

@book{gabriel2022abolition,
  author = {Kay Gabriel},
  title = {Abolition as {M}ethod},
  year = {2022},
  publisher = {Dissent Magazine},
  url = {https://hyperlit.io/abolition-as-method-gabriel-2022},
  file = {Kay Gabriel - Abolition as Method.md},
}

@article{langley2017platform,
  author = {Paul Langley and Andrew Leyshon},
  title = {Platform capitalism},
  year = {2017},
  journal = {Finance and Society},
  number = {1},
  pages = {11--31},
  doi = {10.2218/finsoc.v3i1.1936},
  url = {https://hyperlit.io/4c86a05c-5746-4da2-8307-bb5388dda134},
  file = {Paul Langley; Andrew Leyshon - Platform capitalism.md},
}
`;

const file = (name, text, type = 'text/markdown') => new File([text], name, { type });
const collected = (f, relPath = null) => ({ file: f, relPath: relPath || f.name });

describe('parseFrontMatter', () => {
  test('reads the exporter’s scalars and lists, and returns the body without the block', () => {
    const fm = parseFrontMatter(GABRIEL_NOTE);
    expect(fm.hasBlock).toBe(true);
    expect(fm.fields.title).toBe('Abolition as Method');
    expect(fm.fields.authors).toEqual(['Kay Gabriel']);
    expect(fm.fields.aliases).toEqual(['@gabriel2022abolition']);
    expect(fm.fields.hyperlit).toBe('https://hyperlit.io/abolition-as-method-gabriel-2022');
    expect(fm.body.startsWith('# Abolition as Method')).toBe(true);
    expect(fm.body).not.toContain('citekey');
  });

  test('unescapes quoted values, reads bare values and inline lists', () => {
    const fm = parseFrontMatter('---\ntitle: "He said \\"no\\""\nyear: 1981\ntags: [a, "b c", d]\n---\nBody');
    expect(fm.fields.title).toBe('He said "no"');
    expect(fm.fields.year).toBe('1981');
    expect(fm.fields.tags).toEqual(['a', 'b c', 'd']);
    expect(fm.body).toBe('Body');
  });

  test('a document that merely opens with a horizontal rule is left untouched', () => {
    const prose = '---\nThis is the opening paragraph of an essay, not metadata.\n\n---\n\nSecond section.';
    const fm = parseFrontMatter(prose);
    expect(fm.hasBlock).toBe(false);
    expect(fm.body).toBe(prose);
  });

  test('no block, an unclosed block and an empty block all read as no front matter', () => {
    expect(parseFrontMatter('# Heading\n\ntext').hasBlock).toBe(false);
    expect(parseFrontMatter('---\ntitle: x\nno closing rule').hasBlock).toBe(false);
    expect(parseFrontMatter('---\n---\nbody').hasBlock).toBe(false);
  });
});

describe('parseBibFile', () => {
  test('splits a multi-entry file, keeping nested braces inside one entry', () => {
    const entries = parseBibFile(REFERENCES_BIB);
    expect(entries.map((e) => e.key)).toEqual(['chacko2026decolonising', 'gabriel2022abolition', 'langley2017platform']);
    expect(entries[1].type).toBe('book');
    expect(entries[1].fields.title).toBe('Abolition as {M}ethod');
    expect(entries[2].fields.doi).toBe('10.2218/finsoc.v3i1.1936');
  });

  test('skips @comment / @string blocks and an unterminated tail', () => {
    const entries = parseBibFile('@comment{ignored}\n@string{x = "y"}\n@book{ok, title = {T}}\n@book{broken, title = {never closes');
    expect(entries.map((e) => e.key)).toEqual(['ok']);
  });

  test('pairs an entry by its file field, then citekey, then a @citekey filename', () => {
    const index = indexBibEntries(parseBibFile(REFERENCES_BIB));
    expect(bibEntryFor(index, 'Kay Gabriel - Abolition as Method.md', null)?.key).toBe('gabriel2022abolition');
    expect(bibEntryFor(index, 'renamed.md', parseFrontMatter(GABRIEL_NOTE))?.key).toBe('gabriel2022abolition');
    expect(bibEntryFor(index, '@langley2017platform.md', null)?.key).toBe('langley2017platform');
    expect(bibEntryFor(index, 'unrelated.md', null)).toBeNull();

    // Zotero's `Title:path:mime` file field, several joined by `;`.
    const zotero = indexBibEntries(parseBibFile('@article{z1, title = {Z}, file = {Full Text:files/12/Smith 2020.pdf:application/pdf;Snapshot:files/13/x.html:text/html}}'));
    expect(bibEntryFor(zotero, 'Smith 2020.pdf', null)?.key).toBe('z1');
  });
});

describe('metadataForNote', () => {
  test('front matter fills the import fields; the .bib supplies the stored bibtex', () => {
    const index = indexBibEntries(parseBibFile(REFERENCES_BIB));
    const fm = parseFrontMatter(GABRIEL_NOTE);
    const meta = metadataForNote(fm, bibEntryFor(index, 'Kay Gabriel - Abolition as Method.md', fm));

    expect(meta).toMatchObject({
      title: 'Abolition as Method',
      author: 'Kay Gabriel',
      year: '2022',
      publisher: 'Dissent Magazine',
      url: 'https://www.dissentmagazine.org/article/abolition-as-method/',
      license: 'CC-BY-SA-4.0-NO-AI',
      type: 'book',
    });
    // The vault-only `file` field is gone, and the url names the WORK's
    // source — never the original Hyperlit book the export pointed at.
    expect(meta.bibtex).toContain('@book{gabriel2022abolition,');
    expect(meta.bibtex).not.toContain('file =');
    expect(meta.bibtex).not.toContain('hyperlit.io');
    expect(meta.bibtex).toContain('url = {https://www.dissentmagazine.org/article/abolition-as-method/}');
  });

  test('authors list joins with "; "; the .bib fills fields front matter lacks', () => {
    const index = indexBibEntries(parseBibFile(REFERENCES_BIB));
    const fm = parseFrontMatter(LANGLEY_NOTE);
    const meta = metadataForNote(fm, bibEntryFor(index, 'x.md', fm));
    expect(meta.author).toBe('Paul Langley; Andrew Leyshon');
    expect(meta.doi).toBe('10.2218/finsoc.v3i1.1936');
    expect(meta.journal).toBe('Finance and Society');
    expect(meta.issue).toBe('1');
    expect(meta.pages).toBe('11--31'); // only the .bib had pages
    expect(meta.title).toMatch(/^Platform capitalism: The intermediation/); // front matter wins
    expect(meta.type).toBe('article');
  });

  test('.bib alone (a PDF with no front matter): authors split, url kept, DOI normalised', () => {
    const [entry] = parseBibFile('@article{s2020, author = {Smith, Jane and {World Health Organization}}, title = {A {T}itle}, year = {2020}, doi = {https://doi.org/10.1000/xyz}, url = {https://example.org/a}}');
    const meta = metadataForNote({ fields: {}, body: '', hasBlock: false }, entry);
    expect(meta.author).toBe('Smith, Jane; World Health Organization');
    expect(meta.title).toBe('A Title');
    expect(meta.doi).toBe('10.1000/xyz');
    expect(meta.url).toBe('https://example.org/a');
  });

  test('nothing known → nothing claimed', () => {
    expect(metadataForNote({ fields: {}, body: 'x', hasBlock: false }, null)).toEqual({});
  });
});

describe('identity hints', () => {
  test('book id, hyperlit URL, DOI and hypercite targets', () => {
    const fm = parseFrontMatter(LANGLEY_NOTE);
    expect(identityForNote(fm, null, LANGLEY_NOTE)).toEqual({
      book: '4c86a05c-5746-4da2-8307-bb5388dda134',
      hyperlitUrl: 'https://hyperlit.io/4c86a05c-5746-4da2-8307-bb5388dda134',
      doi: '10.2218/finsoc.v3i1.1936',
      hyperciteTargets: ['book_1761013446163'],
    });
  });

  test('hyperciteTargetsIn finds every target once; ordinary links are not targets', () => {
    const text = 'a (https://hyperlit.io/slug-a#hypercite_1) b [x](https://hyperlit.io/slug-a#hypercite_2) c [y](https://hyperlit.io/book_9#hypercite_zz) d [z](https://example.org/page#section)';
    expect(hyperciteTargetsIn(text).sort()).toEqual(['book_9', 'slug-a']);
  });

  test('the generated README is a hub; a note with a book URL is not', () => {
    expect(isExportHubNote(parseFrontMatter(README_HUB))).toBe(true);
    expect(isExportHubNote(parseFrontMatter(GABRIEL_NOTE))).toBe(false);
    expect(isExportHubNote(parseFrontMatter('# no front matter'))).toBe(false);
  });

  test('normaliseDoi accepts bare, prefixed and URL forms and rejects junk', () => {
    expect(normaliseDoi('10.1000/abc')).toBe('10.1000/abc');
    expect(normaliseDoi('doi: 10.1000/abc')).toBe('10.1000/abc');
    expect(normaliseDoi('https://dx.doi.org/10.1000/abc')).toBe('10.1000/abc');
    expect(normaliseDoi('not a doi')).toBe('');
  });
});

describe('buildIngestPlan with a Hyperlit-exported vault', () => {
  const vault = () => [
    collected(file('README.md', README_HUB)),
    collected(file('Kay Gabriel - Abolition as Method.md', GABRIEL_NOTE)),
    collected(file('Paul Langley; Andrew Leyshon - Platform capitalism.md', LANGLEY_NOTE)),
    collected(file('@gabriel2022abolition.md', '')),
    collected(file('references.bib', REFERENCES_BIB, 'text/plain')),
  ];

  test('notes carry vault metadata + identity; the hub and the empty note are skipped and reported', async () => {
    const plan = await buildIngestPlan(vault(), 'Decolonising Security — Hyperlit library');

    expect(plan.kind).toBe('batch');
    expect(plan.source).toBe('vault');
    // .bib is metadata, never an upload.
    expect(plan.bundles.map((b) => b.filename)).toEqual([
      'Kay Gabriel - Abolition as Method.md',
      'Paul Langley; Andrew Leyshon - Platform capitalism.md',
    ]);
    expect(plan.skipped).toEqual([
      { filename: 'README.md', reason: 'hub' },
      { filename: '@gabriel2022abolition.md', reason: 'empty' },
    ]);

    const [gabriel, langley] = plan.bundles;
    // The title is the WORK's title, not the "Author - Title" filename.
    expect(gabriel.title).toBe('Abolition as Method');
    expect(gabriel.metadata).toMatchObject({ author: 'Kay Gabriel', year: '2022', license: 'CC-BY-SA-4.0-NO-AI' });
    expect(gabriel.identity.hyperlitUrl).toBe('https://hyperlit.io/abolition-as-method-gabriel-2022');
    expect(langley.metadata.doi).toBe('10.2218/finsoc.v3i1.1936');
    expect(langley.identity.hyperciteTargets).toEqual(['book_1761013446163']);
  });

  test('manifest.json still wins over front matter, field by field', async () => {
    const manifest = file('manifest.json', JSON.stringify({
      schema_version: 1,
      documents: { 'Kay Gabriel - Abolition as Method.md': { title: 'Manifest Title', year: 1999 } },
    }), 'application/json');
    const plan = await buildIngestPlan([...vault(), collected(manifest)], 'V');
    const gabriel = plan.bundles.find((b) => b.filename.startsWith('Kay Gabriel'));
    expect(gabriel.title).toBe('Manifest Title');
    expect(gabriel.metadata.year).toBe(1999);
    expect(gabriel.metadata.author).toBe('Kay Gabriel'); // front matter fills what the manifest lacks
  });

  test('a plain vault with no front matter and no .bib is unchanged', async () => {
    const plan = await buildIngestPlan([
      collected(file('a.md', '# A\n\ntext')),
      collected(file('b.md', '# B\n\ntext')),
    ], 'Plain');
    expect(plan.bundles.map((b) => [b.title, b.metadata, b.identity])).toEqual([['a', null, null], ['b', null, null]]);
    expect(plan.skipped).toEqual([]);
  });
});

describe('the "already in Hyperlit" split', () => {
  const bundle = (title, identity) => ({
    mainFile: file(`${title}.md`, 'x'), images: [], rewrittenMain: null, title, filename: `${title}.md`, metadata: null, identity,
  });
  const none = { hyperciteTargets: [] };

  // 0 cites book_b; 1 IS book_b; 2 is matched and uninvolved; 3 is unmatched.
  const bundles = [
    bundle('A', { hyperlitUrl: 'https://hyperlit.io/slug-a', hyperciteTargets: ['slug-b'] }),
    bundle('B', { ...none, book: 'book_b' }),
    bundle('C', { ...none, doi: '10.1/c' }),
    bundle('D', none),
  ];
  const matches = new Map([
    [0, { book: 'book_a', slug: 'slug-a', title: 'A', matchedBy: 'hyperlit' }],
    [1, { book: 'book_b', slug: 'slug-b', title: 'B', matchedBy: 'hyperlit' }],
    [2, { book: 'book_c', slug: null, title: 'C', matchedBy: 'doi' }],
  ]);

  test('a note that cites, and a note that is cited (by slug OR id), are forced to existing', () => {
    expect([...forcedExisting(bundles, matches)].sort()).toEqual([0, 1]);
  });

  test('"existing" shelves every match and uploads only the unmatched note', () => {
    const d = applyChoice(bundles, matches, forcedExisting(bundles, matches), 'existing');
    expect(d.existingBooks.sort()).toEqual(['book_a', 'book_b', 'book_c']);
    expect(d.bundles.map((b) => b.title)).toEqual(['D']);
  });

  test('"own" still shelves the hypercite-involved books; the rest upload as versions', () => {
    const d = applyChoice(bundles, matches, forcedExisting(bundles, matches), 'own');
    expect(d.existingBooks.sort()).toEqual(['book_a', 'book_b']);
    expect(d.bundles.map((b) => [b.title, b.versionOf])).toEqual([['C', 'book_c'], ['D', undefined]]);
  });

  describe('resolveExistingBooks', () => {
    beforeEach(() => {
      vi.unstubAllGlobals();
      document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
    });

    test('sends only notes with an identity hint and maps results back by index', async () => {
      const calls = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ results: [
          { key: '0', status: 'existing', book: 'book_a', slug: 'slug-a', title: 'A', matched_by: 'hyperlit' },
          { key: '1', status: 'new' },
          { key: '2', status: 'existing', book: 'book_c', slug: null, title: 'C', matched_by: 'doi' },
        ] }), { status: 200 });
      }));

      const found = await resolveExistingBooks(bundles);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('/api/import-batches/resolve');
      expect(calls[0].body.items.map((i) => i.key)).toEqual(['0', '1', '2']); // D carries no hint
      expect(calls[0].body.items[0]).toMatchObject({ hyperlit_url: 'https://hyperlit.io/slug-a', title: 'A' });
      expect([...found.keys()]).toEqual([0, 2]);
      expect(found.get(2)).toMatchObject({ book: 'book_c', matchedBy: 'doi' });
    });

    test('no hints → no request; a failing lookup → nothing recognised', async () => {
      const spy = vi.fn(async () => new Response('nope', { status: 500 }));
      vi.stubGlobal('fetch', spy);
      expect((await resolveExistingBooks([bundle('D', none)])).size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
      expect((await resolveExistingBooks(bundles)).size).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('uploadBatch with existing books and own versions', () => {
  function mockFetch(createBody) {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === '/api/validate-book-id') {
        return new Response(JSON.stringify({ success: true, exists: false }), { status: 200 });
      }
      if (String(url) === '/api/import-batches') {
        return new Response(JSON.stringify(createBody), { status: 201 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }));
    return calls;
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
  });

  test('an all-existing drop registers the shelf and uploads NOTHING', async () => {
    const calls = mockFetch({ id: null, shelf: { id: 's1' }, shelf_url: '/u/me/shelf/s', existing_added: 2 });
    const result = await uploadBatch([], { label: 'V', source: 'vault', autoShelf: true, existingBooks: ['book_a', 'book_b'] });

    expect(calls.map((c) => c.url)).toEqual(['/api/import-batches']);
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ items: [], existing_books: ['book_a', 'book_b'], auto_shelf: true });
    expect(result).toEqual({ batchId: null, uploaded: 0, failed: 0, existingAdded: 2, shelfUrl: '/u/me/shelf/s' });
  });

  test('an own version uploads with version_of, the vault’s doi/licence, and a generated bibtex', async () => {
    const calls = mockFetch({ id: 'batch-1', shelf: null, shelf_url: null, existing_added: 1 });
    const result = await uploadBatch([{
      mainFile: file('n.md', 'body'), images: [], rewrittenMain: null, title: 'Platform capitalism', filename: 'n.md',
      metadata: { author: 'Paul Langley; Andrew Leyshon', year: '2017', journal: 'Finance and Society', type: 'article', doi: '10.2218/x', license: 'CC-BY-NC-ND-4.0' },
      versionOf: 'book_orig',
    }], { label: 'V', source: 'vault', autoShelf: true, existingBooks: ['book_a'] });

    const fd = calls.find((c) => c.url === '/import-file').init.body;
    expect(fd.get('version_of')).toBe('book_orig');
    expect(fd.get('doi')).toBe('10.2218/x');
    expect(fd.get('license')).toBe('CC-BY-NC-ND-4.0');
    expect(fd.get('bibtex')).toMatch(/^@article\{[^,]+,/);
    expect(fd.get('bibtex')).toContain('journal = {Finance and Society}');
    expect(result).toMatchObject({ batchId: 'batch-1', uploaded: 1, existingAdded: 1 });
  });

  test('no bundles and no existing books is a no-op', async () => {
    const calls = mockFetch({});
    expect(await uploadBatch([], { label: 'V', source: 'vault', autoShelf: true })).toMatchObject({ batchId: null, existingAdded: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('a single note that is already in Hyperlit', () => {
  const resolveWith = (results) => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ results }), { status: 200 });
    }));
    return calls;
  };
  const existing = { key: '0', status: 'existing', book: 'book_orig', slug: 'abolition-as-method', title: 'Abolition as Method', matched_by: 'hyperlit' };

  /** Let the resolve round-trip finish, then press a dialog button. */
  const press = async (selector) => {
    for (let i = 0; i < 20 && !document.querySelector('.app-dialog-overlay'); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const el = document.querySelector(`.app-dialog-overlay ${selector}`);
    expect(el).not.toBeNull();
    el.click();
  };

  const singleNote = async (text, name = 'Kay Gabriel - Abolition as Method.md') => {
    const plan = await buildIngestPlan([collected(file(name, text))], null, { forceBatch: true });
    return plan.bundles[0];
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
  });

  test('forceBatch plans one note as one bundle; the default stays the form shortcut', async () => {
    const one = [collected(file('Kay Gabriel - Abolition as Method.md', GABRIEL_NOTE))];
    expect((await buildIngestPlan(one, null)).kind).toBe('one-book-folder');

    const forced = await buildIngestPlan(one, null, { forceBatch: true });
    expect(forced.kind).toBe('batch');
    expect(forced.bundles).toHaveLength(1);
    expect(forced.bundles[0].title).toBe('Abolition as Method');
    expect(forced.bundles[0].identity.hyperlitUrl).toBe('https://hyperlit.io/abolition-as-method-gabriel-2022');
  });

  test('offers the existing book or an own version, and returns the choice', async () => {
    resolveWith([existing]);
    let pending = decideSingleNote(await singleNote(GABRIEL_NOTE), null);
    await press('[data-choice="0"]');
    expect(await pending).toEqual({ action: 'existing', match: expect.objectContaining({ book: 'book_orig', slug: 'abolition-as-method' }) });

    pending = decideSingleNote(await singleNote(GABRIEL_NOTE), null);
    await press('[data-choice="1"]');
    const own = await pending;
    expect(own.action).toBe('own');
    expect(own.bundle.versionOf).toBe('book_orig');

    pending = decideSingleNote(await singleNote(GABRIEL_NOTE), null);
    await press('[data-act="cancel"]');
    expect(await pending).toEqual({ action: 'cancel' });
  });

  test('a note carrying hypercites is only ever offered the existing book', async () => {
    resolveWith([existing]);
    const pending = decideSingleNote(await singleNote(LANGLEY_NOTE, 'langley.md'), 'My reading list');
    await press('[data-choice="0"]');
    expect(document.querySelectorAll('[data-choice]').length).toBe(0); // dialog closed
    expect((await pending).action).toBe('existing');
  });

  test('the hypercite dialog has no "own version" button', async () => {
    resolveWith([existing]);
    const pending = decideSingleNote(await singleNote(LANGLEY_NOTE, 'langley.md'), null);
    for (let i = 0; i < 20 && !document.querySelector('.app-dialog-overlay'); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(document.querySelectorAll('.app-dialog-overlay [data-choice]').length).toBe(1);
    expect(document.querySelector('.app-dialog-overlay').textContent).toContain('hypercites');
    document.querySelector('.app-dialog-overlay [data-act="cancel"]').click();
    await pending;
  });

  test('a note we do not hold, or one with no hint, proceeds with no dialog', async () => {
    const calls = resolveWith([{ key: '0', status: 'new' }]);
    expect(await decideSingleNote(await singleNote(GABRIEL_NOTE), null)).toEqual({ action: 'proceed' });
    expect(calls).toHaveLength(1);

    expect(await decideSingleNote(await singleNote('# Just a note\n\ntext', 'plain.md'), null)).toEqual({ action: 'proceed' });
    expect(calls).toHaveLength(1); // no hint → no request
    expect(document.querySelector('.app-dialog-overlay')).toBeNull();
  });

  test('"existing" with no open shelf asks for the Imported works shelf; an open shelf wins', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: null, shelf: { id: 's' }, shelf_url: '/u/me/shelf/imported-works', existing_added: 1 }), { status: 201 });
    }));

    await uploadBatch([], { label: 'x', source: 'files', autoShelf: false, importsShelf: true, existingBooks: ['book_orig'] });
    expect(calls[0].body).toMatchObject({ imports_shelf: true, auto_shelf: false, existing_books: ['book_orig'], items: [] });
    expect(calls[0].body).not.toHaveProperty('shelf_id');

    await uploadBatch([], { label: 'x', source: 'files', autoShelf: false, importsShelf: true, shelfId: 'shelf-1', existingBooks: ['book_orig'] });
    expect(calls[1].body).toMatchObject({ shelf_id: 'shelf-1' });
    expect(calls[1].body).not.toHaveProperty('imports_shelf');
  });
});
