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

import { formatBibtexToCitation } from "../utilities/bibtexProcessor.js";
import DOMPurify from "dompurify";

const SCOPE_STORAGE_KEY = 'hyperlit:citation:scope';
const SHELF_STORAGE_KEY = 'hyperlit:citation:shelfId';
const VALID_SCOPES = ['public', 'mine', 'shelf'];

export class CitationMode {
  constructor({
    toolbar,
    citationButton,
    citationContainer,
    citationInput,
    citationResults,
    allButtons,
    closeHeadingSubmenuCallback
  }) {
    this.toolbar = toolbar;
    this.citationButton = citationButton;
    this.citationContainer = citationContainer;
    this.citationInput = citationInput;
    this.citationResults = citationResults;
    this.allButtons = allButtons; // Array of all toolbar buttons except citation
    this.closeButton = document.getElementById('citation-close-btn');
    this.closeHeadingSubmenuCallback = closeHeadingSubmenuCallback;

    // Scope picker (lives inside citationContainer — query lazily on open()
    // because the container may not be in the DOM yet at construction time).
    this.scopeBar = null;
    this.scopeButtons = null;
    this.shelfPicker = null;
    this.shelfSelect = null;
    this.shelvesLoaded = false;
    this.boundScopeClickHandlers = [];
    this.boundShelfChangeHandler = null;

    // Restore last-used scope + shelf, falling back to public.
    let savedScope = 'public';
    let savedShelfId = '';
    try {
      const s = localStorage.getItem(SCOPE_STORAGE_KEY);
      if (VALID_SCOPES.includes(s)) savedScope = s;
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

  open(context) {
    if (this.isOpen) return;

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
      console.log('✅ Citation mode: Ready for close events');
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
      console.log(`🔒 Locking scroll position at ${this.lockedScrollPosition}px for citation mode`);
      this.boundScrollLockHandler = () => {
        if (window.scrollY !== this.lockedScrollPosition) {
          console.log(`🔒 Scroll changed to ${window.scrollY}px, forcing back to ${this.lockedScrollPosition}px`);
          window.scrollTo(0, this.lockedScrollPosition);
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
      console.log('🔓 Unlocking scroll position');
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
    const root = this.citationResults || this.citationContainer;
    if (!root) return;
    this.scopeBar = root.querySelector('.citation-scope-bar');
    this.resultsItems = root.querySelector('.citation-results-items') || root;
    if (!this.scopeBar) return;
    this.scopeButtons = Array.from(this.scopeBar.querySelectorAll('.citation-scope-btn'));
    this.shelfPicker = this.scopeBar.querySelector('.citation-shelf-picker');
    // Custom dropdown (button + popup) — replaces the native <select> which on
    // iOS always dismissed the keyboard when its picker opened (browser-level
    // behaviour we couldn't intercept). Custom dropdown is just HTML, so
    // mousedown.preventDefault on the trigger keeps the input focused — same
    // trick we use on the scope chips.
    this.shelfTrigger = this.scopeBar.querySelector('.citation-shelf-trigger');
    this.shelfCurrent = this.scopeBar.querySelector('.citation-shelf-current');
    this.shelfOptions = this.scopeBar.querySelector('.citation-shelf-options');
    this.shelfSelect = this.shelfTrigger; // alias used by older test code paths

    // Reflect saved scope in the chip UI
    this.scopeButtons.forEach(btn => {
      const isActive = btn.dataset.scope === this.currentScope;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    // Show chips by default (state is 'hidden' on open). hide method below
    // reacts to the results lifecycle.
    this.scopeBar.style.display = '';
    this._togglePickerVisibility();

    // Click handlers — tracked for detach
    this.scopeButtons.forEach(btn => {
      const handler = () => this._handleScopeChange(btn.dataset.scope);
      // mousedown / pointerdown preventDefault keeps focus on the search input
      // when the user taps a chip — otherwise the chip steals focus, the input
      // blurs, and the mobile keyboard dismisses on every scope change. The
      // click event still fires normally (preventDefault on these only blocks
      // the focus-transfer side effect, not the click synthesis).
      const focusKeeper = (e) => e.preventDefault();
      btn.addEventListener('mousedown', focusKeeper);
      btn.addEventListener('pointerdown', focusKeeper);
      btn.addEventListener('click', handler);
      this.boundScopeClickHandlers.push({ btn, handler, focusKeeper });
    });

    if (this.shelfTrigger) {
      // Trigger button toggles the popup. mousedown/pointerdown preventDefault
      // keeps focus on the search input (same trick as scope chips), so the
      // mobile keyboard stays up while the user picks a shelf.
      const triggerFocusKeeper = (e) => e.preventDefault();
      const triggerClickHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const expanded = this.shelfTrigger.getAttribute('aria-expanded') === 'true';
        if (expanded) {
          this._closeShelfDropdown();
        } else {
          this._openShelfDropdown();
        }
      };
      this.shelfTrigger.addEventListener('mousedown', triggerFocusKeeper);
      this.shelfTrigger.addEventListener('pointerdown', triggerFocusKeeper);
      this.shelfTrigger.addEventListener('click', triggerClickHandler);
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
    if (this.shelfTrigger && this.boundShelfTriggerHandlers) {
      const { triggerFocusKeeper, triggerClickHandler } = this.boundShelfTriggerHandlers;
      this.shelfTrigger.removeEventListener('mousedown', triggerFocusKeeper);
      this.shelfTrigger.removeEventListener('pointerdown', triggerFocusKeeper);
      this.shelfTrigger.removeEventListener('click', triggerClickHandler);
      this.boundShelfTriggerHandlers = null;
    }
    this._closeShelfDropdown();
    this._shelfInteractionAt = 0;
    this.scopeBar = null;
    this.scopeButtons = null;
    this.shelfPicker = null;
    this.shelfTrigger = null;
    this.shelfCurrent = null;
    this.shelfOptions = null;
    this.shelfSelect = null;
  }

  _openShelfDropdown() {
    if (!this.shelfTrigger || !this.shelfOptions) return;
    this.shelfTrigger.setAttribute('aria-expanded', 'true');
    this.shelfOptions.hidden = false;
    // Flag the panel so CSS (and keyboardManager) can grow the blurred area
    // to fit the popup, which sits above the chip bar. Without this the
    // dropdown gets clipped when the panel is in chips-only height.
    this.citationResults?.classList.add('shelf-dropdown-open');
    this._shelfInteractionAt = performance.now();
    this._ensureShelvesLoaded();
    this.repositionContainer();
  }

  _closeShelfDropdown() {
    if (this.shelfTrigger) this.shelfTrigger.setAttribute('aria-expanded', 'false');
    if (this.shelfOptions) this.shelfOptions.hidden = true;
    this.citationResults?.classList.remove('shelf-dropdown-open');
    this.repositionContainer();
  }

  _pickShelf(id, label) {
    this.currentShelfId = id || '';
    try { localStorage.setItem(SHELF_STORAGE_KEY, this.currentShelfId); } catch {}
    if (this.shelfCurrent) {
      this.shelfCurrent.textContent = id ? label : '— pick a shelf —';
    }
    this._closeShelfDropdown();
    this._shelfInteractionAt = performance.now();
    // Re-fire current search with the new shelf
    const inputValue = (this.citationInput?.value || '').trim();
    if (inputValue.length >= 2) {
      this.currentQuery = inputValue;
      this.currentOffset = 0;
      this.performSearch(inputValue, 0);
    }
  }

  _handleScopeChange(newScope) {
    if (!VALID_SCOPES.includes(newScope) || newScope === this.currentScope) {
      // Still allow shelf re-click to surface the picker
      if (newScope === 'shelf') this._ensureShelvesLoaded();
      return;
    }
    this.currentScope = newScope;
    try { localStorage.setItem(SCOPE_STORAGE_KEY, newScope); } catch {}

    this.scopeButtons.forEach(btn => {
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
    if (this.shelfPicker) {
      this.shelfPicker.style.display = this.currentScope === 'shelf' ? '' : 'none';
    }
  }

  async _ensureShelvesLoaded() {
    if (this.shelvesLoaded || !this.shelfOptions) return;
    this.shelvesLoaded = true;
    try {
      const resp = await fetch('/api/shelves', {
        headers: { 'Accept': 'application/json' },
        credentials: 'same-origin',
      });
      const data = await resp.json();
      const shelves = Array.isArray(data) ? data : (data.shelves || data.data || []);
      if (!shelves.length) {
        this.shelfOptions.innerHTML = '<li class="citation-shelf-option-empty" role="option" aria-disabled="true">No shelves — create one first</li>';
        return;
      }
      this._renderShelfOptions(shelves);

      // Restore last-used shelf label if it still exists
      if (this.currentShelfId) {
        const match = shelves.find(s => (s.id || s.shelf_id) === this.currentShelfId);
        if (match && this.shelfCurrent) {
          const count = Number(match.item_count ?? 0);
          const name = match.name || match.title || 'Untitled';
          this.shelfCurrent.textContent = count > 0 ? `${name} (${count})` : `${name} (empty)`;
        }
      }
    } catch (e) {
      this.shelvesLoaded = false;
      console.warn('CitationMode: failed to load shelves:', e);
      this.shelfOptions.innerHTML = '<li class="citation-shelf-option-empty" role="option" aria-disabled="true">Failed to load shelves</li>';
    }
  }

  _renderShelfOptions(shelves) {
    if (!this.shelfOptions) return;
    const escape = (s) => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
    this.shelfOptions.innerHTML = shelves.map(s => {
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
    this.shelfOptions.querySelectorAll('li.citation-shelf-option').forEach(li => {
      const focusKeeper = (e) => e.preventDefault();
      const pickHandler = (e) => {
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
  _updateScopeBarVisibility(_state) {
    // intentional no-op
  }

  // Returns the inner container that holds result items. Result writes target
  // this so innerHTML clears don't wipe the chip bar that lives at the bottom
  // of #citation-toolbar-results.
  _items() {
    return this.resultsItems
      || this.citationResults?.querySelector?.('.citation-results-items')
      || this.citationResults;
  }

  attachEventHandlers() {
    // Input handler
    this.boundInputHandler = this.handleSearchInput.bind(this);
    this.citationInput.addEventListener('input', this.boundInputHandler);

    // MOBILE FIX: Intercept touch on citation input to prevent iOS scroll-to-focus
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile) {
      this.boundInputTouchHandler = (e) => {
        console.log('📱 Citation input touch - preventing default and manually focusing');
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

  handleSearchInput(event) {
    const query = event.target.value.trim();

    // Drive chip-bar visibility off raw input length — hide chips as soon as
    // the user types ANY character, show them again on full clear. CSS hides
    // .citation-scope-bar when data-has-query='true'.
    this.citationResults.dataset.hasQuery = query.length > 0 ? 'true' : 'false';

    // Cancel previous debounce
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

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

  async performSearch(query, offset = 0) {
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
      const params = new URLSearchParams({
        q: query,
        limit: '15',
        offset: String(offset),
        sourceScope: this.currentScope,
      });
      if (this.currentScope === 'shelf' && this.currentShelfId) {
        params.set('shelfId', this.currentShelfId);
      }
      const url = `/api/search/combined?${params.toString()}`;
      const response = await fetch(url, {
        headers: {
          'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]').content,
        },
        signal: this.abortController.signal
      });

      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      await this.renderResults(data.results || [], offset, data.has_more ?? false);

    } catch (error) {
      if (error.name !== 'AbortError') {
        this._items().innerHTML = '<div class="citation-search-empty">Search failed. Please try again.</div>';
        this.citationResults.dataset.state = 'empty';
        this.repositionContainer();
      }
    }
  }

  repositionContainer() {
    console.log(`🔄 repositionContainer called, state=${this.citationResults?.dataset?.state}, keyboardOpen=${window.activeKeyboardManager?.isKeyboardOpen}`);

    // Trigger keyboard manager to reposition container with new height
    if (window.activeKeyboardManager && window.activeKeyboardManager.isKeyboardOpen) {
      console.log(`✅ Calling moveToolbarAboveKeyboard from repositionContainer`);
      const editToolbar = document.getElementById('edit-toolbar');
      const searchToolbar = document.getElementById('search-toolbar');
      const citationToolbar = document.getElementById('citation-toolbar');
      const bottomRightButtons = document.getElementById('bottom-right-buttons');
      const mainContent = document.querySelector('.main-content');

      window.activeKeyboardManager.moveToolbarAboveKeyboard(
        editToolbar, searchToolbar, citationToolbar, bottomRightButtons, mainContent
      );
    } else {
      console.log(`❌ Skipping reposition: activeKeyboardManager=${!!window.activeKeyboardManager}, isKeyboardOpen=${window.activeKeyboardManager?.isKeyboardOpen}`);
    }
  }

  async renderResults(results, offset = 0, hasMore = false) {
    console.log('🔍 renderResults called with', results.length, 'results, offset:', offset, 'hasMore:', hasMore);
    console.log('🔍 citationResults element:', this.citationResults);
    console.log('🔍 citationResults parent:', this.citationResults?.parentElement);

    const items = this._items();

    // Remove any existing "load more" button before appending
    items.querySelector('.citation-load-more')?.remove();

    if (offset === 0) {
      // First page — clear and replace
      items.innerHTML = '';
    }

    if (results.length === 0 && offset === 0) {
      console.log('🔍 No results - showing empty state');
      items.innerHTML = '<div class="citation-search-empty">No results found</div>';
      this.citationResults.dataset.state = 'empty';
      this.repositionContainer();
      return;
    }

    console.log('🔍 Creating buttons for results...');
    // Use Promise.all to await all formatting promises
    const buttons = await Promise.all(results.map(async result => {
      let sanitized;

      if (result.bibtex) {
        const formattedCitation = await formatBibtexToCitation(result.bibtex);
        sanitized = DOMPurify.sanitize(formattedCitation, {
          ALLOWED_TAGS: ['i', 'em', 'b', 'strong', 'a'],
          ALLOWED_ATTR: ['href', 'target']
        });
      } else {
        // Bibtex absent (shouldn't normally happen post-PR4 since the service
        // generates a synthetic bibtex from canonical metadata) — fall back to
        // a simple display so the user still sees the result.
        const title = result.title || 'Untitled';
        const meta = [result.author, result.year, result.journal].filter(Boolean).join(', ');
        const raw = `<em>${title}</em>${meta ? ' — ' + meta : ''}`;
        sanitized = DOMPurify.sanitize(raw, {
          ALLOWED_TAGS: ['i', 'em', 'b', 'strong'],
        });
      }

      // Optional badge for canonical-only results so the user knows ahead of
      // clicking that there's no text in the library, just citation metadata.
      let badge = '';
      if (result.source === 'canonical-only') {
        badge = '<span class="citation-result-badge citation-result-badge-citation-only" title="Citation only — text not in library">citation only</span>';
      }

      // Private-lock badge for any result whose resolved version is one of the
      // caller's private books. Reuses the same SVG used on libraryCard so the
      // visual language matches between the library list and the citation modal.
      let privateIcon = '';
      if (result.is_private) {
        privateIcon = '<span class="citation-result-private" title="Private — only visible to you"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg></span>';
      }

      const button = document.createElement('button');
      button.className = 'citation-result-item';
      if (result.source === 'canonical-only') {
        button.classList.add('citation-result-canonical-only');
        button.title = 'Citation only — text not in library';
      } else if (result.source === 'canonical') {
        button.classList.add('citation-result-canonical');
      }
      if (result.is_private) {
        button.classList.add('citation-result-private-source');
      }
      button.innerHTML = sanitized + (badge ? ' ' + badge : '') + privateIcon;
      button.dataset.bookId = result.book || '';
      button.dataset.canonicalSourceId = result.canonical_source_id || '';
      button.dataset.bibtex = result.bibtex || '';
      button.dataset.hasNodes = result.has_nodes ? '1' : '0';
      button.dataset.source = result.source || '';
      button.dataset.isPrivate = result.is_private ? '1' : '0';

      return button;
    }));

    console.log('🔍 Appending', buttons.length, 'buttons...');
    buttons.forEach(btn => items.appendChild(btn));

    // Show "Load more" button at DOM end of items list (= visual top, due to column-reverse)
    if (hasMore) {
      const loadMore = document.createElement('button');
      loadMore.className = 'citation-load-more citation-result-item';
      loadMore.textContent = 'Load more results';

      const triggerLoadMore = (e) => {
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

  handleDocumentClick(event) {
    // Ignore close attempts immediately after opening (prevents synthetic click from closing)
    if (this.justOpened) {
      console.log('🚫 Citation mode: Ignoring close attempt (just opened)');
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
      const insidePicker = this.shelfPicker && this.shelfPicker.contains(target);
      if (!insidePicker) {
        this._closeShelfDropdown();
        return; // swallow this click — don't propagate to modal-close logic
      }
    }
    // Same brief window as before: ignore close right after a shelf interaction
    // (defensive — the dropdown is now custom HTML, but covers any synthetic
    // events still dispatched around the interaction).
    if (this._shelfInteractionAt && (performance.now() - this._shelfInteractionAt) < 300) {
      console.log('🚫 Citation mode: Ignoring close — recent shelf-picker interaction');
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
      console.log('👋 Citation mode: Closing from outside click');
      this.close();
    } else if (isOnGapBlocker) {
      console.log('🛡️ Citation mode: Ignoring click on gap blocker');
    } else if (isPageRoot) {
      console.log('🚫 Citation mode: Ignoring synthetic outside-click on page root');
    }
  }

  handleKeyDown(event) {
    if (event.key === 'Escape' && this.isOpen) {
      // If the shelf dropdown is open, ESC closes just it (preserves modal).
      if (this.shelfOptions && !this.shelfOptions.hidden) {
        this._closeShelfDropdown();
        return;
      }
      this.close();
    }
  }

  handleTouchStart(event) {
    this.touchStartX = event.touches[0].clientX;
    this.touchStartY = event.touches[0].clientY;
  }

  handleTouchEnd(event) {
    if (!this.isOpen) return;

    // Ignore close attempts immediately after opening (prevents synthetic touch from closing)
    if (this.justOpened) {
      console.log('🚫 Citation mode: Ignoring touchend close attempt (just opened)');
      return;
    }

    const touchEndX = event.changedTouches[0].clientX;
    const touchEndY = event.changedTouches[0].clientY;

    const deltaX = Math.abs(touchEndX - this.touchStartX);
    const deltaY = Math.abs(touchEndY - this.touchStartY);

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

  handleResultsScroll(event) {
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
    const interactive = target.closest('button, a, input, select, textarea, [role="button"], [role="tab"]');
    if (interactive) return;   // tap on a chip / picker / result — must reach click handlers

    event.preventDefault();
  }

  async handleCitationSelection(button) {
    if (!this.pendingContext) {
      console.warn('No pending context for citation insertion');
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
      const { insertCitationAtCursor } = await import('../citations/citationInserter.js');

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
          console.log(`[UndoManager] Recorded citation insertion for undo on #${undoSnapshot.elementId}`);
        }
      }

      // Close the citation mode
      this.close();

    } catch (error) {
      console.error('Error inserting citation:', error);
    }
  }
}
