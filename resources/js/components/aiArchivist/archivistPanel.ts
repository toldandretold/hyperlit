/**
 * AI Archivist hero-page ask flow — the selection-free archivist (home, /j/, /a/).
 *
 * Entered from the search box's archivist mode (search/searchBox.ts): the Ask
 * submit calls openArchivistPanel({question, shelfId}). The goo loader replaces
 * the Ask button's label the instant the ask starts (synchronous, before any
 * await), and the page docks into content mode straight away: the panel IS a
 * `.main-content` div in the feed slot with the step checklist streaming
 * inside it — which buys the feed lifecycle for free (homepageHero's
 * MutationObserver adds `.content-active`; `#copy-feed-close` and feed buttons
 * evict it). On success the checklist panel is REPLACED by the real answer
 * book rendered through the feed pathway (mountAnswerBook →
 * transitionToBookContent → loadHyperText) with the annotation stack armed —
 * the answer is highlightable/hypercitable in place; the hero blades carry
 * #hyperlit-container + #brain-hyperlight for exactly this. createPanel and
 * mountAnswerBook dispatch the same resize event feeds do so fixHeaderSpacing
 * re-pins the wrapper padding to the DOCKED header height. (The in-reader
 * brainQuery flow is untouched.)
 *
 * The answer keeps its live ↗ hypercite anchors and links to the created book
 * (a PRIVATE standalone book on the asker's "AI Archivist" shelf — see
 * AiBrainController::ask).
 *
 * Registered via ButtonRegistry (pages: ['home','journal','reader']) — /a/
 * pages run pageType 'journal'; on 'reader' only the grouped-citation chooser
 * is armed.
 */

import { isLoggedIn } from '../../utilities/auth/index';
import { isByoLlmActive } from '../../aiProviders/profiles';
import { createTopUpLink } from '../../utilities/billing/topUp';
import { navigateByStructure } from '../../SPA/navigation/navigationRegistry';
import { confirmDialog, alertDialog } from '../dialog/dialog';
import { log, verbose } from '../../utilities/logger';
import { createStepManager, brainLoaderSvg, type StepManager } from './stepManager';
import { executeInferenceTicket, readSseStream } from './sseClient';
import { initCiteGroupPopover, destroyCiteGroupPopover } from './citeGroupPopover';

const BRAIN_BUTTON_ID = 'archivist-brain-button';
const ASK_BUTTON_ID = 'archivist-ask-button';

let abortController: AbortController | null = null;
let closeClickHandler: ((e: MouseEvent) => void) | null = null;

/**
 * Create-once/reset init: stamp the brain button's guest state (hero pages —
 * no-op on reader pages where the button doesn't exist), arm the grouped-
 * citation chooser (needed wherever AI answers render, including the reader),
 * and restore the last answer for this page context so following a ↗ and
 * pressing back never loses it. Registered AFTER homepageDisplayUnit
 * (registry dependency) so a restored feed tab wins the feed slot.
 */
export function initAiArchivist(): void {
    void applyGuestState();
    initCiteGroupPopover();
    armClearOnCloseListener();
    restoreStoredAnswer();
}

export function destroyAiArchivist(): void {
    if (abortController) abortController.abort();
    abortController = null;
    if (closeClickHandler) {
        document.removeEventListener('click', closeClickHandler, true);
        closeClickHandler = null;
    }
    void teardownAnnotationStack();
    destroyCiteGroupPopover();
}

/**
 * Hero-page answer context: the shelf id on /j/ and /a/ pages, 'home' on the
 * homepage, null anywhere the archivist search box doesn't exist (reader).
 * Same source of truth the searchBox factory reads (data-shelf-id on the
 * search container).
 */
function pageContextId(): string | null {
    if (!document.querySelector('.home-content-wrapper')) return null;
    const container = document.getElementById('journal-search-container')
        || document.getElementById('homepage-search-container');
    if (!container) return null;
    return (container as HTMLElement).dataset.shelfId || 'home';
}

interface StoredAnswer {
    bookId: string;
    shelf?: { id?: string; name?: string } | null;
    question?: string;
    ctx?: string;
    ts?: number;
}

/** The archivist's occupant of the feed slot, whatever its element id. */
function findPanel(): HTMLElement | null {
    return document.querySelector('.main-content.archivist-panel');
}

