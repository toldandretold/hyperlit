/**
 * Recipient notification controls (front-end half; enforcement is
 * NotificationWriter::allowed, pinned in NotificationPreferencesTest.php).
 *
 * What's pinned: the shared settings view saves each switch under its server
 * key and treats ABSENT as on; unmute calls DELETE and re-renders the list;
 * every engagement row carries a mute button that is a SIBLING of the row
 * anchor (never nested — invalid HTML, and its click would navigate); a named
 * actor's mute POSTs and removes their rows; an anonymous row offers
 * "silence anonymous readers" instead (a preference, no request); the terms
 * notice has no mute; the header gear swaps to settings and back; and the Data
 * sovereignty panel renders the same view.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/utilities/modalFocusTrap', () => ({
  trapModalFocus: vi.fn(() => vi.fn()),
}));
vi.mock('../../../resources/js/utilities/auth/session', () => ({
  getAuthContext: vi.fn().mockResolvedValue({ isLoggedIn: true }),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  getCurrentUserInfo: vi.fn(() => ({ name: 'owner_olga' })),
}));
vi.mock('../../../resources/js/components/archivePanel/exportDownload', () => ({
  initExportDownload: vi.fn(() => null),
}));
vi.mock('../../../resources/js/utilities/preferences', () => ({
  savePreference: vi.fn(),
}));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  confirmDialog: vi.fn().mockResolvedValue(true),
}));

import { savePreference } from '../../../resources/js/utilities/preferences';
import { confirmDialog } from '../../../resources/js/components/dialog/dialog';
import { renderNotificationSettings } from '../../../resources/js/components/notificationsOverlay/notificationSettings';
import {
  openNotificationsOverlay,
  closeNotificationsOverlay,
} from '../../../resources/js/components/notificationsOverlay/notificationsOverlay';
import {
  openDataSovereigntyOverlay,
  closeDataSovereigntyOverlay,
} from '../../../resources/js/components/dataSovereignty/dataSovereigntyOverlay';

const base = {
  verb: 'highlighted',
  context_label: 'your book “Accumulation”',
  snippet: null,
  link: '/aminAccumulation',
  created_at: new Date().toISOString(),
  read_at: new Date().toISOString(),
};
const NAMED = { ...base, id: 1, type: 'hyperlight', actor: 'reader_rita', actor_label: 'reader_rita' };
const NAMED_2 = { ...base, id: 2, type: 'like', actor: 'reader_rita', actor_label: 'reader_rita', verb: 'liked' };
const OTHER = { ...base, id: 3, type: 'hyperlight', actor: 'reader_rob', actor_label: 'reader_rob' };
const ANON = { ...base, id: 4, type: 'suggested_edit', actor: null, actor_label: 'Someone', verb: 'suggested an edit to' };
const TERMS = {
  ...base, id: 5, type: 'terms_published', actor: 'Hyperlit', actor_label: 'Hyperlit',
  verb: 'published', context_label: 'its Terms of Service', link: '/terms',
};

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => '' });

function stubFetch(items = [NAMED, NAMED_2, OTHER, ANON, TERMS]) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/notifications/mute')) {
      const { actor } = JSON.parse(opts.body);
      return json({ success: true, muted: opts.method === 'POST' ? [actor] : [] });
    }
    if (u.startsWith('/api/notifications/read')) return json({ success: true });
    if (u.startsWith('/api/notifications')) {
      return json({ items, total: items.length, unread_count: 0, offset: 0, page_size: 50 });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  closeNotificationsOverlay();
  closeDataSovereigntyOverlay();
  document.body.innerHTML = '';
  window.__userPreferences = {};
});

describe('shared settings view', () => {
  it('renders every switch ON when nothing is stored, and saves each under its server key', () => {
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    renderNotificationSettings(holder);

    const keys = [...holder.querySelectorAll('input[data-pref]')].map((i) => i.dataset.pref);
    expect(keys).toEqual(['notify_hyperlight', 'notify_suggested_edit', 'notify_hypercite', 'notify_like', 'notify_anonymous']);
    expect([...holder.querySelectorAll('input[data-pref]')].every((i) => i.checked)).toBe(true);

    const anon = holder.querySelector('input[data-pref="notify_anonymous"]');
    anon.checked = false;
    anon.dispatchEvent(new Event('change', { bubbles: true }));
    expect(savePreference).toHaveBeenCalledWith('notify_anonymous', false);
    expect(window.__userPreferences.notify_anonymous).toBe(false);
  });

  it('reflects stored OFF switches and lists muted users with a working Unmute', async () => {
    window.__userPreferences = { notify_like: false, notify_muted: ['reader_rita'] };
    const fetchMock = stubFetch();
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    renderNotificationSettings(holder);

    expect(holder.querySelector('input[data-pref="notify_like"]').checked).toBe(false);
    expect(holder.querySelector('input[data-pref="notify_hyperlight"]').checked).toBe(true);
    const unmute = holder.querySelector('.notif-settings-unmute');
    expect(unmute.dataset.actor).toBe('reader_rita');

    unmute.click();
    await vi.waitFor(() => expect(holder.querySelector('.notif-settings-unmute')).toBeNull());

    const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/notifications/mute'));
    expect(call[1].method).toBe('DELETE');
    expect(JSON.parse(call[1].body)).toEqual({ actor: 'reader_rita' });
    expect(window.__userPreferences.notify_muted).toEqual([]);
  });

  it('the generic preference save is never used for the mute list', () => {
    window.__userPreferences = { notify_muted: ['reader_rita'] };
    const holder = document.createElement('div');
    renderNotificationSettings(holder);
    expect(savePreference).not.toHaveBeenCalledWith('notify_muted', expect.anything());
  });
});

describe('notifications panel mute controls', () => {
  it('puts the mute button BESIDE the row anchor, never inside it; terms has none', async () => {
    stubFetch();
    await openNotificationsOverlay();

    const items = document.querySelectorAll('.notif-item');
    expect(items).toHaveLength(4); // terms row is not an engagement item
    items.forEach((item) => {
      const btn = item.querySelector('.notif-mute');
      expect(btn).not.toBeNull();
      expect(btn.closest('a')).toBeNull();
      expect(item.querySelector(':scope > a.notif-row')).not.toBeNull();
    });
    expect(document.querySelector('.notif-row-terms_published .notif-mute')).toBeNull();

    expect(document.querySelector('.notif-item[data-actor="reader_rita"] .notif-mute').getAttribute('aria-label'))
      .toBe('Mute reader_rita');
    expect(document.querySelector('.notif-item[data-actor=""] .notif-mute').getAttribute('aria-label'))
      .toBe('Silence anonymous readers');
  });

  it('muting a named actor POSTs, removes all their rows, keeps others, and keeps the panel open', async () => {
    const fetchMock = stubFetch();
    await openNotificationsOverlay();

    document.querySelector('.notif-item[data-actor="reader_rita"] .notif-mute').click();
    await vi.waitFor(() => expect(document.querySelectorAll('.notif-item[data-actor="reader_rita"]')).toHaveLength(0));

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/notifications/mute'));
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toEqual({ actor: 'reader_rita' });
    expect(document.querySelectorAll('.notif-item[data-actor="reader_rob"]')).toHaveLength(1);
    expect(document.getElementById('notifications-overlay')).not.toBeNull();
  });

  it('a cancelled confirm changes nothing', async () => {
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    const fetchMock = stubFetch();
    await openNotificationsOverlay();

    document.querySelector('.notif-item[data-actor="reader_rita"] .notif-mute').click();
    await flush();
    await flush();

    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/notifications/mute'))).toBe(false);
    expect(document.querySelectorAll('.notif-item[data-actor="reader_rita"]')).toHaveLength(2);
  });

  it('silencing anonymous readers saves the preference and makes no mute request', async () => {
    const fetchMock = stubFetch();
    await openNotificationsOverlay();

    document.querySelector('.notif-item[data-actor=""] .notif-mute').click();
    await vi.waitFor(() => expect(savePreference).toHaveBeenCalledWith('notify_anonymous', false));

    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/notifications/mute'))).toBe(false);
    expect(document.querySelector('.notif-item[data-actor=""] .notif-mute')).toBeNull();
  });

  it('the header gear swaps to the settings view and back to the feed', async () => {
    stubFetch();
    await openNotificationsOverlay();

    document.querySelector('.notifications-panel-gear').click();
    expect(document.querySelector('.notifications-panel-body .notif-settings')).not.toBeNull();
    expect(document.querySelector('.notifications-panel-body .notif-row')).toBeNull();

    document.querySelector('.notif-settings-back').click();
    await vi.waitFor(() => expect(document.querySelector('.notifications-panel-body .notif-row')).not.toBeNull());
    expect(document.querySelector('.notifications-panel-body .notif-settings')).toBeNull();
  });
});

describe('data sovereignty panel', () => {
  it('renders the same notification settings for a logged-in user', () => {
    openDataSovereigntyOverlay();
    const holder = document.querySelector('#data-sovereignty-overlay #datasov-notif-settings');
    expect(holder?.querySelector('.notif-settings')).not.toBeNull();
    expect(holder.querySelectorAll('input[data-pref]')).toHaveLength(5);
  });
});
