// searchToolbar.js - Manages the search toolbar for in-text search

import { verbose, log } from "../../utilities/logger";
import { debounce } from "../../utilities/debounce";
// Import from source modules (not the scrolling/ barrel) so searchToolbar doesn't pull the
// whole scrolling graph in — keeps the static import graph acyclic.
import { navigateToInternalId } from "../../scrolling/internalNav";
import { cancelPendingNavigationCleanup } from "../../scrolling/userScrollDetection";
import { getNodesFromIndexedDB } from "../../indexedDB/nodes/read";
import { getFreshAnchor } from "../../scrolling/readingAnchor";
import { maybePaginatorReveal } from "../../scrolling/paginator";
import { currentLazyLoader } from "../../pageLoad/currentLazyLoaderState"; // zero-import leaf (not the pageLoad barrel) → no cycle
import { isBookEncrypted } from "../../e2ee/registry"; // zero-import leaf → no cycle
import { buildSearchIndex, searchIndex } from "./searchEngine";
import {
  abortSemanticSearch,
  searchBookSemantically,
  SEMANTIC_DEBOUNCE_MS,
  SEMANTIC_MIN_QUERY_LENGTH,
  type SemanticFailure,
} from "./semanticSearch";
import {
  applySearchHighlight,
  applySemanticNodeHighlight,
  clearSearchHighlights,
  clearSemanticHighlights,
  setSearchMode
} from "./searchHighlight";

/** Exact = local substring over IndexedDB; semantic = server-side cosine. */
type SearchMode = 'exact' | 'semantic';

/** Remembered across books and sessions, like homepage_search_mode. */
const MODE_STORAGE_KEY = 'intext_search_mode';

const EXACT_DEBOUNCE_MS = 300;

const FAILURE_COPY: Record<SemanticFailure, string> = {
  offline: 'no connection',
  unavailable: 'unavailable',
  unsupported: 'not available here',
  indexing: 'still indexing…',
  failed: 'search failed',
};

/**
 * SearchToolbarManager - Manages the search toolbar UI and state
 */
class SearchToolbarManager {
  [key: string]: any;
  constructor() {
    this.toolbar = null;
    this.input = null;
    this.prevButton = null;
    this.nextButton = null;
    this.matchCounter = null;
    this.isOpen = false;

    this.modeToggle = null;

    // Search state
    this.searchIndexCache = null;  // Cached search index (exact mode only)
    this.matches = [];             // Current search matches
    this.currentMatchIndex = -1;   // Current match position
    this.matchesByChunk = new Map(); // chunk_id -> array of matches with matchIndex
    this.initialStartLine = null;  // Scroll position when search opened (for nearest match)

    // 'exact' | 'semantic'. Restored from localStorage, but forced back to
    // exact whenever the toggle isn't available (see applyModeAvailability).
    this.mode = this.readStoredMode();
    this.modeAvailable = false;

    // Bound event handlers
    this.boundInputHandler = this.handleInput.bind(this);
    this.boundPrevHandler = this.handlePrev.bind(this);
    this.boundNextHandler = this.handleNext.bind(this);
    this.boundKeydownHandler = this.handleKeydown.bind(this);
    this.boundClickOutsideHandler = this.handleClickOutside.bind(this);
    // Touch handlers with preventDefault to avoid ghost clicks
    this.boundPrevTouchHandler = (e: any) => { e.preventDefault(); this.handlePrev(); };
    this.boundNextTouchHandler = (e: any) => { e.preventDefault(); this.handleNext(); };
    this.boundModeToggleHandler = this.handleModeToggleClick.bind(this);

    // Debounced search handler. Exact mode is 300ms; semantic mode re-arms at
    // 500ms (installDebounce) because every uncached keystroke there is an
    // embedding round-trip, not a local indexOf.
    this.installDebounce();

    // Bind elements
    this.bindElements();

    // Setup event listeners
    this.setupEventListeners();

    verbose.init('SearchToolbar initialized', '/search/inTextSearch/searchToolbar');
  }