// ---- per-ENTRY answer memory (history.state, NOT sessionStorage) ----
// The hero pages remember what was showing per HISTORY ENTRY, the same way
// feeds do (history.state.userPageActiveTab): back onto the entry where the
// answer was up restores the answer; back onto an entry where a feed was open
// restores the feed — a tab-global store showed the "last answer" on entries
// where the user was never viewing it. history.state survives reloads,
// bfcache and back/forward, and other writers (feeds, the container stack)
// spread-preserve unknown keys.

function storeAnswer(ctx: string, data: StoredAnswer): void {
    clearTombstone(ctx); // a fresh ask supersedes any earlier dismissal
    try {
        history.replaceState(
            { ...(history.state || {}), archivistAnswer: { ...data, ctx } },
            '',
            window.location.href,
        );
    } catch {
        // replaceState can throw in rare sandboxed contexts — persistence is
        // a convenience, not a contract
    }
}

function readStoredAnswer(ctx: string): StoredAnswer | null {
    const stored = history.state?.archivistAnswer;
    if (!stored || typeof stored.bookId !== 'string' || !stored.bookId) return null;
    if (stored.ctx !== ctx) return null; // a NAM-archive answer never shows on the homepage
    return stored;
}

function clearStoredAnswer(_ctx?: string): void {
    try {
        if (!history.state?.archivistAnswer) return;
        const { archivistAnswer, ...rest } = history.state;
        history.replaceState(rest, '', window.location.href);
    } catch { /* ignore */ }
}

// ---- dismissal tombstone (tab-scoped) ----
// clearStoredAnswer only cleans the CURRENT entry, but older entries in the
// same tab legitimately still carry the answer in their state — and "I closed
// it" means closed EVERYWHERE: without this, backing onto a pre-dismissal
// entry resurrected the answer. Dismissal records the answer's bookId;
// restore refuses a tombstoned answer on ANY entry; a fresh ask lifts it.

const DISMISSED_KEY_PREFIX = 'hyperlit:archivist:dismissed:';

function tombstoneAnswer(ctx: string, bookId: string | null | undefined): void {
    if (!bookId) return;
    try { sessionStorage.setItem(DISMISSED_KEY_PREFIX + ctx, bookId); } catch { /* ignore */ }
}

function isTombstoned(ctx: string, bookId: string): boolean {
    try { return sessionStorage.getItem(DISMISSED_KEY_PREFIX + ctx) === bookId; } catch { return false; }
}

function clearTombstone(ctx: string): void {
    try { sessionStorage.removeItem(DISMISSED_KEY_PREFIX + ctx); } catch { /* ignore */ }
}

/**
 * Dismissing the answer (× close, or opening a feed tab over it) also forgets
 * it — otherwise the next visit would resurrect a panel the user closed.
 * Create-once capture delegate, armed per init, removed on destroy.
 */
function armClearOnCloseListener(): void {
    if (closeClickHandler) return;
    closeClickHandler = (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (!target?.closest?.('#copy-feed-close, .arranger-button')) return;
        const ctx = pageContextId();
        if (!ctx) return;
        // ⚠️ Signal is the ENTRY STATE, not DOM presence: homepageHero's own
        // capture delegate registers first and its closeFeed() removes the
        // panel synchronously — by the time this handler runs, findPanel()
        // can already be null (the e2e-caught "tombstone never written" bug).
        const stored = readStoredAnswer(ctx);
        const panel = findPanel();
        if (!stored && !panel) return; // no answer in play — nothing to dismiss
        // Dismissed is dismissed on EVERY entry, not just this one.
        tombstoneAnswer(ctx, panel?.id || stored?.bookId);
        clearStoredAnswer(ctx);
        // The answer render is going away — disarm its selection toolbar so
        // feed text never grows one.
        void teardownAnnotationStack();
    };
    document.addEventListener('click', closeClickHandler, true);
}

/**
 * Re-mount the stored answer on landing (SPA-back or full-load back after
 * following a hypercite ↗). A restored FEED wins: homepageDisplayUnit inits
 * first (registry dependency) and stamps `.arranger-button.active`
 * synchronously before its content loads, so both signals are race-safe.
 *
 * The restore renders the REAL answer book through the feed pathway
 * (transitionToBookContent → loadHyperText): the `.main-content` id must be a
 * LOADABLE book id — the `book` global, the bfcache guard and
 * DifferentTemplateTransition all read it as one, and a fake id there sent
 * `loadHyperText('ai-archivist-panel')` into a 404 + blank page on back-nav.
 */
