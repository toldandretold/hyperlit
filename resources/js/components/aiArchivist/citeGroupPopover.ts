/**
 * Grouped-citation chooser: an AI answer that cites several passages in one
 * breath renders ONE ↗ anchor carrying a `data-cite-group` JSON payload
 * (minted by AiBrainController::processCitationsInResponse — [{t: targetHref,
 * s: source label, q: quote}, …]). Clicking it opens this floating chooser
 * listing each cited passage; picking a row navigates to that passage (the
 * hash then rides the normal pinned deep-link mechanism in the reader).
 *
 * ONE document-level capture listener (create-once) covers every surface the
 * anchors appear in — the hero-page archivist panel, a standalone answer book
 * in the reader, and AI sub-book answers inside the hyperlit container
 * (capture + stopPropagation beats the container's own anchor listeners).
 * Styles live in resources/css/components/brainMode.css (loaded on reader,
 * home, journal and user pages alike).
 */

import { log } from '../../utilities/logger';

interface CiteGroupMember {
    t: string; // target href, "/book#hypercite_x"
    s: string; // source label, "Title — Author"
    q: string; // quote snippet
}

let popoverEl: HTMLElement | null = null;
let openForAnchor: HTMLElement | null = null;
let clickHandler: ((e: MouseEvent) => void) | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let scrollHandler: (() => void) | null = null;

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function closePopover(): void {
    if (popoverEl) popoverEl.remove();
    popoverEl = null;
    openForAnchor = null;
}

function parseMembers(anchor: HTMLElement): CiteGroupMember[] {
    try {
        const raw = anchor.getAttribute('data-cite-group') || '[]';
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((m): m is CiteGroupMember =>
            !!m && typeof m.t === 'string' && m.t.startsWith('/'));
    } catch (e) {
        log.warn('citeGroupPopover: unparseable data-cite-group payload', '/components/aiArchivist/citeGroupPopover.ts', e);
        return [];
    }
}

function openPopover(anchor: HTMLElement): void {
    closePopover();

    const members = parseMembers(anchor);
    if (members.length === 0) return;

    const pop = document.createElement('div');
    pop.className = 'cite-group-popover';
    pop.innerHTML = members.map((m) => `
        <a class="cite-group-row" href="${escapeHtml(m.t)}">
            <span class="cite-group-quote">&ldquo;${escapeHtml(m.q || '')}&rdquo;</span>
            <span class="cite-group-source">${escapeHtml(m.s || 'Untitled')} <span class="open-icon">↗</span></span>
        </a>`).join('');

    document.body.appendChild(pop);

    // Seat under the arrow, clamped to the viewport; position:fixed so it works
    // inside scrolled containers too.
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    pop.style.width = `${width}px`;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    pop.style.left = `${left}px`;
    const below = rect.bottom + 8;
    if (below + pop.offsetHeight > window.innerHeight - 12) {
        pop.style.top = `${Math.max(12, rect.top - pop.offsetHeight - 8)}px`;
    } else {
        pop.style.top = `${below}px`;
    }

    popoverEl = pop;
    openForAnchor = anchor;
}

export function initCiteGroupPopover(): void {
    if (clickHandler) return; // create-once; document delegate survives SPA nav

    clickHandler = (e: MouseEvent) => {
        const target = e.target as Element | null;
        const anchor = target?.closest?.('a[data-cite-group]') as HTMLElement | null;

        if (anchor) {
            // Beat the container's own anchor listeners and native navigation.
            e.preventDefault();
            e.stopPropagation();
            if (openForAnchor === anchor) {
                closePopover(); // second click on the same arrow toggles
            } else {
                openPopover(anchor);
            }
            return;
        }

        // Row clicks navigate natively; any other click closes.
        if (popoverEl && !popoverEl.contains(target as Node)) {
            closePopover();
        }
    };
    document.addEventListener('click', clickHandler, true);

    keyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && popoverEl) closePopover();
    };
    document.addEventListener('keydown', keyHandler);

    // Anchors move under scroll (the popover is fixed) — close rather than track.
    scrollHandler = () => { if (popoverEl) closePopover(); };
    document.addEventListener('scroll', scrollHandler, true);
}

export function destroyCiteGroupPopover(): void {
    closePopover();
    if (clickHandler) {
        document.removeEventListener('click', clickHandler, true);
        clickHandler = null;
    }
    if (keyHandler) {
        document.removeEventListener('keydown', keyHandler);
        keyHandler = null;
    }
    if (scrollHandler) {
        document.removeEventListener('scroll', scrollHandler, true);
        scrollHandler = null;
    }
}
