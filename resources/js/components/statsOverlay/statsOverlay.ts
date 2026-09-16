/**
 * Stats overlay — creator-facing reading stats (views, likes, depth funnel)
 * as an ANY-PAGE overlay, opened from the userButton flyout's "Stats" row.
 * Sibling of the Money overlay and built on the same skeleton: body-appended
 * singleton, one root click listener that stopPropagation()s, trapModalFocus
 * (Escape closes, focus returns to the opener), ButtonRegistry registration
 * purely so SPA navigation destroys an open overlay cleanly.
 *
 * Unlike Money (server-rendered synthetic-book HTML), this fetches JSON from
 * /api/creator/stats and renders client-side: a book list with view/like
 * counts, expanding per book into a 10-bar depth chart ("% of views that
 * visited each tenth of the book") from /api/creator/stats/{book}.
 *
 * Deliberately "visited", not "reached": a decile is counted when the reader
 * was actually on screen there, and hypertext is jumped into as often as it is
 * read through — someone landing on the last section via a hypercite visited
 * the 100% mark without ever getting there sequentially. The bars are not a
 * drop-off funnel and shouldn't be captioned as one.
 */

import { log } from '../../utilities/logger';
import { trapModalFocus } from '../../utilities/modalFocusTrap';

interface CreatorBookStats {
    book: string;
    title: string | null;
    author: string | null;
    total_views: number;
    views_30d: number;
    likes: number;
    total_chunks: number | null;
}

interface DepthFunnel {
    book: string;
    total_views: number;
    total_chunks: number | null;
    max_chunk_reached: number | null;
    deciles: Array<{ decile: number; pct: number }>;
}

let overlayEl: HTMLElement | null = null;
let releaseTrap: (() => void) | null = null;

export function closeStatsOverlay(): void {
    releaseTrap?.();
    releaseTrap = null;
    overlayEl?.remove();
    overlayEl = null;
}

