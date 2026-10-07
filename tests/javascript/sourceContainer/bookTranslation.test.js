/**
 * "Translate this book" section — the states GET /api/book-translation drives,
 * and the confirm → POST → poll flow.
 *
 * Locks: a guest is offered "Log in to translate", opening the login prompt
 * (and carrying on once they have); nothing is offered for an unavailable book;
 * the offer names the language and the estimate; an existing copy becomes a
 * link to it; starting asks first, shows progress and polls until the copy
 * exists, then OPENS it — even if the panel was closed meanwhile, but only
 * after asking if the reader has moved to another book, and never for a copy
 * that already existed; no credit / an existing copy are explained, not
 * swallowed; the root book is used from a sub-book overlay.
 *
 * Also locks the TWO-PHASE read. The price lives on its own request, because
 * estimating is the only thing the server does here that reads the whole book
 * and the section ships `hidden` — so while the estimate rode the status
 * response, nothing about Translate appeared until the slowest query in it
 * came back. The section must therefore reveal on the status reply ALONE
 * (with the no-price copy), gain its price when that lands, and never ask for
 * a price it cannot use: not for an unavailable book, not for one already
 * translated, and not while a run is live.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
  verbose: { init: vi.fn() },
}));
vi.mock('../../../resources/js/utilities/auth/csrf', () => ({
  ensureCsrfToken: vi.fn(async () => 'xsrf'),
}));
const loggedIn = { value: true };
vi.mock('../../../resources/js/utilities/auth/session', () => ({
  isLoggedIn: vi.fn(async () => loggedIn.value),
}));
const dialogs = { confirm: true, alerts: [], confirms: [], messages: [] };
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  confirmDialog: vi.fn(async (opts) => {
    dialogs.confirms.push(opts.title);
    dialogs.messages.push(opts.message);

    return dialogs.confirm;
  }),
  alertDialog: vi.fn(async (opts) => { dialogs.alerts.push(opts.message); }),
}));

const showLoginPromptMenu = vi.fn();
vi.mock('../../../resources/js/components/shelves/addToShelfMenu', () => ({ showLoginPromptMenu }));

const navigateByStructure = vi.fn(async () => {});
vi.mock('../../../resources/js/SPA/navigation/NavigationManager', () => ({
  NavigationManager: { navigateByStructure },
}));

const { vizOpen, vizClose } = vi.hoisted(() => ({ vizOpen: vi.fn(async () => {}), vizClose: vi.fn() }));
vi.mock('../../../resources/js/components/sourceContainer/translationViz', () => ({
  openTranslationVizOverlay: vizOpen,
  closeTranslationVizOverlay: vizClose,
  updateTranslationViz: vi.fn(),
}));

import { initBookTranslation, formatEstimate, stopWatching } from '../../../resources/js/components/sourceContainer/bookTranslation';

/** The status reply carries no price — the server returns these as null now. */
const OFFER = {
  success: true, available: true, target_lang: 'en', target_label: 'English',
  characters: null, estimated_cost: null, running: false, progress: null, existing: null,
};
const ESTIMATE = { success: true, characters: 728697, estimated_cost: 8.74 };

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let container;
let fetchMock;
let handle;

/**
 * Route by URL and method, NOT by call order. The price is its own request, so
 * a `mockResolvedValueOnce` chain would have the estimate swallow a reply
 * meant for a status poll — which is exactly how brittle a sequence mock is
 * once a component gains a second endpoint.
 *
 * `status` / `post` accept one reply or a list; the last entry repeats.
 */
function serve({ status, estimate = reply(200, ESTIMATE), post } = {}) {
  const statuses = Array.isArray(status) ? [...status] : [status];
  const posts = Array.isArray(post) ? [...post] : [post];
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return posts.length > 1 ? posts.shift() : posts[0];
    if (String(url).endsWith('/estimate')) return typeof estimate === 'function' ? estimate() : estimate;

    return statuses.length > 1 ? statuses.shift() : statuses[0];
  });
}

const isEstimate = ([url, init]) => init?.method !== 'POST' && String(url).endsWith('/estimate');
const statusCalls = () => fetchMock.mock.calls.filter(([url, init]) => init?.method !== 'POST' && !String(url).endsWith('/estimate'));
const estimateCalls = () => fetchMock.mock.calls.filter(isEstimate);
const postCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');