function restoreStoredAnswer(): void {
    const ctx = pageContextId();
    if (!ctx) return;
    const stored = readStoredAnswer(ctx);
    if (!stored) return;
    if (isTombstoned(ctx, stored.bookId)) {
        // The user closed this answer somewhere — never resurrect it, and
        // clean this entry's stale state while we're here.
        clearStoredAnswer(ctx);
        return;
    }
    if (document.querySelector('.main-content') || document.querySelector('.arranger-button.active')) return;

    void (async () => {
        try {
            await mountAnswerBook(stored.bookId, stored.shelf?.name);
            // This entry was showing an AI answer — put the search header back
            // into archivist mode too (the mode key is a global preference;
            // the ENTRY knows better). searchBox re-applies on the event.
            const modeKey = ctx === 'home' ? 'homepage_search_mode' : 'journal_search_mode';
            try { localStorage.setItem(modeKey, 'archivist'); } catch { /* ignore */ }
            window.dispatchEvent(new Event('hyperlit:refresh-search-mode'));
            verbose.init('aiArchivist: restored stored answer as book render', '/components/aiArchivist/archivistPanel.ts');
        } catch (e) {
            // Book gone (deleted elsewhere) or load failed — forget it and
            // leave the hero clean rather than a broken half-panel.
            log.warn('aiArchivist: stored answer restore failed — clearing', '/components/aiArchivist/archivistPanel.ts', e);
            clearStoredAnswer(ctx);
            closeAnswerPanel();
        }
    })();
}

/**
 * The one way an AI answer displays on a hero page: the REAL book rendered
 * through the feed pathway (transitionToBookContent → loadHyperText — chunks,
 * IndexedDB, mark/underline listeners), adopted with the archivist class +
 * action row, and with the annotation stack armed so the answer is
 * highlightable/hypercitable in place. Used by both the fresh-ask success
 * path and the stored-answer restore.
 */
async function mountAnswerBook(bookId: string, shelfName?: string | null): Promise<void> {
    const { transitionToBookContent } = await import('../homepage/homepageDisplayUnit');
    await transitionToBookContent(bookId, false);
    const container = document.getElementById(bookId);
    if (!container || !container.classList.contains('main-content')) {
        throw new Error('answer book render produced no container');
    }
    container.classList.add('archivist-panel');
    // Selection→book routing: the toolbar resolves the target book via
    // closest('[data-book-id]') — the `book` global is stale on hero pages
    // (transitionToBookContent deliberately skips setCurrentBook).
    container.setAttribute('data-book-id', bookId);
    container.appendChild(buildActionRow(bookId, shelfName));

    // Re-pin the header spacing after the 0.6s dock transition settles —
    // transitionToBookContent's own resize dispatch measures mid-transition,
    // which left a hero-header-sized gap above the answer until first scroll.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 700);

    await armAnnotationStack(bookId);
}

// ---- the annotation stack, scoped to a mounted answer book ----
// Hero pages deliberately never load the hyperlights/hypercites chunks
// (viewManager's reader-only gate). When an ANSWER render is up we arm them
// for that book only, and tear down when it's dismissed — so feed selections
// never grow a toolbar and the lazy chunks stay off ordinary hero visits.

let annotationStackArmed = false;

async function armAnnotationStack(bookId: string): Promise<void> {
    // The container panel is a hard blade dependency (hyperlitContainer/core.ts
    // never creates it) — without it highlight creation could not open.
    if (!document.getElementById('hyperlit-container')) return;
    try {
        const [
            { initializeHighlightManager },
            { initializeHighlightingControls },
            { initializeHypercitingControls },
            { initializeSelectionHandler },
        ] = await Promise.all([
            import('../../hyperlights/index'),
            import('../../hyperlights/selectionToolbar'),
            import('../../hypercites/index'),
            import('../selectionHandler/selectionHandler'),
        ]);
        initializeHighlightManager();
        initializeHighlightingControls(bookId);
        initializeHypercitingControls(bookId);
        initializeSelectionHandler();
        annotationStackArmed = true;
        verbose.init(`aiArchivist: annotation stack armed for ${bookId}`, '/components/aiArchivist/archivistPanel.ts');
    } catch (e) {
        log.error('aiArchivist: failed to arm the annotation stack', '/components/aiArchivist/archivistPanel.ts', e);
    }
}

