/**
 * userSearch — the /u/{username} instantiation of the shared searchBox factory,
 * and the factory's `subScope` seam it is the only user of.
 *
 * Contract: the page context picks the corpus (the username), an OPEN SHELF TAB
 * narrows it. The tab is re-read from the DOM per query rather than cached at
 * init — the `active` class is flipped by four unrelated modules — so these
 * lock: the shelf reaches the endpoint, the placeholder + empty-state name the
 * shelf, a tab change re-runs a VISIBLE result list against the new corpus, and
 * the archivist ask swaps username scope for shelf scope (the server treats the
 * two as mutually exclusive, 422).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/components/aiArchivist/archivistPanel', () => ({
    openArchivistPanel: vi.fn(),
}));

import { openArchivistPanel } from '../../../resources/js/components/aiArchivist/archivistPanel';
import { searchCacheClear } from '../../../resources/js/search/searchResultCache';
import {
    initializeUserSearch,
    destroyUserSearch,
} from '../../../resources/js/components/userProfile/userSearch';

const USERNAME = 'encryptER';
const SHELF_ID = 'bf496592-ad97-440c-b0c7-c4acb84e2cf7';

/** The user page's header: search box + the pill row the sub-scope is read from. */
function buildDom({ ownerTab = false, visitorTab = false, active = false } = {}) {
    const ownerTabHtml = ownerTab
        ? `<button class="arranger-button shelf-tab${active ? ' active' : ''}" data-content="shelf_book"
                   data-filter="shelf" data-shelf-id="${SHELF_ID}" data-sort="recent">
             <span class="shelf-tab-name">AI Archivist</span><span class="shelf-tab-close">×</span>
           </button>`
        : '';
    const visitorTabHtml = visitorTab
        ? `<button class="arranger-button visitor-shelf-tab${active ? ' active' : ''}" data-content=""
                   data-filter="shelf" data-shelf-id="${SHELF_ID}" data-shelf-name="Reading List">Reading List</button>`
        : '';

    // Mirrors the real page: .home-content-wrapper is the feed slot, and the
    // header (with the pill row) is inside it.
    document.body.innerHTML = `
      <div class="home-content-wrapper">
        <div class="fixed-header">
        <div class="arranger-buttons-container">
            <div id="user-search-container" class="search-container search-container--multiline"
                 data-username="${USERNAME}">
                <div class="search-input-anchor">
                    <textarea id="user-search-input" class="search-input" rows="2"></textarea>
                    <div id="user-search-results" class="search-results hidden"></div>
                    <button type="button" id="archivist-ask-button" class="archivist-ask-btn" hidden>Ask</button>
                </div>
                <div class="search-toggle-stack">
                    <label><input type="checkbox" id="user-fulltext-toggle" class="fulltext-toggle-checkbox"></label>
                    <label><input type="checkbox" id="user-semantic-toggle" class="fulltext-toggle-checkbox"></label>
                </div>
            </div>
            <div class="user-pill-scroller">
                <button class="arranger-button${!active ? ' active' : ''}" data-content="${USERNAME}All" data-filter="library">Library</button>
                ${ownerTabHtml}
                ${visitorTabHtml}
                <button type="button" id="shelf-picker-trigger" class="shelf-picker-trigger">+</button>
            </div>
            <button type="button" id="archivist-brain-button"></button>
        </div>
        </div>
      </div>
    `;
}

const input = () => document.getElementById('user-search-input');
const results = () => document.getElementById('user-search-results');
const fulltextToggle = () => document.getElementById('user-fulltext-toggle');
const brainButton = () => document.getElementById('archivist-brain-button');
const askButton = () => document.getElementById('archivist-ask-button');
const shelfTab = () => document.querySelector('.user-pill-scroller [data-filter="shelf"]');
const libraryTab = () => document.querySelector('.user-pill-scroller [data-filter="library"]');

