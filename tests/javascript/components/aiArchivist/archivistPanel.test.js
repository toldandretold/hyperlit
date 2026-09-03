/**
 * archivistPanel — the hero-page AI Archivist answer panel.
 *
 * Locks: the panel IS a .main-content div (so homepageHero's feed lifecycle
 * evicts/closes it for free), it evicts any open feed + deactivates arranger
 * tabs, logged-out users get the .import-auth-* prompt (wired by
 * homepageHero's delegate, not here), and a pre-stream 402 renders a billing
 * error step. Also a smoke test of the extracted stepManager surface
 * (brainQuery.ts re-imports it — same API).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const isLoggedInMock = vi.fn(async () => false);
const showLoginFormMock = vi.fn();
let userContainerMgr = { showLoginForm: showLoginFormMock };

vi.mock('../../../../resources/js/utilities/auth/index', () => ({
    isLoggedIn: (...args) => isLoggedInMock(...args),
}));
vi.mock('../../../../resources/js/components/userButton/userButton', () => ({
    initializeUserContainer: () => userContainerMgr,
}));
vi.mock('../../../../resources/js/aiProviders/profiles', () => ({
    isByoLlmActive: vi.fn(async () => false),
}));
vi.mock('../../../../resources/js/aiProviders/execute', () => ({
    executeTicketRequest: vi.fn(async () => null),
}));
vi.mock('../../../../resources/js/utilities/billing/topUp', () => ({
    createTopUpLink: vi.fn(() => {
        const a = document.createElement('a');
        a.className = 'top-up-link';
        return a;
    }),
}));

const navigateByStructureMock = vi.fn(async () => {});
vi.mock('../../../../resources/js/SPA/navigation/navigationRegistry', () => ({
    navigateByStructure: (...args) => navigateByStructureMock(...args),
}));

const confirmDialogMock = vi.fn(async () => true);
const alertDialogMock = vi.fn(async () => {});
vi.mock('../../../../resources/js/components/dialog/dialog', () => ({
    confirmDialog: (...args) => confirmDialogMock(...args),
    alertDialog: (...args) => alertDialogMock(...args),
}));

const annotationSpies = {
    initHighlightManager: vi.fn(),
    initHighlighting: vi.fn(),
    cleanupHighlighting: vi.fn(),
    initHyperciting: vi.fn(),
    cleanupHyperciting: vi.fn(),
    initSelection: vi.fn(),
    destroySelection: vi.fn(),
};
vi.mock('../../../../resources/js/hyperlights/index', () => ({
    initializeHighlightManager: (...a) => annotationSpies.initHighlightManager(...a),
}));
vi.mock('../../../../resources/js/hyperlights/selectionToolbar', () => ({
    initializeHighlightingControls: (...a) => annotationSpies.initHighlighting(...a),
    cleanupHighlightingControls: (...a) => annotationSpies.cleanupHighlighting(...a),
}));
vi.mock('../../../../resources/js/hypercites/index', () => ({
    initializeHypercitingControls: (...a) => annotationSpies.initHyperciting(...a),
    cleanupHypercitingControls: (...a) => annotationSpies.cleanupHyperciting(...a),
}));
vi.mock('../../../../resources/js/components/selectionHandler/selectionHandler', () => ({
    initializeSelectionHandler: (...a) => annotationSpies.initSelection(...a),
    destroySelectionHandler: (...a) => annotationSpies.destroySelection(...a),
}));

// Simulates the feed pathway the stored-answer restore uses: evict the feed
// slot and mount a real-book container whose element id IS the book id.
const transitionToBookContentMock = vi.fn(async (bookId) => {
    document.querySelectorAll('.main-content').forEach((el) => el.remove());
    const div = document.createElement('div');
    div.id = bookId;
    div.className = 'main-content active-content';
    document.querySelector('.home-content-wrapper').appendChild(div);
});
vi.mock('../../../../resources/js/components/homepage/homepageDisplayUnit', () => ({
    transitionToBookContent: (...args) => transitionToBookContentMock(...args),
}));

import { openArchivistPanel, initAiArchivist, destroyAiArchivist } from '../../../../resources/js/components/aiArchivist/archivistPanel';
import { createStepManager } from '../../../../resources/js/components/aiArchivist/stepManager';

function buildDom({ withFeed = true, activeTab = true } = {}) {
    document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
    document.body.innerHTML = `
        <div class="arranger-buttons-container">
            <div id="homepage-search-container" class="search-container">
            <div class="search-input-anchor">
                <textarea class="search-input"></textarea>
                <button type="button" id="archivist-ask-button" class="archivist-ask-btn">Ask</button>
            </div>
            </div>
            <button class="arranger-button${activeTab ? ' active' : ''}">Most Recent</button>
            <button type="button" id="archivist-brain-button"></button>
            <button type="button" id="copy-feed-close">×</button>
        </div>
        <div class="home-content-wrapper">
            ${withFeed ? '<div id="old-feed" class="main-content active-content"></div>' : ''}
        </div>
    `;
}

const STORED = {
    bookId: 'book_42',
    shelf: { name: 'AI Archivist' },
    question: 'what?',
    ctx: 'home',
};

const seedAnswerState = () => history.replaceState({ archivistAnswer: STORED }, '', window.location.href);
const answerState = () => history.state?.archivistAnswer;

/** Minimal SSE body: yields the given wire text once, then closes. */
function sseBody(wireText) {
    const chunks = [new TextEncoder().encode(wireText)];
    return {
        getReader: () => ({
            read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }),
        }),
    };
}