const section = () => container.querySelector('#book-translation-section');
const button = () => container.querySelector('.book-translation-btn');
const note = () => container.querySelector('.book-translation-note');
const link = () => container.querySelector('.book-translation-open');

beforeEach(() => {
  document.body.innerHTML = '<main class="main-content" id="book_1"></main>';
  navigateByStructure.mockClear();
  showLoginPromptMenu.mockClear();
  vizOpen.mockClear();
  vizClose.mockClear();
  container = document.createElement('div');
  container.innerHTML = `
    <div id="book-translation-section" hidden>
      <button type="button" class="book-translation-btn"></button>
      <a class="book-translation-open" hidden></a>
      <p class="book-translation-note"></p>
    </div>`;
  document.body.appendChild(container);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  loggedIn.value = true;
  dialogs.confirm = true;
  dialogs.alerts = [];
  dialogs.confirms = [];
  dialogs.messages = [];
});

afterEach(() => {
  handle?.destroy();
  stopWatching();
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('formatEstimate', () => {
  it('rounds to cents and never claims precision it lacks', () => {
    expect(formatEstimate(8.7412)).toBe('about $8.74');
    expect(formatEstimate(0.004)).toBe('under $0.01');
    expect(formatEstimate(null)).toBe('');
  });
});

describe('initBookTranslation', () => {
  it('offers a guest a login prompt instead of the translation', async () => {
    loggedIn.value = false;
    serve({ status: reply(200, { ...OFFER, logged_in: false }) });
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(button().textContent).toBe('Log in to translate into English'));
    expect(section().hidden).toBe(false);
    // A guest is quoted too: the price is public, and seeing it precedes
    // deciding to sign up for it.
    await vi.waitFor(() => expect(note().textContent).toContain('Kimi K3, about $8.74'));

    button().click();
    await vi.waitFor(() => expect(showLoginPromptMenu).toHaveBeenCalledWith(button(), 'Log in to translate this book into English'));
    expect(dialogs.confirms).toEqual([]);
    expect(postCalls()).toHaveLength(0); // nothing started
  });

  it('carries on to translating once the guest has logged in', async () => {
    loggedIn.value = false;
    serve({
      status: [reply(200, { ...OFFER, logged_in: false }), reply(200, { ...OFFER, logged_in: true })],
      post: reply(202, { success: true, target_lang: 'en' }),
    });
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Log in to translate into English'));

    loggedIn.value = true; // they logged in from another part of the page
    button().click();

    await vi.waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(showLoginPromptMenu).not.toHaveBeenCalled();
    expect(dialogs.confirms).toEqual(['Translate into English?']);
    expect(statusCalls()).toHaveLength(2); // the open read, then the re-read after logging in
  });

  it('stays hidden for a book that cannot be translated', async () => {
    serve({ status: reply(200, { success: true, available: false, reason: 'Only Chinese and English books can be translated for now.' }) });
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1));
    expect(section().hidden).toBe(true);
    // The whole-book read is never made for a book that can't be translated.
    await new Promise((r) => setTimeout(r, 0));
    expect(estimateCalls()).toHaveLength(0);
  });

  it('offers the translation with its language and estimate, for the root book', async () => {
    serve({ status: reply(200, OFFER) });
    handle = initBookTranslation(container, 'book_1/book_1Fn3');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    expect(statusCalls()[0][0]).toBe('/api/book-translation/book_1');
    expect(button().textContent).toBe('Translate into English');
    expect(button().disabled).toBe(false);
    await vi.waitFor(() => expect(note().textContent).toContain('Kimi K3, about $8.74'));
    // The price is asked for the ROOT book too, not the sub-book overlay's id.
    expect(estimateCalls()[0][0]).toBe('/api/book-translation/book_1/estimate');
  });

  it('reveals the section on the status reply alone, then fills in the price', async () => {
    // The whole point of splitting the endpoint: hold the price back and the
    // section must still be fully usable, just unpriced.
    let releasePrice;
    const held = new Promise((resolve) => { releasePrice = resolve; });
    serve({ status: reply(200, OFFER), estimate: () => held });
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    expect(button().textContent).toBe('Translate into English');
    expect(button().disabled).toBe(false);
    expect(note().textContent).toContain("Kimi K3, charged for what's used.");
    expect(note().textContent).not.toContain('$');

    releasePrice(reply(200, ESTIMATE));
    await vi.waitFor(() => expect(note().textContent).toContain('Kimi K3, about $8.74'));
    // Still one price request — re-rendering must not re-ask.
    expect(estimateCalls()).toHaveLength(1);
  });

  it('survives a price request that fails, offering the unpriced button', async () => {
    serve({ status: reply(200, OFFER), estimate: reply(500, { success: false }) });
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));
    await vi.waitFor(() => expect(estimateCalls()).toHaveLength(1));
    expect(note().textContent).toContain("Kimi K3, charged for what's used.");

    button().click();
    // The dialog still opens — it just can't quote. The server's reservation
    // is what actually protects the balance.
    await vi.waitFor(() => expect(dialogs.confirms).toEqual(['Translate into English?']));
    expect(dialogs.messages[0]).not.toContain('It should cost');
  });

  it('waits for the price before asking the reader to confirm a paid run', async () => {
    let releasePrice;
    const held = new Promise((resolve) => { releasePrice = resolve; });
    serve({ status: reply(200, OFFER), estimate: () => held, post: reply(202, { success: true, target_lang: 'en' }) });
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Checking cost…'));
    expect(dialogs.confirms).toEqual([]); // not asked yet — there is no quote

    releasePrice(reply(200, ESTIMATE));
    await vi.waitFor(() => expect(dialogs.confirms).toEqual(['Translate into English?']));
    expect(dialogs.messages[0]).toContain('It should cost about $8.74');
  });

  it('links to an existing translation instead of offering another', async () => {
    serve({ status: reply(200, { ...OFFER, existing: { book: 'book_99', title: '长相思 (English)' } }) });
    handle = initBookTranslation(container, 'book_1');

    // The Versions/Translations rail surfaces finished translations; the
    // Translate section disappears rather than duplicating an open-link.
    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(section().hidden).toBe(true);
    expect(link().hidden).toBe(true);
    expect(estimateCalls()).toHaveLength(0); // no price for a book already translated
  });

  it('asks first, starts the job, shows progress and polls until the copy exists', async () => {
    serve({
      status: [
        reply(200, OFFER),
        reply(200, { ...OFFER, running: true, progress: { status: 'running', phase: 'text', percent: 0.42, error: null } }),
        reply(200, { ...OFFER, existing: { book: 'book_99', title: '长相思 (English)' }, progress: { status: 'done', phase: 'notes', percent: 1, error: null } }),
      ],
      post: reply(202, { success: true, target_lang: 'en' }),
    });
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));
    await vi.waitFor(() => expect(estimateCalls()).toHaveLength(1));

    vi.useFakeTimers();
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Waiting to translate into English…'));

    const [url, init] = postCalls()[0];
    expect(url).toBe('/api/book-translation/book_1');
    expect(init.headers['X-XSRF-TOKEN']).toBe('xsrf');
    expect(button().disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(button().textContent).toBe('Translating text into English… 42%');

    await vi.advanceTimersByTimeAsync(5000);
    expect(section().hidden).toBe(true); // the rail owns the finished state
    // Still on the book it came from, so it opens by itself.
    await vi.waitFor(() => expect(navigateByStructure).toHaveBeenCalledWith(expect.objectContaining({ fromBook: 'book_1', toBook: 'book_99' })));
  });

  it('does nothing when the confirmation is declined', async () => {
    serve({ status: reply(200, OFFER) });
    dialogs.confirm = false;
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    button().click();
    await new Promise((r) => setTimeout(r, 0));

    expect(postCalls()).toHaveLength(0);
    expect(button().disabled).toBe(false);
  });

  it('explains a lack of credit and offers the button again', async () => {
    serve({ status: reply(200, OFFER), post: reply(402, { success: false, message: 'Insufficient balance' }) });
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    button().click();

    await vi.waitFor(() => expect(dialogs.alerts).toHaveLength(1));
    expect(dialogs.alerts[0]).toContain('Not enough credit');
    expect(button().disabled).toBe(false);
  });

  it('treats a "you already have one" refusal as the finished state', async () => {
    serve({
      status: reply(200, OFFER),
      post: reply(409, { success: false, existing: { book: 'book_99', title: '长相思 (English)' } }),
    });
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    button().click();

    await vi.waitFor(() => expect(section().hidden).toBe(true));
  });

  it('shows why the last run failed and lets it be retried', async () => {
    serve({
      status: reply(200, {
        ...OFFER, progress: { status: 'failed', phase: 'notes', percent: 0.9, error: '2 paragraph(s) could not be translated.' },
      }),
    });
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(button().textContent).toBe('Try again: translate into English'));
    expect(note().textContent).toContain('2 paragraph(s) could not be translated.');
    // A retry is still a paid action, so it is still quoted.
    await vi.waitFor(() => expect(note().textContent).toContain('about $8.74'));
  });
});