function setToggle(el, checked) {
    el.checked = checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Move the `active` class the way the tab modules do. */
function activate(el) {
    document.querySelectorAll('.arranger-button').forEach((b) => b.classList.remove('active'));
    el.classList.add('active');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let fetchMock;

beforeEach(() => {
    localStorage.clear();
    // The URL-keyed result cache is module state: without this, a later test
    // reusing a query renders from cache and never fetches.
    searchCacheClear();
    fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, results: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    destroyUserSearch();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('shelf narrowing of the search endpoint', () => {
    it('omits the shelf param when the Library tab is active', async () => {
        buildDom({ ownerTab: true, active: false });
        initializeUserSearch();
        input().value = 'wombat';

        setToggle(fulltextToggle(), true);
        await flush();

        const url = fetchMock.mock.calls.at(-1)[0];
        expect(url).toContain(`/api/public/library/${USERNAME}/search?q=wombat`);
        expect(url).not.toContain('shelf=');
    });

    it('sends the open shelf tab as &shelf= for every mode', async () => {
        buildDom({ ownerTab: true, active: true });
        initializeUserSearch();
        input().value = 'wombat';

        setToggle(fulltextToggle(), true);
        await flush();
        expect(fetchMock.mock.calls.at(-1)[0]).toContain(`&shelf=${SHELF_ID}`);

        setToggle(fulltextToggle(), false); // → library mode
        await flush();
        const libraryUrl = fetchMock.mock.calls.at(-1)[0];
        expect(libraryUrl).toContain('mode=library');
        expect(libraryUrl).toContain(`&shelf=${SHELF_ID}`);
    });

    it('re-runs a visible result list against the new corpus when the tab changes', async () => {
        buildDom({ ownerTab: true, active: false });
        initializeUserSearch();
        input().value = 'wombat';

        setToggle(fulltextToggle(), true);
        await flush();
        expect(results().classList.contains('hidden')).toBe(false);
        const callsBefore = fetchMock.mock.calls.length;

        activate(shelfTab());
        await flush();

        expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
        expect(fetchMock.mock.calls.at(-1)[0]).toContain(`&shelf=${SHELF_ID}`);

        // ...and back out to the whole library. The cache is dropped first so
        // the re-run has to hit the network to be observable (the library URL
        // was already cached by the first search above).
        searchCacheClear();
        activate(libraryTab());
        await flush();
        expect(fetchMock.mock.calls.at(-1)[0]).not.toContain('shelf=');
    });

    it('drops back to the library scope when the active tab is closed', async () => {
        buildDom({ ownerTab: true, active: true });
        initializeUserSearch();
        expect(input().placeholder).toBe('Search titles & authors in “AI Archivist”');

        shelfTab().remove(); // shelfTabs.closeTab
        await flush();

        expect(input().placeholder).toBe('Search titles & authors...');
    });
});

describe('scoped copy', () => {
    it('names the shelf in the placeholder for each mode, and reverts when it closes', async () => {
        buildDom({ ownerTab: true, active: false });
        initializeUserSearch();
        expect(input().placeholder).toBe('Search titles & authors...');

        activate(shelfTab());
        await flush();
        expect(input().placeholder).toBe('Search titles & authors in “AI Archivist”');

        setToggle(fulltextToggle(), true);
        expect(input().placeholder).toBe('Search text in “AI Archivist”');

        brainButton().click();
        expect(input().placeholder).toBe('Ask the AI Archivist about “AI Archivist”');

        activate(libraryTab());
        await flush();
        expect(input().placeholder).toBe('Ask the AI Archivist about this library...');
    });

    it('reads a visitor tab name from data-shelf-name', () => {
        buildDom({ visitorTab: true, active: true });
        initializeUserSearch();

        expect(input().placeholder).toBe('Search titles & authors in “Reading List”');
    });

    it('clips a long shelf name so the mode stays visible', async () => {
        buildDom({ ownerTab: true, active: true });
        // 40 chars — well past the 24-char display budget.
        document.querySelector('.shelf-tab-name').textContent = 'Twentieth Century Marxist Historiography';
        initializeUserSearch();

        // Clipped to 23 + the ellipsis, and NO trailing "..." after it.
        expect(input().placeholder).toBe('Search titles & authors in “Twentieth Century Marxi…”');

        setToggle(fulltextToggle(), true);
        expect(input().placeholder).toBe('Search text in “Twentieth Century Marxi…”');
    });

    it('names the shelf in the empty state', async () => {
        buildDom({ ownerTab: true, active: true });
        initializeUserSearch();
        input().value = 'wombat';

        setToggle(fulltextToggle(), true);
        await flush();

        expect(results().textContent).toContain('No matches in “AI Archivist”.');
    });
});

describe('scope while an archivist answer holds the feed slot', () => {
    // Opening an answer EVICTS the feed and clears the active tab, so the tab
    // row can no longer report the scope — the panel carries it instead
    // (archivistPanel's stampAskScope). Without this, a follow-up question
    // would silently widen from the shelf to the whole library.
    function mountAnswerPanel({ shelfId = null, shelfName = null } = {}) {
        document.querySelectorAll('.arranger-button.active').forEach((b) => b.classList.remove('active'));
        const panel = document.createElement('div');
        panel.className = 'main-content active-content archivist-panel';
        if (shelfId) {
            panel.dataset.archivistShelfId = shelfId;
            panel.dataset.archivistShelfName = shelfName;
        }
        document.querySelector('.home-content-wrapper').appendChild(panel);
        return panel;
    }

    it('keeps the shelf scope for a follow-up ask after the answer replaces the feed', async () => {
        buildDom({ ownerTab: true, active: true });
        initializeUserSearch();

        mountAnswerPanel({ shelfId: SHELF_ID, shelfName: 'AI Archivist' });
        await flush();

        expect(input().placeholder).toBe('Search titles & authors in “AI Archivist”');

        brainButton().click();
        input().value = 'and the follow-up?';
        askButton().click();
        await vi.waitFor(() => expect(openArchivistPanel).toHaveBeenCalledTimes(1));
        expect(openArchivistPanel).toHaveBeenCalledWith({
            question: 'and the follow-up?',
            shelfId: SHELF_ID,
            shelfName: 'AI Archivist',
            username: null,
        });
    });

    it('drops back to the library when the answer is closed', async () => {
        buildDom({ ownerTab: true, active: true });
        initializeUserSearch();

        const panel = mountAnswerPanel({ shelfId: SHELF_ID, shelfName: 'AI Archivist' });
        await flush();
        panel.remove(); // the × / close-back-to-hero path
        await flush();

        expect(input().placeholder).toBe('Search titles & authors...');
    });

    it('stays library-wide for an answer that was asked library-wide', async () => {
        buildDom({ ownerTab: true, active: false });
        initializeUserSearch();

        mountAnswerPanel();
        await flush();

        expect(input().placeholder).toBe('Search titles & authors...');
    });
});

describe('archivist scope', () => {
    it('asks the shelf (not the username) while a tab is open', async () => {
        buildDom({ ownerTab: true, active: true });
        initializeUserSearch();
        brainButton().click();
        input().value = 'what is delinking?';
        askButton().click();
        // The panel is dynamically imported — poll rather than assume the
        // module resolves within one macrotask (it does not under load).
        await vi.waitFor(() => expect(openArchivistPanel).toHaveBeenCalledTimes(1));

        expect(openArchivistPanel).toHaveBeenCalledWith({
            question: 'what is delinking?',
            shelfId: SHELF_ID,
            shelfName: 'AI Archivist',
            username: null,
        });
    });

    it('asks the whole library when no tab is open', async () => {
        buildDom({ ownerTab: true, active: false });
        initializeUserSearch();
        brainButton().click();
        input().value = 'what is delinking?';
        askButton().click();
        await vi.waitFor(() => expect(openArchivistPanel).toHaveBeenCalledTimes(1));

        expect(openArchivistPanel).toHaveBeenCalledWith({
            question: 'what is delinking?',
            shelfId: null,
            shelfName: null,
            username: USERNAME,
        });
    });
});
