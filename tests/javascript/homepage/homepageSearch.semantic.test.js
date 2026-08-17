/**
 * Homepage search — semantic mode.
 *
 * Covers the three-mode refactor of homepageSearch.ts: mutually exclusive
 * toggles, endpoint selection, localStorage mode persistence (incl. the legacy
 * fulltext-boolean migration), the top-3 + show-more semantic render, the 503
 * provider-outage message, and bfcache pageshow restoration.
 *
 * DOM-lifecycle pattern per lavaLampReentry.test.js: hand-built DOM in
 * beforeEach, destroy + full cleanup in afterEach. fetch is stubbed via
 * vi.stubGlobal. Distinct query strings per test — the module's URL-keyed
 * searchResultCache persists across tests in this file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    initializeHomepageSearch,
    destroyHomepageSearch,
} from '../../../resources/js/search/postgreSQLsearch/homepageSearch';

const STORAGE_KEY_MODE = 'homepage_search_mode';
const STORAGE_KEY_FULLTEXT = 'homepage_search_fulltext';

function buildDom() {
    document.body.innerHTML = `
        <div id="homepage-search-container" class="search-container">
            <div class="search-input-anchor">
                <textarea id="homepage-search-input" class="search-input" rows="2"></textarea>
                <div id="search-results-container" class="search-results hidden"></div>
            </div>
            <div class="search-toggle-stack">
                <label class="fulltext-toggle-label">
                    <input type="checkbox" id="fulltext-search-toggle" class="fulltext-toggle-checkbox">
                    <span class="fulltext-toggle-slider"></span>
                </label>
                <label class="fulltext-toggle-label">
                    <input type="checkbox" id="semantic-search-toggle" class="fulltext-toggle-checkbox">
                    <span class="fulltext-toggle-slider"></span>
                </label>
            </div>
        </div>
    `;
}

function semanticResult(i) {
    return {
        book: `book_${i}`,
        node_id: `book_${i}_node_1`,
        startLine: i,
        title: `Title ${i}`,
        author: `Author ${i}`,
        excerpt: `Excerpt text ${i}`,
        match: 90 - i, // server's floor-rescaled match percentage
    };
}

function okResponse(payload) {
    return { ok: true, status: 200, json: async () => payload };
}

const input = () => document.getElementById('homepage-search-input');
const fulltextToggle = () => document.getElementById('fulltext-search-toggle');
const semanticToggle = () => document.getElementById('semantic-search-toggle');
const resultsContainer = () => document.getElementById('search-results-container');

function setToggle(el, checked) {
    el.checked = checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let fetchMock;

beforeEach(() => {
    localStorage.clear();
    buildDom();
    fetchMock = vi.fn(async () => okResponse({ success: true, results: [], mode: 'semantic' }));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    destroyHomepageSearch();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('mutually exclusive toggles + endpoint selection', () => {
    it('checking semantic unchecks fulltext and hits /api/search/semantic', async () => {
        initializeHomepageSearch();
        input().value = 'first exclusion query';

        setToggle(fulltextToggle(), true);
        await flush();
        expect(fetchMock).toHaveBeenLastCalledWith(
            expect.stringContaining('/api/search/nodes'),
            expect.anything(),
        );

        setToggle(semanticToggle(), true);
        await flush();
        expect(fulltextToggle().checked).toBe(false);
        expect(semanticToggle().checked).toBe(true);
        expect(fetchMock).toHaveBeenLastCalledWith(
            expect.stringContaining('/api/search/semantic'),
            expect.anything(),
        );

        setToggle(fulltextToggle(), true);
        await flush();
        expect(semanticToggle().checked).toBe(false);
        expect(fulltextToggle().checked).toBe(true);
    });

    it('both toggles off searches the library endpoint', async () => {
        initializeHomepageSearch();
        input().value = 'library fallback query';

        setToggle(semanticToggle(), true);
        await flush();
        setToggle(semanticToggle(), false);
        await flush();

        expect(fulltextToggle().checked).toBe(false);
        expect(fetchMock).toHaveBeenLastCalledWith(
            expect.stringContaining('/api/search/library'),
            expect.anything(),
        );
    });

    it('persists the mode and restores it on re-init', () => {
        initializeHomepageSearch();
        setToggle(semanticToggle(), true);
        expect(localStorage.getItem(STORAGE_KEY_MODE)).toBe('semantic');

        destroyHomepageSearch();
        buildDom();
        initializeHomepageSearch();

        expect(semanticToggle().checked).toBe(true);
        expect(fulltextToggle().checked).toBe(false);
        expect(input().placeholder).toBe('Search by meaning...');
    });
});

describe('legacy fulltext key migration', () => {
    it('migrates homepage_search_fulltext=true to mode=fulltext and removes the old key', () => {
        localStorage.setItem(STORAGE_KEY_FULLTEXT, 'true');
        initializeHomepageSearch();

        expect(localStorage.getItem(STORAGE_KEY_MODE)).toBe('fulltext');
        expect(localStorage.getItem(STORAGE_KEY_FULLTEXT)).toBeNull();
        expect(fulltextToggle().checked).toBe(true);
        expect(semanticToggle().checked).toBe(false);
    });
});

describe('semantic rendering', () => {
    it('renders every fetched result visible in one scrollable list', async () => {
        const results = [0, 1, 2, 3, 4].map(semanticResult);
        fetchMock.mockResolvedValue(okResponse({ success: true, results, mode: 'semantic' }));

        initializeHomepageSearch();
        input().value = 'render five results query';
        setToggle(semanticToggle(), true);
        await flush();

        const items = resultsContainer().querySelectorAll('.search-result-semantic');
        expect(items.length).toBe(5);
        expect(resultsContainer().querySelectorAll('.search-result-hidden').length).toBe(0);
        expect(resultsContainer().querySelector('.search-show-more')).toBeNull();
    });

    it('shows a match percentage next to the title', async () => {
        fetchMock.mockResolvedValue(okResponse({ success: true, results: [semanticResult(0)], mode: 'semantic' }));

        initializeHomepageSearch();
        input().value = 'match percentage query';
        setToggle(semanticToggle(), true);
        await flush();

        const badge = resultsContainer().querySelector('.search-result-similarity');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('90% match'); // semanticResult(0).match = 90
    });

    it('omits the badge when the match field is missing', async () => {
        const result = { ...semanticResult(0) };
        delete result.match;
        fetchMock.mockResolvedValue(okResponse({ success: true, results: [result], mode: 'semantic' }));

        initializeHomepageSearch();
        input().value = 'no similarity field query';
        setToggle(semanticToggle(), true);
        await flush();

        expect(resultsContainer().querySelectorAll('.search-result-semantic').length).toBe(1);
        expect(resultsContainer().querySelector('.search-result-similarity')).toBeNull();
    });

    it('links each result to the book at its startLine', async () => {
        fetchMock.mockResolvedValue(okResponse({ success: true, results: [semanticResult(7)], mode: 'semantic' }));

        initializeHomepageSearch();
        input().value = 'anchor link query';
        setToggle(semanticToggle(), true);
        await flush();

        const link = resultsContainer().querySelector('.search-result-match-link');
        expect(link.getAttribute('href')).toBe('/book_7#7');
        // No in-text-search handoff: a semantic hit doesn't contain the query
        // words, so the reader must navigate by anchor alone, not hunt for a
        // literal string that isn't there.
        expect(link.hasAttribute('data-highlight-query')).toBe(false);
    });

    it('shows the provider-outage message on a 503', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

        initializeHomepageSearch();
        input().value = 'outage query';
        setToggle(semanticToggle(), true);
        await flush();

        expect(resultsContainer().textContent).toContain('Semantic search is temporarily unavailable');
    });
});

describe('semantic input thresholds', () => {
    it('uses a 3-char minimum and 500ms debounce in semantic mode', async () => {
        vi.useFakeTimers();
        localStorage.setItem(STORAGE_KEY_MODE, 'semantic');
        initializeHomepageSearch();

        // 2 chars: below the semantic minimum — no search scheduled
        input().value = 'ab';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(600);
        expect(fetchMock).not.toHaveBeenCalled();

        // 3 chars: fires only after the longer 500ms debounce
        input().value = 'abc';
        input().dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(400);
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(150);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/search/semantic'),
            expect.anything(),
        );
    });
});

describe('bfcache pageshow restoration', () => {
    it('re-applies the stored mode to both toggles on a persisted pageshow', async () => {
        vi.useFakeTimers();
        initializeHomepageSearch();
        expect(semanticToggle().checked).toBe(false);

        // Another tab (or pre-freeze interaction) changed the stored mode
        localStorage.setItem(STORAGE_KEY_MODE, 'semantic');

        const event = new Event('pageshow');
        Object.defineProperty(event, 'persisted', { value: true });
        window.dispatchEvent(event);

        expect(semanticToggle().checked).toBe(true);
        expect(fulltextToggle().checked).toBe(false);
        expect(input().placeholder).toBe('Search by meaning...');

        // Safari can clear the input after pageshow — the 150ms re-apply
        // restores state again
        semanticToggle().checked = false;
        await vi.advanceTimersByTimeAsync(200);
        expect(semanticToggle().checked).toBe(true);
    });
});