  /**
   * Bind DOM elements
   */
  bindElements() {
    this.toolbar = document.getElementById('search-toolbar');
    this.input = document.getElementById('search-input');
    this.prevButton = document.getElementById('search-prev-button');
    this.nextButton = document.getElementById('search-next-button');
    this.matchCounter = document.getElementById('search-match-counter');
    // Absent on every page but the reader — the feed pages render the partial
    // without the toggle because their synthetic books are never embedded.
    this.modeToggle = document.getElementById('search-mode-toggle');

    if (!this.toolbar) {
      log.error('SearchToolbar: search-toolbar element not found', '/search/inTextSearch/searchToolbar');
      return;
    }

    verbose.init('SearchToolbar: DOM elements bound', '/search/inTextSearch/searchToolbar');
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    if (!this.toolbar) return;

    // Input field
    if (this.input) {
      this.input.addEventListener('input', this.boundInputHandler);
    }

    // Keydown on the TOOLBAR, not the input: Escape must close no matter which
    // control inside has focus (see handleKeydown).
    this.toolbar.addEventListener('keydown', this.boundKeydownHandler);

    // Navigation buttons
    if (this.prevButton) {
      this.prevButton.addEventListener('click', this.boundPrevHandler);
      this.prevButton.addEventListener('touchend', this.boundPrevTouchHandler);
    }

    if (this.nextButton) {
      this.nextButton.addEventListener('click', this.boundNextHandler);
      this.nextButton.addEventListener('touchend', this.boundNextTouchHandler);
    }

    // Delegated on the group so the two segments share one listener.
    if (this.modeToggle) {
      this.modeToggle.addEventListener('click', this.boundModeToggleHandler);
    }

    verbose.init('SearchToolbar: Event listeners attached', '/search/inTextSearch/searchToolbar');
  }

  /**
   * Re-arm the debounced search at the current mode's interval. Exact mode is a
   * local indexOf over an in-memory index; semantic mode is a network round-trip
   * that may embed the query, so it waits longer (mirrors searchBox.ts).
   */
  installDebounce() {
    if (this.debouncedSearch) this.debouncedSearch.cancel();
    const delay = this.mode === 'semantic' ? SEMANTIC_DEBOUNCE_MS : EXACT_DEBOUNCE_MS;
    this.debouncedSearch = debounce((query: any) => { void this.performSearch(query); }, delay);
  }

  /** Shortest query worth running in the current mode. */
  minQueryLength() {
    return this.mode === 'semantic' ? SEMANTIC_MIN_QUERY_LENGTH : 1;
  }

  readStoredMode(): SearchMode {
    try {
      return localStorage.getItem(MODE_STORAGE_KEY) === 'semantic' ? 'semantic' : 'exact';
    } catch {
      return 'exact';
    }
  }

  /**
   * Decide whether semantic mode is offered for the book now open, and force the
   * mode back to exact when it isn't.
   *
   * Three reasons it may not be, all of them "the server has no embeddings for
   * this text, so the request could only ever come back empty":
   *  - the toggle was never rendered (a feed page — its book is a synthetic
   *    card-list book, excluded by EmbeddingEligibility);
   *  - the book is E2EE encrypted (its plainText AND embedding are nulled on
   *    encrypt — DbLibraryController's scrub);
   *  - it's a sub-book (`parent/Fn12`), excluded as EXCLUDED_LIBRARY_TYPES.
   *
   * The server refuses all three with a 403 anyway (bookSemanticallySearchable)
   * — this is so the user is never offered a dead control.
   */
  applyModeAvailability() {
    const bookId = currentLazyLoader?.bookId;
    const encrypted = bookId ? isBookEncrypted(bookId) : false;
    const isSubBook = typeof bookId === 'string' && bookId.includes('/');

    this.modeAvailable = Boolean(this.modeToggle && bookId && !encrypted && !isSubBook);

    if (this.modeToggle) {
      this.modeToggle.hidden = !this.modeAvailable;
    }

    if (!this.modeAvailable && this.mode !== 'exact') {
      verbose.init(
        `SearchToolbar: semantic unavailable for ${bookId} (encrypted=${encrypted}, subBook=${isSubBook}) — forcing exact`,
        '/search/inTextSearch/searchToolbar'
      );
      this.mode = 'exact';
      this.installDebounce();
    }

    this.renderModeToggle();
    this.updatePlaceholder();
  }

  /**
   * The placeholder doubles as the mode explainer: "keyword" for exact,
   * "meaning" for semantic. Runs even where the toggle isn't rendered, so a
   * mode forced back to exact never leaves a stale semantic prompt behind.
   */
  updatePlaceholder() {
    if (!this.input) return;
    this.input.placeholder =
      this.mode === 'semantic' ? 'Search by meaning…' : 'Search by keyword…';
  }

