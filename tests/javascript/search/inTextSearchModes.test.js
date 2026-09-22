/**
 * In-text search: the exact/semantic mode seam.
 *
 * The premise of semantic mode is that everything AROUND the match list stays
 * identical — open/close, the "N of M" counter, prev/next with wrap, the
 * nearest-match-to-where-you're-reading start, chunk-aware navigation. Only two
 * things differ: where the matches come from, and the fact that a semantic match
 * is a whole NODE (no charStart/charEnd), so it tints instead of wrapping a
 * <mark>.
 *
 * These lock the parts that are easy to break silently:
 *  - server hits ranked by similarity are re-sorted to DOCUMENT order, which is
 *    what makes ▲▼ and findNearestMatchIndex behave as in exact mode;
 *  - the toggle is hidden for books the server has no embeddings for (E2EE,
 *    sub-books) and the mode falls back to exact — never a dead control;
 *  - switching mode clears the OTHER mode's artifacts;
 *  - an in-flight request is aborted when a keystroke supersedes it;
 *  - a full-text handoff (pendingHighlightQuery) forces exact mode, because its
 *    query is a literal string that the semantic engine would rank instead.
 *
 * This folder previously had NO tests for the toolbar at all — it was only ever
 * vi.mock'ed away by other suites.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- module mocks -----------------------------------------------------------

const lazyLoaderState = { current: null };

vi.mock('../../../resources/js/pageLoad/currentLazyLoaderState', () => ({
    get currentLazyLoader() {
        return lazyLoaderState.current;
    },
}));

const encryptedBooks = new Set();
vi.mock('../../../resources/js/e2ee/registry', () => ({
    isBookEncrypted: (bookId) => encryptedBooks.has(String(bookId).split('/')[0]),
}));

vi.mock('../../../resources/js/scrolling/internalNav', () => ({
    navigateToInternalId: vi.fn(),
}));
vi.mock('../../../resources/js/scrolling/userScrollDetection', () => ({
    cancelPendingNavigationCleanup: vi.fn(),
}));
vi.mock('../../../resources/js/scrolling/paginator', () => ({
    // Returning false makes the toolbar fall through to scrollIntoView, the
    // non-paginated path.
    maybePaginatorReveal: vi.fn(() => false),
}));

const anchorState = { elementId: null };
vi.mock('../../../resources/js/scrolling/readingAnchor', () => ({
    getFreshAnchor: () => (anchorState.elementId === null ? null : { elementId: anchorState.elementId }),
}));

const idbNodes = { rows: [] };
vi.mock('../../../resources/js/indexedDB/nodes/read', () => ({
    getNodesFromIndexedDB: vi.fn(async () => idbNodes.rows),
}));

import {
    initializeSearchToolbar,
    destroySearchToolbar,
    getSearchToolbar,
    openSearchToolbarWithQuery,
} from '../../../resources/js/search/inTextSearch/searchToolbar';
import { searchCacheClear } from '../../../resources/js/search/searchResultCache';

const BOOK = 'book_1787617675521';

/** The real partial's markup, toggle included (the reader variant). */
function buildDom({ withToggle = true } = {}) {
    document.body.innerHTML = `
      <div id="search-toolbar">
        ${withToggle ? `
        <div id="search-mode-toggle" class="search-mode-toggle">
          <button type="button" class="search-mode-toggle-btn active" data-search-mode="exact">exact</button>
          <button type="button" class="search-mode-toggle-btn" data-search-mode="semantic">meaning</button>
        </div>` : ''}
        <input type="text" id="search-input" />
        <button type="button" id="search-prev-button"></button>
        <button type="button" id="search-next-button"></button>
        <span id="search-match-counter">0 of 0</span>
      </div>
      <div class="main-content" id="${BOOK}">
        <p id="100">the falling rate of profit</p>
        <p id="200">primitive accumulation and enclosure</p>
        <p id="300">crisis of overproduction</p>
      </div>
    `;
}

/**
 * A /api/search/in-book payload, deliberately in SIMILARITY order.
 *
 * chunk_id is a STRING here on purpose — that is what the wire actually carries.
 * Postgres serializes the numeric column as `"chunk_id":"0"`, verified against a
 * live response.
 */
