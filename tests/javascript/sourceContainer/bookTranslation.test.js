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
const dialogs = { confirm: true, alerts: [], confirms: [] };
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  confirmDialog: vi.fn(async (opts) => { dialogs.confirms.push(opts.title); return dialogs.confirm; }),
  alertDialog: vi.fn(async (opts) => { dialogs.alerts.push(opts.message); }),
}));

const showLoginPromptMenu = vi.fn();
vi.mock('../../../resources/js/components/shelves/addToShelfMenu', () => ({ showLoginPromptMenu }));

const navigateByStructure = vi.fn(async () => {});
vi.mock('../../../resources/js/SPA/navigation/NavigationManager', () => ({
  NavigationManager: { navigateByStructure },
}));

import { initBookTranslation, formatEstimate, stopWatching } from '../../../resources/js/components/sourceContainer/bookTranslation';

const OFFER = {
  success: true, available: true, target_lang: 'en', target_label: 'English',
  characters: 728697, estimated_cost: 8.74, running: false, progress: null, existing: null,
};

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

let container;
let fetchMock;
let handle;

const section = () => container.querySelector('#book-translation-section');
const button = () => container.querySelector('.book-translation-btn');
const note = () => container.querySelector('.book-translation-note');
const link = () => container.querySelector('.book-translation-open');

beforeEach(() => {
  document.body.innerHTML = '<main class="main-content" id="book_1"></main>';
  navigateByStructure.mockClear();
  showLoginPromptMenu.mockClear();
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
    fetchMock.mockResolvedValue(reply(200, { ...OFFER, logged_in: false }));
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(button().textContent).toBe('Log in to translate into English'));
    expect(section().hidden).toBe(false);
    expect(note().textContent).toContain('Kimi K3, about $8.74');

    button().click();
    await vi.waitFor(() => expect(showLoginPromptMenu).toHaveBeenCalledWith(button(), 'Log in to translate this book into English'));
    expect(dialogs.confirms).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the status read only — nothing started
  });

  it('carries on to translating once the guest has logged in', async () => {
    loggedIn.value = false;
    fetchMock
      .mockResolvedValueOnce(reply(200, { ...OFFER, logged_in: false }))
      .mockResolvedValueOnce(reply(200, { ...OFFER, logged_in: true }))
      .mockResolvedValueOnce(reply(202, { success: true, target_lang: 'en' }));
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Log in to translate into English'));

    loggedIn.value = true; // they logged in from another part of the page
    button().click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(showLoginPromptMenu).not.toHaveBeenCalled();
    expect(dialogs.confirms).toEqual(['Translate into English?']);
    expect(fetchMock.mock.calls[2][1].method).toBe('POST');
  });

  it('stays hidden for a book that cannot be translated', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, available: false, reason: 'Only Chinese and English books can be translated for now.' }));
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(section().hidden).toBe(true);
  });

  it('offers the translation with its language and estimate, for the root book', async () => {
    fetchMock.mockResolvedValue(reply(200, OFFER));
    handle = initBookTranslation(container, 'book_1/book_1Fn3');

    await vi.waitFor(() => expect(section().hidden).toBe(false));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/book-translation/book_1');
    expect(button().textContent).toBe('Translate into English');
    expect(button().disabled).toBe(false);
    expect(note().textContent).toContain('Kimi K3, about $8.74');
  });

  it('links to an existing translation instead of offering another', async () => {
    fetchMock.mockResolvedValue(reply(200, { ...OFFER, existing: { book: 'book_99', title: '长相思 (English)' } }));
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(link().hidden).toBe(false));
    expect(link().getAttribute('href')).toBe('/book_99');
    expect(link().textContent).toBe('Open the English translation');
    expect(button().hidden).toBe(true);
  });

  it('asks first, starts the job, shows progress and polls until the copy exists', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, OFFER))
      .mockResolvedValueOnce(reply(202, { success: true, target_lang: 'en' }))
      .mockResolvedValueOnce(reply(200, { ...OFFER, running: true, estimated_cost: null, progress: { status: 'running', phase: 'text', percent: 0.42, error: null } }))
      .mockResolvedValueOnce(reply(200, { ...OFFER, existing: { book: 'book_99', title: '长相思 (English)' }, progress: { status: 'done', phase: 'notes', percent: 1, error: null } }));
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    vi.useFakeTimers();
    button().click();
    await vi.waitFor(() => expect(button().textContent).toBe('Waiting to translate into English…'));

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/api/book-translation/book_1');
    expect(init.method).toBe('POST');
    expect(init.headers['X-XSRF-TOKEN']).toBe('xsrf');
    expect(button().disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(button().textContent).toBe('Translating text into English… 42%');

    await vi.advanceTimersByTimeAsync(5000);
    expect(link().hidden).toBe(false);
    expect(link().getAttribute('href')).toBe('/book_99');
    // Still on the book it came from, so it opens by itself.
    await vi.waitFor(() => expect(navigateByStructure).toHaveBeenCalledWith(expect.objectContaining({ fromBook: 'book_1', toBook: 'book_99' })));
  });

  it('does nothing when the confirmation is declined', async () => {
    fetchMock.mockResolvedValue(reply(200, OFFER));
    dialogs.confirm = false;
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    button().click();
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1); // the status read only
    expect(button().disabled).toBe(false);
  });

  it('explains a lack of credit and offers the button again', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, OFFER))
      .mockResolvedValueOnce(reply(402, { success: false, message: 'Insufficient balance' }));
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    button().click();

    await vi.waitFor(() => expect(dialogs.alerts).toHaveLength(1));
    expect(dialogs.alerts[0]).toContain('Not enough credit');
    expect(button().disabled).toBe(false);
  });

  it('turns a "you already have one" refusal into the link', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, OFFER))
      .mockResolvedValueOnce(reply(409, { success: false, existing: { book: 'book_99', title: '长相思 (English)' } }));
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().textContent).toBe('Translate into English'));

    button().click();

    await vi.waitFor(() => expect(link().hidden).toBe(false));
    expect(link().getAttribute('href')).toBe('/book_99');
  });

  it('shows why the last run failed and lets it be retried', async () => {
    fetchMock.mockResolvedValue(reply(200, {
      ...OFFER, progress: { status: 'failed', phase: 'notes', percent: 0.9, error: '2 paragraph(s) could not be translated.' },
    }));
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(button().textContent).toBe('Try again: translate into English'));
    expect(note().textContent).toContain('2 paragraph(s) could not be translated.');
  });
});

