/**
 * journalSearch — the journal instantiation of the shared searchBox factory.
 *
 * The behavior itself is covered by tests/javascript/homepage/
 * homepageSearch.semantic.test.js (same factory); these lock the
 * journal-specific config: shelf-scoped endpoints per mode, the disabled
 * "No articles yet" state when no shelf backs the journal, and per-shelf
 * query persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    initializeJournalSearch,
    destroyJournalSearch,
} from '../../../resources/js/components/journal/journalSearch';

const SHELF_ID = '11111111-2222-3333-4444-555555555555';

function buildDom(shelfId = SHELF_ID) {
    document.body.innerHTML = `
        <div id="journal-search-container" class="search-container search-container--multiline"
             data-shelf-id="${shelfId}">
            <div class="search-input-anchor">
                <textarea id="journal-search-input" class="search-input" rows="2"></textarea>
                <div id="journal-search-results" class="search-results hidden"></div>
            </div>
            <div class="search-toggle-stack">
                <label><input type="checkbox" id="journal-fulltext-toggle" class="fulltext-toggle-checkbox"></label>
                <label><input type="checkbox" id="journal-semantic-toggle" class="fulltext-toggle-checkbox"></label>
            </div>
        </div>
    `;
}

const input = () => document.getElementById('journal-search-input');
const fulltextToggle = () => document.getElementById('journal-fulltext-toggle');
const semanticToggle = () => document.getElementById('journal-semantic-toggle');

function setToggle(el, checked) {
    el.checked = checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let fetchMock;

beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, results: [], mode: 'semantic' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    destroyJournalSearch();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('journal search config', () => {
    it('hits the shelf endpoint with the right mode param per toggle state', async () => {
        buildDom();
        initializeJournalSearch();
        input().value = 'journal endpoint probe';

        setToggle(semanticToggle(), true);
        await flush();
        expect(fetchMock).toHaveBeenLastCalledWith(
            expect.stringContaining(`/api/public/shelves/${SHELF_ID}/search?q=journal%20endpoint%20probe&mode=semantic`),
            expect.anything(),
        );

        setToggle(fulltextToggle(), true); // unchecks semantic → fulltext = no mode param
        await flush();
        expect(semanticToggle().checked).toBe(false);
        const fulltextUrl = fetchMock.mock.calls.at(-1)[0];
        expect(fulltextUrl).toContain(`/api/public/shelves/${SHELF_ID}/search?q=`);
        expect(fulltextUrl).not.toContain('mode=');

        setToggle(fulltextToggle(), false); // both off → library
        await flush();
        expect(fetchMock.mock.calls.at(-1)[0]).toContain('mode=library');
    });

    it('disables the box with "No articles yet" when the journal has no shelf', () => {
        buildDom('');
        initializeJournalSearch();

        expect(input().disabled).toBe(true);
        expect(input().placeholder).toBe('No articles yet');
        expect(fulltextToggle().disabled).toBe(true);
        expect(semanticToggle().disabled).toBe(true);
    });

    it('persists the query per shelf and the mode across journals', async () => {
        buildDom();
        initializeJournalSearch();
        setToggle(semanticToggle(), true);
        input().value = 'persist probe';
        input().dispatchEvent(new Event('input', { bubbles: true })); // query persists on input
        await flush();

        expect(localStorage.getItem(`journal_search_query_${SHELF_ID}`)).toBe('persist probe');
        expect(localStorage.getItem('journal_search_mode')).toBe('semantic');
    });

    it('migrates the legacy journal_search_fulltext key', () => {
        localStorage.setItem('journal_search_fulltext', 'true');
        buildDom();
        initializeJournalSearch();

        expect(localStorage.getItem('journal_search_mode')).toBe('fulltext');
        expect(localStorage.getItem('journal_search_fulltext')).toBeNull();
        expect(fulltextToggle().checked).toBe(true);
    });
});