function esc(s: string): string {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function bookRowHtml(b: CreatorBookStats): string {
    const title = esc(b.title || b.book);
    // The row button expands the funnel; the arrow is a real ANCHOR beside it
    // (never nested — <a> inside <button> is invalid) so "go to the book" is a
    // plain navigation the browser owns.
    return `
      <div class="stats-book-line">
        <button type="button" class="stats-book-row" data-book="${esc(b.book)}" aria-expanded="false">
          <span class="stats-book-title">${title}${b.author ? `<span class="stats-book-author">${esc(b.author)}</span>` : ''}</span>
          <span class="stats-book-numbers">
            <span title="Total views (unique readers per day)">${b.total_views} views</span>
            <span title="Views in the last 30 days">${b.views_30d} this month</span>
            <span title="Likes">&#9825; ${b.likes}</span>
          </span>
        </button>
        <a class="stats-book-link" href="/${encodeURIComponent(b.book)}" aria-label="Open ${title}" title="Open book">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>
        </a>
      </div>
      <div class="stats-book-detail" data-book-detail="${esc(b.book)}" hidden></div>`;
}

function funnelHtml(f: DepthFunnel): string {
    if (!f.total_views || !f.deciles.length) {
        return '<p class="stats-panel-empty">No reading-depth data yet.</p>';
    }
    const bars = f.deciles.map(d => `
        <div class="stats-funnel-col" title="${d.pct}% of views visited the ${(d.decile + 1) * 10}% mark">
          <div class="stats-funnel-bar" style="height: ${Math.max(2, d.pct)}%"></div>
          <span class="stats-funnel-label">${(d.decile + 1) * 10}</span>
        </div>`).join('');
    return `
      <p class="stats-funnel-caption">Which parts get read — % of views that visited each tenth of the book</p>
      <div class="stats-funnel">${bars}</div>`;
}

async function loadFunnel(detailEl: HTMLElement, book: string): Promise<void> {
    detailEl.innerHTML = '<p class="stats-panel-empty">Loading&hellip;</p>';
    try {
        const resp = await fetch(`/api/creator/stats/${encodeURIComponent(book)}`, {
            headers: { Accept: 'application/json' },
            credentials: 'include',
        });
        if (!resp.ok) throw new Error(`stats detail fetch failed (${resp.status})`);
        detailEl.innerHTML = funnelHtml((await resp.json()) as DepthFunnel);
    } catch (error) {
        log.error('Stats overlay: failed to load depth funnel', '/components/statsOverlay/statsOverlay.ts', error);
        detailEl.innerHTML = '<p class="stats-panel-empty">Could not load depth data.</p>';
    }
}

/**
 * Current list query. The panel is paged, so a sort/search change is a RESET
 * (offset back to 0, rows replaced) while "Load more" is an APPEND — conflating
 * the two is how a filtered list ends up with stale rows from the old query
 * stuck underneath the new ones.
 */
const listState = { sort: 'views', q: '', offset: 0, total: 0, loading: false };

/**
 * Fetch one page. `append` distinguishes "Load more" from a fresh query; a
 * stale-response guard keeps a slow first request from overwriting the results
 * of a later one (type fast in the search box and they WILL land out of order).
 */
let listRequestSeq = 0;

async function loadBooks(panel: HTMLElement, append: boolean): Promise<void> {
    const body = panel.querySelector<HTMLElement>('.stats-panel-body');
    if (!body || listState.loading) return;
    listState.loading = true;
    const seq = ++listRequestSeq;

    if (!append) {
        listState.offset = 0;
        body.innerHTML = '<p class="stats-panel-empty">Loading&hellip;</p>';
    }

    try {
        const params = new URLSearchParams({
            sort: listState.sort,
            offset: String(listState.offset),
        });
        if (listState.q) params.set('q', listState.q);

        const resp = await fetch(`/api/creator/stats?${params}`, {
            headers: { Accept: 'application/json' },
            credentials: 'include',
        });
        if (!resp.ok) throw new Error(`creator stats fetch failed (${resp.status})`);
        const data = (await resp.json()) as {
            books?: CreatorBookStats[]; total?: number; limit?: number;
        };
        if (seq !== listRequestSeq) return; // a newer query already answered

        const books = data.books || [];
        listState.total = data.total || 0;
        listState.offset += books.length;

        const rows = books.map(bookRowHtml).join('');
        if (append) {
            body.querySelector('.stats-load-more-wrap')?.remove();
            body.insertAdjacentHTML('beforeend', rows);
        } else if (books.length) {
            body.innerHTML = rows;
        } else {
            body.innerHTML = listState.q
                ? '<p class="stats-panel-empty">No books match that search.</p>'
                : '<p class="stats-panel-empty">No books yet — stats appear once your books have readers.</p>';
        }

        // Never truncate silently: if there is more, SAY how much more. The
        // first version of this panel returned a bare LIMIT 500 with no count,
        // so a creator with thousands of books was shown 500 and told nothing.
        if (listState.offset < listState.total) {
            body.insertAdjacentHTML('beforeend', `
              <div class="stats-load-more-wrap">
                <button type="button" class="stats-load-more">Load more</button>
                <span class="stats-load-more-count">${listState.offset} of ${listState.total}</span>
              </div>`);
        } else if (listState.total > 0) {
            body.insertAdjacentHTML('beforeend',
                `<div class="stats-load-more-wrap"><span class="stats-load-more-count">${listState.total} book${listState.total === 1 ? '' : 's'}</span></div>`);
        }
    } catch (error) {
        if (seq !== listRequestSeq) return;
        log.error('Stats overlay: failed to load creator stats', '/components/statsOverlay/statsOverlay.ts', error);
        if (!append) body.innerHTML = '<p class="stats-panel-empty">Could not load your stats right now.</p>';
    } finally {
        if (seq === listRequestSeq) listState.loading = false;
    }
}

function onOverlayClick(e: Event): void {
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !overlayEl) return;

    // Backdrop click (outside the panel) closes.
    if (target === overlayEl) {
        closeStatsOverlay();
        return;
    }

    if (target.closest('.stats-panel-close')) {
        e.preventDefault();
        e.stopPropagation();
        closeStatsOverlay();
        return;
    }

    // The "open book" arrow: close the panel and let the click through — the
    // SPA's link handler (or a plain navigation) takes it from here. No
    // preventDefault/stopPropagation, unlike every other branch.
    if (target.closest('.stats-book-link')) {
        closeStatsOverlay();
        return;
    }

    if (target.closest('.stats-load-more')) {
        e.preventDefault();
        e.stopPropagation();
        const panel = overlayEl.querySelector<HTMLElement>('.stats-panel');
        if (panel) void loadBooks(panel, true);
        return;
    }

    const row = target.closest<HTMLElement>('.stats-book-row');
    if (row) {
        e.preventDefault();
        e.stopPropagation();
        const book = row.dataset.book || '';
        const detail = overlayEl.querySelector<HTMLElement>(
            `.stats-book-detail[data-book-detail="${CSS.escape(book)}"]`
        );
        if (!detail) return;
        const expanded = row.getAttribute('aria-expanded') === 'true';
        row.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        detail.hidden = expanded;
        if (!expanded && !detail.dataset.loaded) {
            detail.dataset.loaded = '1';
            void loadFunnel(detail, book);
        }
    }
}