async function teardownAnnotationStack(): Promise<void> {
    if (!annotationStackArmed) return;
    annotationStackArmed = false;
    try {
        const [
            { cleanupHighlightingControls },
            { cleanupHypercitingControls },
            { destroySelectionHandler },
        ] = await Promise.all([
            import('../../hyperlights/selectionToolbar'),
            import('../../hypercites/index'),
            import('../selectionHandler/selectionHandler'),
        ]);
        cleanupHighlightingControls();
        cleanupHypercitingControls();
        destroySelectionHandler();
    } catch (e) {
        verbose.init('aiArchivist: annotation stack teardown failed (non-fatal)', '/components/aiArchivist/archivistPanel.ts');
    }
}

/**
 * Dim (but keep clickable) the brain button for guests — clicking still enters
 * AI mode; submitting opens the login flow.
 */
async function applyGuestState(): Promise<void> {
    const brain = document.getElementById(BRAIN_BUTTON_ID);
    if (!brain) return;
    try {
        const loggedIn = await isLoggedIn();
        brain.classList.toggle('archivist-guest', !loggedIn);
        if (!loggedIn) brain.title = 'Log in to use the AI Archivist';
    } catch (e) {
        verbose.init('aiArchivist: guest-state check failed (non-fatal)', '/components/aiArchivist/archivistPanel.ts');
    }
}

/** Swap the Ask button's label for the goo loader while the ask is in flight. */
function setAsking(asking: boolean): void {
    const btn = document.getElementById(ASK_BUTTON_ID) as HTMLButtonElement | null;
    if (!btn) return;
    if (asking) {
        btn.innerHTML = brainLoaderSvg(false);
        btn.classList.add('asking');
        btn.disabled = true;
    } else {
        btn.textContent = 'Ask';
        btn.classList.remove('asking');
        btn.disabled = false;
    }
}

/**
 * Take over the feed slot with a fresh archivist panel (evicting any open
 * feed, exactly like transitionToBookContent does).
 */
function createPanel(): HTMLElement | null {
    const wrapper = document.querySelector('.home-content-wrapper');
    if (!wrapper) {
        log.error('aiArchivist: no .home-content-wrapper to mount the panel in', '/components/aiArchivist/archivistPanel.ts');
        return null;
    }
    document.querySelectorAll('.main-content').forEach((el) => el.remove());
    document.querySelectorAll('.arranger-button.active').forEach((el) => el.classList.remove('active'));

    const panel = document.createElement('div');
    // ⚠️ NO fake element id: `.main-content`'s id is read as a BOOK id by the
    // SPA machinery (app.ts `book` global, DifferentTemplateTransition, the
    // bfcache guard). The streaming panel stays id-less; on success it is
    // REPLACED by the real book render (mountAnswerBook), which carries the
    // real book id.
    panel.className = 'main-content active-content archivist-panel';
    wrapper.appendChild(panel);

    // Same trick transitionToBookContent uses: a resize dispatch makes
    // fixHeaderSpacing() re-pin the wrapper's padding-top to the header
    // height. Without it the padding stays sized for the TALL hero header and
    // the panel starts ~10cm down the page. Fired twice — now, and after the
    // 0.6s dock transition so the final (small) header height is measured.
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 700);

    return panel;
}

function renderAuthPrompt(panel: HTMLElement): void {
    // The .import-auth-* anchors are wired by homepageHero's capture-phase
    // delegate on both 'home' and 'journal' pages — no listeners needed here.
    panel.innerHTML = `
      <div class="archivist-answer">
        <h1>Ask the AI Archivist</h1>
        <p class="archivist-auth-message">You need to <a class="import-auth-link import-auth-login" tabindex="0">log in</a> or <a class="import-auth-link import-auth-register" tabindex="0">register</a> to use the AI Archivist.</p>
      </div>`;
}

export interface ArchivistAsk {
    question: string;
    /** public shelf scope (journal/archive pages); null = whole public corpus */
    shelfId: string | null;
}

