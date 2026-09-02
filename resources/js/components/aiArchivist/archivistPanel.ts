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
 * evict it). createPanel dispatches the same resize event feeds do so
 * fixHeaderSpacing re-pins the wrapper padding to the DOCKED header height —
 * without it the checklist starts a hero-header's-worth of empty space down
 * the page. (The in-reader brainQuery flow is untouched.)
 *
 * The answer keeps its live ↗ hypercite anchors and links to the created book
 * (a PRIVATE standalone book on the asker's "AI Archivist" shelf — see
 * AiBrainController::ask).
 *
 * Registered via ButtonRegistry (pages: ['home','journal','reader']) — /a/
 * pages run pageType 'journal'; on 'reader' only the grouped-citation chooser
 * is armed.
 */

import DOMPurify from 'dompurify';
import { isLoggedIn } from '../../utilities/auth/index';
import { isByoLlmActive } from '../../aiProviders/profiles';
import { createTopUpLink } from '../../utilities/billing/topUp';
import { log, verbose } from '../../utilities/logger';
import { createStepManager, brainLoaderSvg, type StepManager } from './stepManager';
import { executeInferenceTicket, readSseStream } from './sseClient';
import { initCiteGroupPopover, destroyCiteGroupPopover } from './citeGroupPopover';

const BRAIN_BUTTON_ID = 'archivist-brain-button';
const ASK_BUTTON_ID = 'archivist-ask-button';
const PANEL_ID = 'ai-archivist-panel';
let abortController: AbortController | null = null;

/**
 * Create-once/reset init: stamp the brain button's guest state (hero pages —
 * no-op on reader pages where the button doesn't exist) and arm the grouped-
 * citation chooser (needed wherever AI answers render, including the reader).
 */
export function initAiArchivist(): void {
    void applyGuestState();
    initCiteGroupPopover();
}

export function destroyAiArchivist(): void {
    if (abortController) abortController.abort();
    abortController = null;
    destroyCiteGroupPopover();
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

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
    panel.id = PANEL_ID;
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
            <div class="archivist-result"></div>
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
        renderAnswer(panel.querySelector('.archivist-result') as HTMLElement, data);
    } catch (error) {
        if ((error as any)?.name === 'AbortError') return;
        log.error('aiArchivist: ask request failed', '/components/aiArchivist/archivistPanel.ts', error);
        const errPanel = document.getElementById(PANEL_ID);
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
 * Render the finished answer into the feed-slot panel: the nodes' HTML (the ↗
 * hypercite anchors are plain `/{sourceBook}#hypercite_x` links — native
 * navigation triggers the reader's pinned deep-link mechanism; grouped anchors
 * carry data-cite-group for the chooser) + a link to the created book.
 */
function renderAnswer(resultEl: HTMLElement, data: any): void {
    const nodes: any[] = Array.isArray(data.nodes) ? data.nodes : [];
    const html = nodes.map((n) => n?.content || '').join('');

    const answer = document.createElement('div');
    answer.className = 'archivist-answer-body';
    answer.innerHTML = DOMPurify.sanitize(html);

    // Repair legacy-shaped arrows: content minted before the flat-anchor fix
    // stores <a><sup class="open-icon">&amp;nearr;</sup></a> (HtmlBlockSplitter's
    // libxml round-trip escaped the entity), which renders as literal
    // "&nearr;" text. Same repair the reader applies at render — keep in sync
    // with normalizeHyperciteElements in lazyLoader/chunkRender.ts (not
    // imported: that would pull the whole reader render chunk into hero pages).
    answer.querySelectorAll('a[href*="#hypercite_"] > sup.open-icon').forEach((sup) => {
        const anchor = sup.parentElement as HTMLAnchorElement;
        anchor.classList.add('open-icon');
        anchor.textContent = '↗';
    });

    const footer = document.createElement('p');
    footer.className = 'archivist-open-link';
    const bookId = String(data.bookId || '');
    const shelfName = escapeHtml(String(data.shelf?.name || 'AI Archivist'));
    footer.innerHTML = bookId
        ? `Saved to your &ldquo;${shelfName}&rdquo; shelf · <a href="/${encodeURIComponent(bookId)}">Open in your library <span class="open-icon">↗</span></a>`
        : '';

    resultEl.replaceChildren(answer, footer);
}