export async function openStatsOverlay(): Promise<void> {
    if (overlayEl) return; // already open

    const overlay = document.createElement('div');
    overlay.id = 'stats-overlay';
    overlay.innerHTML = `
      <div class="stats-panel" role="dialog" aria-label="Reading stats for your books">
        <div class="stats-panel-header">
          <span class="stats-panel-title">Stats</span>
          <span class="stats-panel-actions">
            <button type="button" class="stats-panel-close" aria-label="Close">&times;</button>
          </span>
        </div>
        <div class="stats-panel-controls">
          <select class="stats-sort-select" aria-label="Sort books">
            <option value="views">Most Viewed</option>
            <option value="likes">Most Liked</option>
            <option value="recent">Recently Added</option>
            <option value="title">Title (A–Z)</option>
            <option value="author">Author (A–Z)</option>
          </select>
          <input type="search" class="stats-search-input" aria-label="Search your books by title or author" placeholder="Search title or author">
        </div>
        <div class="stats-panel-body"><p class="stats-panel-empty">Loading&hellip;</p></div>
      </div>`;
    overlay.addEventListener('click', onOverlayClick);
    document.body.appendChild(overlay);
    overlayEl = overlay;

    const panel = overlay.querySelector<HTMLElement>('.stats-panel');
    if (!panel) return;

    // Fresh open = fresh query; the module-level listState outlives the overlay.
    listState.sort = 'views';
    listState.q = '';
    listState.offset = 0;
    listState.loading = false;

    panel.querySelector<HTMLSelectElement>('.stats-sort-select')
        ?.addEventListener('change', (e) => {
            listState.sort = (e.target as HTMLSelectElement).value;
            void loadBooks(panel, false);
        });

    // Debounced: a keystroke-per-request would both hammer the endpoint and
    // guarantee out-of-order responses (the seq guard in loadBooks catches
    // those, but not sending them is better).
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    panel.querySelector<HTMLInputElement>('.stats-search-input')
        ?.addEventListener('input', (e) => {
            const value = (e.target as HTMLInputElement).value.trim();
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                listState.q = value;
                void loadBooks(panel, false);
            }, 250);
        });

    releaseTrap = trapModalFocus(panel, { onEscape: closeStatsOverlay });
    await loadBooks(panel, false);
}

/* ── ButtonRegistry lifecycle ─────────────────────────────────────────── */

export function initStatsOverlay(): void {
    // Nothing to arm — the overlay is built on demand by the userButton menu.
    // A fresh page/SPA entry must never inherit an orphaned open overlay.
    closeStatsOverlay();
}

export function destroyStatsOverlay(): void {
    closeStatsOverlay();
}
