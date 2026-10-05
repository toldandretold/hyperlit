/**
 * slugSection — the Book URL section of Creator Tools. Pins: a slugged book
 * renders read-only (no input — set-once is the server contract and the UI
 * must mirror it); a slug-less book gets the server's suggestion prefilled;
 * a successful set POSTs the NORMALIZED slug and swaps to the read-only view;
 * a 422 surfaces the server's message without losing the form; a failed
 * slug-info load leaves the section hidden; every fetch Response is consumed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { confirmDialog } = vi.hoisted(() => ({ confirmDialog: vi.fn() }));
vi.mock('../../../../resources/js/app', () => ({ book: 'book_1234567890' }));
vi.mock('../../../../resources/js/components/dialog/dialog', () => ({ confirmDialog }));
vi.mock('../../../../resources/js/utilities/logger', () => ({
  log: { error: vi.fn() },
}));

import { loadSlugSection } from '../../../../resources/js/components/sourceContainer/creatorTools/slugSection';

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

function makeSelf() {
  document.body.innerHTML = '<div id="book-url-section" style="display: none;"></div>';
  return { container: document.body };
}

const section = () => document.querySelector('#book-url-section');

beforeEach(() => {
  vi.clearAllMocks();
  confirmDialog.mockResolvedValue(true);
});

describe('slugSection', () => {
  it('renders read-only for a book that already has a slug', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      success: true, slug: 'against-innovation', encrypted: false, canSet: false, suggestion: null,
    }));
    const self = makeSelf();

    await loadSlugSection(self);

    expect(section().style.display).toBe('');
    expect(section().textContent).toContain('/against-innovation');
    expect(section().textContent).toContain("permanent and can't be changed");
    expect(section().querySelector('#book-url-slug-input')).toBeNull();
    expect(section().querySelector('#book-url-set-btn')).toBeNull();
    // The URL is a selectable link — no copy button anywhere in this section.
    expect(section().querySelector('button')).toBeNull();
  });

  it('renders the claim form with the suggestion prefilled when no slug is set', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      success: true, slug: null, encrypted: false, canSet: true, suggestion: 'my-great-book',
    }));
    const self = makeSelf();

    await loadSlugSection(self);

    // Stacked layout: labelled current URL (the raw book id), then the
    // proposed slug on its own full-width row.
    expect(section().textContent).toContain('Current:');
    expect(section().textContent).toContain('/book_1234567890');
    expect(section().textContent).toContain('Change to:');
    // The origin prefix sits above the slug box so the row reads as the full
    // prospective URL: https://host/ + <slug>.
    expect(section().textContent).toContain(`${window.location.origin}/`);
    const input = section().querySelector('#book-url-slug-input');
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.value).toBe('my-great-book');
    expect(section().querySelector('#book-url-set-btn')).not.toBeNull();
    expect(section().textContent).toContain('once set, it can never be changed');
  });

  it('refuses the form for an encrypted book', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      success: true, slug: null, encrypted: true, canSet: false, suggestion: null,
    }));
    const self = makeSelf();

    await loadSlugSection(self);

    expect(section().style.display).toBe('');
    expect(section().querySelector('#book-url-slug-input')).toBeNull();
    expect(section().textContent).toContain('Encrypted books');
  });

  it('POSTs the normalized slug and swaps to the read-only view on success', async () => {
    const infoResp = jsonResponse({
      success: true, slug: null, encrypted: false, canSet: true, suggestion: 'my-great-book',
    });
    const setResp = jsonResponse({ success: true, message: 'Slug set successfully', book: 'book_1234567890', slug: 'my-edited-slug' });
    global.fetch = vi.fn().mockResolvedValueOnce(infoResp).mockResolvedValueOnce(setResp);
    const self = makeSelf();
    await loadSlugSection(self);

    const input = section().querySelector('#book-url-slug-input');
    input.value = '  My-Edited-Slug ';
    section().querySelector('#book-url-set-btn').click();
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));

    const [url, opts] = global.fetch.mock.calls[1];
    expect(url).toBe('/api/db/library/set-slug');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ book: 'book_1234567890', slug: 'my-edited-slug' });
    expect(confirmDialog).toHaveBeenCalledOnce();
    // Both response bodies were consumed (the undrained-fetch invariant).
    expect(infoResp.json).toHaveBeenCalled();
    expect(setResp.json).toHaveBeenCalled();

    await vi.waitFor(() => expect(section().textContent).toContain('/my-edited-slug'));
    expect(section().querySelector('#book-url-slug-input')).toBeNull();
    expect(section().textContent).toContain("permanent and can't be changed");
  });

  it('does not POST when the confirm dialog is cancelled', async () => {
    confirmDialog.mockResolvedValue(false);
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({
      success: true, slug: null, encrypted: false, canSet: true, suggestion: 'my-great-book',
    }));
    const self = makeSelf();
    await loadSlugSection(self);

    section().querySelector('#book-url-set-btn').click();
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce());

    expect(global.fetch).toHaveBeenCalledTimes(1); // only the slug-info GET
    expect(section().querySelector('#book-url-slug-input')).not.toBeNull();
  });

  it('surfaces the server message on a 422 and keeps the form', async () => {
    const infoResp = jsonResponse({
      success: true, slug: null, encrypted: false, canSet: true, suggestion: null,
    });
    const rejectResp = jsonResponse({ success: false, message: 'This slug is reserved and cannot be used' }, false, 422);
    global.fetch = vi.fn().mockResolvedValueOnce(infoResp).mockResolvedValueOnce(rejectResp);
    const self = makeSelf();
    await loadSlugSection(self);

    const input = section().querySelector('#book-url-slug-input');
    input.value = 'admin';
    section().querySelector('#book-url-set-btn').click();
    await vi.waitFor(() => {
      const status = section().querySelector('#book-url-status');
      expect(status.style.display).toBe('');
      expect(status.textContent).toBe('This slug is reserved and cannot be used');
    });

    // Error response body was consumed too; form survives for a retry.
    expect(rejectResp.json).toHaveBeenCalled();
    expect(section().querySelector('#book-url-slug-input').value).toBe('admin');
    expect(section().querySelector('#book-url-set-btn').disabled).toBe(false);
  });

  it('leaves the section hidden when slug-info fails', async () => {
    const errResp = jsonResponse({ success: false, message: 'Only the book creator can view slug info' }, false, 403);
    global.fetch = vi.fn().mockResolvedValue(errResp);
    const self = makeSelf();

    await loadSlugSection(self);

    expect(section().style.display).toBe('none');
    expect(section().innerHTML).toBe('');
    expect(errResp.json).toHaveBeenCalled(); // still drained
  });
});
