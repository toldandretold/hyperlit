/**
 * Data sovereignty: ONE profile-menu row (below Passkeys, above Logout) that
 * opens a Stats-class overlay housing the data/privacy options — export,
 * privacy policy, delete account. The overlay is the same skeleton as
 * stats/notifications/money: body-appended singleton, trapModalFocus, close
 * button, backdrop close, ButtonRegistry init/destroy teardown.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/components/userContainer/deleteAccount', () => ({
  startDeleteAccountFlow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/components/notificationsOverlay/notificationsOverlay', () => ({
  openNotificationsOverlay: vi.fn(),
  applyNotificationsBadge: vi.fn(),
}));
vi.mock('../../../resources/js/components/dataSovereignty/dataSovereigntyOverlay', async (importOriginal) => {
  // The menu test mocks the OPENER only; the overlay suite below unmocks it.
  const real = await importOriginal();
  return { ...real, openDataSovereigntyOverlay: vi.fn(real.openDataSovereigntyOverlay) };
});
vi.mock('../../../resources/js/utilities/auth/index', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, getCurrentUserInfo: vi.fn(() => ({ name: 'Test User' })) };
});
vi.mock('../../../resources/js/components/archivePanel/exportDownload', () => ({
  initExportDownload: vi.fn(() => ({ destroy: vi.fn() })),
}));

import { getProfileHTML } from '../../../resources/js/components/userContainer/forms';
import { attachProfileButtonListeners } from '../../../resources/js/components/userContainer/profile';
import {
  openDataSovereigntyOverlay,
  closeDataSovereigntyOverlay,
  initDataSovereigntyOverlay,
} from '../../../resources/js/components/dataSovereignty/dataSovereigntyOverlay';
import { startDeleteAccountFlow } from '../../../resources/js/components/userContainer/deleteAccount';
import { initExportDownload } from '../../../resources/js/components/archivePanel/exportDownload';

describe('Data sovereignty menu row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeDataSovereigntyOverlay();
    document.body.innerHTML = '';
  });

  it('renders one row, below Passkeys and above Logout', () => {
    document.body.innerHTML = getProfileHTML(true);

    // The ROW is labelled just "Data" (menu brevity); the overlay it opens
    // carries the full "Data sovereignty" title.
    const row = document.getElementById('dataSovereigntyBtn');
    expect(row).toBeTruthy();
    expect(row.textContent.trim()).toBe('Data');
    expect(row.classList.contains('menu-row-btn')).toBe(true);

    const ids = [...document.querySelectorAll('.user-profile > button')].map((b) => b.id);
    expect(ids.indexOf('dataSovereigntyBtn')).toBe(ids.indexOf('passkeysBtn') + 1);
    expect(ids.indexOf('logout')).toBe(ids.indexOf('dataSovereigntyBtn') + 1);
  });

  it('the row opens the overlay (stats-style: close container first, lazy open)', async () => {
    document.body.innerHTML = `<div id="host">${getProfileHTML(true)}</div>`;
    const self = {
      container: document.getElementById('host'),
      handleLogout: vi.fn(),
      handleMyBooksClick: vi.fn(),
      closeContainer: vi.fn(),
    };
    attachProfileButtonListeners(self);

    document.getElementById('dataSovereigntyBtn').click();
    await vi.waitFor(() => expect(openDataSovereigntyOverlay).toHaveBeenCalled());
    expect(self.closeContainer).toHaveBeenCalled();
    expect(document.getElementById('data-sovereignty-overlay')).toBeTruthy();
  });
});

describe('Data sovereignty overlay', () => {
  let originalLocation;

  beforeEach(() => {
    vi.clearAllMocks();
    closeDataSovereigntyOverlay();
    document.body.innerHTML = '';
    originalLocation = window.location;
    delete window.location;
    window.location = { href: '' };
    return () => { window.location = originalLocation; };
  });

  it('builds the panel with export + rights rows and is a singleton', () => {
    openDataSovereigntyOverlay();
    openDataSovereigntyOverlay(); // second call must not duplicate

    expect(document.querySelectorAll('#data-sovereignty-overlay').length).toBe(1);
    for (const id of ['datasov-export-md', 'datasov-export-sqlite', 'datasovPrivacyBtn', 'datasovDeleteBtn']) {
      expect(document.getElementById(id), `#${id} missing`).toBeTruthy();
    }
    expect(document.querySelector('.datasov-panel-close')).toBeTruthy();
    expect(document.querySelector('.datasov-panel-title').textContent).toBe('Data sovereignty');
    expect(document.getElementById('datasovDeleteBtn').classList.contains('datasov-row-danger')).toBe(true);

    // The REAL export machinery is wired with the user scope, both kinds.
    expect(initExportDownload).toHaveBeenCalledWith(
      expect.anything(), 'datasov-export-md', { scopeType: 'user', scopeId: 'Test User' }, 'markdown',
    );
    expect(initExportDownload).toHaveBeenCalledWith(
      expect.anything(), 'datasov-export-sqlite', { scopeType: 'user', scopeId: 'Test User' }, 'sqlite',
    );
  });

  it('closing the overlay destroys the export poll handles', () => {
    const destroys = [];
    vi.mocked(initExportDownload).mockImplementation(() => {
      const destroy = vi.fn();
      destroys.push(destroy);
      return { destroy };
    });

    openDataSovereigntyOverlay();
    closeDataSovereigntyOverlay();

    expect(destroys.length).toBe(2);
    destroys.forEach((d) => expect(d).toHaveBeenCalled());
  });

  it('close button and backdrop both close; init() tears down an orphan', () => {
    openDataSovereigntyOverlay();
    document.querySelector('.datasov-panel-close').click();
    expect(document.getElementById('data-sovereignty-overlay')).toBeNull();

    openDataSovereigntyOverlay();
    document.getElementById('data-sovereignty-overlay').click(); // backdrop
    expect(document.getElementById('data-sovereignty-overlay')).toBeNull();

    openDataSovereigntyOverlay();
    initDataSovereigntyOverlay(); // SPA re-entry must never inherit an open overlay
    expect(document.getElementById('data-sovereignty-overlay')).toBeNull();
  });

  it('privacy row navigates to /privacy (the policy book)', () => {
    openDataSovereigntyOverlay();
    document.getElementById('datasovPrivacyBtn').click();
    expect(window.location.href).toBe('/privacy');
    expect(document.getElementById('data-sovereignty-overlay')).toBeNull();
  });

  it('delete row closes the overlay and launches the deletion flow', async () => {
    openDataSovereigntyOverlay();
    document.getElementById('datasovDeleteBtn').click();
    expect(document.getElementById('data-sovereignty-overlay')).toBeNull();
    await vi.waitFor(() => expect(startDeleteAccountFlow).toHaveBeenCalled());
  });
});