describe('when a translation finishes', () => {
  const RUNNING = { ...OFFER, running: true, progress: { status: 'running', phase: 'text', percent: 0.5, error: null } };
  const DONE = { ...OFFER, existing: { book: 'book_99', title: '长相思 (English)' }, progress: { status: 'done', phase: 'notes', percent: 1, error: null } };

  it('still opens the copy after the panel was closed mid-run', async () => {
    serve({ status: [reply(200, RUNNING), reply(200, DONE)] });
    vi.useFakeTimers();
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().disabled).toBe(true));

    handle.destroy(); // the reader closes the panel
    handle = null;
    await vi.advanceTimersByTimeAsync(5000);

    await vi.waitFor(() => expect(navigateByStructure).toHaveBeenCalledWith(expect.objectContaining({ toBook: 'book_99' })));
  });

  it.each([
    ['opens it when they say so', true, 1],
    ['leaves them be when they say later', false, 0],
  ])('asks, rather than pulling them away, when the reader has moved to another book — %s', async (_why, answer, opened) => {
    serve({ status: [reply(200, RUNNING), reply(200, DONE)] });
    vi.useFakeTimers();
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().disabled).toBe(true));

    document.querySelector('.main-content').id = 'book_other';
    dialogs.confirm = answer;
    await vi.advanceTimersByTimeAsync(5000);

    await vi.waitFor(() => expect(dialogs.confirms).toEqual(['Translation ready']));
    await vi.waitFor(() => expect(navigateByStructure).toHaveBeenCalledTimes(opened));
  });

  it('never opens a translation that already existed when the panel opened', async () => {
    serve({ status: reply(200, DONE) });
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(statusCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(section().hidden).toBe(true);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(20000);

    expect(navigateByStructure).not.toHaveBeenCalled();
    expect(statusCalls()).toHaveLength(1); // nothing running, nothing polled
    expect(estimateCalls()).toHaveLength(0);
  });

  it('stops watching a run that failed', async () => {
    serve({
      status: [reply(200, RUNNING), reply(200, { ...OFFER, progress: { status: 'failed', phase: 'text', percent: 0.4, error: 'It broke.' } })],
    });
    vi.useFakeTimers();
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().disabled).toBe(true));
    // A live run is never priced — that read is the expensive one.
    expect(estimateCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(button().textContent).toBe('Try again: translate into English');

    await vi.advanceTimersByTimeAsync(20000);
    expect(statusCalls()).toHaveLength(2);
    expect(navigateByStructure).not.toHaveBeenCalled();
  });
});