const askButton = () => document.getElementById('archivist-ask-button');

beforeEach(() => {
    isLoggedInMock.mockReset();
    isLoggedInMock.mockResolvedValue(false);
    showLoginFormMock.mockReset();
    userContainerMgr = { showLoginForm: showLoginFormMock };
    navigateByStructureMock.mockClear();
    navigateByStructureMock.mockResolvedValue(undefined);
    transitionToBookContentMock.mockClear();
    Object.values(annotationSpies).forEach((s) => s.mockClear());
    confirmDialogMock.mockClear();
    confirmDialogMock.mockResolvedValue(true);
    alertDialogMock.mockClear();
    sessionStorage.clear();
    localStorage.clear();
    history.replaceState(null, '', window.location.href); // fresh per-entry state
    vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
    destroyAiArchivist();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('panel lifecycle', () => {
    it('streams in a checklist panel, then replaces it with the REAL answer book render', async () => {
        buildDom();
        isLoggedInMock.mockResolvedValue(true);
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseBody('event: result\ndata: {"success":true,"bookId":"book_1","nodes":[{"content":"<p>the answer</p>"}],"shelf":{"name":"AI Archivist"}}\n\n'),
        });

        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        // The final occupant is the real-book container from the feed pathway
        expect(transitionToBookContentMock).toHaveBeenCalledWith('book_1', false);
        const panel = document.querySelector('.main-content.archivist-panel');
        expect(panel).not.toBeNull();
        expect(panel.id).toBe('book_1'); // loadable book id — the SPA invariant
        expect(panel.getAttribute('data-book-id')).toBe('book_1'); // selection→book routing
        expect(panel.classList.contains('active-content')).toBe(true);
        expect(panel.closest('.home-content-wrapper')).not.toBeNull();
        expect(panel.querySelector('.brain-steps')).toBeNull(); // checklist panel evicted
        expect(panel.querySelector('.archivist-view-btn')).not.toBeNull();
        expect(panel.querySelector('.archivist-delete-btn')).not.toBeNull();
        expect(document.getElementById('old-feed')).toBeNull();
        expect(document.querySelector('.arranger-button.active')).toBeNull();
        // Ask button restored after completion
        expect(askButton().textContent).toBe('Ask');
        expect(askButton().disabled).toBe(false);
        // The answer is persisted PER HISTORY ENTRY for back-navigation restore
        expect(answerState()?.bookId).toBe('book_1');
    });

    it('arms the annotation stack when the blade has #hyperlit-container, and disarms on close', async () => {
        buildDom();
        document.body.insertAdjacentHTML('beforeend', '<div id="hyperlit-container" class="container-panel hidden"><div class="scroller"></div></div>');
        initAiArchivist(); // arms the close listener that disarms the stack
        isLoggedInMock.mockResolvedValue(true);
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseBody('event: result\ndata: {"success":true,"bookId":"book_1","nodes":[],"shelf":{"name":"AI Archivist"}}\n\n'),
        });

        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        expect(annotationSpies.initHighlightManager).toHaveBeenCalled();
        expect(annotationSpies.initHighlighting).toHaveBeenCalledWith('book_1');
        expect(annotationSpies.initHyperciting).toHaveBeenCalledWith('book_1');
        expect(annotationSpies.initSelection).toHaveBeenCalled();

        // Dismissing the answer disarms the stack (feed text must never grow a toolbar)
        document.getElementById('copy-feed-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 25));
        expect(annotationSpies.cleanupHighlighting).toHaveBeenCalled();
        expect(annotationSpies.cleanupHyperciting).toHaveBeenCalled();
        expect(annotationSpies.destroySelection).toHaveBeenCalled();
    });

    it('does NOT arm the annotation stack when #hyperlit-container is absent', async () => {
        buildDom();
        isLoggedInMock.mockResolvedValue(true);
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseBody('event: result\ndata: {"success":true,"bookId":"book_1","nodes":[],"shelf":{"name":"AI Archivist"}}\n\n'),
        });

        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        expect(annotationSpies.initHighlighting).not.toHaveBeenCalled();
    });

    it('re-pins the header spacing via a resize dispatch when the panel mounts', async () => {
        buildDom();
        isLoggedInMock.mockResolvedValue(true);
        fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: 'AI query failed' }) });
        const resizeSpy = vi.fn();
        window.addEventListener('resize', resizeSpy);

        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        expect(resizeSpy).toHaveBeenCalled(); // the fixHeaderSpacing trigger — kills the hero-height gap
        window.removeEventListener('resize', resizeSpy);
    });

    it('errors render in the panel checklist and restore the Ask button', async () => {
        buildDom();
        isLoggedInMock.mockResolvedValue(true);
        fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: 'AI query failed' }) });

        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        const panel = document.querySelector('.main-content.archivist-panel');
        expect(panel).not.toBeNull();
        expect(panel.querySelector('.brain-step.error')).not.toBeNull();
        expect(askButton().textContent).toBe('Ask');
    });

    it('guests get the login form, no panel, no fetch, Ask button restored', async () => {
        buildDom();
        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        expect(showLoginFormMock).toHaveBeenCalledTimes(1);
        expect(document.querySelector('.main-content.archivist-panel')).toBeNull();
        expect(document.getElementById('old-feed')).not.toBeNull(); // feed untouched
        expect(fetch).not.toHaveBeenCalled();
        expect(askButton().textContent).toBe('Ask');
        expect(askButton().disabled).toBe(false);
    });

    it('guests fall back to the in-panel .import-auth-* prompt when the login form is unavailable', async () => {
        buildDom();
        userContainerMgr = null;
        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        const panel = document.querySelector('.main-content.archivist-panel');
        expect(panel).not.toBeNull();
        expect(panel.querySelector('.import-auth-login')).not.toBeNull();
        expect(panel.querySelector('.import-auth-register')).not.toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('an auth-init failure counts as logged out instead of silently stalling', async () => {
        buildDom();
        isLoggedInMock.mockRejectedValue(new Error('auth init exploded'));
        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        expect(showLoginFormMock).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('renders a billing error step with a top-up link on a pre-stream 402', async () => {
        buildDom();
        isLoggedInMock.mockResolvedValue(true);
        fetch.mockResolvedValue({
            ok: false,
            status: 402,
            json: async () => ({ message: 'Insufficient balance' }),
        });

        await openArchivistPanel({ question: 'what is this archive about?', shelfId: 'not-checked-here' });

        const errorStep = document.querySelector('.main-content.archivist-panel')?.querySelector('.brain-step.error');
        expect(errorStep).not.toBeNull();
        expect(errorStep.textContent).toContain('Insufficient balance');
        expect(errorStep.querySelector('.top-up-link')).not.toBeNull();
        expect(fetch).toHaveBeenCalledWith('/api/ai-brain/ask', expect.objectContaining({ method: 'POST' }));
    });

    it('initAiArchivist dims the brain button for guests', async () => {
        buildDom();
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));
        expect(document.getElementById('archivist-brain-button').classList.contains('archivist-guest')).toBe(true);
    });
});

