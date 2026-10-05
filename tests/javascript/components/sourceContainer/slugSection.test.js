/**
 * slugSection — the Book URL section of Creator Tools. Pins: a slugged book
 * renders read-only (no input — set-once is the server contract and the UI
 * must mirror it); a slug-less book gets the server's suggestion prefilled and
 * LIVE availability feedback (format screened locally; everything else — the
 * reserved-route/username/collision gauntlet — comes from the slug-check
 * endpoint, so the inline verdict always matches what Set URL would say); a
 * successful set POSTs the NORMALIZED slug and swaps to the read-only view; a
 * 422 surfaces the server's message without losing the form; a failed
 * slug-info load leaves the section hidden; every fetch Response is consumed.
 *
 * Fake timers throughout: the live check debounces 500ms, and a REAL timer
 * leaking across tests would fire mid-later-test and eat its fetch mock (the
 * cross-test pollution class). The fetch mock routes by URL, not call order,
 * for the same reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock('../../../../resources/js/app', () => ({ book: 'book_1234567890' }));
vi.mock('../../../../resources/js/components/dialog/dialog', () => ({ confirmDialog }));
vi.mock('../../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
}));

import { loadSlugSection } from '../../../../resources/js/components/sourceContainer/creatorTools/slugSection';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: vi.fn().mockResolvedValue(body) };
}

/**
 * URL-routed fetch mock. `routes` maps a path substring to a response (or a
 * function of the URL for per-value answers). Returns the spy.
 */
function mockFetchRoutes(routes) {
  const spy = vi.fn(async (url) => {
    for (const [needle, resp] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        return typeof resp === 'function' ? resp(String(url)) : resp;
      }
    }
    throw new Error(`Unrouted fetch in test: ${url}`);
  });
  global.fetch = spy;
  return spy;
}

const INFO_FORM = {
  success: true, slug: null, encrypted: false, canSet: true, suggestion: 'my-great-book',
};

function makeSelf() {
  document.body.innerHTML = '<div id="book-url-section" style="display: none;"></div>';
  return { container: document.body };
}

const section = () => document.querySelector('#book-url-section');
const input = () => section().querySelector('#book-url-slug-input');
const checkLine = () => section().querySelector('#book-url-check');
const settle = (ms = 600) => vi.advanceTimersByTimeAsync(ms);

