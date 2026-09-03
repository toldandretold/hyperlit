/**
 * searchBox — the ONE search-box behavior, instantiated per page.
 *
 * The homepage (`homepageSearch.ts`) and journal pages (`journalSearch.ts`)
 * used to be parallel forks of the same component; they drifted (the journal
 * missed the semantic mode, textarea auto-grow, match badges) and the fork's
 * original rationale — shared ids/localStorage state causing stale-binding
 * bugs — is solved properly here by per-instance closures over a config:
 * every page keeps its OWN element ids, storage keys, and endpoints, while
 * the behavior (three modes, mutually exclusive toggles, debounce, bfcache
 * restore, renderers) is single-sourced.
 *
 * Modes: 'library' (titles & authors), 'fulltext' (node content), 'semantic'
 * (embedding search; opt-in, never default). The two toggles are mutually
 * exclusive — checking one unchecks the other.
 *
 * Optional fourth mode: 'archivist' (the AI Archivist takeover, hero pages
 * only). Entered/exited via the brain button, NOT a toggle: applyMode stamps
 * `archivist-mode` on the surrounding .arranger-buttons-container and CSS does
 * the header takeover (toggles + feed buttons hide, the Ask button appears).
 * The mode is SUBMIT-driven — typing/focus/restore never fire anything; only
 * Enter or the Ask button call config.archivist.onSubmit. Instances without
 * archivist config behave exactly as before (a persisted 'archivist' mode
 * falls back to 'library').
 */

import DOMPurify from 'dompurify';
import { log, verbose } from '../utilities/logger';
import { searchCacheGet, searchCacheSet } from './searchResultCache';

export type SearchMode = 'library' | 'fulltext' | 'semantic' | 'archivist';

export interface SearchBoxConfig {
    ids: {
        container: string;
        input: string;
        results: string;
        fulltextToggle: string;
        semanticToggle: string;
        /** the brain button that toggles archivist mode (requires `archivist`) */
        brainButton?: string;
        /** the submit button shown in archivist mode (requires `archivist`) */
        askButton?: string;
    };
    storage: {
        modeKey: string;
        /** old boolean key migrated into modeKey on first read */
        legacyFulltextKey?: string;
        /** query persistence key; ctx is the page context id ('' on home, shelfId on journals) */
        queryKey: (ctx: string) => string;
    };
    placeholders: Record<'library' | 'fulltext' | 'semantic', string> & { archivist?: string };
    /** empty-state copy for library/fulltext ('semantic' has shared copy) */
    noResultsMessage: (mode: SearchMode) => string;
    /** full request URL for a mode + query (include any limit/scope params) —
     *  never called in archivist mode (that mode has no search endpoint) */
    endpointFor: (mode: Exclude<SearchMode, 'archivist'>, query: string, ctx: string) => string;
    /**
     * Context requirement (journal pages): read this dataset key off the
     * container; when absent the box is disabled with the given placeholder.
     */
    context?: { datasetKey: string; missingPlaceholder: string };
    /** AI Archivist wiring — submit-driven, no search endpoint involved */
    archivist?: { onSubmit: (query: string, contextId: string) => void };
    /** source tag for logger lines */
    logSource: string;
}

// Longer debounce + higher minimum for semantic: every uncached keystroke is
// an embedding API round-trip, and 2-char fragments embed to near-noise.
const DEBOUNCE_MS = 300;
const DEBOUNCE_SEMANTIC_MS = 500;
const MIN_QUERY_LENGTH = 2;
const MIN_QUERY_LENGTH_SEMANTIC = 3;

const SEMANTIC_UNAVAILABLE = 'Semantic search is temporarily unavailable';

// Archivist asks are real prompts, not incremental queries — same floor as the
// server's `question` min:3.
const MIN_QUERY_LENGTH_ARCHIVIST = 3;

function isSearchMode(value: string | null): value is SearchMode {
    return value === 'library' || value === 'fulltext' || value === 'semantic' || value === 'archivist';
}

