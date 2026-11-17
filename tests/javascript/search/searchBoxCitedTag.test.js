/**
 * Shelf-scoped search endpoints (ShelfController::publicSearch) mark a hit
 * `cited: true` when its book is not a member of the collection but is
 * hypercited by one (ShelfCitedTexts). The box labels those in every mode so a
 * passage of Capital is not mistaken for a shelf reading; a payload without the
 * field (homepage, /u/) renders no label at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSearchBox } from '../../../resources/js/search/searchBox';

function buildDom() {
    document.body.innerHTML = `
        <div id="ct-search-container" class="search-container">
            <textarea id="ct-search-input" class="search-input"></textarea>
            <div id="ct-search-results" class="search-results hidden"></div>
        </div>`;
}

let box = null;
const results = () => document.getElementById('ct-search-results');

async function search(mode, payload) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, mode, results: payload }),
    }));
    const input = document.getElementById('ct-search-input');
    input.value = 'xylophone ' + mode; // distinct per test: the box's result cache is keyed by URL
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.head.innerHTML = '<meta name="csrf-token" content="t">';
    buildDom();
    box = createSearchBox({
        ids: { container: 'ct-search-container', input: 'ct-search-input', results: 'ct-search-results' },
        storage: { modeKey: 'ct_search_mode', queryKey: () => 'ct_search_query' },
        placeholders: { library: 'Titles…', fulltext: 'Text…', semantic: 'Meaning…' },
        noResultsMessage: () => 'No results',
        endpointFor: (mode, query) => `/api/test/${mode}?q=${encodeURIComponent(query)}`,
        logSource: 'searchBoxCitedTag.test',
    });
    box.init();
});

afterEach(() => {
    box?.destroy();
    box = null;
    vi.unstubAllGlobals();
});

describe('the "cited by this collection" label', () => {
    it('marks a cited title row and leaves a member row (and a field-less row) unlabelled', async () => {
        await search('library', [
            { book: 'book_member', headline: 'Member <mark>Xylophone</mark>', cited: false },
            { book: 'book_capital', headline: 'Capital', cited: true },
            { book: 'book_home', headline: 'Homepage row without the field' },
        ]);
        const rows = [...results().querySelectorAll('.search-result-item')];
        expect(rows).toHaveLength(3);
        expect(rows[0].classList.contains('search-result-cited')).toBe(false);
        expect(rows[0].querySelector('.search-result-cited-tag')).toBeNull();
        expect(rows[1].classList.contains('search-result-cited')).toBe(true);
        expect(rows[1].querySelector('.search-result-cited-tag').textContent).toBe('cited by this collection');
        expect(rows[2].querySelector('.search-result-cited-tag')).toBeNull();
    });

    it('labels a cited book group in full-text mode, beside the author', async () => {
        await search('fulltext', [
            { book: 'book_capital', title: 'Capital', author: 'Marx', cited: true, matches: [{ node_id: 'n', startLine: 12, headline: 'a <mark>xylophone</mark>' }] },
            { book: 'book_member', title: 'Essay', author: 'Someone', cited: false, matches: [{ node_id: 'm', startLine: 3, headline: 'the <mark>xylophone</mark>' }] },
        ]);
        const groups = [...results().querySelectorAll('.search-result-book')];
        expect(groups[0].classList.contains('search-result-cited')).toBe(true);
        expect(groups[0].querySelector('.search-result-book-header .search-result-cited-tag')).not.toBeNull();
        expect(groups[1].querySelector('.search-result-cited-tag')).toBeNull();
        // The match links are untouched.
        expect(groups[0].querySelector('.search-result-match-link').getAttribute('href')).toBe('/book_capital#12');
    });

    it('labels a cited passage in semantic mode, after the match badge', async () => {
        await search('semantic', [
            { book: 'book_capital', title: 'Capital', author: 'Marx', excerpt: 'Commodities…', match: 71, cited: true },
            { book: 'book_member', title: 'Essay', author: 'Someone', excerpt: 'On xylophones', match: 64, cited: false },
        ]);
        const rows = [...results().querySelectorAll('.search-result-semantic')];
        const source = rows[0].querySelector('.search-result-semantic-source');
        expect(source.querySelector('.search-result-similarity').textContent).toBe('71% match');
        expect(source.querySelector('.search-result-cited-tag').textContent).toBe('cited by this collection');
        expect(rows[1].querySelector('.search-result-cited-tag')).toBeNull();
    });
});