function rankedPayload() {
    return {
        success: true,
        mode: 'semantic',
        results: [
            { node_id: 'n3', startLine: '300', chunk_id: '0', excerpt: 'crisis', similarity: 0.84, match: 54 },
            { node_id: 'n1', startLine: '100', chunk_id: '0', excerpt: 'falling', similarity: 0.71, match: 17 },
            { node_id: 'n2', startLine: '200', chunk_id: '0', excerpt: 'primitive', similarity: 0.69, match: 11 },
        ],
    };
}

function mockFetchOnce(payload, { status = 200 } = {}) {
    const fetchMock = vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        blob: async () => new Blob([]),
    }));
    globalThis.fetch = fetchMock;
    return fetchMock;
}

/** Drive the toolbar the way a user would, bypassing the debounce timer. */
async function typeAndSearch(toolbar, query) {
    toolbar.input.value = query;
    await toolbar.performSearch(query);
}

beforeEach(() => {
    vi.useRealTimers();
    encryptedBooks.clear();
    idbNodes.rows = [];
    anchorState.elementId = null;
    searchCacheClear();
    localStorage.clear();
    lazyLoaderState.current = { bookId: BOOK, currentlyLoadedChunks: new Set([0]) };
    buildDom();
});

afterEach(() => {
    destroySearchToolbar();
    document.body.innerHTML = '';
    delete globalThis.fetch;
    vi.restoreAllMocks();
});

describe('semantic mode result ordering', () => {
    it('re-sorts similarity-ranked hits into document order', async () => {
        const fetchMock = mockFetchOnce(rankedPayload());
        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');

        await typeAndSearch(toolbar, 'crisis of overproduction');

        expect(fetchMock).toHaveBeenCalled();
        // Server said 300, 100, 200 (best first). The toolbar must walk the book
        // top to bottom instead.
        expect(toolbar.matches.map(m => m.startLine)).toEqual(['100', '200', '300']);
    });

    it('opens on the first match at or after the reading position', async () => {
        mockFetchOnce(rankedPayload());
        // Reading at node 150 → the nearest hit at-or-after is 200, index 1.
        anchorState.elementId = '150';

        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');
        await typeAndSearch(toolbar, 'crisis of overproduction');

        expect(toolbar.currentMatchIndex).toBe(1);
        expect(document.getElementById('search-match-counter').textContent).toBe('2 of 3');
    });

    it('coerces the wire’s string chunk_id to a number', async () => {
        // Postgres serializes nodes.chunk_id as a string. Left as one it compares
        // false against currentlyLoadedChunks (a Set of numbers) and keys
        // matchesByChunk under "0" while lookups ask for 0 — so marks are never
        // applied to chunks already on screen and every hit takes the slow
        // navigate-and-wait branch.
        mockFetchOnce(rankedPayload());
        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');
        await typeAndSearch(toolbar, 'crisis of overproduction');

        expect(toolbar.matches.every(m => typeof m.chunk_id === 'number')).toBe(true);
        // Keyed numerically, so the already-loaded chunk 0 resolves.
        expect(toolbar.matchesByChunk.has(0)).toBe(true);
        expect(toolbar.matchesByChunk.has('0')).toBe(false);
    });

    it('tints whole nodes with their match %, inserting no <mark>', async () => {
        mockFetchOnce(rankedPayload());
        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');
        await typeAndSearch(toolbar, 'crisis of overproduction');

        const tinted = document.querySelectorAll('.semantic-match');
        expect(tinted).toHaveLength(3);
        expect(document.getElementById('100').dataset.semanticMatch).toBe('17');
        expect(document.getElementById('300').dataset.semanticMatch).toBe('54');

        // The node's text is untouched — no extractContents surgery.
        expect(document.querySelectorAll('mark.search-highlight')).toHaveLength(0);
        expect(document.getElementById('300').innerHTML).toBe('crisis of overproduction');
    });
});