describe('the live-progress row', () => {
  const RUNNING = { ...OFFER, running: true, progress: { status: 'running', phase: 'text', percent: 0.5, error: null, stage: 'text' } };
  const row = () => container.querySelector('#book-translation-live');

  it('appears while a run is live and opens the overlay, fed by the run watch', async () => {
    serve({ status: reply(200, RUNNING) });
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(row()).not.toBeNull());

    row().querySelector('.book-translation-viz-toggle').click();
    expect(vizOpen).toHaveBeenCalledTimes(1);
    const [status, follow] = vizOpen.mock.calls[0];
    expect(status.running).toBe(true);
    // The follow hook subscribes to the SAME module-level watch and hands
    // back an unsubscribe — the overlay outlives this panel, not the watch.
    const listener = vi.fn();
    const unfollow = follow(listener);
    expect(typeof unfollow).toBe('function');
    unfollow();

    // No stray requests: the map fetch belongs to the overlay module (mocked),
    // and a running job is never priced.
    expect(statusCalls()).toHaveLength(1);
    expect(estimateCalls()).toHaveLength(0);
  });

  it('is removed when the run ends, and never exists for a plain offer', async () => {
    serve({
      status: [reply(200, RUNNING), reply(200, { ...OFFER, progress: { status: 'failed', phase: 'text', percent: 0.4, error: 'It broke.' } })],
    });
    vi.useFakeTimers();
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(row()).not.toBeNull());

    await vi.advanceTimersByTimeAsync(5000);
    expect(row()).toBeNull();
    expect(vizOpen).not.toHaveBeenCalled();
  });
});
