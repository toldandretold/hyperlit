/**
 * CitationMode — scope chip behaviour, URL building, results-state visibility.
 *
 * Heavy DOM/keyboard/mobile coupling in the open()/close() lifecycle is out of
 * scope here — we test the parts a user actually interacts with: scope state,
 * localStorage persistence, URL parameters, chip visibility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DOMPurify (used in renderResults — not exercised here)
vi.mock('dompurify', () => ({
  default: { sanitize: (s) => s },
}));

vi.mock('../../../resources/js/utilities/bibtexProcessor', () => ({
  formatBibtexToCitation: vi.fn(async (b) => b),
}));

import { CitationMode } from '../../../resources/js/editToolbar/citationMode/index';
import { searchCacheClear } from '../../../resources/js/search/searchResultCache';

function buildMarkup() {
  // Chip bar lives inside #citation-toolbar-results now (the blurred panel).
  // Result items go into .citation-results-items so innerHTML clears don't
  // wipe the chip bar.
  document.body.innerHTML = `
    <div id="edit-toolbar">
      <button id="citation-button"></button>
      <div id="citation-mode-container" class="hidden">
        <div class="citation-input-wrapper">
          <input type="text" id="citation-search-input" />
          <button id="citation-close-btn">×</button>
        </div>
      </div>
    </div>
    <div id="citation-toolbar-results">
      <div class="citation-scope-bar">
        <div class="citation-scope-chips" role="tablist">
          <button type="button" class="citation-scope-btn active" data-scope="public" aria-selected="true">Public</button>
          <button type="button" class="citation-scope-btn" data-scope="mine" aria-selected="false">Personal</button>
          <button type="button" class="citation-scope-btn" data-scope="shelf" aria-selected="false">Shelf</button>
        </div>
        <div class="citation-shelf-picker" style="display:none;">
          <button type="button" class="citation-shelf-trigger" aria-haspopup="listbox" aria-expanded="false">
            <span class="citation-shelf-current">— pick a shelf —</span>
            <span class="citation-shelf-caret">▾</span>
          </button>
          <ul class="citation-shelf-options" role="listbox" hidden></ul>
        </div>
      </div>
      <div class="citation-results-items"></div>
    </div>
    <meta name="csrf-token" content="test-csrf">
  `;
}

function makeMode() {
  buildMarkup();
  return new CitationMode({
    toolbar: document.getElementById('edit-toolbar'),
    citationButton: document.getElementById('citation-button'),
    citationContainer: document.getElementById('citation-mode-container'),
    citationInput: document.getElementById('citation-search-input'),
    citationResults: document.getElementById('citation-toolbar-results'),
    allButtons: [],
    closeHeadingSubmenuCallback: () => {},
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  // The client-side search cache is module-level state — clear it so a cached
  // response from one test can never silently satisfy another test's fetch.
  searchCacheClear();
});

describe('CitationMode — scope initialisation', () => {
  it('defaults to public when nothing in localStorage', () => {
    const mode = makeMode();
    expect(mode.currentScope).toBe('public');
    expect(mode.currentShelfId).toBe('');
  });

  it('restores scope from localStorage', () => {
    localStorage.setItem('hyperlit:citation:scope', 'mine');
    localStorage.setItem('hyperlit:citation:shelfId', 'some-shelf-uuid');
    const mode = makeMode();
    expect(mode.currentScope).toBe('mine');
    expect(mode.currentShelfId).toBe('some-shelf-uuid');
  });

  it('ignores invalid scope from localStorage (defaults to public)', () => {
    localStorage.setItem('hyperlit:citation:scope', 'evil_payload');
    const mode = makeMode();
    expect(mode.currentScope).toBe('public');
  });
});

describe('CitationMode — _handleScopeChange', () => {
  it('updates currentScope, localStorage, and button active class', () => {
    const mode = makeMode();
    mode._initScopeChips();

    mode._handleScopeChange('mine');

    expect(mode.currentScope).toBe('mine');
    expect(localStorage.getItem('hyperlit:citation:scope')).toBe('mine');

    const activeBtn = document.querySelector('.citation-scope-btn.active');
    expect(activeBtn.dataset.scope).toBe('mine');
  });

  it('shows shelf picker when shelf scope selected', () => {
    const mode = makeMode();
    mode._initScopeChips();

    mode._handleScopeChange('shelf');

    const picker = document.querySelector('.citation-shelf-picker');
    expect(picker.style.display).toBe('');
  });

  it('hides shelf picker when switching back to public', () => {
    const mode = makeMode();
    mode._initScopeChips();

    mode._handleScopeChange('shelf');
    mode._handleScopeChange('public');

    const picker = document.querySelector('.citation-shelf-picker');
    expect(picker.style.display).toBe('none');
  });

  it('ignores invalid scope values', () => {
    const mode = makeMode();
    mode._initScopeChips();
    const before = mode.currentScope;

    mode._handleScopeChange('invalid_scope');

    expect(mode.currentScope).toBe(before);
  });

  it('resets currentOffset and re-fires search when scope changes mid-query', () => {
    const mode = makeMode();
    mode._initScopeChips();
    // _handleScopeChange reads from the input element (source of truth) — the
    // currentQuery/offset state is just a cache.
    mode.citationInput.value = 'something';
    mode.currentQuery = 'something';
    mode.currentOffset = 30;

    const performSearchSpy = vi.spyOn(mode, 'performSearch').mockImplementation(() => {});
    mode._handleScopeChange('mine');

    expect(mode.currentOffset).toBe(0);
    expect(performSearchSpy).toHaveBeenCalledWith('something', 0);
  });
});

describe('CitationMode — performSearch URL building', () => {
  it('includes sourceScope=public by default', async () => {
    const mode = makeMode();
    const fetchSpy = vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], has_more: false }),
    }));

    await mode.performSearch('marx', 0);

    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0][0];
    expect(url).toContain('sourceScope=public');
    expect(url).toContain('q=marx');
    expect(url).toContain('limit=15');
    expect(url).toContain('offset=0');
  });

  it('includes shelfId when scope=shelf and a shelf is selected', async () => {
    const mode = makeMode();
    mode.currentScope = 'shelf';
    mode.currentShelfId = 'shelf-uuid-xyz';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], has_more: false }),
    }));

    await mode.performSearch('marx', 0);

    const url = fetch.mock.calls[0][0];
    expect(url).toContain('sourceScope=shelf');
    expect(url).toContain('shelfId=shelf-uuid-xyz');
  });

  it('omits shelfId when scope is not shelf', async () => {
    const mode = makeMode();
    mode.currentScope = 'mine';
    mode.currentShelfId = 'leftover-shelf-uuid';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], has_more: false }),
    }));

    await mode.performSearch('marx', 0);

    const url = fetch.mock.calls[0][0];
    expect(url).not.toContain('shelfId');
  });

  it('guard: shelf scope without shelfId short-circuits (no fetch)', async () => {
    const mode = makeMode();
    mode.currentScope = 'shelf';
    mode.currentShelfId = '';
    vi.stubGlobal('fetch', vi.fn());

    await mode.performSearch('marx', 0);

    expect(fetch).not.toHaveBeenCalled();
    expect(mode.citationResults.dataset.state).toBe('empty');
  });
});

describe('CitationMode — custom shelf dropdown (not native <select>)', () => {
  // Stub fetch so _ensureShelvesLoaded resolves cleanly — otherwise the
  // real fetch hits localhost:3000 and the rejected promise surfaces as
  // an uncaught error in the test runner.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'shelf-1', name: 'My Shelf', item_count: 3 }],
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // Native <select> always dismissed the iOS keyboard when its picker opened.
  // Custom dropdown is just HTML, so mousedown.preventDefault on the trigger
  // keeps the input focused (same trick as the scope chips).

  it('tapping the trigger button does NOT fire native select picker (it is a <button>)', () => {
    const mode = makeMode();
    mode._initScopeChips();
    expect(mode.shelfTrigger?.tagName).toBe('BUTTON');
    expect(mode.shelfOptions?.tagName).toBe('UL');
  });

  it('mousedown on the trigger preventDefaults (keeps input focused)', () => {
    const mode = makeMode();
    mode._initScopeChips();
    let prevented = false;
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const original = ev.preventDefault.bind(ev);
    ev.preventDefault = () => { prevented = true; original(); };
    mode.shelfTrigger.dispatchEvent(ev);
    expect(prevented).toBe(true);
  });

  it('clicking trigger toggles the popup open/closed', () => {
    const mode = makeMode();
    mode._initScopeChips();
    expect(mode.shelfOptions.hidden).toBe(true);
    expect(mode.shelfTrigger.getAttribute('aria-expanded')).toBe('false');

    mode.shelfTrigger.click();
    expect(mode.shelfOptions.hidden).toBe(false);
    expect(mode.shelfTrigger.getAttribute('aria-expanded')).toBe('true');

    mode.shelfTrigger.click();
    expect(mode.shelfOptions.hidden).toBe(true);
  });

  it('picking a shelf updates state, label, and closes the popup', () => {
    const mode = makeMode();
    mode._initScopeChips();
    // Manually render some options (skipping the fetch)
    mode._renderShelfOptions([{ id: 'shelf-1', name: 'My Shelf', item_count: 3 }]);
    mode._openShelfDropdown();

    const opt = mode.shelfOptions.querySelector('li.citation-shelf-option');
    expect(opt).not.toBeNull();
    opt.click();

    expect(mode.currentShelfId).toBe('shelf-1');
    expect(mode.shelfCurrent.textContent).toContain('My Shelf');
    expect(mode.shelfOptions.hidden).toBe(true);
  });

  it('option mousedown preventDefaults so picking keeps input focused', () => {
    const mode = makeMode();
    mode._initScopeChips();
    mode._renderShelfOptions([{ id: 'shelf-1', name: 'My Shelf', item_count: 3 }]);
    const opt = mode.shelfOptions.querySelector('li.citation-shelf-option');

    let prevented = false;
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const original = ev.preventDefault.bind(ev);
    ev.preventDefault = () => { prevented = true; original(); };
    opt.dispatchEvent(ev);
    expect(prevented).toBe(true);
  });

  it('click outside the popup closes it WITHOUT closing the modal', () => {
    const mode = makeMode();
    mode.isOpen = true;
    mode.justOpened = false;
    mode._initScopeChips();
    mode._openShelfDropdown();

    const closeSpy = vi.spyOn(mode, 'close');
    const outsider = document.createElement('div');
    document.body.appendChild(outsider);

    mode.handleDocumentClick({
      target: outsider,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    expect(mode.shelfOptions.hidden).toBe(true);     // popup closed
    expect(closeSpy).not.toHaveBeenCalled();         // modal NOT closed
  });

  it('ESC closes only the popup if it is open (modal stays)', () => {
    const mode = makeMode();
    mode.isOpen = true;
    mode._initScopeChips();
    mode._openShelfDropdown();
    const closeSpy = vi.spyOn(mode, 'close');

    mode.handleKeyDown({ key: 'Escape' });

    expect(mode.shelfOptions.hidden).toBe(true);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('ESC closes the modal when popup is not open', () => {
    const mode = makeMode();
    mode.isOpen = true;
    mode._initScopeChips();
    const closeSpy = vi.spyOn(mode, 'close');

    mode.handleKeyDown({ key: 'Escape' });

    expect(closeSpy).toHaveBeenCalled();
  });

  it('teardown removes trigger handlers and closes any open popup', () => {
    const mode = makeMode();
    mode._initScopeChips();
    mode._openShelfDropdown();
    mode._destroyScopeChips();

    // Popup should be closed AND trigger refs cleared
    expect(mode.shelfTrigger).toBeNull();
    expect(mode.shelfOptions).toBeNull();
  });
});

describe('CitationMode — chip taps must not steal focus from the input', () => {
  // Regression: tapping a chip on mobile dismissed the keyboard because the
  // chip stole focus from the search input on click. Fix: preventDefault on
  // mousedown + pointerdown keeps focus on the input — click still fires.

  it('mousedown on a chip calls preventDefault (keeps input focused)', () => {
    const mode = makeMode();
    mode._initScopeChips();

    const chip = document.querySelector('.citation-scope-btn[data-scope="mine"]');
    let prevented = false;

    // Patch the chip's preventDefault detector via custom event
    const mdEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const original = mdEvent.preventDefault.bind(mdEvent);
    mdEvent.preventDefault = () => { prevented = true; original(); };
    chip.dispatchEvent(mdEvent);

    expect(prevented).toBe(true);
  });

  it('pointerdown on a chip calls preventDefault (mobile focus keeper)', () => {
    const mode = makeMode();
    mode._initScopeChips();

    const chip = document.querySelector('.citation-scope-btn[data-scope="shelf"]');
    let prevented = false;

    // happy-dom doesn't have a PointerEvent constructor — use Event instead
    const pdEvent = new Event('pointerdown', { bubbles: true, cancelable: true });
    const original = pdEvent.preventDefault.bind(pdEvent);
    pdEvent.preventDefault = () => { prevented = true; original(); };
    chip.dispatchEvent(pdEvent);

    expect(prevented).toBe(true);
  });

  it('click event still fires (preventDefault on pointerdown does NOT cancel click)', () => {
    const mode = makeMode();
    mode._initScopeChips();
    const performSearchSpy = vi.spyOn(mode, 'performSearch').mockImplementation(() => {});

    const chip = document.querySelector('.citation-scope-btn[data-scope="mine"]');
    // Simulate the sequence: pointerdown (prevented) → click (still fires)
    chip.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    chip.click();

    // Click handler ran → scope changed
    expect(mode.currentScope).toBe('mine');
    expect(document.querySelector('.citation-scope-btn.active').dataset.scope).toBe('mine');
  });

  it('teardown removes the focus-keeper listeners', () => {
    const mode = makeMode();
    mode._initScopeChips();
    mode._destroyScopeChips();

    // After teardown, dispatching pointerdown should NOT have any handler
    // calling preventDefault — track via spy.
    const chip = document.querySelector('.citation-scope-btn[data-scope="public"]');
    let prevented = false;
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true });
    const original = ev.preventDefault.bind(ev);
    ev.preventDefault = () => { prevented = true; original(); };
    chip.dispatchEvent(ev);

    expect(prevented).toBe(false);
  });
});

describe('CitationMode — handleResultsScroll mustn’t eat chip taps', () => {
  // Regression: handleResultsScroll used to preventDefault() on every
  // touchstart inside the panel when the panel wasn't overflowing — that
  // canceled the synthesized click event too, so tapping a scope chip on
  // mobile silently did nothing.

  it('does NOT preventDefault on a touchstart over a chip button', () => {
    const mode = makeMode();
    mode._initScopeChips();

    const chip = document.querySelector('.citation-scope-btn[data-scope="shelf"]');
    expect(chip).not.toBeNull();

    let prevented = false;
    const fakeEvent = {
      target: chip,
      preventDefault: () => { prevented = true; },
    };
    mode.handleResultsScroll(fakeEvent);

    expect(prevented).toBe(false);
  });

  it('does NOT preventDefault on a touchstart over the shelf trigger button', () => {
    const mode = makeMode();
    mode._initScopeChips();

    const trigger = document.querySelector('.citation-shelf-trigger');
    expect(trigger).not.toBeNull();

    let prevented = false;
    mode.handleResultsScroll({ target: trigger, preventDefault: () => { prevented = true; } });

    expect(prevented).toBe(false);
  });

  it('does NOT preventDefault on a touchstart over a result item button', () => {
    const mode = makeMode();
    mode._initScopeChips();

    const item = document.createElement('button');
    item.className = 'citation-result-item';
    mode._items().appendChild(item);

    let prevented = false;
    mode.handleResultsScroll({ target: item, preventDefault: () => { prevented = true; } });

    expect(prevented).toBe(false);
  });

  it('DOES preventDefault on a touchstart over the bare panel backdrop', () => {
    const mode = makeMode();
    mode._initScopeChips();

    // Tap on the panel itself (not on any interactive element)
    let prevented = false;
    mode.handleResultsScroll({
      target: mode.citationResults,
      preventDefault: () => { prevented = true; },
    });

    expect(prevented).toBe(true);
  });
});

describe('CitationMode — chip visibility tracks input via data-has-query', () => {
  // New contract: panel height is constant, chip bar visibility is driven by
  // data-has-query on #citation-toolbar-results. CSS hides .citation-scope-bar
  // when data-has-query='true'.

  function fakeInputEvent(value) {
    return { target: { value } };
  }

  it('typing any character sets data-has-query=true (hides chips via CSS)', () => {
    const mode = makeMode();
    mode._initScopeChips();

    mode.handleSearchInput(fakeInputEvent('a'));
    expect(mode.citationResults.dataset.hasQuery).toBe('true');

    mode.handleSearchInput(fakeInputEvent('marx'));
    expect(mode.citationResults.dataset.hasQuery).toBe('true');
  });

  it('clearing the input sets data-has-query=false (chips return)', () => {
    const mode = makeMode();
    mode._initScopeChips();

    mode.handleSearchInput(fakeInputEvent('marx'));
    mode.handleSearchInput(fakeInputEvent(''));

    expect(mode.citationResults.dataset.hasQuery).toBe('false');
  });

  it('shelf scope without shelfId keeps data-has-query=false so picker stays reachable', () => {
    const mode = makeMode();
    mode._initScopeChips();
    mode.currentScope = 'shelf';
    mode.currentShelfId = '';

    return mode.performSearch('marx', 0).then(() => {
      // performSearch's no-shelfId guard MUST force hasQuery off — otherwise
      // typing would hide the chips and trap the user with no picker visible.
      expect(mode.citationResults.dataset.hasQuery).toBe('false');
      expect(mode._items().textContent).toContain('Pick a shelf');
    });
  });

  it('scope change that does not fire a new search resets hasQuery', () => {
    const mode = makeMode();
    mode._initScopeChips();
    mode.citationResults.dataset.hasQuery = 'true';
    // input is empty — _handleScopeChange should not fire a search,
    // and should reset has-query to surface chips again.
    mode._handleScopeChange('mine');
    expect(mode.citationResults.dataset.hasQuery).toBe('false');
  });
});

describe('CitationMode — chip bar lives in the blurred results panel', () => {
  // Pre-PR layout had chips inside #edit-toolbar, which made the toolbar grow
  // on scope toggle and pushed the search input below the viewport on narrow
  // screens. Chips now live inside #citation-toolbar-results.

  it('scope bar resolves from inside #citation-toolbar-results, not the toolbar', () => {
    const mode = makeMode();
    mode._initScopeChips();
    expect(mode.scopeBar).not.toBeNull();
    expect(mode.scopeBar.closest('#citation-toolbar-results')).not.toBeNull();
    expect(mode.scopeBar.closest('#edit-toolbar')).toBeNull();
  });

  it('result writes target .citation-results-items, leaving the chip bar intact', async () => {
    const mode = makeMode();
    mode._initScopeChips();

    await mode.renderResults([{
      row_type: 'library', id: 'b1', book: 'b1', canonical_source_id: null,
      title: 'Test', author: 'A', year: '2024', bibtex: '@misc{x,author={A},year={2024},title={Test}}',
      has_version: true, has_nodes: true, is_private: false, source: 'library',
    }]);

    // Chip bar still present after results render
    expect(document.querySelector('.citation-scope-bar')).not.toBeNull();
    expect(document.querySelectorAll('.citation-scope-btn').length).toBe(3);

    // Items went into .citation-results-items
    expect(document.querySelector('.citation-results-items .citation-result-item')).not.toBeNull();
  });

  it('clearing input wipes the items list but keeps the chip bar', () => {
    const mode = makeMode();
    mode._initScopeChips();

    // Seed something into items
    mode._items().innerHTML = '<div class="citation-search-loading">Searching...</div>';
    expect(mode._items().innerHTML).toContain('Searching');

    mode.handleSearchInput({ target: { value: '' } });

    expect(mode._items().innerHTML).toBe('');
    // Chip bar still present
    expect(document.querySelector('.citation-scope-bar')).not.toBeNull();
    expect(document.querySelectorAll('.citation-scope-btn').length).toBe(3);
  });

  it('_updateScopeBarVisibility is a no-op (panel state controls visibility via CSS)', () => {
    const mode = makeMode();
    mode._initScopeChips();
    // Call all the old transition states — none of them should mutate the chip
    // bar's inline display. CSS handles panel-level visibility via data-state.
    ['hidden', 'loading', 'results', 'empty'].forEach(s => mode._updateScopeBarVisibility(s));
    expect(mode.scopeBar.style.display).toBe('');
  });
});

describe('CitationMode — regression: type → clear → switch scope', () => {
  // Reproduces the "Pick a shelf" dead-end bug: stale currentQuery from a prior
  // search re-fires when scope changes after the input is cleared, hiding the
  // chip bar (and the picker) right when the user needs it.

  function fakeInputEvent(value) {
    return { target: { value } };
  }

  it('clearing the input resets currentQuery so subsequent scope-change does not re-fire', () => {
    const mode = makeMode();
    mode._initScopeChips();

    // 1. Type a query
    mode.handleSearchInput(fakeInputEvent('marx capital'));
    expect(mode.currentQuery).toBe('marx capital');

    // 2. Clear the input
    mode.handleSearchInput(fakeInputEvent(''));
    expect(mode.currentQuery).toBe('');
    expect(mode.currentOffset).toBe(0);
  });

  it('clicking Shelf after clearing input does NOT fire a stale search', () => {
    const mode = makeMode();
    mode._initScopeChips();
    const performSearchSpy = vi.spyOn(mode, 'performSearch').mockImplementation(() => {});

    mode.handleSearchInput(fakeInputEvent('marx'));        // type
    mode.handleSearchInput(fakeInputEvent(''));            // clear
    performSearchSpy.mockClear();
    mode._handleScopeChange('shelf');                      // user clicks Shelf

    expect(performSearchSpy).not.toHaveBeenCalled();
  });

  it('switching scope while results are visible collapses panel back to chip-only state', () => {
    const mode = makeMode();
    mode._initScopeChips();

    // Simulate post-search state: results visible
    mode._items().innerHTML = '<button class="citation-result-item">Some result</button>';
    mode.citationResults.dataset.state = 'results';

    // User clears input and clicks a different scope chip
    mode.handleSearchInput(fakeInputEvent(''));
    mode._handleScopeChange('mine');

    expect(mode.citationResults.dataset.state).toBe('hidden');
    expect(mode._items().innerHTML).toBe('');
    // Chip bar still present and reachable
    expect(document.querySelectorAll('.citation-scope-btn').length).toBe(3);
  });

  it('Shelf scope without shelfId shows pick-a-shelf empty message but keeps the picker', () => {
    const mode = makeMode();
    mode._initScopeChips();
    mode.currentScope = 'shelf';
    mode.currentShelfId = '';

    return mode.performSearch('something', 0).then(() => {
      expect(mode._items().textContent).toContain('Pick a shelf');
      // Picker is part of the chip bar — must still be in the DOM
      expect(document.querySelector('.citation-shelf-picker')).not.toBeNull();
    });
  });

  it('Shelf chip stays interactable across type → clear → click cycles', () => {
    const mode = makeMode();
    mode._initScopeChips();
    const performSearchSpy = vi.spyOn(mode, 'performSearch').mockImplementation(() => {});

    mode.handleSearchInput(fakeInputEvent('marx capital'));   // type
    mode.citationResults.dataset.state = 'results';            // results land
    mode.handleSearchInput(fakeInputEvent(''));                // clear
    mode._handleScopeChange('shelf');                          // click Shelf

    const picker = document.querySelector('.citation-shelf-picker');
    expect(picker.style.display).toBe('');                     // picker visible
    expect(document.querySelectorAll('.citation-scope-btn').length).toBe(3);
    expect(performSearchSpy).not.toHaveBeenCalled();           // no stale fire
  });
});

describe('CitationMode — one-shot re-query on external_pending', () => {
  // The server dispatches a background OpenAlex/Open Library ingest when local
  // results are thin (external_pending=true) — the modal re-fires the SAME
  // query once ~2.5s later so the new canonicals fold in. Exactly once, and
  // never after the user typed a new query or closed the modal.

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fetchReturning(payload) {
    return vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  }

  it('schedules exactly one retry when external_pending=true on the first page', async () => {
    const mode = makeMode();
    mode.isOpen = true;
    const fetchMock = fetchReturning({ results: [], has_more: false, external_pending: true });
    vi.stubGlobal('fetch', fetchMock);

    mode.currentQuery = 'obscure book';
    await mode.performSearch('obscure book', 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Retry fires after 2.5s — the retry's own response has external_pending
    // false (server dedup), so no further retries get scheduled.
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [], has_more: false, external_pending: false }) });
    await vi.advanceTimersByTimeAsync(2500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not schedule a retry when external_pending is false or absent', async () => {
    const mode = makeMode();
    mode.isOpen = true;
    const fetchMock = fetchReturning({ results: [], has_more: false });
    vi.stubGlobal('fetch', fetchMock);

    mode.currentQuery = 'anything';
    await mode.performSearch('anything', 0);
    await vi.advanceTimersByTimeAsync(10000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a retry for load-more pages (offset > 0)', async () => {
    const mode = makeMode();
    mode.isOpen = true;
    const fetchMock = fetchReturning({ results: [], has_more: false, external_pending: true });
    vi.stubGlobal('fetch', fetchMock);

    mode.currentQuery = 'paging';
    await mode.performSearch('paging', 15);
    await vi.advanceTimersByTimeAsync(10000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a new keystroke cancels the pending retry', async () => {
    const mode = makeMode();
    mode.isOpen = true;
    const fetchMock = fetchReturning({ results: [], has_more: false, external_pending: true });
    vi.stubGlobal('fetch', fetchMock);

    mode.currentQuery = 'first query';
    await mode.performSearch('first query', 0);
    expect(mode.externalRetryTimer).not.toBeNull();

    // User types again before the retry fires
    mode.handleSearchInput({ target: { value: 'second query' } });
    expect(mode.externalRetryTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(10000);
    // Only the debounced search for the new query fired — not the stale retry.
    const urls = fetchMock.mock.calls.map(c => c[0]);
    expect(urls.filter(u => u.includes('first'))).toHaveLength(1);
  });

  it('closing the modal cancels the pending retry', async () => {
    const mode = makeMode();
    mode.isOpen = true;
    const fetchMock = fetchReturning({ results: [], has_more: false, external_pending: true });
    vi.stubGlobal('fetch', fetchMock);

    mode.currentQuery = 'closing time';
    await mode.performSearch('closing time', 0);
    expect(mode.externalRetryTimer).not.toBeNull();

    mode.close();
    expect(mode.externalRetryTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retry is skipped if the current query changed by fire time', async () => {
    const mode = makeMode();
    mode.isOpen = true;
    const fetchMock = fetchReturning({ results: [], has_more: false, external_pending: true });
    vi.stubGlobal('fetch', fetchMock);

    mode.currentQuery = 'original';
    await mode.performSearch('original', 0);
    expect(mode.externalRetryTimer).not.toBeNull();

    // Query state moved on without going through handleSearchInput. Spy on
    // performSearch (not raw fetch — incidental component fetches would make
    // a call-count assertion flaky) to prove the stale retry never re-fires.
    const performSearchSpy = vi.spyOn(mode, 'performSearch');
    mode.currentQuery = 'different';
    await vi.advanceTimersByTimeAsync(10000);

    expect(performSearchSpy).not.toHaveBeenCalled();
    expect(mode.externalRetryTimer).toBeNull();
  });
});

describe('CitationMode — private-lock badge in renderResults', () => {
  it('renders the private-lock icon when result.is_private is true', async () => {
    const mode = makeMode();
    await mode.renderResults([
      {
        row_type: 'library',
        id: 'book_private_one',
        book: 'book_private_one',
        canonical_source_id: null,
        title: 'My Private Thing',
        author: 'Me',
        year: '2024',
        bibtex: '@misc{x, author = {Me}, year = {2024}, title = {My Private Thing}}',
        has_version: true,
        has_nodes: true,
        is_private: true,
        source: 'library',
      },
    ]);

    const btn = mode.citationResults.querySelector('.citation-result-item');
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('citation-result-private-source')).toBe(true);
    expect(btn.querySelector('.citation-result-private')).not.toBeNull();
    expect(btn.querySelector('.citation-result-private svg')).not.toBeNull();
    expect(btn.dataset.isPrivate).toBe('1');
  });

  it('omits the lock icon on a public result', async () => {
    const mode = makeMode();
    await mode.renderResults([
      {
        row_type: 'library',
        id: 'book_public_one',
        book: 'book_public_one',
        canonical_source_id: null,
        title: 'A Public Thing',
        author: 'A',
        year: '2024',
        bibtex: '@misc{x, author = {A}, year = {2024}, title = {A Public Thing}}',
        has_version: true,
        has_nodes: true,
        is_private: false,
        source: 'library',
      },
    ]);

    const btn = mode.citationResults.querySelector('.citation-result-item');
    expect(btn.classList.contains('citation-result-private-source')).toBe(false);
    expect(btn.querySelector('.citation-result-private')).toBeNull();
    expect(btn.dataset.isPrivate).toBe('0');
  });
});

describe('CitationMode — _updateScopeBarVisibility (legacy no-op API)', () => {
  // Kept as a public no-op so external callers keep working. Visibility is now
  // a CSS concern, driven off citationResults.dataset.state.

  it('is a no-op on a fully initialised instance', () => {
    const mode = makeMode();
    mode._initScopeChips();
    expect(() => mode._updateScopeBarVisibility('results')).not.toThrow();
    expect(mode.scopeBar.style.display).toBe('');
  });

  it('does not throw if scope bar not yet initialised', () => {
    const mode = makeMode();
    expect(() => mode._updateScopeBarVisibility('hidden')).not.toThrow();
  });
});