describe('mode availability', () => {
    it('hides the toggle and forces exact for an E2EE book', async () => {
        encryptedBooks.add(BOOK);
        localStorage.setItem('intext_search_mode', 'semantic');

        const toolbar = initializeSearchToolbar();
        await toolbar.open();

        expect(toolbar.modeAvailable).toBe(false);
        expect(toolbar.mode).toBe('exact');
        expect(document.getElementById('search-mode-toggle').hidden).toBe(true);
    });

    it('hides the toggle and forces exact for a sub-book', async () => {
        lazyLoaderState.current = { bookId: `${BOOK}/Fn12`, currentlyLoadedChunks: new Set([0]) };
        localStorage.setItem('intext_search_mode', 'semantic');

        const toolbar = initializeSearchToolbar();
        await toolbar.open();

        expect(toolbar.modeAvailable).toBe(false);
        expect(toolbar.mode).toBe('exact');
    });

    it('is unavailable on a page whose partial rendered no toggle', async () => {
        buildDom({ withToggle: false });
        localStorage.setItem('intext_search_mode', 'semantic');

        const toolbar = initializeSearchToolbar();
        await toolbar.open();

        expect(toolbar.modeAvailable).toBe(false);
        expect(toolbar.mode).toBe('exact');
    });

    it('refuses to switch into semantic when unavailable', async () => {
        encryptedBooks.add(BOOK);
        const toolbar = initializeSearchToolbar();
        await toolbar.open();

        await toolbar.changeMode('semantic');

        expect(toolbar.mode).toBe('exact');
    });
});

describe('switching modes', () => {
    it('clears the other mode’s artifacts', async () => {
        idbNodes.rows = [
            { startLine: '300', chunk_id: 0, content: '<p>crisis of overproduction</p>' },
        ];
        const toolbar = initializeSearchToolbar();
        await toolbar.open();

        // Exact mode first: a real <mark> is inserted.
        await typeAndSearch(toolbar, 'crisis');
        expect(document.querySelectorAll('mark.search-highlight').length).toBeGreaterThan(0);

        mockFetchOnce(rankedPayload());
        await toolbar.changeMode('semantic');

        // The <mark> is gone and tints replace it.
        expect(document.querySelectorAll('mark.search-highlight')).toHaveLength(0);
        expect(document.querySelectorAll('.semantic-match').length).toBeGreaterThan(0);

        // ...and back again.
        await toolbar.changeMode('exact');
        expect(document.querySelectorAll('.semantic-match')).toHaveLength(0);
    });

    it('builds the local index when switching INTO exact', async () => {
        // open() skips the index when it opens straight into semantic mode; the
        // first switch to exact has to build it or exact silently finds nothing.
        localStorage.setItem('intext_search_mode', 'semantic');
        idbNodes.rows = [
            { startLine: '300', chunk_id: 0, content: '<p>crisis of overproduction</p>' },
        ];

        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        expect(toolbar.searchIndexCache).toBeNull();

        toolbar.input.value = 'crisis';
        await toolbar.changeMode('exact');

        expect(toolbar.searchIndexCache).not.toBeNull();
        expect(toolbar.matches.length).toBeGreaterThan(0);
    });

    it('persists the chosen mode', async () => {
        mockFetchOnce(rankedPayload());
        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');

        expect(localStorage.getItem('intext_search_mode')).toBe('semantic');
    });
});