export async function openArchivistPanel({ question, shelfId }: ArchivistAsk): Promise<void> {
    // A new ask replaces any in-flight one.
    if (abortController) abortController.abort();

    // INSTANT feedback, before any await: the goo replaces the Ask label.
    setAsking(true);

    try {
        // Auth gate: guests get the normal login flow (the user-container form,
        // same as the homepage .import-auth-* links). Guarded so an auth-init
        // failure/hang can never silently swallow the click (the original
        // "Ask does nothing" bug).
        let loggedIn = false;
        try {
            loggedIn = await Promise.race([
                isLoggedIn(),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000)),
            ]);
        } catch {
            loggedIn = false;
        }
        if (!loggedIn) {
            try {
                const { initializeUserContainer }: any = await import('../userButton/userButton');
                const mgr = initializeUserContainer();
                if (mgr) {
                    mgr.showLoginForm();
                    return;
                }
            } catch (e) {
                log.error('aiArchivist: failed to open the login form', '/components/aiArchivist/archivistPanel.ts', e);
            }
            // Fallback: the in-panel prompt (wired by homepageHero's delegate)
            const fallbackPanel = createPanel();
            if (fallbackPanel) renderAuthPrompt(fallbackPanel);
            return;
        }

        // Dock into content mode straight away: the panel takes the feed slot
        // and the checklist streams inside it (as feeds do).
        const panel = createPanel();
        if (!panel) return;
        panel.innerHTML = `
          <div class="archivist-answer">
            <div class="brain-status" style="display:none;"><div class="brain-steps"></div></div>
          </div>`;
        const steps: StepManager = createStepManager(
            panel.querySelector('.brain-status') as HTMLElement,
            panel.querySelector('.brain-steps') as HTMLElement,
            { blob: false }, // the goo already spins in the Ask button
        );
        steps.enqueueStep('Sending your question');

        const csrfToken = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
        if (!csrfToken) {
            steps.setError('Error: No CSRF token found');
            return;
        }

        const showBillingError = (msg: string) => {
            const step = steps.setError(msg);
            step.appendChild(createTopUpLink({
                style: 'display:inline-block;margin-left:8px;padding:4px 12px;background:#00afaf;color:#fff;border-radius:4px;text-decoration:none;font-size:12px;font-weight:500;',
            }));
        };

        const byoActive = await isByoLlmActive();
        abortController = new AbortController();
        const signal = abortController.signal;

        const response = await fetch('/api/ai-brain/ask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-TOKEN': csrfToken,
                'Accept': 'text/event-stream',
            },
            credentials: 'same-origin',
            signal,
            body: JSON.stringify({
                question,
                shelfId,
                model: 'accounts/fireworks/models/deepseek-v4-pro-0813',
                client_inference: byoActive,
            }),
        });

        // The panel can be evicted mid-stream (× close, a feed button) — abort
        // the request instead of streaming into a detached node. The book still
        // lands in the user's library server-side.
        const alive = () => {
            if (panel.isConnected) return true;
            if (abortController) abortController.abort();
            return false;
        };

        // Pre-stream errors (auth, billing, validation, foreign shelf) are JSON
        if (!response.ok) {
            let data: any;
            try { data = await response.json(); } catch { data = {}; }
            const msg = data.message || 'AI query failed';
            if (response.status === 401) {
                renderAuthPrompt(panel);
            } else if (response.status === 402) {
                showBillingError(msg);
            } else if (response.status === 504) {
                steps.setError('The AI took too long. Please try again.');
            } else {
                steps.setError(msg);
            }
            return;
        }

        let data: any = null;
        let streamError: string | null = null;
        await readSseStream(response.body as ReadableStream<Uint8Array>, {
            onStatus: (msg) => { if (alive()) steps.enqueueStep(msg); },
            onInferenceRequest: (parsed) => { void executeInferenceTicket(parsed, csrfToken); },
            onError: (msg) => { streamError = msg; },
            onResult: (d) => { data = d; },
        });

        if (!alive()) return;

        if (streamError) {
            steps.setError(streamError);
            return;
        }
        if (!data || !data.success) {
            steps.setError((data && data.message) || 'AI query failed');
            return;
        }

        steps.flushStepsNow();
        // Persist for this page context so back-navigation (or a reload) after
        // following a ↗ restores the answer (as a real book render) instead of
        // losing it.
        const ctx = pageContextId();
        if (ctx && data.bookId) {
            storeAnswer(ctx, {
                bookId: data.bookId,
                shelf: data.shelf ?? null,
                question,
                ts: Date.now(),
            });
        }
        // Swap the checklist panel for the REAL book render (the transition
        // evicts it) — highlightable in place, and the container carries the
        // real book id, which the SPA machinery reads off `.main-content`.
        if (data.bookId) {
            try {
                await mountAnswerBook(data.bookId, data.shelf?.name);
            } catch (e) {
                log.error('aiArchivist: answer book mount failed', '/components/aiArchivist/archivistPanel.ts', e);
                const p = findPanel();
                if (p && p.isConnected) {
                    steps.setError('Answer saved — open it from your AI Archivist shelf.');
                }
            }
        } else {
            steps.setError('AI query failed');
        }
    } catch (error) {
        if ((error as any)?.name === 'AbortError') return;
        log.error('aiArchivist: ask request failed', '/components/aiArchivist/archivistPanel.ts', error);
        const errPanel = findPanel();
        const statusEl = errPanel?.querySelector('.brain-status') as HTMLElement | null;
        const stepsEl = errPanel?.querySelector('.brain-steps') as HTMLElement | null;
        if (statusEl && stepsEl) {
            createStepManager(statusEl, stepsEl, { blob: false })
                .setError('Network error. If your question went through, the answer will appear on your AI Archivist shelf.');
        }
    } finally {
        setAsking(false);
        abortController = null;
    }
}

