/**
 * Journal-scoped search for /j/{slug} pages — homepage search parity, scoped
 * to THIS journal: default mode searches titles & authors, the "Full text"
 * toggle searches inside article content. Both modes hit the public shelf
 * search endpoint (GET /api/public/shelves/{id}/search —
 * ShelfController::publicSearch; `mode=library` is the titles branch).
 *
 * Deliberately its own small component with its own element ids
 * (#journal-search-*) rather than a parameterised homepageSearch: that
 * component is global site search with localStorage-persisted mode state, and
 * sharing ids/state across page types is how stale-binding bugs happen.
 *
 * Registered via ButtonRegistry (pages: ['journal']) — survives SPA nav.
 */
import DOMPurify from 'dompurify';
import { log, verbose } from '../../utilities/logger';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

// Homepage-parity persistence (homepage_search_query/_fulltext equivalents).
// The toggle is a user preference shared across journals; the query is
// per-journal (restoring journal A's query into journal B's box would lie).
const STORAGE_KEY_FULLTEXT = 'journal_search_fulltext';
const storageKeyQuery = (shelfId: string) => `journal_search_query_${shelfId}`;

const PLACEHOLDER_TITLES = 'Search titles & authors...';
const PLACEHOLDER_FULLTEXT = 'Search article text...';

let searchInput: HTMLInputElement | null = null;
let fulltextToggle: HTMLInputElement | null = null;
let resultsContainer: HTMLElement | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let abortController: AbortController | null = null;
let outsideClickHandler: ((e: MouseEvent) => void) | null = null;
let toggleHandler: (() => void) | null = null;
let pageshowHandler: ((e: PageTransitionEvent) => void) | null = null;
let currentQuery = '';
let isFullTextMode = false;

interface ShelfSearchMatch {
  node_id: string;
  startLine: number | string | null;
  headline: string;
}

interface ShelfSearchBookResult {
  book: string;
  title: string | null;
  author: string | null;
  matches: ShelfSearchMatch[];
}

interface ShelfLibraryResult {
  book: string;
  title: string | null;
  author: string | null;
  year: string | null;
  headline: string;
}

export function initializeJournalSearch(): void {
  const container = document.getElementById('journal-search-container');
  searchInput = document.getElementById('journal-search-input') as HTMLInputElement | null;
  fulltextToggle = document.getElementById('journal-fulltext-toggle') as HTMLInputElement | null;
  resultsContainer = document.getElementById('journal-search-results');

  if (!container || !searchInput || !resultsContainer) {
    return; // not a journal page render
  }

  const shelfId = container.dataset.shelfId || '';
  if (!shelfId) {
    // Journal not harvested yet — no shelf to search; leave the box inert but
    // honest about it.
    searchInput.disabled = true;
    searchInput.placeholder = 'No articles yet';
    if (fulltextToggle) fulltextToggle.disabled = true;
    return;
  }

  // Restore persisted state (homepage parity: home does the same on init).
  restorePersistedState(shelfId);

  searchInput.addEventListener('input', () => handleInput(shelfId));
  // Focus with a query already in the box (e.g. restored after Back): show
  // the rendered results if we have them, otherwise re-run the search —
  // same semantics as home's handleFocus.
  searchInput.addEventListener('focus', () => {
    const query = searchInput?.value.trim() ?? '';
    if (query.length < MIN_QUERY_LENGTH) return;
    currentQuery = query;
    if (resultsContainer && resultsContainer.childElementCount > 0 && !resultsContainer.classList.contains('hidden')) {
      showResults();
    } else {
      void performSearch(shelfId, query);
    }
  });

  if (fulltextToggle) {
    toggleHandler = () => {
      isFullTextMode = !!fulltextToggle?.checked;
      localStorage.setItem(STORAGE_KEY_FULLTEXT, String(isFullTextMode));
      if (searchInput) {
        searchInput.placeholder = isFullTextMode ? PLACEHOLDER_FULLTEXT : PLACEHOLDER_TITLES;
      }
      // Re-run the live query in the new mode (same behavior as home).
      if (currentQuery.length >= MIN_QUERY_LENGTH) {
        void performSearch(shelfId, currentQuery);
      }
    };
    fulltextToggle.addEventListener('change', toggleHandler);
  }

  outsideClickHandler = (e: MouseEvent) => {
    if (container && !container.contains(e.target as Node)) {
      hideResults();
    }
  };
  document.addEventListener('click', outsideClickHandler);

  // Safari bfcache: Back resumes the frozen page — NO init re-runs, the stale
  // results dropdown is still open, and Safari clears autocomplete="off" text
  // inputs on restore (possibly AFTER pageshow fires, so re-apply again a beat
  // later). Empty the dropdown (not just hide it) so a subsequent focus can't
  // resurrect stale results.
  pageshowHandler = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    if (resultsContainer) resultsContainer.innerHTML = '';
    hideResults();
    restorePersistedState(shelfId);
    setTimeout(() => restorePersistedState(shelfId), 150);
  };
  window.addEventListener('pageshow', pageshowHandler);

  verbose.init('journalSearch initialized', '/components/journal/journalSearch.ts');
}

/** Apply saved toggle + query onto the DOM (init AND bfcache pageshow). */
function restorePersistedState(shelfId: string): void {
  if (!searchInput) return;

  const savedFulltext = localStorage.getItem(STORAGE_KEY_FULLTEXT);
  if (savedFulltext !== null && fulltextToggle) {
    fulltextToggle.checked = savedFulltext === 'true';
  }
  isFullTextMode = !!fulltextToggle?.checked;
  searchInput.placeholder = isFullTextMode ? PLACEHOLDER_FULLTEXT : PLACEHOLDER_TITLES;

  const savedQuery = localStorage.getItem(storageKeyQuery(shelfId));
  searchInput.value = savedQuery || '';
  currentQuery = savedQuery || '';
}