describe('when a translation finishes', () => {
  const RUNNING = { ...OFFER, running: true, estimated_cost: null, progress: { status: 'running', phase: 'text', percent: 0.5, error: null } };
  const DONE = { ...OFFER, existing: { book: 'book_99', title: '长相思 (English)' }, progress: { status: 'done', phase: 'notes', percent: 1, error: null } };

  it('still opens the copy after the panel was closed mid-run', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, RUNNING)).mockResolvedValue(reply(200, DONE));
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
    fetchMock.mockResolvedValueOnce(reply(200, RUNNING)).mockResolvedValue(reply(200, DONE));
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
    fetchMock.mockResolvedValue(reply(200, DONE));
    handle = initBookTranslation(container, 'book_1');

    await vi.waitFor(() => expect(link().hidden).toBe(false));
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(20000);

    expect(navigateByStructure).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing running, nothing polled
  });

  it('stops watching a run that failed', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, RUNNING))
      .mockResolvedValue(reply(200, { ...OFFER, progress: { status: 'failed', phase: 'text', percent: 0.4, error: 'It broke.' } }));
    vi.useFakeTimers();
    handle = initBookTranslation(container, 'book_1');
    await vi.waitFor(() => expect(button().disabled).toBe(true));

    await vi.advanceTimersByTimeAsync(5000);
    expect(button().textContent).toBe('Try again: translate into English');

    await vi.advanceTimersByTimeAsync(20000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(navigateByStructure).not.toHaveBeenCalled();
  });
});