describe('request lifecycle', () => {
    it('aborts an in-flight request when a newer query supersedes it', async () => {
        const signals = [];
        globalThis.fetch = vi.fn((url, opts) => {
            signals.push(opts.signal);
            return new Promise((resolve, reject) => {
                // What a real fetch does on abort: reject with an AbortError,
                // which is the branch semanticSearch must treat as "superseded"
                // rather than as a failure worth showing the user.
                opts.signal.addEventListener('abort', () => {
                    const err = new Error('The operation was aborted.');
                    err.name = 'AbortError';
                    reject(err);
                });
                // The second call resolves normally.
                if (signals.length > 1) {
                    resolve({ ok: true, status: 200, json: async () => rankedPayload(), blob: async () => new Blob([]) });
                }
            });
        });

        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');

        const first = toolbar.performSearch('crisis of over');
        const second = toolbar.performSearch('crisis of overproduction');
        await Promise.all([first, second]);

        expect(signals[0].aborted).toBe(true);
        // The aborted request must not have clobbered the UI with an error —
        // the newer query owns it.
        const counter = document.getElementById('search-match-counter');
        expect(counter.classList.contains('search-status-error')).toBe(false);
        expect(toolbar.matches.map(m => m.startLine)).toEqual(['100', '200', '300']);
    });

    it('reports a 403 in the counter slot instead of showing zero matches', async () => {
        mockFetchOnce({ success: false }, { status: 403 });
        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');

        await typeAndSearch(toolbar, 'crisis of overproduction');

        const counter = document.getElementById('search-match-counter');
        expect(counter.classList.contains('search-status-error')).toBe(true);
        expect(counter.textContent).toBe('not available here');
    });

    it('does not fetch at all when offline', async () => {
        const fetchMock = mockFetchOnce(rankedPayload());
        const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');
        await typeAndSearch(toolbar, 'crisis of overproduction');

        expect(fetchMock).not.toHaveBeenCalled();
        expect(document.getElementById('search-match-counter').textContent).toBe('no connection');
        onLine.mockRestore();
    });

    it('scopes the request to the open book', async () => {
        const fetchMock = mockFetchOnce(rankedPayload());
        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await toolbar.changeMode('semantic');
        await typeAndSearch(toolbar, 'crisis of overproduction');

        expect(fetchMock.mock.calls[0][0]).toContain(`book=${encodeURIComponent(BOOK)}`);
    });
});

describe('keyboard', () => {
    /** Dispatch a bubbling keydown from a specific element inside the toolbar. */
    function press(el, key, extra = {}) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
    }

    it('Escape closes from the ▲▼ buttons and the mode toggle, not just the input', async () => {
        // The listener used to sit on #search-input alone, so a user who clicked
        // next/prev and then pressed Escape got nothing: focus was on a button,
        // the event never reached the handler, and the bar stayed up with no
        // keyboard way out.
        const toolbar = initializeSearchToolbar();

        for (const sel of ['#search-next-button', '#search-prev-button', '.search-mode-toggle-btn']) {
            await toolbar.open();
            expect(toolbar.isOpen).toBe(true);

            press(document.querySelector(sel), 'Escape');
            expect(toolbar.isOpen, `Escape from ${sel} should close`).toBe(false);
        }
    });

    it('Enter advances only from the input — a focused button would double-advance', async () => {
        idbNodes.rows = [
            { startLine: '100', chunk_id: 0, content: '<p>crisis one</p>' },
            { startLine: '200', chunk_id: 0, content: '<p>crisis two</p>' },
        ];
        const toolbar = initializeSearchToolbar();
        await toolbar.open();
        await typeAndSearch(toolbar, 'crisis');

        const start = toolbar.currentMatchIndex;

        // A focused button already fires click on Enter; handling it here too
        // would move two matches per keypress.
        press(document.querySelector('#search-next-button'), 'Enter');
        expect(toolbar.currentMatchIndex).toBe(start);

        press(toolbar.input, 'Enter');
        expect(toolbar.currentMatchIndex).not.toBe(start);
    });
});

describe('full-text handoff', () => {
    it('forces exact mode — the handed-off query is a literal string', async () => {
        // searchBox deliberately omits this handoff for semantic hits, so a
        // pendingHighlightQuery is always a verbatim match. Running it through
        // the semantic engine because that's the remembered mode would rank by
        // meaning and land somewhere else.
        localStorage.setItem('intext_search_mode', 'semantic');
        idbNodes.rows = [
            { startLine: '300', chunk_id: 0, content: '<p>crisis of overproduction</p>' },
        ];
        const fetchMock = mockFetchOnce(rankedPayload());

        initializeSearchToolbar();
        await openSearchToolbarWithQuery('crisis', '300');

        const toolbar = getSearchToolbar();
        expect(toolbar.mode).toBe('exact');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
