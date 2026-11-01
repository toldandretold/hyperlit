/**
 * Grouped-citation router: an AI answer (or the MCP cite_passage tool) that cites
 * several passages in one breath renders ONE ↗ anchor carrying a `data-cite-group`
 * JSON payload (minted by AiBrainController::processCitationsInResponse —
 * [{t: targetHref, s: source label, q: quote}, …]). Clicking it opens the normal
 * hyperlit container with one Reference section per member — detection.ts parses
 * the payload into a multi-member hypercite-citation descriptor and the builder
 * stacks the sections, exactly like a range citation.
 *
 * ONE document-level CAPTURE listener (create-once) covers every surface the
 * anchors appear in — the hero-page archivist panel, a standalone answer book
 * in the reader, and AI sub-book answers inside the hyperlit container. Capture
 * is load-bearing twice over: it beats the reader's bubble-phase globalLinkHandler
 * (no double-open), and on home/user/journal pages — where no lazyLoader link
 * handler exists — it is the ONLY route into the container for these anchors.
 */

import { log } from '../../utilities/logger';

let clickHandler: ((e: MouseEvent) => void) | null = null;

export function initCiteGroupRouter(): void {
    if (clickHandler) return; // create-once; document delegate survives SPA nav

    clickHandler = (e: MouseEvent) => {
        const target = e.target as Element | null;
        const anchor = target?.closest?.('a[data-cite-group]') as HTMLElement | null;
        if (!anchor) return;

        // Beat native navigation and the reader's own anchor listeners.
        e.preventDefault();
        e.stopPropagation();

        void (async () => {
            try {
                const { handleUnifiedContentClick } = await import('../../hyperlitContainer/index');
                await handleUnifiedContentClick(anchor);
            } catch (err) {
                log.error('citeGroupRouter: failed to open container for grouped citation', '/components/aiArchivist/citeGroupRouter.ts', err);
            }
        })();
    };
    document.addEventListener('click', clickHandler, true);
}

export function destroyCiteGroupRouter(): void {
    if (clickHandler) {
        document.removeEventListener('click', clickHandler, true);
        clickHandler = null;
    }
}
