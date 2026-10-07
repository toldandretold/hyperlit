/**
 * Versions / Translations rail (bookVersions.ts).
 *
 * Locks: the section stays hidden when the work has no other visible
 * edition; the heading adapts to what's present (Translations / Versions /
 * both); an MT entry always names the model and its commissioner, upgraded
 * to co-translator once human_reviewed; the edited-since note renders; the
 * current book is unlinked; a sub-book id resolves to its root; destroy()
 * before the response renders nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { init: vi.fn() },
}));

import { initBookVersions, modelLabel } from '../../../resources/js/components/sourceContainer/bookVersions';

const entry = (over = {}) => ({
  book: 'book_x', title: 'A Title', language: 'en', creator: 'reader',
  created_at: '2026-10-07T00:00:00Z', kind: 'translation', is_current: false,
  translation: { target: 'en', model: 'accounts/fireworks/models/kimi-k3', human_reviewed: false, original_edited_since: false },
  ...over,
});

const ORIGINAL = entry({ book: 'book_1', title: '长相思', language: 'zh-Hans', creator: 'owner', kind: 'original', is_current: true, translation: null });

let container;
let fetchMock;
let handle;

const section = () => container.querySelector('#book-versions-section');
const heading = () => container.querySelector('.book-versions-heading');
const entries = () => [...container.querySelectorAll('.book-version-entry')];

function reply(versions) {
  return { ok: true, status: 200, json: async () => ({ success: true, book: 'book_1', versions }) };
}

beforeEach(() => {
  container = document.createElement('div');
  container.innerHTML = `
    <p class="citation">Someone, "A Title", Journal (2026).</p>
    <p class="citation-translation-note" hidden></p>
    <div id="book-versions-section" hidden>
      <h3 class="book-versions-heading">Versions</h3>
      <ul class="book-versions-list"></ul>
    </div>`;
  document.body.appendChild(container);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  handle?.destroy();
  container.remove();
  vi.unstubAllGlobals();
});

describe('modelLabel', () => {
  it('names Kimi K3 and falls back to the id tail', () => {
    expect(modelLabel('accounts/fireworks/models/kimi-k3')).toBe('Kimi K3');
    expect(modelLabel('some/other-model')).toBe('other-model');
    expect(modelLabel(null)).toBeNull();
  });
});

describe('initBookVersions', () => {
  it('stays hidden when the work has no other visible edition', async () => {
    fetchMock.mockResolvedValue(reply([ORIGINAL]));
    handle = initBookVersions(container, 'book_1');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(section().hidden).toBe(true);
  });

  it('renders OTHER editions compactly: the language IS the link, the current book is not listed', async () => {
    fetchMock.mockResolvedValue(reply([
      ORIGINAL,
      entry({ book: 'book_en', title: '长相思 (English)' }),
      entry({
        book: 'book_en2', title: 'Edited (English)', creator: 'editor',
        translation: { target: 'en', model: 'accounts/fireworks/models/kimi-k3', human_reviewed: true, original_edited_since: true },
      }),
    ]));
    handle = initBookVersions(container, 'book_1');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    // Viewing the original with translations only — the heading says so,
    // and the original itself (the current book) is NOT in the list.
    expect(heading().textContent).toBe('Translations');
    expect(entries()).toHaveLength(2);
    expect(section().textContent).not.toContain('this book');
    expect(section().textContent).not.toContain('长相思');

    const mt = entries()[0];
    const mtLink = mt.querySelector('a.book-version-title');
    expect(mtLink.getAttribute('href')).toBe('/book_en');
    expect(mtLink.textContent).toBe('English'); // the language, not the title
    expect(mt.textContent).toContain('machine translation (Kimi K3), commissioned by reader');

    const edited = entries()[1];
    expect(edited.textContent).toContain('co-translated by editor');
    expect(edited.textContent).toContain('The original has been edited since this translation was made.');
  });

  it('names the original by language with an obvious link, when viewed from a translation', async () => {
    fetchMock.mockResolvedValue(reply([
      entry({ book: 'book_1', title: '长相思', language: 'zh-Hans', creator: 'owner', kind: 'original', is_current: false, translation: null }),
      entry({ book: 'book_zh', language: 'en', is_current: true }),
    ]));
    handle = initBookVersions(container, 'book_zh');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    const original = entries()[0].querySelector('a.book-version-title');
    expect(original.getAttribute('href')).toBe('/book_1');
    expect(original.textContent).toContain('Original');
    expect(original.textContent).toContain('简体中文');
  });

  it('says just "Translations" when the current book is the original with translations only', async () => {
    fetchMock.mockResolvedValue(reply([ORIGINAL, entry({ book: 'book_en' })]));
    handle = initBookVersions(container, 'book_1');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    expect(heading().textContent).toBe('Translations');
  });

  it('says "Versions" for canonical siblings alone', async () => {
    fetchMock.mockResolvedValue(reply([
      ORIGINAL,
      entry({ book: 'book_v2', kind: 'canonical_version', creator: 'librarian', translation: null }),
    ]));
    handle = initBookVersions(container, 'book_1');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    expect(heading().textContent).toBe('Versions');
    // Same language, same work — here the TITLE is the distinguishing link.
    expect(entries()[0].querySelector('a.book-version-title').textContent).toBe('A Title');
    expect(entries()[0].textContent).toContain('another version · by librarian');
  });

  it('discloses MT provenance under the citation when the CURRENT book is a translation', async () => {
    fetchMock.mockResolvedValue(reply([
      entry({ book: 'book_1', title: '长相思', kind: 'original', creator: 'owner', is_current: false, translation: null }),
      entry({ book: 'book_zh', language: 'zh-Hans', creator: 'reader', is_current: true }),
    ]));
    handle = initBookVersions(container, 'book_zh');

    const note = () => container.querySelector('.citation-translation-note');
    await vi.waitFor(() => expect(note().hidden).toBe(false));
    expect(note().textContent).toContain('Machine translation (Kimi K3) into 简体中文, commissioned by reader');
    expect(note().textContent).toContain('describe the original work');
    expect(note().querySelector('a').getAttribute('href')).toBe('/book_1');
  });

  it('still discloses provenance when the original is invisible to this viewer — just without the link', async () => {
    fetchMock.mockResolvedValue(reply([
      entry({ book: 'book_zh', language: 'zh-Hans', creator: 'reader', is_current: true }),
    ]));
    handle = initBookVersions(container, 'book_zh');

    const note = () => container.querySelector('.citation-translation-note');
    await vi.waitFor(() => expect(note().hidden).toBe(false));
    expect(note().querySelector('a')).toBeNull();
    // The rail itself stays hidden: nothing else is visible to list.
    expect(section().hidden).toBe(true);
  });

  it('leaves the provenance note hidden on an original', async () => {
    fetchMock.mockResolvedValue(reply([ORIGINAL, entry({ book: 'book_en' })]));
    handle = initBookVersions(container, 'book_1');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    expect(container.querySelector('.citation-translation-note').hidden).toBe(true);
  });

  it('asks about the ROOT book from a sub-book overlay', async () => {
    fetchMock.mockResolvedValue(reply([ORIGINAL]));
    handle = initBookVersions(container, 'book_1/book_1Fn3');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/book-versions/book_1');
  });

  it('renders nothing after destroy(), even once the response lands', async () => {
    let release;
    fetchMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    handle = initBookVersions(container, 'book_1');
    handle.destroy();
    handle = null;

    release(reply([ORIGINAL, entry({ book: 'book_en' })]));
    await Promise.resolve();
    await Promise.resolve();
    expect(section().hidden).toBe(true);
    expect(entries()).toHaveLength(0);
  });
});
