// CitationMode - Manages citation search interface integrated into edit toolbar
// Follows the HeadingSubmenu pattern for mode switching
//
// Test coverage:
//   - tests/javascript/editToolbar/citationMode.test.js (Vitest unit, happy-dom)
//       Scope chips, custom shelf dropdown, focus-keeper, handleResultsScroll
//       interactive-element exception, _shelfInteractionAt guard window.
//   - tests/e2e/specs/citations/citation-modal-scope.spec.js (Playwright)
//       Scope UI, URL params, regression: type→clear→Shelf trap.
//   - tests/e2e/specs/citations/citation-modal-mobile.spec.js (Playwright mobile)
//       Real-touch chip taps, shelf trigger keeps input focused (keyboard up).
//   - tests/e2e/specs/citations/citation-modal-insertion.spec.js (Playwright)
//       Full insertion flow, bibliography record shape.
// See tests/Feature/Citations/README.md for the full suite map.

import { buildResultButton } from "./resultsRender";
import { buildCombinedSearchUrl } from "./searchQuery";
import { searchCacheGet, searchCacheSet } from "../../search/searchResultCache";
import { log } from "../../utilities/logger";
import type { CitationModeOptions, ShelfUI, ScopeChipsUI, PendingContext, CitationSearchResult } from "./types";

declare global {
  interface Window {
    activeKeyboardManager?: any;
  }
}

const SCOPE_STORAGE_KEY = 'hyperlit:citation:scope';
const SHELF_STORAGE_KEY = 'hyperlit:citation:shelfId';
const VALID_SCOPES = ['public', 'mine', 'shelf'];

export class CitationMode {
  // Category A refs — always present while the mode operates. Resolved once in the
  // constructor; if any is missing the instance is `inert` and open() no-ops (the
  // editToolbar isDisabled pattern). Method bodies then use them with NO null-checks
  // (provably non-null), and tests reading them keep working.
  private inert = false;
  toolbar!: HTMLElement;
  citationButton!: HTMLElement;
  citationContainer!: HTMLElement;
  citationInput!: HTMLInputElement;
  citationResults!: HTMLElement;
  // Category B — queried at construction, genuinely optional; guarded with `if`.
  closeButton: HTMLElement | null = null;
  closeHeadingSubmenuCallback: (() => void) | undefined;
  private scopeUI: ScopeChipsUI | null = null;
  shelvesLoaded: boolean = false;
  boundScopeClickHandlers: any[] = [];
  boundShelfChangeHandler: ((e: Event) => void) | null = null;
  currentScope: string = 'public';
  currentShelfId: string = '';
  isOpen: boolean = false;
  pendingContext: PendingContext | null = null;
  debounceTimer: ReturnType<typeof setTimeout> | null = null;
  externalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  externalPoll: { query: string; attemptsLeft: number; baseline: number } | null = null;
  abortController: AbortController | null = null;
  currentQuery: string = '';
  currentOffset: number = 0;
  hasMore: boolean = false;
  touchStartX: number | null = null;
  touchStartY: number | null = null;
  boundDocumentClickHandler: ((e: MouseEvent) => void) | null = null;
  boundDocumentKeyDownHandler: ((e: KeyboardEvent) => void) | null = null;
  boundDocumentTouchStartHandler: ((e: TouchEvent) => void) | null = null;
  boundDocumentTouchEndHandler: ((e: TouchEvent) => void) | null = null;
  boundInputHandler: ((e: Event) => void) | null = null;
  boundResultsScrollHandler: ((e: Event) => void) | null = null;
  boundCloseButtonHandler: ((e: Event) => void) | null = null;
  justOpened: boolean = false;
  lockedScrollPosition: number | null = 0;
  boundScrollLockHandler: ((e: Event) => void) | null = null;
  _shelfInteractionAt: number = 0;
  boundShelfTriggerHandlers: { triggerFocusKeeper: (e: Event) => void; triggerClickHandler: (e: Event) => void } | null = null;
  boundInputTouchHandler: ((e: TouchEvent) => void) | null = null;

  // Back-compat read-only accessors: the scope/shelf refs now live in `scopeUI`, but tests
  // (and any external reader) still address them as flat properties. Null when closed.
  get scopeBar(): HTMLElement | null { return this.scopeUI?.scopeBar ?? null; }
  get shelfTrigger(): HTMLElement | null { return this.scopeUI?.shelf?.trigger ?? null; }
  get shelfOptions(): HTMLElement | null { return this.scopeUI?.shelf?.options ?? null; }
  get shelfCurrent(): HTMLElement | null { return this.scopeUI?.shelf?.current ?? null; }