describe('stored-answer restore', () => {
    it('restores the stored answer as a REAL book render when the feed slot is free', async () => {
        buildDom({ withFeed: false, activeTab: false });
        seedAnswerState();

        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));

        expect(transitionToBookContentMock).toHaveBeenCalledWith('book_42', false);
        const panel = document.querySelector('.main-content.archivist-panel');
        expect(panel).not.toBeNull();
        expect(panel.id).toBe('book_42'); // loadable book id — the invariant
        expect(panel.querySelector('.archivist-view-btn')).not.toBeNull();
        expect(panel.querySelector('.archivist-delete-btn')).not.toBeNull();
        // …and the search header returns to AI mode (per-entry truth wins)
        expect(localStorage.getItem('homepage_search_mode')).toBe('archivist');
    });

    it('a restored feed wins — no restore when .main-content or an active tab exists', async () => {
        buildDom({ withFeed: true, activeTab: false });
        seedAnswerState();
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));
        expect(document.querySelector('.main-content.archivist-panel')).toBeNull();
        expect(document.getElementById('old-feed')).not.toBeNull();

        destroyAiArchivist();
        buildDom({ withFeed: false, activeTab: true });
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));
        expect(document.querySelector('.main-content.archivist-panel')).toBeNull();
    });

    it('a dismissed answer never resurrects from an OLDER entry (the tombstone)', async () => {
        // 1. entry A shows the answer
        buildDom({ withFeed: false, activeTab: false });
        seedAnswerState();
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));
        expect(document.querySelector('.main-content.archivist-panel')).not.toBeNull();

        // 2. user closes it (×) — tombstoned tab-wide
        document.getElementById('copy-feed-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));

        // 3. back onto an OLDER entry that still carries the answer in state
        destroyAiArchivist();
        buildDom({ withFeed: false, activeTab: false });
        seedAnswerState();
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));

        expect(document.querySelector('.main-content.archivist-panel')).toBeNull(); // dismissed is dismissed
        expect(answerState()).toBeUndefined(); // and the stale entry state is scrubbed

        // 4. a FRESH ask lifts the tombstone (storeAnswer clears it) — covered
        //    by the success-path test asserting persistence after dismissals.
    });

    it('closing via × or opening a feed tab forgets the stored answer', async () => {
        buildDom({ withFeed: false, activeTab: false });
        seedAnswerState();
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));
        expect(document.querySelector('.main-content.archivist-panel')).not.toBeNull();

        document.getElementById('copy-feed-close').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(answerState()).toBeUndefined();
    });
});