/**
 * The answer's footer actions — shared by the fresh-ask render and the
 * stored-answer restore (which appends it under a real book render).
 */
function buildActionRow(bookId: string, shelfName?: string | null): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'archivist-action-row';

    const note = document.createElement('span');
    note.className = 'archivist-saved-note';
    note.textContent = `Saved to your “${String(shelfName || 'AI Archivist')}” shelf`;

    // Open the answer book in the FULL reader (highlight, hypercite,
    // brain-on-selection, edit — the complete annotation stack lives there).
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'archivist-view-btn';
    viewBtn.innerHTML = 'View full hypertext <span class="open-icon">↗</span>';
    viewBtn.addEventListener('click', async () => {
        try {
            await navigateByStructure({
                toBook: bookId,
                targetUrl: `/${bookId}`,
                targetStructure: 'reader',
                hash: '',
            });
        } catch (e) {
            log.error('aiArchivist: SPA nav to answer book failed — falling back to reload', '/components/aiArchivist/archivistPanel.ts', e);
            window.location.href = `/${encodeURIComponent(bookId)}`;
        }
    });

    // Discard: deletes the book server-side (BookDeletionService delinks
    // the minted hypercites in the source books), clears the stored
    // answer, and returns to the hero — a clean slate.
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'archivist-delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', async () => {
        const ok = await confirmDialog({
            message: 'Delete this answer? The book and its hypercite links to the sources will be removed.',
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!ok) return;
        const csrfToken = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || '';
        try {
            const resp = await fetch(`/api/books/${encodeURIComponent(bookId)}`, {
                method: 'DELETE',
                headers: { 'X-CSRF-TOKEN': csrfToken, 'Accept': 'application/json' },
                credentials: 'same-origin',
            });
            if (!resp.ok) throw new Error(`Delete failed: ${resp.status}`);
            const ctx = pageContextId();
            if (ctx) {
                tombstoneAnswer(ctx, bookId); // no entry may resurrect a deleted book
                clearStoredAnswer(ctx);
            }
            closeAnswerPanel();
        } catch (e) {
            log.error('aiArchivist: delete answer failed', '/components/aiArchivist/archivistPanel.ts', e);
            await alertDialog({ message: 'Could not delete the answer. Please try again.' });
        }
    });

    footer.append(note, viewBtn, deleteBtn);
    return footer;
}

/** Return to the hero state through the real close path when available. */
function closeAnswerPanel(): void {
    void teardownAnnotationStack();
    // `!= null` (loose): offsetParent is null when the × is display:none AND
    // undefined in environments without layout (jsdom) — both mean "don't
    // trust the × path".
    const close = document.getElementById('copy-feed-close') as HTMLElement | null;
    if (close && close.offsetParent != null) {
        close.click(); // homepageHero's closeFeed — removes .main-content + content-active
        return;
    }
    findPanel()?.remove();
    document.getElementById('app-container')?.classList.remove('content-active', 'scrolled');
}
