/**
 * Logout must never wipe the device on an UNSYNCED flush verdict without asking.
 *
 * Logout is the one cleanup path that is unrecoverable: clearAllCachedData →
 * clearDatabase() drops historyLog too, so the replay that rescues every other
 * failed sync dies with it. The old code awaited flushAllPendingEdits(), ignored
 * the (nonexistent) result and wiped regardless — and that flush could return
 * "done" with a POST still in flight (see indexedDB/flushDurability.test.js).
 *
 * Everything around the decision is a mocked seam; what's asserted is the ORDER
 * and the veto: unsynced ⇒ confirm, cancel ⇒ no /logout POST and no wipe.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  flushAllPendingEdits: vi.fn(),
}));
vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  confirmDialog: vi.fn(),
}));
vi.mock('../../../resources/js/components/userContainer/cache', () => ({
  clearAllCachedData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  setCurrentUser: vi.fn(),
  clearCurrentUser: vi.fn(),
  broadcastAuthChange: vi.fn(),
  refreshAuth: vi.fn(),
  ensureCsrfToken: vi.fn().mockResolvedValue('test-csrf-token'),
}));
vi.mock('../../../resources/js/utilities/operationState', () => ({
  setPerimeterButtonsHidden: vi.fn(),
}));

import { flushAllPendingEdits } from '../../../resources/js/indexedDB/serverSync/index';
import { confirmDialog } from '../../../resources/js/components/dialog/dialog';
import { clearAllCachedData } from '../../../resources/js/components/userContainer/cache';
import { handleLogout } from '../../../resources/js/components/userContainer/auth';

function makeSelf() {
  document.body.innerHTML = '<div id="user-container"><button id="logout">Log out</button></div>';
  return {
    container: document.getElementById('user-container'),
    user: { name: 'tester' },
    updateButtonColor: vi.fn(),
    closeContainer: vi.fn(),
    performLogoutCleanup: vi.fn(),
    showUserProfile: vi.fn(),
  };
}

describe('handleLogout — unsynced-work gate', () => {
  let fetchMock;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('logs out normally when the flush reports everything synced', async () => {
    vi.mocked(flushAllPendingEdits).mockResolvedValue({ synced: true, pendingBatches: 0, timedOut: false });

    await handleLogout(makeSelf());

    expect(confirmDialog).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/logout', expect.objectContaining({ method: 'POST' }));
    expect(clearAllCachedData).toHaveBeenCalled();
  });

  it('ABORTS the logout (no POST, no wipe) when work is unsent and the user backs out', async () => {
    vi.mocked(flushAllPendingEdits).mockResolvedValue({ synced: false, pendingBatches: 2, timedOut: true });
    vi.mocked(confirmDialog).mockResolvedValue(false); // "Stay signed in"

    await handleLogout(makeSelf());

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();      // session still alive → the retry can still land
    expect(clearAllCachedData).not.toHaveBeenCalled(); // ← the data-loss step, not taken
  });

  it('proceeds when the user accepts losing the unsent work', async () => {
    vi.mocked(flushAllPendingEdits).mockResolvedValue({ synced: false, pendingBatches: 1, timedOut: false });
    vi.mocked(confirmDialog).mockResolvedValue(true); // "Log out anyway"

    await handleLogout(makeSelf());

    expect(fetchMock).toHaveBeenCalledWith('/logout', expect.objectContaining({ method: 'POST' }));
    expect(clearAllCachedData).toHaveBeenCalled();
  });

  it('treats a THROWING flush as unsynced rather than sailing on into the wipe', async () => {
    vi.mocked(flushAllPendingEdits).mockRejectedValue(new Error('IDB exploded'));
    vi.mocked(confirmDialog).mockResolvedValue(false);

    await handleLogout(makeSelf());

    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(clearAllCachedData).not.toHaveBeenCalled();
  });

  it('shows a busy label on #logout while the flush runs, and restores it', async () => {
    let releaseFlush;
    vi.mocked(flushAllPendingEdits).mockImplementation(() => new Promise((resolve) => {
      releaseFlush = () => resolve({ synced: true, pendingBatches: 0, timedOut: false });
    }));

    const self = makeSelf();
    const logoutBtn = self.container.querySelector('#logout');
    const running = handleLogout(self);
    await Promise.resolve();

    expect(logoutBtn.disabled).toBe(true);
    expect(logoutBtn.textContent).toBe('Saving your last changes…');

    releaseFlush();
    await running;

    expect(logoutBtn.disabled).toBe(false);
    expect(logoutBtn.textContent).toBe('Log out');
  });
});