  constructor({
    toolbar,
    citationButton,
    citationContainer,
    citationInput,
    citationResults,
    closeHeadingSubmenuCallback
  }: CitationModeOptions = {}) {
    this.closeButton = document.getElementById('citation-close-btn');
    this.closeHeadingSubmenuCallback = closeHeadingSubmenuCallback;

    // If any essential citation element is missing, the mode is inert and open() no-ops.
    if (!toolbar || !citationButton || !citationContainer || !citationInput || !citationResults) {
      this.inert = true;
      return;
    }
    this.toolbar = toolbar;
    this.citationButton = citationButton;
    this.citationContainer = citationContainer;
    this.citationInput = citationInput;
    this.citationResults = citationResults;

    // Scope/shelf refs (scopeUI) are queried lazily in _initScopeChips() on open() —
    // the container may not be in the DOM at construction time. Field initializers cover defaults.
    this.shelvesLoaded = false;
    this.boundScopeClickHandlers = [];
    this.boundShelfChangeHandler = null;

    // Restore last-used scope + shelf, falling back to public.
    let savedScope = 'public';
    let savedShelfId = '';
    try {
      const s = localStorage.getItem(SCOPE_STORAGE_KEY);
      if (s && VALID_SCOPES.includes(s)) savedScope = s;
      savedShelfId = localStorage.getItem(SHELF_STORAGE_KEY) || '';
    } catch {}
    this.currentScope = savedScope;
    this.currentShelfId = savedShelfId;

    // State
    this.isOpen = false;
    this.pendingContext = null;
    this.debounceTimer = null;
    this.abortController = null;
    this.currentQuery = '';
    this.currentOffset = 0;
    this.hasMore = false;

    // Touch tracking
    this.touchStartX = null;
    this.touchStartY = null;

    // Bound handlers for cleanup
    this.boundDocumentClickHandler = null;
    this.boundDocumentKeyDownHandler = null;
    this.boundDocumentTouchStartHandler = null;
    this.boundDocumentTouchEndHandler = null;
    this.boundInputHandler = null;
    this.boundResultsScrollHandler = null;
    this.boundCloseButtonHandler = null;
  }

  open(context: PendingContext) {
    if (this.inert || this.isOpen) return;

    // Close heading submenu if it's open (prevents visual overlap)
    if (this.closeHeadingSubmenuCallback) {
      this.closeHeadingSubmenuCallback();
    }

    this.pendingContext = context;
    this.isOpen = true;
    this.justOpened = true; // Flag to prevent immediate closure

    // Clear flag after 300ms (prevents synthetic click from closing)
    setTimeout(() => {
      this.justOpened = false;
    }, 300);

    // Add citation mode class to toolbar (CSS will hide other buttons)
    this.toolbar.classList.add('citation-mode-active');

    // Show citation container
    this.citationContainer.classList.remove('hidden');

    // Wire scope chips first so this._items() resolves correctly on the wipes below.
    this._initScopeChips();

    // Clear previous state
    this.citationInput.value = '';
    this._items().innerHTML = '';
    this.citationResults.dataset.state = 'hidden';
    this.citationResults.dataset.hasQuery = 'false';

    // MOBILE SCROLL LOCK: Lock window scroll position when citation mode opens
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      this.lockedScrollPosition = window.scrollY || window.pageYOffset || 0;
      this.boundScrollLockHandler = () => {
        if (window.scrollY !== this.lockedScrollPosition) {
          window.scrollTo(0, this.lockedScrollPosition ?? 0);
        }
      };
      window.addEventListener('scroll', this.boundScrollLockHandler, { passive: false });
    }

    // Attach event handlers
    this.attachEventHandlers();

    // Auto-focus on desktop only (mobile causes wild iOS scrolling)
    if (!isMobile) {
      setTimeout(() => {
        this.citationInput.focus();
      }, 100);
    }

