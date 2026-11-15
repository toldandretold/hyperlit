/**
 * Library-mode results can carry `type: 'shelf'` rows (GET /api/search/library
 * with shelves=1 — PublicShelfSearch). A shelf is a collection PAGE, not a
 * text: it links the server-supplied page url (never `/{book}`), wears the
 * shelf glyph, and says what it is.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSearchBox } from '../../../resources/js/search/searchBox';

function buildDom() {
    document.body.innerHTML = `
        <div id="sr-search-container" class="search-container">
            <textarea id="sr-search-input" class="search-input"></textarea>
            <div id="sr-search-results" class="search-results hidden"></div>
        </div>`;
}

function makeBox() {
    return createSearchBox({
        ids: { container: 'sr-search-container', input: 'sr-search-input', results: 'sr-search-results' },
        storage: { modeKey: 'sr_search_mode', queryKey: () => 'sr_search_query' },
        placeholders: { library: 'Titles…', fulltext: 'Text…', semantic: 'Meaning…' },
        noResultsMessage: () => 'No results',
        endpointFor: (mode, query) => `/api/test/${mode}?q=${encodeURIComponent(query)}&shelves=1`,
        logSource: 'searchBoxShelfResults.test',
    });
}

const results = () => document.getElementById('sr-search-results');

async function search(query, payload) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, mode: 'library', results: payload }),
    }));
    const input = document.getElementById('sr-search-input');
    input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
}

let box = null;

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.head.innerHTML = '<meta name="csrf-token" content="t">';
    buildDom();
    box = makeBox();
    box.init();
});

afterEach(() => {
    box?.destroy();
    box = null;
    vi.unstubAllGlobals();
});

describe('shelf rows in library-mode results', () => {
    it('links the shelf page, with the glyph and a label, beside ordinary book rows', async () => {
        await search('decolonising one', [
            { type: 'shelf', kind: 'archive', name: 'Decolonising Security', creator: 'sam', count: 37, url: '/a/decolonising-security' },
            { book: 'book_1', headline: 'Decolonising <mark>Security</mark> Studies' },
        ]);

        const shelf = results().querySelector('.search-result-shelf a');
        expect(shelf.getAttribute('href')).toBe('/a/decolonising-security');
        expect(shelf.querySelector('svg.search-result-shelf-icon')).not.toBeNull();
        expect(shelf.querySelector('.search-result-headline').textContent).toBe('Decolonising Security');
        expect(shelf.querySelector('.search-result-shelf-meta').textContent).toBe('Archive · 37 texts');

        // The book row is untouched: /{book}, no glyph.
        const book = results().querySelector('.search-result-item:not(.search-result-shelf) a');
        expect(book.getAttribute('href')).toBe('/book_1');
        expect(book.querySelector('svg')).toBeNull();
    });

    it("names a plain user shelf's owner, and singularises one text", async () => {
        await search('reading list two', [
            { type: 'shelf', kind: 'shelf', name: 'Reading list', creator: 'Ann Lee', count: 1, url: '/u/AnnLee/shelf/reading-list' },
        ]);

        expect(results().querySelector('.search-result-shelf-meta').textContent).toBe('Shelf · Ann Lee · 1 text');
    });

    it('escapes the shelf name and refuses a url that is not root-relative', async () => {
        await search('hostile three', [
            { type: 'shelf', kind: 'shelf', name: '<img src=x onerror=1>', creator: '<b>x</b>', count: 2, url: 'javascript:alert(1)' },
            { type: 'shelf', kind: 'shelf', name: 'Elsewhere', creator: 'x', count: 2, url: '//evil.example/a' },
        ]);

        const links = results().querySelectorAll('.search-result-shelf a');
        expect(links[0].getAttribute('href')).toBe('#');
        expect(links[1].getAttribute('href')).toBe('#');
        expect(results().querySelector('img')).toBeNull();
        expect(results().querySelector('.search-result-shelf-meta b')).toBeNull();
        expect(links[0].querySelector('.search-result-headline').textContent).toBe('<img src=x onerror=1>');
    });
});