export function destroyJournalSearch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  if (outsideClickHandler) {
    document.removeEventListener('click', outsideClickHandler);
    outsideClickHandler = null;
  }
  if (toggleHandler && fulltextToggle) {
    fulltextToggle.removeEventListener('change', toggleHandler);
  }
  toggleHandler = null;
  if (pageshowHandler) {
    window.removeEventListener('pageshow', pageshowHandler);
    pageshowHandler = null;
  }
  fulltextToggle = null;
  searchInput = null;
  resultsContainer = null;
  currentQuery = '';
  isFullTextMode = false;
}

function handleInput(shelfId: string): void {
  if (!searchInput) return;
  const query = searchInput.value.trim();
  currentQuery = query;

  if (debounceTimer) clearTimeout(debounceTimer);
  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  if (query.length < MIN_QUERY_LENGTH) {
    localStorage.removeItem(storageKeyQuery(shelfId));
    hideResults();
    return;
  }

  localStorage.setItem(storageKeyQuery(shelfId), query);

  debounceTimer = setTimeout(() => {
    void performSearch(shelfId, query);
  }, DEBOUNCE_MS);
}

async function performSearch(shelfId: string, query: string): Promise<void> {
  if (abortController) abortController.abort();
  abortController = new AbortController();

  const mode = isFullTextMode ? '' : '&mode=library';

  try {
    const response = await fetch(
      `/api/public/shelves/${encodeURIComponent(shelfId)}/search?q=${encodeURIComponent(query)}${mode}`,
      {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        signal: abortController.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Journal search failed: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      showMessage('Search failed. Please try again.');
      return;
    }

    if (data.mode === 'library') {
      renderLibraryResults((data.results ?? []) as ShelfLibraryResult[]);
    } else {
      renderFullTextResults((data.results ?? []) as ShelfSearchBookResult[]);
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return;
    }
    log.error('Journal search error', '/components/journal/journalSearch.ts', error);
    showMessage('Search failed. Please try again.');
  }
}

/** Titles & authors mode: flat list of articles (home's library-mode shape). */
function renderLibraryResults(results: ShelfLibraryResult[]): void {
  if (!resultsContainer) return;

  if (!results.length) {
    showMessage('No matches in this journal.');
    return;
  }

  let html = '<ul class="search-results-list">';
  for (const result of results) {
    html += `
      <li class="search-result-item">
        <a href="/${encodeURIComponent(result.book)}" class="search-result-link">
          <span class="search-result-headline">${DOMPurify.sanitize(result.headline, { ALLOWED_TAGS: ['b', 'mark'] })}</span>
        </a>
      </li>
    `;
  }
  html += '</ul>';

  resultsContainer.innerHTML = html;
  showResults();
}

/** Full-text mode: grouped by article with match snippets. */
function renderFullTextResults(results: ShelfSearchBookResult[]): void {
  if (!resultsContainer) return;

  if (!results.length) {
    showMessage('No matches in this journal.');
    return;
  }

  let html = '<ul class="search-results-list">';

  for (const bookResult of results) {
    html += `
      <li class="search-result-book">
        <div class="search-result-book-header">
          <a href="/${encodeURIComponent(bookResult.book)}" class="search-result-book-title">${escapeHtml(bookResult.title || 'Untitled')}</a>
          <span class="search-result-book-author">${escapeHtml(bookResult.author || '')}</span>
        </div>
        <ul class="search-result-matches">
    `;

    for (const match of bookResult.matches.slice(0, 3)) {
      const nodeAnchor = match.startLine ? `#${match.startLine}` : '';
      html += `
        <li class="search-result-match">
          <a href="/${encodeURIComponent(bookResult.book)}${nodeAnchor}"
             class="search-result-match-link"
             data-highlight-query="${escapeHtml(currentQuery)}">
            <span class="search-result-snippet">${DOMPurify.sanitize(match.headline, { ALLOWED_TAGS: ['b', 'mark'] })}</span>
          </a>
        </li>
      `;
    }

    if (bookResult.matches.length > 3) {
      html += `<li class="search-result-more">+${bookResult.matches.length - 3} more matches</li>`;
    }

    html += '</ul></li>';
  }

  html += '</ul>';

  resultsContainer.innerHTML = html;

  // Same wiring as homepageSearch: clicking a match stashes the query +
  // startLine so the reader's search toolbar opens highlighted at the match
  // (checkHighlightParam on the reader side) — the highlight is sessionStorage-
  // driven, not URL-driven.
  resultsContainer.querySelectorAll<HTMLElement>('[data-highlight-query]').forEach((link) => {
    link.addEventListener('click', () => {
      const query = link.dataset.highlightQuery;
      if (!query) return;
      const href = link.getAttribute('href') || '';
      const startLine = href.match(/#(\d+)/)?.[1];
      sessionStorage.setItem('pendingHighlightQuery', query);
      if (startLine) {
        sessionStorage.setItem('pendingHighlightStartLine', startLine);
      }
      verbose.content(`Stored highlight query: ${query}`, '/components/journal/journalSearch.ts');
    });
  });

  showResults();
}

function showMessage(message: string): void {
  if (!resultsContainer) return;
  resultsContainer.innerHTML = `<div class="search-no-results">${escapeHtml(message)}</div>`;
  showResults();
}

function showResults(): void {
  resultsContainer?.classList.remove('hidden');
  resultsContainer?.classList.add('visible');
}

function hideResults(): void {
  resultsContainer?.classList.add('hidden');
  resultsContainer?.classList.remove('visible');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