  /** Reflect this.mode onto the segmented control. */
  renderModeToggle() {
    if (!this.modeToggle) return;

    this.modeToggle.querySelectorAll('.search-mode-toggle-btn').forEach((btn: Element) => {
      const isActive = (btn as HTMLElement).dataset.searchMode === this.mode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  handleModeToggleClick(e: any) {
    const btn = e.target?.closest?.('.search-mode-toggle-btn');
    if (!btn) return;

    const next = btn.dataset.searchMode === 'semantic' ? 'semantic' : 'exact';
    void this.changeMode(next);
  }

  /**
   * Switch modes: drop the OTHER mode's artifacts (a leftover tint or <mark>
   * would read as a hit in the new mode), then re-run whatever is in the box.
   */
  async changeMode(next: SearchMode) {
    if (next === this.mode) return;
    if (next === 'semantic' && !this.modeAvailable) return;

    verbose.init(`SearchToolbar: mode ${this.mode} → ${next}`, '/search/inTextSearch/searchToolbar');

    // Cancel work belonging to the mode we're leaving.
    this.debouncedSearch.cancel();
    abortSemanticSearch();

    this.mode = next;
    try {
      localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch { /* private mode — the session still works, just doesn't persist */ }

    this.installDebounce();
    this.renderModeToggle();
    this.updatePlaceholder();
    this.clearAllHighlights();
    this.matches = [];
    this.currentMatchIndex = -1;
    this.matchesByChunk = new Map();
    this.updateMatchCounter(0, 0);
    this.updateNavigationButtons(false);

    // open() skips the local index when it opens straight into semantic mode, so
    // the first switch INTO exact has to build it — without this, performSearch
    // returns early on a null cache and exact mode silently finds nothing.
    if (next === 'exact') {
      await this.ensureSearchIndex();
    }

    const query = this.input?.value ?? '';
    if (query.length >= this.minQueryLength()) {
      await this.performSearch(query);
    }
  }

  /** Both modes' markers, whichever is present. */
  clearAllHighlights() {
    clearSearchHighlights();
    clearSemanticHighlights();
  }

  /**
   * Report a semantic failure where the counter sits — the only free space in a
   * one-row find bar.
   */
  showModeError(reason: SemanticFailure, detail?: string) {
    if (!this.matchCounter) return;
    this.matchCounter.textContent = detail ?? FAILURE_COPY[reason] ?? FAILURE_COPY.failed;
    this.matchCounter.classList.add('search-status-error');
  }

  /**
   * Open the search toolbar
   */
  async open() {
    if (!this.toolbar) return;

    verbose.init('SearchToolbar: Opening', '/search/inTextSearch/searchToolbar');

    // Remember what had focus so close() can hand it back (keyboard users
    // otherwise land on <body> after Escape and lose their place).
    this._focusReturnEl = document.activeElement instanceof HTMLElement
      && !this.toolbar.contains(document.activeElement)
      ? document.activeElement
      : null;

    // Capture initial scroll position for nearest-match search
    this.initialStartLine = this.getCurrentVisibleStartLine();
    verbose.init(`SearchToolbar: Captured initial position: ${this.initialStartLine}`, '/search/inTextSearch/searchToolbar');

    // Cancel any pending navigation cleanup timers from previous navigations
    cancelPendingNavigationCleanup();

    this.toolbar.classList.add('visible');
    this.isOpen = true;

    // Enable search mode (dims other highlights)
    setSearchMode(true);

    // Hide perimeter buttons for clean search UI
    this.hidePerimeterButtons();

    // Add click outside listener
    setTimeout(() => {
      document.addEventListener('click', this.boundClickOutsideHandler, true);
    }, 100);

    // Focus the input field
    if (this.input) {
      // Delay focus slightly to ensure keyboard handling is ready
      setTimeout(() => {
        this.input.focus();
      }, 100);
    }

    // Reset match counter
    this.updateMatchCounter(0, 0);

    // Disable navigation buttons initially
    this.updateNavigationButtons(false);

    // Decide whether semantic mode is on offer for THIS book before the user can
    // press anything.
    this.applyModeAvailability();

    // Semantic mode needs no local index — the ranking happens server-side, and
    // building one would pull every node out of IndexedDB for nothing.
    if (this.mode === 'exact') {
      await this.ensureSearchIndex();
    }
  }

  /**
   * Ensure search index is built
   */
  async ensureSearchIndex() {
    // If we already have an index, don't rebuild
    if (this.searchIndexCache) {
      verbose.init('SearchToolbar: Using cached search index', '/search/inTextSearch/searchToolbar');
      return;
    }

    // Get book ID from lazyLoader
    const bookId = currentLazyLoader?.bookId;
    if (!bookId) {
      log.error('SearchToolbar: No bookId available', '/search/inTextSearch/searchToolbar');
      return;
    }

    try {
      const nodes = await getNodesFromIndexedDB(bookId);
      this.searchIndexCache = buildSearchIndex(nodes);
      verbose.init(`SearchToolbar: Index built with ${this.searchIndexCache.length} entries`, '/search/inTextSearch/searchToolbar');
    } catch (error) {
      log.error(`SearchToolbar: Failed to build search index — ${(error as Error)?.message}`, '/search/inTextSearch/searchToolbar');
    }
  }

  /**
   * Close the search toolbar
   */
  close() {
    if (!this.toolbar) return;

    verbose.init('SearchToolbar: Closing', '/search/inTextSearch/searchToolbar');

    // Cancel any pending debounced search + any in-flight semantic request
    this.debouncedSearch.cancel();
    abortSemanticSearch();

    this.toolbar.classList.remove('visible');
    this.isOpen = false;

    // Disable search mode and clear highlights
    setSearchMode(false);
    this.clearAllHighlights();

    // Restore perimeter buttons
    this.showPerimeterButtons();

    // Remove click outside listener
    document.removeEventListener('click', this.boundClickOutsideHandler, true);

    // Clear input
    if (this.input) {
      this.input.value = '';
      this.input.blur();
    }

    // Hand focus back to whatever opened the toolbar (non-modal: no trap).
    const returnEl = this._focusReturnEl;
    this._focusReturnEl = null;
    if (returnEl && returnEl.isConnected) {
      try { returnEl.focus(); } catch { /* non-fatal */ }
    }

    // Clear search state but keep index cached
    this.clearSearch();
  }

  /**
   * Toggle the search toolbar
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Handle input changes (debounced)
   */
  handleInput(e: any) {
    const query = e.target.value;
    verbose.init(`SearchToolbar: Input changed - "${query}"`, '/search/inTextSearch/searchToolbar');

    // Clear previous highlights immediately for visual feedback
    this.clearAllHighlights();
    this.matchesByChunk = new Map();

    if (!query || query.length === 0) {
      // Cancel any pending debounced search
      this.debouncedSearch.cancel();
      abortSemanticSearch();
      this.matches = [];
      this.currentMatchIndex = -1;
      this.updateNavigationButtons(false);
      this.updateMatchCounter(0, 0);

      // Return to initial reading position when search is cleared
      if (this.initialStartLine !== null && currentLazyLoader) {
        verbose.init(`SearchToolbar: Search cleared, returning to initial position: ${this.initialStartLine}`, '/search/inTextSearch/searchToolbar');
        navigateToInternalId(String(this.initialStartLine), currentLazyLoader, false);
      }
      return;
    }

    // Debounce the actual search operation
    this.debouncedSearch(query);
  }

  /**
   * Perform the actual search (called after debounce).
   *
   * Both modes funnel into commitMatches, so everything downstream —
   * navigation, prev/next, the counter, the nearest-match start — is identical.
   * The only difference is where the match list comes from and what a match
   * carries: exact hits have charStart/charEnd, semantic hits have a `match` %.
   */
  async performSearch(query: any) {
    if (this.mode === 'semantic') {
      await this.performSemanticSearch(query);
      return;
    }

    if (!this.searchIndexCache) return;

    verbose.init(`SearchToolbar: Performing search for "${query}"`, '/search/inTextSearch/searchToolbar');

    this.commitMatches(searchIndex(this.searchIndexCache, query));
  }

  /**
   * Server-side semantic search over this book's node embeddings.
   *
   * The server returns hits ranked by similarity; we re-sort to DOCUMENT ORDER
   * before committing them. That is what keeps ▲▼ and findNearestMatchIndex()
   * behaving exactly as in exact mode — the alternative (walking best-match
   * first) would jump around the book and abandon "start where I'm reading".
   */
  async performSemanticSearch(query: any) {
    const bookId = currentLazyLoader?.bookId;
    if (!bookId) return;

    verbose.init(`SearchToolbar: Performing semantic search for "${query}"`, '/search/inTextSearch/searchToolbar');

    const result = await searchBookSemantically(bookId, String(query));

    // A superseded keystroke: the newer request owns the UI now.
    if (!result.ok && result.reason === 'aborted') return;

    // Mode or query changed while the request was in flight.
    if (this.mode !== 'semantic' || !this.isOpen) return;

    if (!result.ok) {
      this.matches = [];
      this.currentMatchIndex = -1;
      this.updateNavigationButtons(false);
      this.showModeError(result.reason, result.detail);
      return;
    }

    const ordered = [...result.hits].sort(
      (a, b) => parseFloat(a.startLine) - parseFloat(b.startLine)
    );

    this.commitMatches(ordered.map(hit => ({
      startLine: hit.startLine,
      chunk_id: hit.chunk_id,
      match: hit.match,
      similarity: hit.similarity,
    })));
  }

  /**
   * Adopt a fresh match list (already in document order) and drive the UI from
   * it. Shared by both modes — this is the seam that makes semantic mode "work
   * the same".
   */
  commitMatches(matches: any[]) {
    this.matches = matches;
    this.matchesByChunk = new Map();

    if (this.matches.length > 0) {
      // Group matches by chunk_id for efficient batch insertion
      this.matches.forEach((match: any, index: any) => {
        const chunkId = match.chunk_id;
        if (!this.matchesByChunk.has(chunkId)) {
          this.matchesByChunk.set(chunkId, []);
        }
        this.matchesByChunk.get(chunkId).push({ ...match, matchIndex: index });
      });

      // Apply marks to chunks already in DOM
      this.applyMarksToLoadedChunks();

      // Find the first match at or after current scroll position
      this.currentMatchIndex = this.findNearestMatchIndex();
      this.updateMatchCounter(this.currentMatchIndex + 1, this.matches.length);
      this.updateNavigationButtons(true);
      // Navigate to the nearest match
      this.navigateToCurrentMatch();
    } else {
      this.currentMatchIndex = -1;
      this.updateMatchCounter(0, 0);
      this.updateNavigationButtons(false);
    }
  }

  /**
   * Navigate to the current match and highlight it
   */
  navigateToCurrentMatch() {
    if (this.currentMatchIndex < 0 || this.currentMatchIndex >= this.matches.length) {
      return;
    }

    const match = this.matches[this.currentMatchIndex];
    const chunkId = match.chunk_id;
    const targetId = String(match.startLine);

    verbose.init(`SearchToolbar: Navigating to match ${this.currentMatchIndex + 1}/${this.matches.length} (startLine: ${targetId}, chunk: ${chunkId})`, '/search/inTextSearch/searchToolbar');

    if (!currentLazyLoader) return;

    // Check if chunk is already loaded - if so, skip navigation and go directly to mark
    const chunkAlreadyLoaded = currentLazyLoader.currentlyLoadedChunks?.has(chunkId);

    if (chunkAlreadyLoaded) {
      // Chunk is loaded - just highlight and scroll to mark directly
      this.highlightCurrentMatch();
    } else {
      // Chunk not loaded - need to load it first
      navigateToInternalId(targetId, currentLazyLoader, false);

      // Apply highlight after a short delay to let chunk load
      setTimeout(() => {
        this.highlightCurrentMatch();
      }, 300);
    }
  }

  /**
   * Highlight the current match in the DOM
   */
  highlightCurrentMatch() {
    if (this.currentMatchIndex < 0 || this.currentMatchIndex >= this.matches.length) {
      return;
    }

    const match = this.matches[this.currentMatchIndex];
    const chunkId = match.chunk_id;

    // Ensure all marks for this chunk are applied
    this.applyMarksForChunk(chunkId);

    // Remove 'current' from whichever marker kind is in play
    document.querySelectorAll('mark.search-highlight.current, .semantic-match.current')
      .forEach(m => m.classList.remove('current'));

    // Semantic mode addresses the NODE (there is no <mark> — the whole node is
    // the hit); exact mode addresses the <mark> it inserted.
    const targetEl = this.mode === 'semantic'
      ? document.getElementById(String(match.startLine))
      : document.getElementById(`search-match-${this.currentMatchIndex}`);

    if (targetEl) {
      targetEl.classList.add('current');
      // Paginated mode: flip to the match's page (a native scrollIntoView
      // would scroll the overflow:hidden wrapper and corrupt page geometry).
      if (!maybePaginatorReveal(targetEl)) {
        targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  /**
   * Apply all search markers for a specific chunk.
   *
   * Exact mode wraps character ranges in <mark>; semantic mode tints the node
   * itself, because the server ranked the whole node and there are no offsets to
   * wrap (see semanticSearch.ts for why we don't try to synthesize them).
   *
   * @param {number} chunkId - The chunk ID to apply markers for
   */
  applyMarksForChunk(chunkId: any) {
    const chunkMatches = this.matchesByChunk.get(chunkId);
    if (!chunkMatches) return;

    chunkMatches.forEach((match: any) => {
      const element = document.getElementById(String(match.startLine));
      if (!element) return;

      const isCurrent = match.matchIndex === this.currentMatchIndex;

      if (this.mode === 'semantic') {
        // Idempotent: re-applying on a chunk reload just rewrites the same
        // class + data attributes.
        applySemanticNodeHighlight(element, match.match ?? 0, isCurrent, match.matchIndex);
        return;
      }

      const markId = `search-match-${match.matchIndex}`;

      // Skip if mark already exists (handles chunk reload case)
      if (document.getElementById(markId)) return;

      applySearchHighlight(element, match.charStart, match.charEnd, isCurrent, markId);
    });
  }

  /**
   * Apply marks to all currently loaded chunks
   * Called when the search query changes to immediately show results in visible chunks
   */
  applyMarksToLoadedChunks() {
    if (!currentLazyLoader?.currentlyLoadedChunks) return;

    // For each loaded chunk, apply marks if we have matches there
    currentLazyLoader.currentlyLoadedChunks.forEach((chunkId: any) => {
      if (this.matchesByChunk.has(chunkId)) {
        this.applyMarksForChunk(chunkId);
      }
    });
  }

  /**
   * The current visible element's startLine — FRESH (search results should
   * center on where the user is at open time; the saved anchor alone can lag
   * by up to 250ms, the same staleness class as the audio jump-to-top bug).
   * @returns {number|null} The startLine of the currently visible element, or null
   */
  getCurrentVisibleStartLine() {
    if (!currentLazyLoader?.bookId) return null;

    const anchor = getFreshAnchor(currentLazyLoader.bookId);

    return anchor ? parseFloat(anchor.elementId) : null;
  }

  /**
   * Find the index of the first match at or after the initial scroll position (when search opened)
   * @returns {number} The index of the nearest match (0 if none found after initial position)
   */
  findNearestMatchIndex() {
    if (this.matches.length === 0) return 0;

    // Use the position captured when search opened
    if (this.initialStartLine === null) return 0;

    // Find first match with startLine >= initial position
    for (let i = 0; i < this.matches.length; i++) {
      if (parseFloat(this.matches[i].startLine) >= this.initialStartLine) {
        verbose.init(`SearchToolbar: Starting from match ${i + 1} (startLine ${this.matches[i].startLine} >= initial ${this.initialStartLine})`, '/search/inTextSearch/searchToolbar');
        return i;
      }
    }

    // No match after initial position - wrap to first match
    verbose.init(`SearchToolbar: No matches after initial position (${this.initialStartLine}), wrapping to first match`, '/search/inTextSearch/searchToolbar');
    return 0;
  }

  /**
   * Handle previous match button
   */
  handlePrev() {
    if (this.matches.length === 0) return;

    verbose.init('SearchToolbar: Previous match', '/search/inTextSearch/searchToolbar');

    // Wrap around to end if at beginning
    if (this.currentMatchIndex <= 0) {
      this.currentMatchIndex = this.matches.length - 1;
    } else {
      this.currentMatchIndex--;
    }

    this.updateMatchCounter(this.currentMatchIndex + 1, this.matches.length);
    this.navigateToCurrentMatch();
  }

  /**
   * Handle next match button
   */
  handleNext() {
    if (this.matches.length === 0) return;

    verbose.init('SearchToolbar: Next match', '/search/inTextSearch/searchToolbar');

    // Wrap around to beginning if at end
    if (this.currentMatchIndex >= this.matches.length - 1) {
      this.currentMatchIndex = 0;
    } else {
      this.currentMatchIndex++;
    }

    this.updateMatchCounter(this.currentMatchIndex + 1, this.matches.length);
    this.navigateToCurrentMatch();
  }

  /**
   * Handle clicks outside the search toolbar
   */
  handleClickOutside(e: any) {
    // Don't close if clicking inside the toolbar
    if (this.toolbar && this.toolbar.contains(e.target)) {
      return;
    }

    // Don't close if clicking the settings button (which opens the toolbar)
    if (e.target.closest('#searchButton')) {
      return;
    }

    // Close the toolbar
    this.close();
  }

  /**
   * Handle keyboard shortcuts in search input
   */
  handleKeydown(e: any) {
    // Escape closes from ANYWHERE in the toolbar, not just the input. The
    // listener used to sit on #search-input alone, so a user who clicked ▲/▼ (or
    // the mode toggle) and then pressed Escape got nothing — focus was on a
    // button, the event never reached the handler, and the find bar stayed up
    // with no keyboard way out. The overlay contract is "Escape closes"; bind it
    // to the toolbar and let it bubble.
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }

    // Enter / Cmd+G = next match — but ONLY from the input. On a focused button
    // Enter already fires a click, so handling it here too would advance twice.
    if (e.target !== this.input) return;

    if (e.key === 'Enter' || (e.key === 'g' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      if (e.shiftKey) {
        this.handlePrev();
      } else {
        this.handleNext();
      }
    }
  }

  /**
   * Update match counter display
   */
  updateMatchCounter(current: any, total: any) {
    if (this.matchCounter) {
      // Clears any semantic failure message showing in this slot.
      this.matchCounter.classList.remove('search-status-error');
      this.matchCounter.textContent = `${current} of ${total}`;
    }
  }

  /**
   * Update navigation button states
   */
  updateNavigationButtons(enabled: any) {
    if (this.prevButton) {
      this.prevButton.disabled = !enabled;
    }
    if (this.nextButton) {
      this.nextButton.disabled = !enabled;
    }
  }

  /**
   * Clear search results (keeps index cached)
   */
  clearSearch() {
    verbose.init('SearchToolbar: Clearing search', '/search/inTextSearch/searchToolbar');
    this.matches = [];
    this.currentMatchIndex = -1;
    this.matchesByChunk = new Map();
    this.initialStartLine = null;
  }

  /**
   * Invalidate the search index (call when book changes)
   */
  invalidateIndex() {
    verbose.init('SearchToolbar: Invalidating search index', '/search/inTextSearch/searchToolbar');
    this.searchIndexCache = null;
    this.matches = [];
    this.currentMatchIndex = -1;
  }

  /**
   * Hide all perimeter buttons when search is open
   */
  hidePerimeterButtons() {
    const perimeterButtonIds = [
      'bottom-right-buttons',
      'bottom-left-buttons',
      'topRightContainer',
      'logoNavWrapper',
      'userButtonContainer'
    ];

    perimeterButtonIds.forEach(id => {
      const element = document.getElementById(id);
      if (element && !element.classList.contains('perimeter-hidden')) {
        element.classList.add('perimeter-hidden');
      }
    });

    verbose.init('SearchToolbar: Perimeter buttons hidden', '/search/inTextSearch/searchToolbar');
  }

  /**
   * Show all perimeter buttons when search is closed
   */
  showPerimeterButtons() {
    const perimeterButtonIds = [
      'bottom-right-buttons',
      'bottom-left-buttons',
      'topRightContainer',
      'logoNavWrapper',
      'userButtonContainer'
    ];

    perimeterButtonIds.forEach(id => {
      const element = document.getElementById(id);
      if (element && element.classList.contains('perimeter-hidden')) {
        element.classList.remove('perimeter-hidden');
      }
    });

    verbose.init('SearchToolbar: Perimeter buttons shown', '/search/inTextSearch/searchToolbar');
  }

  /**
   * Rebind elements after SPA transitions
   */
  rebindElements() {
    // The toggle listener lives on an element that SPA nav may have replaced —
    // drop it before rebinding or the old node keeps a live handler.
    if (this.modeToggle) {
      this.modeToggle.removeEventListener('click', this.boundModeToggleHandler);
    }

    this.bindElements();

    // Re-attach to the (possibly new) toggle element.
    if (this.modeToggle) {
      this.modeToggle.addEventListener('click', this.boundModeToggleHandler);
    }

    // Invalidate index on rebind since book may have changed
    this.invalidateIndex();
    verbose.init('SearchToolbar: Elements rebound', '/search/inTextSearch/searchToolbar');
  }

  /**
   * Clean up event listeners
   */
  destroy() {
    // Cancel any pending debounced search + in-flight semantic request
    this.debouncedSearch.cancel();
    abortSemanticSearch();

    // Remove click outside listener if it exists
    document.removeEventListener('click', this.boundClickOutsideHandler, true);

    if (this.modeToggle) {
      this.modeToggle.removeEventListener('click', this.boundModeToggleHandler);
    }

    if (this.input) {
      this.input.removeEventListener('input', this.boundInputHandler);
    }

    if (this.toolbar) {
      this.toolbar.removeEventListener('keydown', this.boundKeydownHandler);
    }

    if (this.prevButton) {
      this.prevButton.removeEventListener('click', this.boundPrevHandler);
      this.prevButton.removeEventListener('touchend', this.boundPrevTouchHandler);
    }

    if (this.nextButton) {
      this.nextButton.removeEventListener('click', this.boundNextHandler);
      this.nextButton.removeEventListener('touchend', this.boundNextTouchHandler);
    }

    verbose.init('SearchToolbar: Event listeners removed', '/search/inTextSearch/searchToolbar');
  }
}

// Search toolbar manager instance (singleton)
let searchToolbarManager: any = null;

// Invalidate search index when background download completes (chunked lazy loading)
window.addEventListener('backgroundDownloadComplete', () => {
  if (searchToolbarManager) {
    searchToolbarManager.searchIndexCache = null;
  }
});

/**
 * Initialize the search toolbar manager
 */
export function initializeSearchToolbar() {
  if (!searchToolbarManager) {
    // Create new manager instance
    searchToolbarManager = new SearchToolbarManager();
    verbose.init('Search Toolbar initialized', '/search/inTextSearch/searchToolbar');
  } else {
    // Manager exists, just rebind elements after SPA transition
    searchToolbarManager.rebindElements();
    verbose.init('Search Toolbar rebound', '/search/inTextSearch/searchToolbar');
  }

  return searchToolbarManager;
}

/**
 * Get the search toolbar manager instance
 */
export function getSearchToolbar() {
  return searchToolbarManager;
}

/**
 * Open the search toolbar
 */
export function openSearchToolbar() {
  if (searchToolbarManager) {
    searchToolbarManager.open();
  }
}

/**
 * Close the search toolbar
 */
export function closeSearchToolbar() {
  if (searchToolbarManager) {
    searchToolbarManager.close();
  }
}

/**
 * Check if search toolbar is currently open
 */
export function isSearchToolbarOpen() {
  return searchToolbarManager ? searchToolbarManager.isOpen : false;
}

/**
 * Destroy search toolbar manager for cleanup during navigation
 */
export function destroySearchToolbar() {
  if (searchToolbarManager) {
    searchToolbarManager.destroy();
    searchToolbarManager = null;
    verbose.init('Search Toolbar destroyed', '/search/inTextSearch/searchToolbar');
    return true;
  }
  return false;
}

/**
 * Invalidate the search index (call when book changes or content is edited)
 */
export function invalidateSearchIndex() {
  if (searchToolbarManager) {
    searchToolbarManager.invalidateIndex();
  }
}

/**
 * Open the search toolbar with a pre-filled query (used for highlighting from homepage search)
 * @param {string} query - The search query to pre-fill and execute
 * @param {number|string} [targetStartLine] - Optional startLine to navigate to nearest match
 */
export async function openSearchToolbarWithQuery(query: any, targetStartLine: any = null) {
  if (!searchToolbarManager) {
    log.error('SearchToolbar: Manager not initialized', '/search/inTextSearch/searchToolbar');
    return;
  }

  // Open the toolbar first (this sets initialStartLine to current scroll position)
  await searchToolbarManager.open();

  // This handoff always comes from a FULL-TEXT result (searchBox deliberately
  // omits it for semantic hits — the matched paragraph doesn't contain the query
  // words), so the query is a literal string that exists in the text. Force
  // exact mode: running it through the semantic engine because that's the user's
  // remembered preference would rank by meaning and land somewhere else.
  if (searchToolbarManager.mode !== 'exact') {
    searchToolbarManager.mode = 'exact';
    searchToolbarManager.installDebounce();
    searchToolbarManager.renderModeToggle();
    await searchToolbarManager.ensureSearchIndex();
  }

  // Override initialStartLine AFTER open() if we have a target startLine
  // This must come after open() because open() resets initialStartLine to current scroll position
  if (targetStartLine) {
    searchToolbarManager.initialStartLine = Number(targetStartLine);
    verbose.init(`SearchToolbar: Override initial position to ${targetStartLine}`, '/search/inTextSearch/searchToolbar');
  }

  // Set the input value and trigger search
  if (searchToolbarManager.input && query) {
    searchToolbarManager.input.value = query;
    // Trigger the input handler to perform the search
    searchToolbarManager.handleInput({ target: searchToolbarManager.input });

    verbose.init(`SearchToolbar: Opened with query "${query}"`, '/search/inTextSearch/searchToolbar');
  }
}

/**
 * Check sessionStorage for pending highlight query and trigger search if present
 * Call this after page load on reader pages
 */
export function checkHighlightParam() {
  const highlightQuery = sessionStorage.getItem('pendingHighlightQuery');
  const highlightStartLine = sessionStorage.getItem('pendingHighlightStartLine');

  if (highlightQuery) {
    verbose.init(`SearchToolbar: Found pending highlight query "${highlightQuery}", startLine: ${highlightStartLine}`, '/search/inTextSearch/searchToolbar');

    // Clear immediately so it doesn't trigger again on refresh
    sessionStorage.removeItem('pendingHighlightQuery');
    sessionStorage.removeItem('pendingHighlightStartLine');

    // Delay to ensure page and search index are ready
    setTimeout(() => {
      openSearchToolbarWithQuery(highlightQuery, highlightStartLine);
    }, 1000);
  }
}