    // Update positioning if keyboard is open
    const keyboardManager = (window as any).activeKeyboardManager;
    if (keyboardManager && keyboardManager.isKeyboardOpen) {
      const editToolbar = document.getElementById('edit-toolbar');
      const searchToolbar = document.getElementById('search-toolbar');
      const citationToolbar = document.getElementById('citation-toolbar');
      const bottomRightButtons = document.getElementById('bottom-right-buttons');
      const mainContent = document.querySelector('.main-content');

      keyboardManager.moveToolbarAboveKeyboard(
        editToolbar, searchToolbar, citationToolbar, bottomRightButtons, mainContent
      );
    }
  }

  close() {
    // Early return if already closed
    if (!this.isOpen) return;

    this.isOpen = false;
    this.pendingContext = null;
    this.currentQuery = '';
    this.currentOffset = 0;
    this.hasMore = false;

    // Remove citation mode class (CSS will show other buttons)
    this.toolbar.classList.remove('citation-mode-active');

    // Hide citation container
    this.citationContainer.classList.add('hidden');

    // Hide citation results container (fixes dark rectangle bug on iOS).
    // Only wipe the items list — leave the chip bar (sibling) intact so it's
    // ready for the next open() without re-instantiating handlers.
    this.citationResults.dataset.state = 'hidden';
    this.citationResults.dataset.hasQuery = 'false';
    const items = this.citationResults?.querySelector?.('.citation-results-items');
    if (items) items.innerHTML = '';
    else if (this.citationResults) this.citationResults.innerHTML = '';

    // MOBILE SCROLL LOCK: Remove scroll lock handler
    if (this.boundScrollLockHandler) {
      window.removeEventListener('scroll', this.boundScrollLockHandler);
      this.boundScrollLockHandler = null;
      this.lockedScrollPosition = null;
    }

    // Cancel any pending search
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Clear debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Clear any pending external-ingest follow-up query
    this.clearExternalRetry();

    // Tear down scope chip handlers
    this._destroyScopeChips();

    // Detach event handlers
    this.detachEventHandlers();
  }

  // Render the scope chips into their resting state (active button highlighted, shelf
  // picker shown if the persisted scope is 'shelf'), attach click handlers, and lazy-load
  // shelves only when needed. Idempotent — safe to call on every open().
  //
  // Chip bar now lives INSIDE #citation-toolbar-results (the blurred panel above
  // the input), not inside #citation-mode-container. Putting them in the
  // toolbar made the toolbar grow on scope toggle and pushed the search input
  // below the viewport on narrow screens. Result items go into a sibling
  // .citation-results-items so innerHTML clears don't wipe the chip bar.
  _initScopeChips() {
    const root = this.citationResults;
    const scopeBar = root.querySelector<HTMLElement>('.citation-scope-bar');
    if (!scopeBar) return;
    const scopeButtons = Array.from(scopeBar.querySelectorAll<HTMLElement>('.citation-scope-btn'));

    // Custom shelf dropdown (button + popup) — replaces the native <select> which on
    // iOS always dismissed the keyboard when its picker opened. Built as a bundle only
    // if the whole markup block is present (it's one cohesive block in the template).
    const trigger = scopeBar.querySelector<HTMLElement>('.citation-shelf-trigger');
    const picker = scopeBar.querySelector<HTMLElement>('.citation-shelf-picker');
    const current = scopeBar.querySelector<HTMLElement>('.citation-shelf-current');
    const options = scopeBar.querySelector<HTMLElement>('.citation-shelf-options');
    const shelf: ShelfUI | null =
      (trigger && picker && current && options) ? { picker, trigger, current, options } : null;

    this.scopeUI = { scopeBar, scopeButtons, shelf };

    // Reflect saved scope in the chip UI
    scopeButtons.forEach((btn) => {
      const isActive = btn.dataset.scope === this.currentScope;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // Show chips by default (state is 'hidden' on open).
    scopeBar.style.display = '';
    this._togglePickerVisibility();

    // Click handlers — tracked for detach. mousedown/pointerdown preventDefault keeps focus
    // on the search input (otherwise the chip steals focus and the mobile keyboard dismisses);
    // the click still fires normally.
    scopeButtons.forEach((btn) => {
      const handler = () => this._handleScopeChange(btn.dataset.scope);
      const focusKeeper = (e: Event) => e.preventDefault();
      btn.addEventListener('mousedown', focusKeeper);
      btn.addEventListener('pointerdown', focusKeeper);
      btn.addEventListener('click', handler);
      this.boundScopeClickHandlers.push({ btn, handler, focusKeeper });
    });

    if (shelf) {
      // Same focus-keeper trick on the shelf trigger so the keyboard stays up.
      const triggerFocusKeeper = (e: Event) => e.preventDefault();
      const triggerClickHandler = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const expanded = shelf.trigger.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          this._closeShelfDropdown();
        } else {
          this._openShelfDropdown();
        }
      };
      shelf.trigger.addEventListener('mousedown', triggerFocusKeeper);
      shelf.trigger.addEventListener('pointerdown', triggerFocusKeeper);
      shelf.trigger.addEventListener('click', triggerClickHandler);
      this.boundShelfTriggerHandlers = { triggerFocusKeeper, triggerClickHandler };
    }

    // Lazy load shelves if persisted scope is 'shelf'
    if (this.currentScope === 'shelf') {
      this._ensureShelvesLoaded();
    }
  }

  _destroyScopeChips() {
    this.boundScopeClickHandlers.forEach(({ btn, handler, focusKeeper }) => {
      btn.removeEventListener('click', handler);
      if (focusKeeper) {
        btn.removeEventListener('mousedown', focusKeeper);
        btn.removeEventListener('pointerdown', focusKeeper);
      }
    });
    this.boundScopeClickHandlers = [];
    const shelf = this.scopeUI?.shelf;
    if (shelf && this.boundShelfTriggerHandlers) {
      const { triggerFocusKeeper, triggerClickHandler } = this.boundShelfTriggerHandlers;
      shelf.trigger.removeEventListener('mousedown', triggerFocusKeeper);
      shelf.trigger.removeEventListener('pointerdown', triggerFocusKeeper);
      shelf.trigger.removeEventListener('click', triggerClickHandler);
      this.boundShelfTriggerHandlers = null;
    }
    this._closeShelfDropdown();
    this._shelfInteractionAt = 0;
    this.scopeUI = null;
  }

  _openShelfDropdown() {
    const shelf = this.scopeUI?.shelf;
    if (!shelf) return;
    shelf.trigger.setAttribute('aria-expanded', 'true');
    shelf.options.hidden = false;
    // Flag the panel so CSS (and keyboardManager) can grow the blurred area
    // to fit the popup, which sits above the chip bar.
    this.citationResults.classList.add('shelf-dropdown-open');
    this._shelfInteractionAt = performance.now();
    this._ensureShelvesLoaded();
    this.repositionContainer();
  }

  _closeShelfDropdown() {
    const shelf = this.scopeUI?.shelf;
    if (shelf) {
      shelf.trigger.setAttribute('aria-expanded', 'false');
      shelf.options.hidden = true;
    }
    this.citationResults.classList.remove('shelf-dropdown-open');
    this.repositionContainer();
  }

  _pickShelf(id: string | undefined, label: string | undefined) {
    this.currentShelfId = id || '';
    try { localStorage.setItem(SHELF_STORAGE_KEY, this.currentShelfId); } catch {}
    const current = this.scopeUI?.shelf?.current;
    if (current) {
      current.textContent = id ? (label ?? '') : '— pick a shelf —';
    }
    this._closeShelfDropdown();
    this._shelfInteractionAt = performance.now();
    // Re-fire current search with the new shelf
    const inputValue = (this.citationInput.value || '').trim();
    if (inputValue.length >= 2) {
      this.currentQuery = inputValue;
      this.currentOffset = 0;
      this.performSearch(inputValue, 0);
    }
  }

  _handleScopeChange(newScope: string | undefined) {
    if (!newScope || !VALID_SCOPES.includes(newScope) || newScope === this.currentScope) {
      // Still allow shelf re-click to surface the picker
      if (newScope === 'shelf') this._ensureShelvesLoaded();
      return;
    }
    this.currentScope = newScope;
    try { localStorage.setItem(SCOPE_STORAGE_KEY, newScope); } catch {}

    this.scopeUI?.scopeButtons.forEach((btn) => {
      const isActive = btn.dataset.scope === newScope;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    this._togglePickerVisibility();
    if (newScope === 'shelf') this._ensureShelvesLoaded();

    // If we're not about to fire a real new search, just collapse the panel
    // back to the chip-only state. (Chip bar lives in the panel now, so it
    // stays visible regardless.)
    const inputValue = (this.citationInput?.value || '').trim();
    const willFireSearch = inputValue.length >= 2 && !(newScope === 'shelf' && !this.currentShelfId);
    if (!willFireSearch) {
      this._items().innerHTML = '';
      this.citationResults.dataset.state = 'hidden';
      this.citationResults.dataset.hasQuery = 'false';
      this.repositionContainer();
    }

    // Re-fire current search with new scope (resets pagination). Use the live
    // input value, not this.currentQuery — the latter goes stale when the
    // input was cleared without firing a new search.
    if (willFireSearch) {
      this.currentQuery = inputValue;
      this.currentOffset = 0;
      this.performSearch(inputValue, 0);
    }
  }

  _togglePickerVisibility() {
    const picker = this.scopeUI?.shelf?.picker;
    if (picker) {
      picker.style.display = this.currentScope === 'shelf' ? '' : 'none';
    }
  }

  async _ensureShelvesLoaded() {
    const shelf = this.scopeUI?.shelf;
    if (this.shelvesLoaded || !shelf) return;
    this.shelvesLoaded = true;
    try {
      const resp = await fetch('/api/shelves', {
        headers: { 'Accept': 'application/json' },
        credentials: 'same-origin',
      });
      const data = await resp.json();
      const shelves = Array.isArray(data) ? data : (data.shelves || data.data || []);
      if (!shelves.length) {
        shelf.options.innerHTML = '<li class="citation-shelf-option-empty" role="option" aria-disabled="true">No shelves — create one first</li>';
        return;
      }
      this._renderShelfOptions(shelves);

      // Restore last-used shelf label if it still exists
      if (this.currentShelfId) {
        const match = shelves.find((s: any) => (s.id || s.shelf_id) === this.currentShelfId);
        if (match) {
          const count = Number(match.item_count ?? 0);
          const name = match.name || match.title || 'Untitled';
          shelf.current.textContent = count > 0 ? `${name} (${count})` : `${name} (empty)`;
        }
      }
    } catch (e) {
      this.shelvesLoaded = false;
      log.error('Failed to load shelves', '/editToolbar/citationMode/index.ts', e);
      shelf.options.innerHTML = '<li class="citation-shelf-option-empty" role="option" aria-disabled="true">Failed to load shelves</li>';
    }
  }

  _renderShelfOptions(shelves: any) {
    const options = this.scopeUI?.shelf?.options;
    if (!options) return;
    const escape = (s: any) => String(s).replace(/[<>&"]/g, (c: string) => (({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'} as Record<string, string>)[c] || c));
    options.innerHTML = shelves.map((s: any) => {
      const id = s.id || s.shelf_id;
      const count = Number(s.item_count ?? 0);
      const name = escape(s.name || s.title || 'Untitled');
      const label = count > 0 ? `${name} (${count})` : `${name} (empty)`;
      const selected = id === this.currentShelfId ? ' aria-selected="true"' : '';
      return `<li class="citation-shelf-option" role="option" data-shelf-id="${id}" data-shelf-label="${label}"${selected}>${label}</li>`;
    }).join('');

    // Per-option focus-keeper + pick handler. Same mousedown/pointerdown
    // preventDefault trick the chip buttons use, so tapping an option doesn't
    // shift focus away from the input (keyboard stays up).
    options.querySelectorAll('li.citation-shelf-option').forEach((li: any) => {
      const focusKeeper = (e: any) => e.preventDefault();
      const pickHandler = (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        this._pickShelf(li.dataset.shelfId, li.dataset.shelfLabel);
      };
      li.addEventListener('mousedown', focusKeeper);
      li.addEventListener('pointerdown', focusKeeper);
      li.addEventListener('click', pickHandler);
    });
  }

  // Kept as a no-op for backward compat: the chip bar now lives inside the
  // blurred results panel itself, so its visibility tracks the panel's
  // data-state via CSS rather than a per-state JS toggle. Callers can keep
  // invoking this safely.
  _updateScopeBarVisibility(_state: any) {
    // intentional no-op
  }

  // Returns the inner container that holds result items. Result writes target
  // this so innerHTML clears don't wipe the chip bar that lives at the bottom
  // of #citation-toolbar-results.
  _items(): HTMLElement {
    return this.citationResults.querySelector<HTMLElement>('.citation-results-items')
      || this.citationResults;
  }

  attachEventHandlers() {
    // Input handler
    this.boundInputHandler = this.handleSearchInput.bind(this);
    this.citationInput.addEventListener('input', this.boundInputHandler);

    // MOBILE FIX: Intercept touch on citation input to prevent iOS scroll-to-focus
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      this.boundInputTouchHandler = (e: any) => {
        e.preventDefault(); // Prevent iOS scroll-to-focus behavior
        e.stopPropagation();

        // Manually focus the input without triggering scroll
        this.citationInput.focus({ preventScroll: true });
      };
      this.citationInput.addEventListener('touchend', this.boundInputTouchHandler, { passive: false });
    }

    // Close button handler
    if (this.closeButton) {
      this.boundCloseButtonHandler = () => this.close();
      this.closeButton.addEventListener('click', this.boundCloseButtonHandler);
    }

    // Document click handler (click outside to close)
    this.boundDocumentClickHandler = this.handleDocumentClick.bind(this);
    document.addEventListener('click', this.boundDocumentClickHandler, true);

    // Keyboard handler (ESC to close)
    this.boundDocumentKeyDownHandler = this.handleKeyDown.bind(this);
    document.addEventListener('keydown', this.boundDocumentKeyDownHandler);

    // Touch handlers for mobile
    this.boundDocumentTouchStartHandler = this.handleTouchStart.bind(this);
    this.boundDocumentTouchEndHandler = this.handleTouchEnd.bind(this);
    document.addEventListener('touchstart', this.boundDocumentTouchStartHandler, { passive: true });
    document.addEventListener('touchend', this.boundDocumentTouchEndHandler, { passive: false });

    // Results scroll prevention when not scrollable
    this.boundResultsScrollHandler = this.handleResultsScroll.bind(this);
    this.citationResults.addEventListener('touchstart', this.boundResultsScrollHandler, { passive: false });
  }

  detachEventHandlers() {
    if (this.boundInputHandler) {
      this.citationInput.removeEventListener('input', this.boundInputHandler);
    }
    if (this.boundInputTouchHandler) {
      this.citationInput.removeEventListener('touchend', this.boundInputTouchHandler);
    }
    if (this.boundCloseButtonHandler && this.closeButton) {
      this.closeButton.removeEventListener('click', this.boundCloseButtonHandler);
    }
    if (this.boundDocumentClickHandler) {
      document.removeEventListener('click', this.boundDocumentClickHandler, true);
    }
    if (this.boundDocumentKeyDownHandler) {
      document.removeEventListener('keydown', this.boundDocumentKeyDownHandler);
    }
    if (this.boundDocumentTouchStartHandler) {
      document.removeEventListener('touchstart', this.boundDocumentTouchStartHandler);
    }
    if (this.boundDocumentTouchEndHandler) {
      document.removeEventListener('touchend', this.boundDocumentTouchEndHandler);
    }
    if (this.boundResultsScrollHandler) {
      this.citationResults.removeEventListener('touchstart', this.boundResultsScrollHandler);
    }
  }

  handleSearchInput(event: any) {
    const query = event.target.value.trim();

    // Drive chip-bar visibility off raw input length — hide chips as soon as
    // the user types ANY character, show them again on full clear. CSS hides
    // .citation-scope-bar when data-has-query='true'.
    this.citationResults.dataset.hasQuery = query.length > 0 ? 'true' : 'false';

    // Cancel previous debounce + any pending external-ingest retry (the retry
    // is bound to the query it was scheduled for; a new keystroke supersedes it)
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.clearExternalRetry();

    if (query.length < 2) {
      this._items().innerHTML = '';
      this.citationResults.dataset.state = 'hidden';
      // Reset state so a subsequent scope-change doesn't re-fire a stale query
      // (typing "marx" → clearing → clicking Shelf used to re-fire "marx" with
      // shelf+no-shelfId, hitting the "Pick a shelf" empty state).
      this.currentQuery = '';
      this.currentOffset = 0;
      this.hasMore = false;
      // Re-position so the panel shrinks back to chip-bar height when keyboard
      // is up (keyboardManager uses state-aware heights).
      this.repositionContainer();
      return;
    }

    // Show loading state
    this._items().innerHTML = '<div class="citation-search-loading">Searching...</div>';
    this.citationResults.dataset.state = 'loading';
    this.repositionContainer();

    // Reset pagination for new query
    this.currentQuery = query;
    this.currentOffset = 0;
    this.hasMore = false;

    // Debounce search
    this.debounceTimer = setTimeout(() => {
      this.performSearch(query, 0);
    }, 300);
  }

  async performSearch(query: any, offset = 0, bypassCache = false) {
    // Guard: shelf scope needs a shelfId — otherwise we'd fire the request just to
    // get a 422 back. Surface a friendlier message in the results pane AND keep
    // the scope bar visible so the user can actually use the picker (hiding it
    // here was the cause of the "Pick a shelf" dead-end).
    if (this.currentScope === 'shelf' && !this.currentShelfId) {
      this._items().innerHTML = '<div class="citation-search-empty">Pick a shelf to search within.</div>';
      this.citationResults.dataset.state = 'empty';
      // Keep chip bar visible so the picker is reachable — without this the
      // user's typed text would hide the chips and trap them.
      this.citationResults.dataset.hasQuery = 'false';
      this.repositionContainer();
      return;
    }

    // Cancel previous request
    if (this.abortController) {
      this.abortController.abort();
    }

    this.abortController = new AbortController();

    try {
      const url = buildCombinedSearchUrl(query, this.currentScope, this.currentShelfId, offset);

      // Client-side cache: the URL is the key (encodes query/scope/shelf/offset).
      // Backspacing or retyping an identical query renders instantly. The
      // external-pending retry bypasses so it reaches the server.
      if (!bypassCache) {
        const cached = searchCacheGet<{ results?: CitationSearchResult[]; has_more?: boolean; external_status?: string }>(url);
        if (cached) {
          await this.renderResults(cached.results || [], offset, cached.has_more ?? false);
          this.updateExternalPolling(false, query, offset, (cached.results || []).length,
            typeof cached.external_status === 'string' ? cached.external_status : null);
          return;
        }
      }

      const response = await fetch(url, {
        headers: {
          'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as HTMLMetaElement | null)?.content || '',
        },
        signal: this.abortController.signal
      });

      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      // Never cache pages while an external ingest may still land for this
      // query — a cached thin page would hide the ingested results on retype.
      const pollActiveForQuery = this.externalPoll !== null && this.externalPoll.query === query;
      if (data.external_pending !== true && !pollActiveForQuery) {
        searchCacheSet(url, data);
      }
      await this.renderResults(data.results || [], offset, data.has_more ?? false);
      this.updateExternalPolling(
        data.external_pending === true,
        query,
        offset,
        (data.results || []).length,
        typeof data.external_status === 'string' ? data.external_status : null,
      );

    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this._items().innerHTML = '<div class="citation-search-empty">Search failed. Please try again.</div>';
        this.citationResults.dataset.state = 'empty';
        this.repositionContainer();
      }
    }
  }

  /**
   * External-supplement polling. When the server returns external_pending=true
   * it has dispatched a background OpenAlex/Open Library ingest for this query;
   * results land whenever that job finishes (1-15s, cold-API dependent). We
   * re-fire the same query up to 3 times at 2.5s intervals, stopping early as
   * soon as the result count grows past the pre-ingest baseline. Poll responses
   * always carry external_pending=false (server dedup key), so polls can never
   * restart themselves — only a fresh dispatch can.
   */
  updateExternalPolling(pending: boolean, query: string, offset: number, resultCount: number, status: string | null = null) {
    if (pending && offset === 0) {
      // Server just dispatched a background ingest — start polling.
      this.externalPoll = { query, attemptsLeft: 3, baseline: resultCount };
      this.showExternalSearchingState(resultCount);
      this.scheduleNextExternalPoll();
      return;
    }

    const poll = this.externalPoll;
    if (poll && poll.query === query && offset === 0) {
      if (resultCount > poll.baseline || poll.attemptsLeft <= 0) {
        // External results landed (renderResults already showed them), or we
        // gave up — renderResults painted the final state; refine the empty
        // message with what we know about the external outcome.
        this.clearExternalRetry();
        if (resultCount === 0) this.applyExternalEmptyMessage(status);
        return;
      }
      this.showExternalSearchingState(resultCount);
      this.scheduleNextExternalPoll();
      return;
    }

    // No poll in flight (e.g. retyped a query inside its dedup window): the
    // server still reports the last known external outcome — word the empty
    // state honestly instead of a bare "No results found".
    if (offset === 0 && resultCount === 0) {
      this.applyExternalEmptyMessage(status);
    }
  }

  /**
   * Honest empty-state wording from the external-supplement outcome:
   *   sources_failed      — the emptiness is NOT trustworthy, sources errored
   *   pending/dispatched  — job still running; results may appear shortly
   *   completed/null      — genuine "nothing found", keep the default message
   */
  applyExternalEmptyMessage(status: string | null) {
    if (status === 'sources_failed') {
      this._items().innerHTML = '<div class="citation-search-empty">No results found — external databases are currently unreachable. Try again in a few minutes.</div>';
    } else if (status === 'pending' || status === 'dispatched') {
      this._items().innerHTML = '<div class="citation-search-empty">No results yet — still searching external databases in the background. Try this search again shortly.</div>';
    }
    // completed / null → leave renderResults' default "No results found".
  }

  scheduleNextExternalPoll() {
    if (this.externalRetryTimer) {
      clearTimeout(this.externalRetryTimer);
    }
    this.externalRetryTimer = setTimeout(() => {
      this.externalRetryTimer = null;
      const poll = this.externalPoll;
      // Only if the modal is still open and the user hasn't typed a new query.
      if (!poll || !this.isOpen || this.currentQuery !== poll.query) {
        this.clearExternalRetry();
        return;
      }
      poll.attemptsLeft -= 1;
      // bypassCache: polls must reach the server for the fresh page.
      this.performSearch(poll.query, 0, true);
    }, 2500);
  }

  /** While waiting on the background ingest with nothing local to show. */
  showExternalSearchingState(resultCount: number) {
    if (resultCount > 0) return; // local results visible — poll silently
    this._items().innerHTML = '<div class="citation-search-loading">No local results — searching external databases…</div>';
    this.citationResults.dataset.state = 'loading';
    this.repositionContainer();
  }

  clearExternalRetry() {
    if (this.externalRetryTimer) {
      clearTimeout(this.externalRetryTimer);
      this.externalRetryTimer = null;
    }
    this.externalPoll = null;
  }

  repositionContainer() {
    // Trigger keyboard manager to reposition container with new height
    if (window.activeKeyboardManager && window.activeKeyboardManager.isKeyboardOpen) {
      const editToolbar = document.getElementById('edit-toolbar');
      const searchToolbar = document.getElementById('search-toolbar');
      const citationToolbar = document.getElementById('citation-toolbar');
      const bottomRightButtons = document.getElementById('bottom-right-buttons');
      const mainContent = document.querySelector('.main-content');

      window.activeKeyboardManager.moveToolbarAboveKeyboard(
        editToolbar, searchToolbar, citationToolbar, bottomRightButtons, mainContent
      );
    }
  }

  async renderResults(results: CitationSearchResult[], offset = 0, hasMore = false) {
    const items = this._items();

    // Remove any existing "load more" button before appending
    items.querySelector('.citation-load-more')?.remove();

    if (offset === 0) {
      // First page — clear and replace
      items.innerHTML = '';
    }

    if (results.length === 0 && offset === 0) {
      items.innerHTML = '<div class="citation-search-empty">No results found</div>';
      this.citationResults.dataset.state = 'empty';
      this.repositionContainer();
      return;
    }

    // Per-result button construction is pure — extracted to ./resultsRender.
    const buttons = await Promise.all(results.map((result) => buildResultButton(result)));

    buttons.forEach(btn => items.appendChild(btn));

    // Show "Load more" button at DOM end of items list (= visual top, due to column-reverse)
    if (hasMore) {
      const loadMore = document.createElement('button');
      loadMore.className = 'citation-load-more citation-result-item';
      loadMore.textContent = 'Load more results';

      const triggerLoadMore = (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        if (loadMore.disabled) return;
        this.currentOffset += 15;
        loadMore.textContent = 'Loading…';
        loadMore.disabled = true;
        this.performSearch(this.currentQuery, this.currentOffset);
      };

      loadMore.addEventListener('touchend', triggerLoadMore, { passive: false });
      loadMore.addEventListener('click', triggerLoadMore);
      items.appendChild(loadMore);
    }

    this.hasMore = hasMore;
    this.citationResults.dataset.state = 'results';
    this.repositionContainer();
  }

  handleDocumentClick(event: any) {
    // Ignore close attempts immediately after opening (prevents synthetic click from closing)
    if (this.justOpened) {
      return;
    }

    const target = event.target;

    // Check if click is on a result item or inside one (for child elements like <i>, <em>)
    const resultItem = target.closest('.citation-result-item');
    if (resultItem) {
      if (resultItem.classList.contains('citation-load-more')) return;
      event.preventDefault();
      event.stopPropagation();
      this.handleCitationSelection(resultItem);
      return;
    }

    // If the custom shelf dropdown is open and the click is OUTSIDE it,
    // close just the dropdown — never the whole modal.
    if (this.shelfOptions && !this.shelfOptions.hidden) {
      const picker = this.scopeUI?.shelf?.picker;
      const insidePicker = picker && picker.contains(target);
      if (!insidePicker) {
        this._closeShelfDropdown();
        return; // swallow this click — don't propagate to modal-close logic
      }
    }
    // Same brief window as before: ignore close right after a shelf interaction
    // (defensive — the dropdown is now custom HTML, but covers any synthetic
    // events still dispatched around the interaction).
    if (this._shelfInteractionAt && (performance.now() - this._shelfInteractionAt) < 300) {
      return;
    }

    // Check if click is inside citation container, results container, citation button, or gap blocker
    const isInsideContainer = this.citationContainer.contains(target);
    const isInsideResults = this.citationResults.contains(target);
    const isOnCitationButton = this.citationButton.contains(target);
    const gapBlocker = document.getElementById('keyboard-gap-blocker');
    const isOnGapBlocker = gapBlocker && (target === gapBlocker || gapBlocker.contains(target));

    // Defensive: if the target is the bare <body> / <html> / null, that's
    // overwhelmingly a synthetic event from a closing native overlay (iOS
    // select picker, etc.) rather than a real outside tap. Ignore.
    const isPageRoot = !target || target === document.body || target === document.documentElement;

    if (!isInsideContainer && !isInsideResults && !isOnCitationButton && !isOnGapBlocker && !isPageRoot) {
      this.close();
    }
  }

  handleKeyDown(event: any) {
    if (event.key === 'Escape' && this.isOpen) {
      // If the shelf dropdown is open, ESC closes just it (preserves modal).
      if (this.shelfOptions && !this.shelfOptions.hidden) {
        this._closeShelfDropdown();
        return;
      }
      this.close();
    }
  }

  handleTouchStart(event: any) {
    this.touchStartX = event.touches[0].clientX;
    this.touchStartY = event.touches[0].clientY;
  }

  handleTouchEnd(event: any) {
    if (!this.isOpen) return;

    // Ignore close attempts immediately after opening (prevents synthetic touch from closing)
    if (this.justOpened) {
      return;
    }

    const touchEndX = event.changedTouches[0].clientX;
    const touchEndY = event.changedTouches[0].clientY;

    const deltaX = Math.abs(touchEndX - (this.touchStartX ?? 0));
    const deltaY = Math.abs(touchEndY - (this.touchStartY ?? 0));

    // Ignore if this was a scroll (threshold 10px)
    if (deltaX > 10 || deltaY > 10) {
      return;
    }

    // Handle as tap
    const target = document.elementFromPoint(touchEndX, touchEndY);
    if (target && target.classList.contains('citation-load-more')) {
      // Handled by the button's own touchend listener; suppress click synthesis here too
      event.preventDefault();
      return;
    }
    if (target && target.classList.contains('citation-result-item')) {
      event.preventDefault();
      this.handleCitationSelection(target);
    }
  }

  handleResultsScroll(event: any) {
    // Was: preventDefault() on touchstart when the panel wasn't overflowing,
    // intended to stop scroll-chaining to the page beneath. But preventDefault
    // on touchstart ALSO cancels the synthesized click event — so on mobile
    // every tap inside the panel (chip buttons, picker, results) silently
    // failed: the scope chips couldn't be tapped at all. Scroll-chaining is
    // now handled natively by `overscroll-behavior: contain` on the panel
    // CSS, so we only preventDefault when the touch is over a NON-interactive
    // surface (the bare blurred backdrop) AND the panel isn't scrollable.
    const container = this.citationResults;
    const isScrollable = container.scrollHeight > container.clientHeight;
    if (isScrollable) return;

    const target = event.target;
    if (!target || !target.closest) return;
    const interactive = target.closest('button, a, input, select, textarea, [role="button"], [role="tab"], [role="option"], [role="listbox"], .citation-shelf-option, .citation-shelf-trigger');
    if (interactive) return;   // tap on a chip / picker / shelf option / result — must reach click handlers

    event.preventDefault();
  }

  async handleCitationSelection(button: any) {
    if (!this.pendingContext) {
      log.error('No pending context for citation insertion', '/editToolbar/citationMode/index.ts');
      return;
    }

    const { range, bookId, saveCallback, undoSnapshot, undoManager } = this.pendingContext;

    // Build the new picked-object shape that citationInserter accepts.
    // book may be empty for canonical-only — the inserter is fine with that
    // as long as canonical_source_id is set.
    const picked = {
      book: button.dataset.bookId || '',
      canonical_source_id: button.dataset.canonicalSourceId || null,
      bibtex: button.dataset.bibtex || '',
      has_nodes: button.dataset.hasNodes !== '0',
    };

    try {
      // Dynamic import to avoid circular dependencies
      const { insertCitationAtCursor } = await import('../../citations/citationInserter');

      await insertCitationAtCursor(
        range,
        bookId,
        picked,
        saveCallback
      );

      // Record undo entry for the citation insertion
      if (undoSnapshot && undoManager) {
        const el = document.getElementById(undoSnapshot.elementId);
        if (el && el.innerHTML !== undoSnapshot.oldHTML) {
          undoManager._pushUndo(bookId, {
            type: 'input',
            elementId: undoSnapshot.elementId,
            oldHTML: undoSnapshot.oldHTML,
            newHTML: el.innerHTML,
            bookId,
            cursorBefore: undoSnapshot.cursorBefore || 0,
            cursorAfter: 0,
          });
        }
      }

      // Close the citation mode
      this.close();

    } catch (error) {
      log.error('Error inserting citation', '/editToolbar/citationMode/index.ts', error);
    }
  }
}
