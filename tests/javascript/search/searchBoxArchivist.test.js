/**
 * searchBox 'archivist' mode — the hero-page AI Archivist takeover.
 *
 * Locks the factory contract: the brain button toggles the mode (stamping
 * `archivist-mode` on the surrounding .arranger-buttons-container for the CSS
 * takeover), the mode is strictly SUBMIT-driven (typing/focus/restore never
 * fetch or fire), Enter submits (Shift+Enter doesn't), and a persisted
 * 'archivist' mode degrades to 'library' on instances without the wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSearchBox } from '../../../resources/js/search/searchBox';

function buildDom() {
    document.body.innerHTML = `
        <div class="arranger-buttons-container">
            <div id="test-search-container" class="search-container search-container--multiline">
                <div class="search-input-anchor">
                    <textarea id="test-search-input" class="search-input" rows="2"></textarea>
                    <div id="test-search-results" class="search-results hidden"></div>
                    <button type="button" id="archivist-ask-button" class="archivist-ask-btn" hidden>Ask</button>
                </div>
                <div class="search-toggle-stack">
                    <label><input type="checkbox" id="test-fulltext-toggle"></label>
                    <label><input type="checkbox" id="test-semantic-toggle"></label>
                </div>
            </div>
            <button class="arranger-button">Most Recent</button>
            <button type="button" id="archivist-brain-button"></button>
        </div>
    `;
}

function makeBox({ withArchivist = true, onSubmit = vi.fn() } = {}) {
    const config = {
        ids: {
            container: 'test-search-container',
            input: 'test-search-input',
            results: 'test-search-results',
            fulltextToggle: 'test-fulltext-toggle',
            semanticToggle: 'test-semantic-toggle',
            ...(withArchivist ? { brainButton: 'archivist-brain-button', askButton: 'archivist-ask-button' } : {}),
        },
        storage: {
            modeKey: 'test_search_mode',
            queryKey: () => 'test_search_query',
        },
        placeholders: {
            library: 'Search titles...',
            fulltext: 'Search content...',
            semantic: 'Search by meaning...',
            ...(withArchivist ? { archivist: 'Ask the AI Archivist...' } : {}),
        },
        noResultsMessage: () => 'No results',
        endpointFor: (mode, query) => `/api/test/${mode}?q=${encodeURIComponent(query)}`,
        ...(withArchivist ? { archivist: { onSubmit } } : {}),
        logSource: 'searchBoxArchivist.test',
    };
    return { box: createSearchBox(config), onSubmit };
}

const input = () => document.getElementById('test-search-input');
const brain = () => document.getElementById('archivist-brain-button');
const ask = () => document.getElementById('archivist-ask-button');
const row = () => document.querySelector('.arranger-buttons-container');
const semanticToggle = () => document.getElementById('test-semantic-toggle');

function type(value) {
    input().value = value;
    input().dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(shiftKey = false) {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 700));

let fetchMock;
let activeBox = null;

beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
    fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, results: [], mode: 'library' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    if (activeBox) { activeBox.destroy(); activeBox = null; }
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('entering and leaving archivist mode', () => {
    it('brain click enters the takeover; a second click restores the previous mode', () => {
        buildDom();
        const { box } = makeBox();
        activeBox = box;
        box.init();

        // start from semantic so "previous mode" is meaningful
        semanticToggle().checked = true;
        semanticToggle().dispatchEvent(new Event('change', { bubbles: true }));

        brain().click();
        expect(row().classList.contains('archivist-mode')).toBe(true);
        expect(ask().hidden).toBe(false);
        expect(brain().classList.contains('active')).toBe(true);
        expect(input().placeholder).toBe('Ask the AI Archivist...');
        expect(localStorage.getItem('test_search_mode')).toBe('archivist');

        brain().click();
        expect(row().classList.contains('archivist-mode')).toBe(false);
        expect(ask().hidden).toBe(true);
        expect(brain().classList.contains('active')).toBe(false);
        expect(semanticToggle().checked).toBe(true);
        expect(input().placeholder).toBe('Search by meaning...');
        expect(localStorage.getItem('test_search_mode')).toBe('semantic');
    });

    it('dispatches hyperlit:archivist-mode-changed on USER boundary crossings only', async () => {
        buildDom();
        const { box } = makeBox();
        activeBox = box;
        const events = [];
        const listener = (e) => events.push(e.detail?.active);
        window.addEventListener('hyperlit:archivist-mode-changed', listener);

        box.init(); // restore path — no event even if mode were persisted
        expect(events).toHaveLength(0);

        brain().click(); // enter
        expect(events).toEqual([true]);
        brain().click(); // exit
        expect(events).toEqual([true, false]);

        window.removeEventListener('hyperlit:archivist-mode-changed', listener);
    });

    it('a persisted archivist mode restores the takeover on init without firing anything', async () => {
        localStorage.setItem('test_search_mode', 'archivist');
        localStorage.setItem('test_search_query', 'a saved draft prompt');
        buildDom();
        const { box, onSubmit } = makeBox();
        activeBox = box;
        box.init();

        expect(row().classList.contains('archivist-mode')).toBe(true);
        expect(input().value).toBe('a saved draft prompt');
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('falls back to library when the instance has no archivist wiring', () => {
        localStorage.setItem('test_search_mode', 'archivist');
        buildDom();
        const { box } = makeBox({ withArchivist: false });
        activeBox = box;
        box.init();

        expect(row().classList.contains('archivist-mode')).toBe(false);
        expect(input().placeholder).toBe('Search titles...');
    });
});

describe('submit-driven behaviour', () => {
    it('typing in archivist mode persists the draft but never fetches', async () => {
        buildDom();
        const { box } = makeBox();
        activeBox = box;
        box.init();
        brain().click();

        type('what does delinking mean in this archive?');
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(localStorage.getItem('test_search_query')).toBe('what does delinking mean in this archive?');
    });

    it('focus in archivist mode never searches', async () => {
        buildDom();
        const { box } = makeBox();
        activeBox = box;
        box.init();
        brain().click();
        type('a long enough draft');
        input().dispatchEvent(new Event('focus', { bubbles: true }));
        await flush();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Enter submits the prompt; Shift+Enter does not; too-short prompts do not', () => {
        buildDom();
        const { box, onSubmit } = makeBox();
        activeBox = box;
        box.init();
        brain().click();

        input().value = 'hi';
        pressEnter();
        expect(onSubmit).not.toHaveBeenCalled();

        input().value = 'what does delinking mean?';
        pressEnter(true); // Shift+Enter = newline, no submit
        expect(onSubmit).not.toHaveBeenCalled();

        pressEnter();
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith('what does delinking mean?', '');
    });

    it('the Ask button submits', () => {
        buildDom();
        const { box, onSubmit } = makeBox();
        activeBox = box;
        box.init();
        brain().click();

        input().value = 'ask via the button';
        ask().click();
        expect(onSubmit).toHaveBeenCalledWith('ask via the button', '');
    });
});
