// deleteAccount.ts — the Data sovereignty "Delete account" flow.
//
// Dialog-only (components/dialog primitives — already focus-trapped and
// inventoried, so this adds no new overlay surface): preview → two scope
// choices → consequences warning (with an export escape hatch) → password +
// typed challenge → POST. On success it runs the LOGOUT TAIL (broadcast,
// clear user, wipe local caches, hard redirect home).
//
// Deliberately NO flushAllPendingEdits before the wipe: the flush-verdict gate
// exists so unsynced edits aren't destroyed by accident, and account deletion
// is the one caller whose explicit purpose is destruction — syncing a last
// batch of edits to an account about to be erased would be work done for the
// shredder. Cancel at any step posts nothing and wipes nothing.
import { alertDialog, choiceDialog, confirmDialog, formDialog } from '../dialog/dialog';
import { clearAllCachedData } from './cache';
import { clearCurrentUser, broadcastAuthChange, ensureCsrfToken } from '../../utilities/auth/index';
import { log } from '../../utilities/logger';

interface DeletionPreview {
  success: boolean;
  public_books: number;
  private_books: number;
  encrypted_books: number;
  annotations: number;
  has_vault: boolean;
}

const CHOICE_OPTIONS = [
  { value: 'delete', label: 'Delete everything', description: 'Erased for everyone, permanently.' },
  { value: 'anonymize', label: 'Keep, anonymized', description: 'Stays public, attributed to a nameless deleted account.' },
  { value: 'keep', label: 'Keep, attributed', description: 'Stays public under your current username (which will no longer link to any account).' },
];

export async function startDeleteAccountFlow(self: any): Promise<void> {
  // 1. Preview — the dialogs speak in the user's real numbers.
  let preview: DeletionPreview;
  try {
    const res = await fetch('/api/user/account-deletion/preview', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    preview = (await res.json()) as DeletionPreview;
    if (!res.ok || !preview.success) throw new Error('preview failed');
  } catch (err) {
    log.error('deleteAccount: preview failed', 'userContainer/deleteAccount.ts', err);
    await alertDialog({ title: 'Something went wrong', message: 'Could not load your account summary. Please try again.' });
    return;
  }

  // 2. Scope choices — only asked when there is anything the choice governs.
  let books = 'delete';
  if (preview.public_books > 0) {
    const picked = await choiceDialog({
      title: `Your ${preview.public_books} published book${preview.public_books === 1 ? '' : 's'}`,
      message: 'Other readers may have cited or highlighted these. What should happen to them?',
      options: CHOICE_OPTIONS,
    });
    if (picked === null) return;
    books = picked;
  }

  let annotations = 'delete';
  if (preview.annotations > 0) {
    const picked = await choiceDialog({
      title: `Your ${preview.annotations} public annotation${preview.annotations === 1 ? '' : 's'}`,
      message: 'Highlights and citations you made on other people’s books. (Private ones are always deleted.)',
      options: CHOICE_OPTIONS,
    });
    if (picked === null) return;
    annotations = picked;
  }

  // 3. Consequences — one honest screen, with an export escape hatch.
  const lines = [
    `${preview.private_books} private/unlisted book${preview.private_books === 1 ? '' : 's'} will be permanently deleted.`,
    preview.encrypted_books > 0
      ? `${preview.encrypted_books} encrypted book${preview.encrypted_books === 1 ? '' : 's'} will be deleted along with your passkey vault — unrecoverable by anyone, including us.`
      : null,
    books === 'keep'
      ? 'Books kept under your name will show a byline that no longer links to any account.'
      : null,
    'Read-count records are anonymized; billing records are retained (nameless) as financial records.',
    'Your username is retired forever — nobody can ever register it.',
    'This is immediate and irreversible. You may want to export your data first (Data sovereignty → Export my data).',
  ].filter(Boolean).join('\n\n');

  const proceed = await confirmDialog({
    title: 'Delete your account?',
    message: lines,
    confirmLabel: 'Continue',
    cancelLabel: 'Keep my account',
    danger: true,
  });
  if (!proceed) return;

  // 4. Password + typed challenge.
  const challenge = 'delete my account';
  const form = await formDialog({
    title: 'Final confirmation',
    message: `Type “${challenge}” and enter your password.`,
    textFields: [
      { key: 'challenge', label: `Type: ${challenge}`, type: 'text', autocomplete: 'off' },
      { key: 'password', label: 'Your password', type: 'password', autocomplete: 'current-password' },
    ],
    confirmLabel: 'Delete my account',
    cancelLabel: 'Cancel',
    danger: true,
  });
  if (!form) return;
  if (form.texts.challenge?.trim().toLowerCase() !== challenge) {
    await alertDialog({ title: 'Not deleted', message: 'The confirmation phrase did not match. Nothing was changed.' });
    return;
  }

  // 5. POST — the account is dead the moment this returns 202.
  try {
    await ensureCsrfToken();
    const token = decodeURIComponent(document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] ?? '');
    const res = await fetch('/api/user/account-deletion', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-XSRF-TOKEN': token,
      },
      body: JSON.stringify({ password: form.texts.password ?? '', books, annotations }),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const message = res.status === 422 && payload?.message
        ? payload.message
        : 'Deletion failed. Nothing was changed. Please try again.';
      await alertDialog({ title: 'Not deleted', message });
      return;
    }
  } catch (err) {
    log.error('deleteAccount: request failed', 'userContainer/deleteAccount.ts', err);
    await alertDialog({ title: 'Not deleted', message: 'Network problem — nothing was changed. Please try again.' });
    return;
  }

  log.user('Account deletion accepted; clearing local data', 'userContainer/deleteAccount.ts');

  // 6. The logout tail (auth.ts handleLogout's success path), minus the flush.
  try {
    broadcastAuthChange('logout'); // other tabs run their own cleanup
    clearCurrentUser();
    self?.updateButtonColor?.();
    await clearAllCachedData(); // wipes IndexedDB incl. historyLog + E2EE keys
    self?.closeContainer?.();
  } catch (err) {
    log.error('deleteAccount: local cleanup error (continuing to redirect)', 'userContainer/deleteAccount.ts', err);
  }

  await alertDialog({
    title: 'Account deleted',
    message: 'Your account is being removed. A confirmation email is on its way.',
  });

  // Full load, not SPA nav — guarantees no stale in-memory state survives.
  window.location.href = '/';
}
