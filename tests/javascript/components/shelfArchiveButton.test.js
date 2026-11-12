/**
 * "View as archive" shelf-header button (server half pinned in
 * tests/Feature/Api/ShelfArchiveTest.php).
 *
 * What's pinned: the button shows only while the shelf is public (and closes
 * its picker when hidden); a shelf that already has an archive navigates
 * straight to /a/{slug} with no POST; a shelf without one opens the inline,
 * set-once URL picker prefilled with the server's suggestion, live-checks a
 * typed slug, and Create POSTs then navigates; a taken slug keeps the picker
 * open with the suggestion; Escape collapses it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createShelfArchiveButton,
  navigation,
  slugifyInput,
} from '../../../resources/js/components/shelves/shelfArchiveButton';

const SHELF = '11111111-2222-4333-8444-555555555555';

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function mount(visibility = 'public') {
  const header = document.createElement('div');
  const titleRow = document.createElement('div');
  header.appendChild(titleRow);
  document.body.appendChild(header);
  const api = createShelfArchiveButton({
    shelfId: SHELF,
    visibility,
    mountPicker: (row) => titleRow.after(row),
  });
  titleRow.appendChild(api.el);
  return { api, header };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('shelfArchiveButton', () => {
  let go;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    go = vi.spyOn(navigation, 'go').mockImplementation(() => {});
    globalThis.fetch = vi.fn();
  });

  it('is visible only while the shelf is public', () => {
    const { api } = mount('private');
    expect(api.el.style.display).toBe('none');
    api.setVisibility('public');
    expect(api.el.style.display).toBe('');
    api.setVisibility('private');
    expect(api.el.style.display).toBe('none');
  });

  it('navigates straight to an existing archive without POSTing', async () => {
    fetch.mockImplementation(() => json({ exists: true, slug: 'cyber-politics', url: '/a/cyber-politics' }));
    const { api } = mount();
    api.el.click();
    await flush();
    expect(go).toHaveBeenCalledWith('/a/cyber-politics');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
    expect(document.querySelector('.shelf-header-archive-picker')).toBeNull();

    // Second click reuses the known URL — no second request.
    api.el.click();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('opens a prefilled set-once picker, then Create POSTs and navigates', async () => {
    fetch.mockImplementationOnce(() => json({ exists: false, suggestion: 'cyber-politics' }));
    const { api } = mount();
    api.el.click();
    await flush();

    const picker = document.querySelector('.shelf-header-archive-picker');
    expect(picker).not.toBeNull();
    const input = picker.querySelector('input');
    expect(input.value).toBe('cyber-politics');
    expect(picker.textContent).toMatch(/permanent/i);

    fetch.mockImplementationOnce(() => json({ slug: 'cyber-politics', url: '/a/cyber-politics', created: true }));
    picker.querySelector('.shelf-archive-create').click();
    await flush();

    const [url, init] = fetch.mock.calls[1];
    expect(url).toBe(`/api/shelves/${SHELF}/archive`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ slug: 'cyber-politics' });
    expect(go).toHaveBeenCalledWith('/a/cyber-politics');
  });

  it('live-checks a typed slug and reports a taken one', async () => {
    vi.useFakeTimers();
    try {
      fetch.mockImplementationOnce(() => json({ exists: false, suggestion: 'cyber-politics' }));
      const { api } = mount();
      api.el.click();
      await vi.runAllTimersAsync();

      const picker = document.querySelector('.shelf-header-archive-picker');
      const input = picker.querySelector('input');
      const create = picker.querySelector('.shelf-archive-create');
      const status = picker.querySelector('.shelf-archive-status');

      fetch.mockImplementationOnce(() => json({ exists: false, suggestion: 'x', slug: 'taken-one', valid: true, available: false }));
      input.value = 'Taken One';
      input.dispatchEvent(new Event('input'));
      expect(input.value).toBe('taken-one'); // normalised as typed
      await vi.advanceTimersByTimeAsync(400);

      expect(fetch.mock.calls[1][0]).toBe(`/api/shelves/${SHELF}/archive?slug=taken-one`);
      expect(status.dataset.state).toBe('bad');
      expect(status.textContent).toBe('Taken');
      expect(create.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a taken slug on Create keeps the picker open with the suggestion', async () => {
    fetch.mockImplementationOnce(() => json({ exists: false, suggestion: 'cyber-politics' }));
    const { api } = mount();
    api.el.click();
    await flush();
    const picker = document.querySelector('.shelf-header-archive-picker');

    fetch.mockImplementationOnce(() => json({ error: '/a/cyber-politics is taken.', suggestion: 'cyber-politics-sam' }, 422));
    picker.querySelector('.shelf-archive-create').click();
    await flush();
    await flush();

    expect(go).not.toHaveBeenCalled();
    expect(document.querySelector('.shelf-header-archive-picker')).not.toBeNull();
    expect(picker.querySelector('.shelf-archive-status').textContent).toContain('cyber-politics-sam');
  });

  it('Escape collapses the picker; hiding the button closes it too', async () => {
    fetch.mockImplementation(() => json({ exists: false, suggestion: 'cyber-politics' }));
    const { api } = mount();
    api.el.click();
    await flush();
    const input = document.querySelector('.shelf-header-archive-picker input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.shelf-header-archive-picker')).toBeNull();

    api.el.click();
    await flush();
    expect(document.querySelector('.shelf-header-archive-picker')).not.toBeNull();
    api.setVisibility('private');
    expect(document.querySelector('.shelf-header-archive-picker')).toBeNull();
  });

  it('slugifyInput normalises free typing', () => {
    expect(slugifyInput('Cyber Politics!!')).toBe('cyber-politics-');
    expect(slugifyInput('--a--b')).toBe('a-b');
  });
});
