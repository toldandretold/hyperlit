/**
 * The account-deletion flow: cancel anywhere ⇒ nothing posted, nothing wiped;
 * success ⇒ wipe + cross-tab broadcast — and NO flushAllPendingEdits call,
 * because the one caller whose purpose is destruction must not sync edits into
 * the shredder (deliberate inversion of the logout flush gate).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../resources/js/components/dialog/dialog', () => ({
  alertDialog: vi.fn().mockResolvedValue(undefined),
  choiceDialog: vi.fn(),
  confirmDialog: vi.fn(),
  formDialog: vi.fn(),
}));
vi.mock('../../../resources/js/components/userContainer/cache', () => ({
  clearAllCachedData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../resources/js/utilities/auth/index', () => ({
  clearCurrentUser: vi.fn(),
  broadcastAuthChange: vi.fn(),
  ensureCsrfToken: vi.fn().mockResolvedValue('tok'),
}));
vi.mock('../../../resources/js/indexedDB/serverSync/index', () => ({
  flushAllPendingEdits: vi.fn(),
}));

import { choiceDialog, confirmDialog, formDialog } from '../../../resources/js/components/dialog/dialog';
import { clearAllCachedData } from '../../../resources/js/components/userContainer/cache';
import { broadcastAuthChange } from '../../../resources/js/utilities/auth/index';
import { flushAllPendingEdits } from '../../../resources/js/indexedDB/serverSync/index';
import { startDeleteAccountFlow } from '../../../resources/js/components/userContainer/deleteAccount';

const PREVIEW = {
  success: true, public_books: 2, private_books: 1, encrypted_books: 0, annotations: 3, has_vault: false,
};

function makeSelf() {
  return { updateButtonColor: vi.fn(), closeContainer: vi.fn() };
}

describe('startDeleteAccountFlow', () => {
  let fetchMock;
  let originalLocation;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/preview')) {
        return { ok: true, status: 200, json: async () => PREVIEW };
      }
      return { ok: true, status: 202, json: async () => ({ success: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    // jsdom/happy-dom lets us stub the redirect target.
    originalLocation = window.location;
    delete window.location;
    window.location = { href: '' };
    return () => { window.location = originalLocation; };
  });

  it('cancelling the first choice posts nothing and wipes nothing', async () => {
    vi.mocked(choiceDialog).mockResolvedValue(null);

    await startDeleteAccountFlow(makeSelf());

    expect(fetchMock).toHaveBeenCalledTimes(1); // the preview only
    expect(clearAllCachedData).not.toHaveBeenCalled();
    expect(broadcastAuthChange).not.toHaveBeenCalled();
  });

  it('cancelling the consequences screen posts nothing', async () => {
    vi.mocked(choiceDialog).mockResolvedValue('delete');
    vi.mocked(confirmDialog).mockResolvedValue(false);

    await startDeleteAccountFlow(makeSelf());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clearAllCachedData).not.toHaveBeenCalled();
  });

  it('a wrong typed challenge refuses without posting', async () => {
    vi.mocked(choiceDialog).mockResolvedValue('delete');
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(formDialog).mockResolvedValue({ radio: null, number: '', texts: { challenge: 'nope', password: 'pw' } });

    await startDeleteAccountFlow(makeSelf());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clearAllCachedData).not.toHaveBeenCalled();
  });

  it('success posts the choices, wipes local data, broadcasts cross-tab, never flushes', async () => {
    const self = makeSelf();
    vi.mocked(choiceDialog)
      .mockResolvedValueOnce('anonymize') // books
      .mockResolvedValueOnce('keep'); // annotations
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(formDialog).mockResolvedValue({ radio: null, number: '', texts: { challenge: 'Delete My Account', password: 'pw' } });

    await startDeleteAccountFlow(self);

    const post = fetchMock.mock.calls.find(([url]) => !String(url).includes('/preview'));
    expect(post).toBeTruthy();
    expect(JSON.parse(post[1].body)).toEqual({ password: 'pw', books: 'anonymize', annotations: 'keep' });

    expect(broadcastAuthChange).toHaveBeenCalledWith('logout');
    expect(clearAllCachedData).toHaveBeenCalled();
    expect(flushAllPendingEdits).not.toHaveBeenCalled();
    expect(window.location.href).toBe('/');
  });

  it('a server refusal (wrong password) leaves local data alone', async () => {
    vi.mocked(choiceDialog).mockResolvedValue('delete');
    vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(formDialog).mockResolvedValue({ radio: null, number: '', texts: { challenge: 'delete my account', password: 'wrong' } });
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/preview')) return { ok: true, status: 200, json: async () => PREVIEW };
      return { ok: false, status: 422, json: async () => ({ success: false, message: 'Incorrect password' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await startDeleteAccountFlow(makeSelf());

    expect(clearAllCachedData).not.toHaveBeenCalled();
    expect(broadcastAuthChange).not.toHaveBeenCalled();
    expect(window.location.href).toBe('');
  });
});
