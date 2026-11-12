/**
 * Shelf likes on the client (server half: tests/Feature/Api/ShelfLikeTest.php).
 *
 * wireShelfLikeButton is the ONE behaviour behind both hearts — the shelf
 * header's and the archive panel's (#like-book in #archive-container, for
 * journal/archive pages whose corpus is a shelf). Pinned: the state is seated
 * from the public count endpoint; a click toggles optimistically and POSTs /
 * DELETEs; a failed request reverts; a logged-out click prompts login and
 * sends nothing. And the archive panel renders Like only when the corpus HAS a
 * shelf (a user library doesn't), with Share always present.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const auth = vi.hoisted(() => ({ isLoggedIn: vi.fn(async () => true) }));
vi.mock('../../../resources/js/utilities/auth/index', () => auth);
vi.mock('../../../resources/js/utilities/bibtexProcessor', () => ({ formatBibtexToCitation: vi.fn(async () => 'Sam (2026). Cyber Politics.') }));

import { wireShelfLikeButton } from '../../../resources/js/components/shelves/shelfLike';
import { buildArchiveHtml } from '../../../resources/js/components/archivePanel/buildArchiveHtml';

const SHELF = '11111111-2222-4333-8444-555555555555';
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function mount() {
  document.body.innerHTML = '<button id="b"></button>';
  const btn = document.getElementById('b');
  wireShelfLikeButton(btn, SHELF, 'archive');
  return btn;
}

describe('wireShelfLikeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.isLoggedIn.mockResolvedValue(true);
  });

  it('seats the liked state from the public endpoint', async () => {
    globalThis.fetch = vi.fn(() => json({ count: 3, liked: true }));
    const btn = mount();
    await flush();
    expect(fetch.mock.calls[0][0]).toBe(`/api/public/shelves/${SHELF}/likes`);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('liked')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Unlike this archive');
  });

  it('a click likes (POST), a second click unlikes (DELETE)', async () => {
    globalThis.fetch = vi.fn(() => json({ count: 0, liked: false }));
    const btn = mount();
    await flush();

    fetch.mockImplementation(() => json({ success: true, liked: true }));
    btn.click();
    await flush();
    let [url, init] = fetch.mock.calls.at(-1);
    expect(url).toBe(`/api/shelves/${SHELF}/like`);
    expect(init.method).toBe('POST');
    expect(btn.getAttribute('aria-pressed')).toBe('true');

    btn.click();
    await flush();
    [url, init] = fetch.mock.calls.at(-1);
    expect(init.method).toBe('DELETE');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('a failed request reverts the optimistic toggle', async () => {
    globalThis.fetch = vi.fn(() => json({ count: 0, liked: false }));
    const btn = mount();
    await flush();
    fetch.mockImplementation(() => json({ error: 'nope' }, 404));
    btn.click();
    await flush();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.classList.contains('liked')).toBe(false);
  });

  it('logged out: prompts login, sends nothing', async () => {
    globalThis.fetch = vi.fn(() => json({ count: 0, liked: false }));
    auth.isLoggedIn.mockResolvedValue(false);
    const btn = mount();
    await flush();
    const before = fetch.mock.calls.length;
    btn.click();
    await flush();
    // The real anchored login prompt (addToShelfMenu, lazily imported) appears.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Log in to like archives'));
    expect(fetch.mock.calls.length).toBe(before);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('archive panel action bar', () => {
  const base = {
    displayName: 'Cyber Politics', noun: 'archive', pageUrl: 'https://hyperlit.test/a/cyber-politics', bibtex: '@misc{x}',
    librarian: { label: 'Kept by', name: 'sam', url: null }, audience: 'public',
    counts: { public_books: 2, export_books: 2, e2ee_skipped: 0 },
  };
  const render = async (data) => {
    const host = document.createElement('div');
    host.innerHTML = await buildArchiveHtml(data);
    return host;
  };

  it('a shelf-backed corpus (archive / journal) gets Like + Share', async () => {
    const host = await render({ ...base, shelfId: SHELF });
    expect(host.querySelector('#source-action-bar #like-book')).not.toBeNull();
    expect(host.querySelector('#share-control [data-share="link"]')).not.toBeNull();
    expect(host.querySelector('#share-control [data-share="citation"]')).not.toBeNull();
    expect(host.querySelector('#like-book').getAttribute('aria-label')).toBe('Like this archive');
  });

  it('a user library (no shelf) gets Share only', async () => {
    const host = await render({ ...base, noun: 'library', shelfId: null });
    expect(host.querySelector('#like-book')).toBeNull();
    expect(host.querySelector('#share-control')).not.toBeNull();
  });
});