function escapeHtml(text: any): string {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

export function createSearchBox(config: SearchBoxConfig) {
    // ---- per-instance state (closure-scoped — nothing shared across pages)
    let searchInput: HTMLTextAreaElement | null = null;
    let fulltextToggle: HTMLInputElement | null = null;
    let semanticToggle: HTMLInputElement | null = null;
    let brainButton: HTMLButtonElement | null = null;
    let askButton: HTMLButtonElement | null = null;
    let resultsContainer: HTMLElement | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    let searchMode: SearchMode = 'library';
    /** where the brain button returns to when archivist mode is switched off */
    let lastNonArchivistMode: SearchMode = 'library';
    let currentSearchQuery = '';
    let contextId = '';
    let pageshowHandler: ((e: PageTransitionEvent) => void) | null = null;
    let outsideClickHandler: ((e: MouseEvent) => void) | null = null;
    let modeRefreshHandler: (() => void) | null = null;

    const hasArchivist = () => !!(config.archivist && config.ids.brainButton);
    const minLen = () => (searchMode === 'semantic' ? MIN_QUERY_LENGTH_SEMANTIC : MIN_QUERY_LENGTH);
    const debounceMs = () => (searchMode === 'semantic' ? DEBOUNCE_SEMANTIC_MS : DEBOUNCE_MS);
    const placeholderFor = (mode: SearchMode): string =>
        (mode === 'archivist' ? config.placeholders.archivist : config.placeholders[mode])
        ?? config.placeholders.library;

    /** Read the persisted mode, migrating the legacy fulltext boolean key. */
    function readStoredMode(): SearchMode {
        const stored = localStorage.getItem(config.storage.modeKey);
        // A persisted 'archivist' only counts on an instance that has the
        // wiring — anywhere else it degrades to the default mode.
        if (stored === 'archivist') return hasArchivist() ? 'archivist' : 'library';
        if (isSearchMode(stored)) return stored;
        if (config.storage.legacyFulltextKey) {
            const legacy = localStorage.getItem(config.storage.legacyFulltextKey);
            if (legacy !== null) {
                const migrated: SearchMode = legacy === 'true' ? 'fulltext' : 'library';
                localStorage.setItem(config.storage.modeKey, migrated);
                localStorage.removeItem(config.storage.legacyFulltextKey);
                return migrated;
            }
        }
        return 'library';
    }

    /**
     * Grow the textarea to fit its content (CSS min/max-height clamp the
     * range; beyond the cap it scrolls internally). Runs on every input —
     * including pastes — and after programmatic value restores.
     */
    function autosize() {
        if (!searchInput) return;
        searchInput.style.height = 'auto';
        searchInput.style.height = `${searchInput.scrollHeight}px`;
    }

    /**
     * Sync toggles + placeholder to a mode. The two toggles are mutually
     * exclusive (three effective modes), so both checkboxes are always set.
     */
    function applyMode(mode: SearchMode) {
        if (mode !== 'archivist') lastNonArchivistMode = mode;
        searchMode = mode;
        if (fulltextToggle) fulltextToggle.checked = mode === 'fulltext';
        if (semanticToggle) semanticToggle.checked = mode === 'semantic';
        if (searchInput) searchInput.placeholder = placeholderFor(mode);

        // The archivist takeover is pure CSS keyed off this class: the
        // .arranger-buttons-container hides the toggle stack + feed buttons,
        // widens the input anchor and reveals the Ask button.
        const row = document.getElementById(config.ids.container)?.closest('.arranger-buttons-container');
        if (row) row.classList.toggle('archivist-mode', mode === 'archivist');
        if (askButton) askButton.hidden = mode !== 'archivist';
        if (brainButton) brainButton.classList.toggle('active', mode === 'archivist');
        if (mode === 'archivist') hideResults(); // a stale dropdown under a submit-driven mode lies
    }

    /** Persist + apply a mode change, re-running the search if long enough. */
    function changeMode(mode: SearchMode) {
        const wasArchivist = searchMode === 'archivist';
        applyMode(mode);
        localStorage.setItem(config.storage.modeKey, mode);
        verbose.content(`Search mode changed to: ${mode}`, config.logSource);
        // Announce archivist boundary crossings (USER-driven only — restores
        // go through applyMode and stay silent): the archivist panel hides its
        // answer when the mode flips off and reshows it when flipped back on.
        const isArchivist = mode === 'archivist';
        if (wasArchivist !== isArchivist) {
            window.dispatchEvent(new CustomEvent('hyperlit:archivist-mode-changed', { detail: { active: isArchivist } }));
        }
        // Archivist is submit-driven: entering it must never auto-fire.
        if (mode === 'archivist') return;
        const query = searchInput?.value.trim() ?? '';
        if (query.length >= minLen()) {
            performSearch(query);
        } else {
            hideResults();
        }
    }

    function handleFulltextToggleChange(event: Event) {
        changeMode((event.target as HTMLInputElement).checked ? 'fulltext' : 'library');
    }

    function handleSemanticToggleChange(event: Event) {
        changeMode((event.target as HTMLInputElement).checked ? 'semantic' : 'library');
    }

    /** Brain button: toggle between archivist mode and the previous mode. */
    function handleBrainClick() {
        changeMode(searchMode === 'archivist' ? lastNonArchivistMode : 'archivist');
    }

    function submitArchivist() {
        if (!config.archivist) return;
        const query = searchInput?.value.trim() ?? '';
        if (query.length < MIN_QUERY_LENGTH_ARCHIVIST) {
            searchInput?.focus();
            return;
        }
        config.archivist.onSubmit(query, contextId);
    }

    function handleAskClick() {
        submitArchivist();
    }

    function handleSearchInput(event: Event) {
        autosize();
        const query = (event.target as HTMLTextAreaElement).value.trim();

        if (debounceTimer) clearTimeout(debounceTimer);
        if (abortController) abortController.abort();

        // Archivist: persist the draft prompt, but NEVER fire on keystrokes.
        if (searchMode === 'archivist') {
            if (query.length === 0) {
                localStorage.removeItem(config.storage.queryKey(contextId));
            } else {
                localStorage.setItem(config.storage.queryKey(contextId), query);
            }
            return;
        }

        if (query.length < minLen()) {
            hideResults();
            if (query.length === 0) {
                localStorage.removeItem(config.storage.queryKey(contextId));
            }
            return;
        }

        localStorage.setItem(config.storage.queryKey(contextId), query);
        showLoading();
        debounceTimer = setTimeout(() => performSearch(query), debounceMs());
    }

    function handleKeyDown(event: KeyboardEvent) {
        // Archivist: Enter submits the prompt; Shift+Enter keeps its newline
        // (the textarea is multiline by design).
        if (searchMode === 'archivist' && event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitArchivist();
            return;
        }
        if (event.key === 'Escape') {
            hideResults();
            searchInput?.blur();
        }
    }

    function handleFocus() {
        if (searchMode === 'archivist') return; // submit-driven — focus never searches
        const query = searchInput?.value.trim() ?? '';
        if (query.length < minLen() || !resultsContainer) return;
        if (!resultsContainer.innerHTML || resultsContainer.classList.contains('hidden')) {
            performSearch(query);
        } else {
            resultsContainer.classList.remove('hidden');
            resultsContainer.classList.add('visible');
        }
    }

    async function performSearch(query: string) {
        if (searchMode === 'archivist') return; // submit-driven — no search endpoint
        currentSearchQuery = query;
        const url = config.endpointFor(searchMode, query, contextId);

        // Client-side cache (URL key encodes endpoint/mode/scope/query) —
        // backspacing or retyping an identical query renders instantly.
        const cached = searchCacheGet<{ results: any; mode: any }>(url);
        if (cached) {
            renderResults(cached.results, cached.mode);
            return;
        }

        abortController = new AbortController();
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'X-CSRF-TOKEN': (document.querySelector('meta[name="csrf-token"]') as any)?.content,
                },
                credentials: 'include',
                signal: abortController.signal,
            });

            if (!response.ok) {
                // The semantic endpoints 503 when the embedding provider is
                // down — a dependency outage worth naming.
                if (response.status === 503) {
                    showError(SEMANTIC_UNAVAILABLE);
                    return;
                }
                throw new Error(`Search failed: ${response.status}`);
            }

            const data = await response.json();
            if (data.success) {
                searchCacheSet(url, data);
                renderResults(data.results, data.mode);
            } else {
                showError('Search failed. Please try again.');
            }
        } catch (error) {
            if ((error as any).name === 'AbortError') return;
            log.error('Search error', config.logSource, error);
            showError('Search failed. Please try again.');
        }
    }

    function renderResults(results: any, mode: any) {
        if (!resultsContainer) return;
        if (!results || results.length === 0) {
            showNoResults();
            return;
        }

        let html = '<ul class="search-results-list">';

        if (mode === 'library') {
            // Library results: simple list of books
            results.forEach((result: any) => {
                html += `
                    <li class="search-result-item">
                        <a href="/${encodeURIComponent(result.book)}" class="search-result-link">
                            <span class="search-result-headline">${DOMPurify.sanitize(result.headline, { ALLOWED_TAGS: ['b', 'mark'] })}</span>
                        </a>
                    </li>
                `;
            });
        } else if (mode === 'semantic') {
            // Semantic results: flat ranked list (rank IS the signal — no book
            // grouping), plain excerpts (no exact matched term to <mark>).
            // `match` is the server's floor-rescaled percentage: 0% = the
            // measured cosine noise floor (unrelated English), 100% =
            // identical — the top of the scale is real, not clamped.
            // NO data-highlight-query handoff: the matched paragraph doesn't
            // contain the query words, so the reader's in-text search would
            // hunt for a literal string that isn't there and fail. The
            // #startLine anchor alone lands on the paragraph.
            results.forEach((result: any) => {
                const nodeAnchor = result.startLine ? `#${result.startLine}` : '';
                const matchPct = typeof result.match === 'number'
                    ? `<span class="search-result-similarity">${result.match}% match</span>`
                    : '';
                html += `
                    <li class="search-result-semantic">
                        <a href="/${encodeURIComponent(result.book)}${nodeAnchor}"
                           class="search-result-match-link">
                            <span class="search-result-snippet">${escapeHtml(result.excerpt)}</span>
                            <span class="search-result-semantic-source">
                                <span class="search-result-book-title">${escapeHtml(result.title || 'Untitled')}</span>${matchPct}
                                <span class="search-result-book-author">${escapeHtml(result.author || 'Unknown')}</span>
                            </span>
                        </a>
                    </li>
                `;
            });
        } else {
            // Full-text results: grouped by book with match snippets. Sub-book
            // fields only exist on the homepage endpoint; absent they render
            // as a plain book row.
            results.forEach((bookResult: any) => {
                const isSubbook = !!bookResult.is_subbook;
                const displayTitle = isSubbook
                    ? (bookResult.parent_title || 'Untitled')
                    : (bookResult.title || 'Untitled');
                const displayAuthor = isSubbook
                    ? (bookResult.parent_author || 'Unknown')
                    : (bookResult.author || 'Unknown');
                const kindLabel = isSubbook
                    ? (bookResult.subbook_kind === 'highlight' ? 'Highlight in ' : 'Footnote in ')
                    : '';

                html += `
                    <li class="search-result-book${isSubbook ? ' search-result-subbook' : ''}">
                        <div class="search-result-book-header">
                            <a href="/${encodeURIComponent(bookResult.book)}" class="search-result-book-title">
                                ${kindLabel ? `<span class="search-result-subbook-label">${kindLabel}</span>` : ''}${escapeHtml(displayTitle)}
                            </a>
                            <span class="search-result-book-author">${escapeHtml(displayAuthor)}</span>
                        </div>
                        <ul class="search-result-matches">
                `;

                bookResult.matches.slice(0, 3).forEach((match: any) => {
                    const nodeAnchor = match.startLine ? `#${match.startLine}` : '';
                    html += `
                        <li class="search-result-match">
                            <a href="/${encodeURIComponent(bookResult.book)}${nodeAnchor}"
                               class="search-result-match-link"
                               data-highlight-query="${escapeHtml(currentSearchQuery)}">
                                <span class="search-result-snippet">${DOMPurify.sanitize(match.headline, { ALLOWED_TAGS: ['b', 'mark'] })}</span>
                            </a>
                        </li>
                    `;
                });

                if (bookResult.matches.length > 3) {
                    html += `<li class="search-result-more">+${bookResult.matches.length - 3} more matches</li>`;
                }

                html += '</ul></li>';
            });
        }

        html += '</ul>';

        resultsContainer.innerHTML = html;
        resultsContainer.classList.remove('hidden');
        resultsContainer.classList.add('visible');

        // Clicking a match stashes the query + startLine so the reader opens
        // highlighted at the match (sessionStorage-driven, not URL-driven).
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
                verbose.content(`Stored highlight query: ${query}, startLine: ${startLine}`, config.logSource);
            });
        });
    }

    function showLoading() {
        if (!resultsContainer) return;
        // Semantic gets its own copy: the query-embedding round-trip adds
        // ~100-300ms on cache miss, so set the expectation.
        const text = searchMode === 'semantic' ? 'Searching by meaning...' : 'Searching...';
        resultsContainer.innerHTML = `<div class="search-loading">${text}</div>`;
        resultsContainer.classList.remove('hidden');
        resultsContainer.classList.add('visible');
    }

    function showNoResults() {
        if (!resultsContainer) return;
        // Semantic "no results" usually means nothing cleared the similarity
        // cutoff — distinguish that from a keyword miss.
        const message = searchMode === 'semantic'
            ? 'No sufficiently similar passages found'
            : config.noResultsMessage(searchMode);
        resultsContainer.innerHTML = `<div class="search-no-results">${escapeHtml(message)}</div>`;
        resultsContainer.classList.remove('hidden');
        resultsContainer.classList.add('visible');
    }

    function showError(message: string) {
        if (!resultsContainer) return;
        resultsContainer.innerHTML = `<div class="search-error">${escapeHtml(message)}</div>`;
        resultsContainer.classList.remove('hidden');
        resultsContainer.classList.add('visible');
    }

    function hideResults() {
        if (!resultsContainer) return;
        resultsContainer.classList.remove('visible');
        resultsContainer.classList.add('hidden');
        resultsContainer.innerHTML = '';
    }

    /** Apply saved mode + query onto the DOM (init AND bfcache pageshow). */
    function restorePersistedState() {
        applyMode(readStoredMode());
        if (searchInput) {
            searchInput.value = localStorage.getItem(config.storage.queryKey(contextId)) || '';
            autosize();
        }
    }

    function init() {
        const container = document.getElementById(config.ids.container);
        searchInput = document.getElementById(config.ids.input) as HTMLTextAreaElement | null;
        fulltextToggle = document.getElementById(config.ids.fulltextToggle) as HTMLInputElement | null;
        semanticToggle = document.getElementById(config.ids.semanticToggle) as HTMLInputElement | null;
        brainButton = hasArchivist()
            ? document.getElementById(config.ids.brainButton as string) as HTMLButtonElement | null
            : null;
        askButton = hasArchivist() && config.ids.askButton
            ? document.getElementById(config.ids.askButton) as HTMLButtonElement | null
            : null;
        resultsContainer = document.getElementById(config.ids.results);

        if (!container || !searchInput || !resultsContainer) {
            verbose.init('Search elements not found, skipping initialization', config.logSource);
            return;
        }

        if (config.context) {
            contextId = container.dataset[config.context.datasetKey] || '';
            if (!contextId) {
                // e.g. journal not harvested yet — leave the box inert but
                // honest about it.
                searchInput.disabled = true;
                searchInput.placeholder = config.context.missingPlaceholder;
                if (fulltextToggle) fulltextToggle.disabled = true;
                if (semanticToggle) semanticToggle.disabled = true;
                if (brainButton) brainButton.disabled = true;
                return;
            }
        }

        restorePersistedState();

        searchInput.addEventListener('input', handleSearchInput);
        searchInput.addEventListener('keydown', handleKeyDown);
        searchInput.addEventListener('focus', handleFocus);
        if (fulltextToggle) fulltextToggle.addEventListener('change', handleFulltextToggleChange);
        if (semanticToggle) semanticToggle.addEventListener('change', handleSemanticToggleChange);
        if (brainButton) brainButton.addEventListener('click', handleBrainClick);
        if (askButton) askButton.addEventListener('click', handleAskClick);

        outsideClickHandler = (e: MouseEvent) => {
            const area = document.getElementById(config.ids.container);
            if (area && !area.contains(e.target as Node)) hideResults();
        };
        document.addEventListener('click', outsideClickHandler);

        // Safari bfcache: Back resumes the frozen page — NO init re-runs, the
        // stale results dropdown is still open, and Safari clears
        // autocomplete="off" inputs on restore (possibly AFTER pageshow, so
        // re-apply again a beat later). Empty the dropdown so a focus can't
        // resurrect stale results.
        pageshowHandler = (e: PageTransitionEvent) => {
            if (!e.persisted || !searchInput) return;
            if (resultsContainer) resultsContainer.innerHTML = '';
            hideResults();
            restorePersistedState();
            setTimeout(restorePersistedState, 150);
        };
        window.addEventListener('pageshow', pageshowHandler);

        // The archivist panel re-syncs the persisted mode after restoring an
        // answer (per-entry truth beats the global preference) — re-apply
        // without firing anything.
        modeRefreshHandler = () => applyMode(readStoredMode());
        window.addEventListener('hyperlit:refresh-search-mode', modeRefreshHandler);

        verbose.init('Search box initialized', config.logSource);
    }

    function destroy() {
        if (searchInput) {
            searchInput.removeEventListener('input', handleSearchInput);
            searchInput.removeEventListener('keydown', handleKeyDown);
            searchInput.removeEventListener('focus', handleFocus);
        }
        if (fulltextToggle) fulltextToggle.removeEventListener('change', handleFulltextToggleChange);
        if (semanticToggle) semanticToggle.removeEventListener('change', handleSemanticToggleChange);
        if (brainButton) brainButton.removeEventListener('click', handleBrainClick);
        if (askButton) askButton.removeEventListener('click', handleAskClick);
        if (outsideClickHandler) {
            document.removeEventListener('click', outsideClickHandler);
            outsideClickHandler = null;
        }
        if (pageshowHandler) {
            window.removeEventListener('pageshow', pageshowHandler);
            pageshowHandler = null;
        }
        if (modeRefreshHandler) {
            window.removeEventListener('hyperlit:refresh-search-mode', modeRefreshHandler);
            modeRefreshHandler = null;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        if (abortController) abortController.abort();

        searchInput = null;
        fulltextToggle = null;
        semanticToggle = null;
        brainButton = null;
        askButton = null;
        resultsContainer = null;
        searchMode = 'library';
        lastNonArchivistMode = 'library';
        currentSearchQuery = '';
        contextId = '';

        verbose.init('Search box destroyed', config.logSource);
    }

    return { init, destroy };
}