function type(value) {
  input().value = value;
  input().dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  confirmDialog.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('slugSection', () => {
  it('renders read-only for a book that already has a slug', async () => {
    mockFetchRoutes({
      'slug-info': jsonResponse({ success: true, slug: 'against-innovation', encrypted: false, canSet: false, suggestion: null }),
    });
    await loadSlugSection(makeSelf());

    expect(section().style.display).toBe('');
    expect(section().textContent).toContain('/against-innovation');
    expect(section().textContent).toContain("permanent and can't be changed");
    expect(input()).toBeNull();
    expect(section().querySelector('#book-url-set-btn')).toBeNull();
    // The URL is a selectable link — no copy button anywhere in this section.
    expect(section().querySelector('button')).toBeNull();
  });

  it('renders the claim form with the suggestion prefilled, and live-verifies it on load', async () => {
    const fetchSpy = mockFetchRoutes({
      'slug-info': jsonResponse(INFO_FORM),
      'slug-check': jsonResponse({ success: true, slug: 'my-great-book', available: true, message: null }),
    });
    await loadSlugSection(makeSelf());

    // Stacked layout: labelled current URL (the raw book id), the origin
    // prefix, then the proposed slug on its own full-width row.
    expect(section().textContent).toContain('Current:');
    expect(section().textContent).toContain('/book_1234567890');
    expect(section().textContent).toContain('Change to:');
    expect(section().textContent).toContain(`${window.location.origin}/`);
    expect(input().tagName).toBe('TEXTAREA');
    expect(input().value).toBe('my-great-book');

    // The suggestion was minted available, but it is re-verified live anyway.
    await settle();
    const checkCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('slug-check'));
    expect(String(checkCall[0])).toContain('slug=my-great-book');
    expect(String(checkCall[0])).toContain('book=book_1234567890');
    expect(checkLine().textContent).toBe('Available');
    expect(checkLine().className).toContain('success');
  });

  it('live check surfaces the FULL gauntlet verdict (reserved word ≠ merely taken)', async () => {
    mockFetchRoutes({
      'slug-info': jsonResponse({ ...INFO_FORM, suggestion: null }),
      'slug-check': (url) => jsonResponse(
        url.includes('slug=admin')
          ? { success: true, slug: 'admin', available: false, message: 'This slug is reserved and cannot be used' }
          : { success: true, slug: 'my-free-slug', available: true, message: null },
      ),
    });
    await loadSlugSection(makeSelf());

    type('admin');
    await settle();
    expect(checkLine().textContent).toBe('This slug is reserved and cannot be used');
    expect(checkLine().className).toContain('error');

    type('my-free-slug');
    await settle();
    expect(checkLine().textContent).toBe('Available');
    expect(checkLine().className).toContain('success');
  });

  it('screens malformed slugs locally — no server probe for a format error', async () => {
    const fetchSpy = mockFetchRoutes({
      'slug-info': jsonResponse({ ...INFO_FORM, suggestion: null }),
    });
    await loadSlugSection(makeSelf());

    type('-bad-slug-');
    // Format verdict is immediate (no debounce)…
    expect(checkLine().className).toContain('error');
    expect(checkLine().textContent).toContain('lowercase');
    // …and even after the debounce window, no slug-check request went out.
    await settle();
    expect(fetchSpy.mock.calls.every(([u]) => !String(u).includes('slug-check'))).toBe(true);

    // Clearing the field clears the verdict.
    type('');
    expect(checkLine().style.display).toBe('none');
  });

  it('refuses the form for an encrypted book', async () => {
    mockFetchRoutes({
      'slug-info': jsonResponse({ success: true, slug: null, encrypted: true, canSet: false, suggestion: null }),
    });
    await loadSlugSection(makeSelf());

    expect(section().style.display).toBe('');
    expect(input()).toBeNull();
    expect(section().textContent).toContain('Encrypted books');
  });

  it('POSTs the normalized slug and swaps to the read-only view on success', async () => {
    const infoResp = jsonResponse(INFO_FORM);
    const setResp = jsonResponse({ success: true, message: 'Slug set successfully', book: 'book_1234567890', slug: 'my-edited-slug' });
    const fetchSpy = mockFetchRoutes({
      'slug-info': infoResp,
      'slug-check': jsonResponse({ success: true, available: true, message: null }),
      'set-slug': setResp,
    });
    await loadSlugSection(makeSelf());

    type('  My-Edited-Slug ');
    section().querySelector('#book-url-set-btn').click();
    await settle(10);

    const setCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('set-slug'));
    expect(setCall).toBeTruthy();
    expect(setCall[1].method).toBe('POST');
    expect(JSON.parse(setCall[1].body)).toEqual({ book: 'book_1234567890', slug: 'my-edited-slug' });
    expect(confirmDialog).toHaveBeenCalledOnce();
    // Both response bodies were consumed (the undrained-fetch invariant).
    expect(infoResp.json).toHaveBeenCalled();
    expect(setResp.json).toHaveBeenCalled();

    expect(section().textContent).toContain('/my-edited-slug');
    expect(input()).toBeNull();
    expect(section().textContent).toContain("permanent and can't be changed");
  });

  it('does not POST when the confirm dialog is cancelled', async () => {
    confirmDialog.mockResolvedValue(false);
    const fetchSpy = mockFetchRoutes({
      'slug-info': jsonResponse(INFO_FORM),
      'slug-check': jsonResponse({ success: true, available: true, message: null }),
    });
    await loadSlugSection(makeSelf());

    section().querySelector('#book-url-set-btn').click();
    await settle(10);

    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls.every(([u]) => !String(u).includes('set-slug'))).toBe(true);
    expect(input()).not.toBeNull();
  });

  it('surfaces the server message on a 422 and keeps the form', async () => {
    const rejectResp = jsonResponse({ success: false, message: 'This slug is reserved and cannot be used' }, false, 422);
    mockFetchRoutes({
      'slug-info': jsonResponse({ ...INFO_FORM, suggestion: null }),
      'slug-check': jsonResponse({ success: true, available: true, message: null }),
      'set-slug': rejectResp,
    });
    await loadSlugSection(makeSelf());

    type('admin2');
    section().querySelector('#book-url-set-btn').click();
    await settle(10);

    const status = section().querySelector('#book-url-status');
    expect(status.style.display).toBe('');
    expect(status.textContent).toBe('This slug is reserved and cannot be used');
    // Error response body was consumed too; form survives for a retry.
    expect(rejectResp.json).toHaveBeenCalled();
    expect(input().value).toBe('admin2');
    expect(section().querySelector('#book-url-set-btn').disabled).toBe(false);
  });

  it('leaves the section hidden when slug-info fails', async () => {
    const errResp = jsonResponse({ success: false, message: 'Only the book creator can view slug info' }, false, 403);
    mockFetchRoutes({ 'slug-info': errResp });
    await loadSlugSection(makeSelf());

    expect(section().style.display).toBe('none');
    expect(section().innerHTML).toBe('');
    expect(errResp.json).toHaveBeenCalled(); // still drained
  });
});
