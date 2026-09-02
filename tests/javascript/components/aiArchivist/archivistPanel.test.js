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

import { openArchivistPanel, initAiArchivist } from '../../../../resources/js/components/aiArchivist/archivistPanel';
import { createStepManager } from '../../../../resources/js/components/aiArchivist/stepManager';

function buildDom() {
    document.head.innerHTML = '<meta name="csrf-token" content="test-token">';
    document.body.innerHTML = `
        <div class="arranger-buttons-container">
            <div class="search-input-anchor">
                <textarea class="search-input"></textarea>
                <button type="button" id="archivist-ask-button" class="archivist-ask-btn">Ask</button>
            </div>
            <button class="arranger-button active">Most Recent</button>
            <button type="button" id="archivist-brain-button"></button>
        </div>
        <div class="home-content-wrapper">
            <div id="old-feed" class="main-content active-content"></div>
        </div>
    `;
}

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
    vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('panel lifecycle', () => {
    it('docks straight into a .main-content panel and renders the answer with the checklist inside it', async () => {
        buildDom();
        isLoggedInMock.mockResolvedValue(true);
        fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: sseBody('event: result\ndata: {"success":true,"bookId":"book_1","nodes":[{"content":"<p>the answer</p>"}],"shelf":{"name":"AI Archivist"}}\n\n'),
        });

        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        const panel = document.getElementById('ai-archivist-panel');
        expect(panel).not.toBeNull();
        expect(panel.classList.contains('main-content')).toBe(true);
        expect(panel.classList.contains('active-content')).toBe(true);
        expect(panel.closest('.home-content-wrapper')).not.toBeNull();
        expect(panel.querySelector('.brain-steps')).not.toBeNull(); // checklist lives in the panel
        expect(panel.textContent).toContain('the answer');
        expect(panel.textContent).toContain('Open in your library');
        expect(document.getElementById('old-feed')).toBeNull();
        expect(document.querySelector('.arranger-button.active')).toBeNull();
        // Ask button restored after completion
        expect(askButton().textContent).toBe('Ask');
        expect(askButton().disabled).toBe(false);
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

        const panel = document.getElementById('ai-archivist-panel');
        expect(panel).not.toBeNull();
        expect(panel.querySelector('.brain-step.error')).not.toBeNull();
        expect(askButton().textContent).toBe('Ask');
    });

    it('guests get the login form, no panel, no fetch, Ask button restored', async () => {
        buildDom();
        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        expect(showLoginFormMock).toHaveBeenCalledTimes(1);
        expect(document.getElementById('ai-archivist-panel')).toBeNull();
        expect(document.getElementById('old-feed')).not.toBeNull(); // feed untouched
        expect(fetch).not.toHaveBeenCalled();
        expect(askButton().textContent).toBe('Ask');
        expect(askButton().disabled).toBe(false);
    });

    it('guests fall back to the in-panel .import-auth-* prompt when the login form is unavailable', async () => {
        buildDom();
        userContainerMgr = null;
        await openArchivistPanel({ question: 'what is this archive about?', shelfId: null });

        const panel = document.getElementById('ai-archivist-panel');
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

        const errorStep = document.getElementById('ai-archivist-panel')?.querySelector('.brain-step.error');
        expect(errorStep).not.toBeNull();
        expect(errorStep.textContent).toContain('Insufficient balance');
        expect(errorStep.querySelector('.top-up-link')).not.toBeNull();
        expect(fetch).toHaveBeenCalledWith('/api/ai-brain/ask', expect.objectContaining({ method: 'POST' }));
    });

    it('initAiArchivist dims the brain button for guests', async () => {
        buildDom();
        initAiArchivist();
        await new Promise((r) => setTimeout(r, 0));
        expect(document.getElementById('archivist-brain-button').classList.contains('archivist-guest')).toBe(true);
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