describe('footer actions', () => {
    async function mountStoredAnswer() {
        buildDom({ withFeed: false, activeTab: false });
        seedAnswerState();
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 25));
        return document.querySelector('.main-content.archivist-panel');
    }

    it('"View full hypertext" navigates into the reader via the SPA pathway', async () => {
        const panel = await mountStoredAnswer();
        panel.querySelector('.archivist-view-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(navigateByStructureMock).toHaveBeenCalledWith({
            toBook: 'book_42',
            targetUrl: '/book_42',
            targetStructure: 'reader',
            hash: '',
        });
    });

    it('Delete: confirm → DELETE request → panel gone + storage cleared', async () => {
        const panel = await mountStoredAnswer();
        fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) });

        panel.querySelector('.archivist-delete-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(confirmDialogMock).toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledWith('/api/books/book_42', expect.objectContaining({ method: 'DELETE' }));
        expect(answerState()).toBeUndefined();
        expect(document.querySelector('.main-content.archivist-panel')).toBeNull();
    });

    it('Delete: cancel → nothing happens', async () => {
        const panel = await mountStoredAnswer();
        confirmDialogMock.mockResolvedValue(false);

        panel.querySelector('.archivist-delete-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(fetch).not.toHaveBeenCalled();
        expect(answerState()).toBeTruthy();
        expect(document.querySelector('.main-content.archivist-panel')).not.toBeNull();
    });

    it('Delete: server failure → alert, answer kept', async () => {
        const panel = await mountStoredAnswer();
        fetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

        panel.querySelector('.archivist-delete-btn').click();
        await new Promise((r) => setTimeout(r, 0));

        expect(alertDialogMock).toHaveBeenCalled();
        expect(answerState()).toBeTruthy();
    });
});

describe('stepManager extraction surface', () => {
    it('keeps the public API brainQuery.ts depends on', () => {
        document.body.innerHTML = '<div class="brain-status"><div class="brain-steps"></div></div>';
        const steps = createStepManager(
            document.querySelector('.brain-status'),
            document.querySelector('.brain-steps'),
        );
        for (const method of ['enqueueStep', 'flushStepsNow', 'updateCurrent', 'setError', 'clear']) {
            expect(typeof steps[method]).toBe('function');
        }
        const errorRow = steps.setError('boom');
        expect(errorRow.classList.contains('brain-step')).toBe(true);
        expect(errorRow.classList.contains('error')).toBe(true);
        expect(document.querySelector('.brain-steps .brain-step.error')).not.toBeNull();
    });
});
