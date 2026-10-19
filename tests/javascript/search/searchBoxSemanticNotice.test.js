/**
 * The semanticNotice config hook: a NON-blocking coverage disclosure rendered
 * above semantic results (and the empty state), with an action button. The
 * user page uses it for "your private books aren't included — embeddings are
 * off". Semantic mode itself is never blocked; other modes never show it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSearchBox } from '../../../resources/js/search/searchBox';

function buildDom() {
    document.body.innerHTML = `
        <div id="sn-search-container" class="search-container">
            <textarea id="sn-search-input" class="search-input"></textarea>
            <div id="sn-search-results" class="search-results hidden"></div>
            <label><input type="checkbox" id="sn-fulltext-toggle"></label>
            <label><input type="checkbox" id="sn-semantic-toggle"></label>
        </div>`;
}

function makeBox(semanticNotice) {
    return createSearchBox({
        ids: {
            container: 'sn-search-container',
            input: 'sn-search-input',
            results: 'sn-search-results',
            fulltextToggle: 'sn-fulltext-toggle',
            semanticToggle: 'sn-semantic-toggle',
        },
        storage: { modeKey: 'sn_search_mode', queryKey: () => 'sn_search_query' },
        placeholders: { library: 'Titles…', fulltext: 'Text…', semantic: 'Meaning…' },
        noResultsMessage: () => 'No results',
        endpointFor: (mode, query) => `/api/test/${mode}?q=${encodeURIComponent(query)}`,
        ...(semanticNotice ? { semanticNotice } : {}),
        logSource: 'searchBoxSemanticNotice.test',
    });
}

const input = () => document.getElementById('sn-search-input');
const results = () => document.getElementById('sn-search-results');
const notice = () => results().querySelector('.search-semantic-notice');

function enterSemanticMode() {
    const toggle = document.getElementById('sn-semantic-toggle');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
}

async function search(query) {
    input().value = query;
    input().dispatchEvent(new Event('input', { bubbles: true }));
    // Outlive the semantic debounce (~600ms) plus the fetch microtasks.
    await new Promise((r) => setTimeout(r, 900));
}

let box = null;
let fetchMock;

beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '<meta name="csrf-token" content="t">';
    buildDom();
    fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, mode: 'semantic', results: [{ book: 'b1', headline: 'A passage', match: 42 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    box?.destroy();
    box = null;
});

describe('searchBox semanticNotice', () => {
    it('renders the notice above semantic results and the action fires', async () => {
        const onAction = vi.fn();
        box = makeBox(() => ({ text: 'Private books not included.', actionLabel: 'Enable', onAction }));
        box.init();
        enterSemanticMode();

        await search('meaning of accumulation');

        expect(notice()).not.toBeNull();
        expect(notice().textContent).toContain('Private books not included.');
        // The notice sits ABOVE the result list, and the results still rendered.
        expect(results().firstElementChild.className).toContain('search-semantic-notice');
        expect(results().querySelector('.search-results-list')).not.toBeNull();

        notice().querySelector('.search-semantic-notice-action').click();
        expect(onAction).toHaveBeenCalled();
    });

    it('renders the notice on the semantic empty state too', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, mode: 'semantic', results: [] }) });
        box = makeBox(() => ({ text: 'Private books not included.', actionLabel: 'Enable', onAction: vi.fn() }));
        box.init();
        enterSemanticMode();

        // Distinct query: the searchBox result cache is module-level and
        // URL-keyed, so reusing test 1's query would replay its results.
        await search('a query matching nothing whatsoever');

        expect(notice()).not.toBeNull();
        expect(results().querySelector('.search-no-results')).not.toBeNull();
    });

    it('a null notice (or non-semantic mode) renders nothing extra', async () => {
        box = makeBox(() => null);
        box.init();
        enterSemanticMode();
        await search('a third distinct semantic query');
        expect(notice()).toBeNull();

        box.destroy();
        buildDom();
        box = makeBox(() => ({ text: 'x', actionLabel: 'y', onAction: vi.fn() }));
        box.init(); // library mode — notice provider present but mode wrong
        fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, mode: 'library', results: [{ book: 'b1', headline: 'x' }] }) });
        await search('accumulation');
        expect(notice()).toBeNull();
    });
});
