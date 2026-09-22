/**
 * Notifications overlay + unread pink dot.
 *
 * What's pinned: the profile menu row opens the panel (same seam as Stats);
 * opening renders server-shaped rows and fires the mark-read POST exactly when
 * something was unread; the pink dot rides #userButton / #notificationsBtn
 * while unread > 0 and clears after the panel opens; SPA destroy removes an
 * open overlay (the orphaned-overlay class of bug the ButtonRegistry exists
 * for). The fetch layer is stubbed; trapModalFocus is mocked so release-on-
 * close is assertable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const releaseTrapMock = vi.fn();
vi.mock('../../../resources/js/utilities/modalFocusTrap', () => ({
  trapModalFocus: vi.fn(() => releaseTrapMock),
}));
vi.mock('../../../resources/js/utilities/auth/session', () => ({
  getAuthContext: vi.fn().mockResolvedValue({ isLoggedIn: true }),
}));

import { trapModalFocus } from '../../../resources/js/utilities/modalFocusTrap';
import { getAuthContext } from '../../../resources/js/utilities/auth/session';
import {
  openNotificationsOverlay,
  closeNotificationsOverlay,
  destroyNotificationsOverlay,
  refreshNotificationsBadge,
} from '../../../resources/js/components/notificationsOverlay/notificationsOverlay';
import { attachProfileButtonListeners } from '../../../resources/js/components/userContainer/profile';
import { getProfileHTML } from '../../../resources/js/components/userContainer/forms';

const ITEM = {
  id: 1,
  type: 'hyperlight',
  actor: 'reader_rita',
  actor_label: 'reader_rita',
  verb: 'highlighted',
  context_label: 'your book “Accumulation”',
  snippet: 'a highlighted passage',
  link: '/aminAccumulation#hyperlight_x',
  created_at: new Date().toISOString(),
  read_at: null,
};

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    blob: async () => new Blob([]),
  };
}

/** fetch stub routing by URL; records calls for assertions. */
function stubFetch({ items = [ITEM], unread = 1, total = 1 } = {}) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    if (String(url).startsWith('/api/notifications/unread-count')) {
      return jsonResponse({ unread });
    }
    if (String(url).startsWith('/api/notifications/read')) {
      return jsonResponse({ success: true, marked: unread });
    }
    if (String(url).startsWith('/api/notifications')) {
      return jsonResponse({ items, total, unread_count: unread, offset: 0, page_size: 50 });
    }
    throw new Error(`unexpected fetch: ${url} ${opts.method || 'GET'}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  closeNotificationsOverlay();
  document.body.innerHTML = '';
});

describe('notifications overlay', () => {
  it('opens, renders server-shaped rows, and traps focus', async () => {
    stubFetch();
    await openNotificationsOverlay();

    const overlay = document.getElementById('notifications-overlay');
    expect(overlay).not.toBeNull();
    expect(trapModalFocus).toHaveBeenCalledTimes(1);

    const row = overlay.querySelector('.notif-row');
    expect(row).not.toBeNull();
    expect(row.getAttribute('href')).toBe('/aminAccumulation#hyperlight_x');
    expect(row.classList.contains('notif-unread')).toBe(true); // unread styling kept for THIS open
    expect(row.textContent).toContain('reader_rita');
    expect(row.textContent).toContain('highlighted');
    expect(row.textContent).toContain('your book “Accumulation”');
    expect(row.textContent).toContain('a highlighted passage');
  });

  it('fires the mark-read POST when something was unread — and not when nothing was', async () => {
    const fetchMock = stubFetch({ unread: 1 });
    await openNotificationsOverlay();
    await flush();
    expect(fetchMock.mock.calls.some(([url, opts]) =>
      String(url).startsWith('/api/notifications/read') && opts?.method === 'POST')).toBe(true);

    closeNotificationsOverlay();
    const quietFetch = stubFetch({ items: [{ ...ITEM, read_at: new Date().toISOString() }], unread: 0 });
    await openNotificationsOverlay();
    await flush();
    expect(quietFetch.mock.calls.some(([url, opts]) =>
      String(url).startsWith('/api/notifications/read') && opts?.method === 'POST')).toBe(false);
  });

  it('styles each row by type: heart on likes, marked verb on highlights, rainbow verb on cites', async () => {
    stubFetch({
      items: [
        { ...ITEM, id: 10, type: 'hyperlight', verb: 'highlighted', read_at: new Date().toISOString() },
        { ...ITEM, id: 11, type: 'like', verb: 'liked', snippet: null, read_at: new Date().toISOString() },
        { ...ITEM, id: 12, type: 'hypercite_paired', verb: 'cited', read_at: new Date().toISOString() },
      ],
      unread: 0,
      total: 3,
    });
    await openNotificationsOverlay();
    const overlay = document.getElementById('notifications-overlay');

    // Like: aqua heart, no marked verb.
    const likeRow = overlay.querySelector('.notif-row-like');
    expect(likeRow.querySelector('.notif-like-heart')).not.toBeNull();

    // Highlight: verb wears a highlight mark; no heart.
    const hlRow = overlay.querySelector('.notif-row-hyperlight');
    expect(hlRow.querySelector('.notif-verb-highlight')?.textContent).toBe('highlighted');
    expect(hlRow.querySelector('.notif-like-heart')).toBeNull();

    // Hypercite: verb wears the rainbow underline span.
    const citeRow = overlay.querySelector('.notif-row-hypercite_paired');
    expect(citeRow.querySelector('.notif-verb-cite')?.textContent).toBe('cited');
  });

  it('closes on the close button and releases the focus trap', async () => {
    stubFetch();
    await openNotificationsOverlay();

    document.querySelector('.notifications-panel-close').click();

    expect(document.getElementById('notifications-overlay')).toBeNull();
    expect(releaseTrapMock).toHaveBeenCalled();
  });

  it('shows the empty state when there is nothing', async () => {
    stubFetch({ items: [], unread: 0, total: 0 });
    await openNotificationsOverlay();

    expect(document.querySelector('.notifications-panel-empty').textContent)
      .toContain('Nothing yet');
  });

  it('destroy (SPA nav) removes an orphaned open overlay', async () => {
    stubFetch();
    await openNotificationsOverlay();
    expect(document.getElementById('notifications-overlay')).not.toBeNull();

    destroyNotificationsOverlay();
    expect(document.getElementById('notifications-overlay')).toBeNull();
  });
});

describe('unread pink dot', () => {
  function mountButtons() {
    // The Account button always carries the silhouette svg (blade-rendered);
    // the dot anchors to that icon, so the fixture must include it.
    document.body.innerHTML = `
      <button id="userButton"><svg id="userLogo"></svg></button>
      <div id="user-container">${getProfileHTML()}</div>`;
  }

  /**
   * Visibility is a CLASS on the anchor, not the presence of the dot element.
   * The dot is always in the DOM and always absolutely positioned: it used to
   * be created/removed when the unread fetch resolved, which could land while
   * the profile flyout was mid-open-animation and shifted every row below it
   * (see notificationsBadgeNoReflow.test.js). Nothing about the reveal may
   * touch layout, so "is it showing" has to be asked of the class.
   */
  const dotShowing = (sel) =>
    !!document.querySelector(sel)?.classList.contains('has-unread');

  it('appears anchored to the icon of #userButton and #notificationsBtn while unread > 0, and only then', async () => {
    mountButtons();
    stubFetch({ unread: 3 });
    await refreshNotificationsBadge();

    // The dot lives INSIDE the icon anchor (next to the silhouette/bell),
    // never at the button's far corner.
    expect(document.querySelector('#userButton .notif-dot-anchor > .notif-dot')).not.toBeNull();
    expect(document.querySelector('#userButton .notif-dot-anchor > svg')).not.toBeNull();
    expect(document.querySelector('#notificationsBtn .notif-dot-anchor > .notif-dot')).not.toBeNull();
    expect(dotShowing('#userButton .notif-dot-anchor')).toBe(true);
    expect(dotShowing('#notificationsBtn .notif-dot-anchor')).toBe(true);

    stubFetch({ unread: 0 });
    await refreshNotificationsBadge();
    expect(dotShowing('#userButton .notif-dot-anchor')).toBe(false);
    expect(dotShowing('#notificationsBtn .notif-dot-anchor')).toBe(false);
    // ...and the elements themselves stayed put.
    expect(document.querySelectorAll('.notif-dot')).toHaveLength(2);
  });

  it('never fetches for a logged-out session (and clears any dots)', async () => {
    mountButtons();
    const fetchMock = stubFetch({ unread: 3 });
    await refreshNotificationsBadge();
    expect(dotShowing('#userButton .notif-dot-anchor')).toBe(true);

    vi.mocked(getAuthContext).mockResolvedValueOnce({ isLoggedIn: false });
    fetchMock.mockClear();
    await refreshNotificationsBadge();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dotShowing('#userButton .notif-dot-anchor')).toBe(false);
    expect(dotShowing('#notificationsBtn .notif-dot-anchor')).toBe(false);
  });

  it('clears the dots when opening the panel marks everything read', async () => {
    mountButtons();
    stubFetch({ unread: 2 });
    await refreshNotificationsBadge();
    expect(dotShowing('#userButton .notif-dot-anchor')).toBe(true);

    await openNotificationsOverlay();
    await flush();
    expect(dotShowing('#userButton .notif-dot-anchor')).toBe(false);
  });
});

describe('profile menu row', () => {
  it('renders a Notifications row and opens the overlay via the Stats-style seam', async () => {
    document.body.innerHTML = `<div id="user-container">${getProfileHTML()}</div>`;
    stubFetch();
    const self = {
      container: document.getElementById('user-container'),
      closeContainer: vi.fn(),
      handleLogout: vi.fn(),
      handleMyBooksClick: vi.fn(),
    };
    attachProfileButtonListeners(self);

    const btn = document.getElementById('notificationsBtn');
    expect(btn).not.toBeNull();
    btn.click();
    await flush();
    await flush(); // dynamic import + open

    expect(self.closeContainer).toHaveBeenCalled();
    expect(document.getElementById('notifications-overlay')).not.toBeNull();
  });
});
