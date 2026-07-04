/**
 * E2EE book lifecycle (docs/e2ee.md): lock (encrypt), publish (decrypt
 * permanently), and the open-gate used by the reader before content loads.
 *
 * Both transitions follow the same shape: flip the server flag first (the
 * transition endpoint also pins visibility and scrubs derived plaintext),
 * then full-push the book tree through the blocking sync — which encrypts or
 * passes plaintext according to the NEW flag. The interim window is always
 * private-only, so nothing public ever shows ciphertext.
 */

import { ensureCsrfToken } from '../utilities/auth/csrf';
import { getConnection } from '../indexedDB/core/connection';
import { log } from '../utilities/logger';
import { createDekForBook, isVaultUnlocked, clearKeyCaches } from './keys';
import { setBookEncrypted, rootBookId } from './registry';

export class E2eeLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeLifecycleError';
  }
}

async function postTransition(
  bookId: string,
  body: Record<string, unknown>,
): Promise<{ tree: string[] }> {
  const csrfToken = await ensureCsrfToken();
  if (!csrfToken) throw new E2eeLifecycleError("Couldn't start a secure session — please try again");

  const response = await fetch(`/api/db/library/${encodeURIComponent(bookId)}/encryption`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'X-XSRF-TOKEN': csrfToken,
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    message?: string;
    tree?: string[];
  };
  if (!response.ok || data.success !== true) {
    throw new E2eeLifecycleError(data.message || `Encryption transition failed (${response.status})`);
  }
  return { tree: Array.isArray(data.tree) && data.tree.length ? data.tree : [bookId] };
}

/**
 * Pull the WHOLE tree into local IDB before re-pushing it. The tree comes from
 * the SERVER (a lock/publish must cover sub-books this device never opened) —
 * a partial local copy re-pushed through the nuclear per-store upsert would
 * otherwise drop the missing nodes. The full-data endpoint routes slash ids to
 * the sub-book variant, so one call shape covers both.
 */
async function pullBookTree(tree: string[]): Promise<void> {
  const { syncBookDataFromDatabase } = await import('../indexedDB/serverSync/pull');
  for (const id of tree) {
    const result = await syncBookDataFromDatabase(id);
    if (result && result.success === false && result.reason !== 'book_not_found') {
      throw new E2eeLifecycleError(`Could not download "${id}" before the transition (${result.reason ?? 'pull failed'})`);
    }
  }
}

/** Patch the local library record's E2EE fields (IDB is plaintext by design). */
async function patchLocalLibrary(bookId: string, patch: Record<string, unknown>): Promise<void> {
  const db = await getConnection();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('library', 'readwrite');
    const store = tx.objectStore('library');
    const get = store.get(bookId);
    get.onsuccess = () => {
      if (get.result) store.put({ ...get.result, ...patch });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Full-push every tree id through the per-store push (nodes, annotations,
 * footnotes, bibliography, library) — its E2EE seam encrypts or passes
 * plaintext according to the registry flag at push time.
 */
async function pushBookTree(tree: string[]): Promise<void> {
  const { syncIndexedDBtoPostgreSQL } = await import('../indexedDB/serverSync/push');
  for (const id of tree) {
    await syncIndexedDBtoPostgreSQL(id);
  }
}

/**
 * Lock (encrypt) an existing book. Requires an unlocked vault. Explicit user
 * action per book — never automatic. Removes the book from server keyword
 * search (in-book search is unaffected; IndexedDB stays plaintext locally).
 */
export async function lockBook(bookId: string): Promise<void> {
  const root = rootBookId(bookId);
  if (!(await isVaultUnlocked())) {
    throw new E2eeLifecycleError('Unlock your encrypted books first (passkey required)');
  }

  const { wrappedDek } = await createDekForBook(root);
  // Flags flip first — the server pins private/unlisted and scrubs derived
  // plaintext, but the CONTENT columns stay readable-plaintext until the
  // ciphertext push below overwrites them (private-only window).
  const { tree } = await postTransition(root, { encrypted: true, wrapped_dek: wrappedDek });

  setBookEncrypted(root, true);
  await patchLocalLibrary(root, {
    encrypted: true,
    wrapped_dek: wrappedDek,
    visibility: 'private',
    listed: false,
    slug: null,
  });

  // Complete-then-push: the plaintext rows pass the decrypt seam untouched.
  await pullBookTree(tree);
  await pushBookTree(tree);
  log.user(`Book locked (E2EE): ${root}`, '/e2ee/lifecycle.ts');
}

/**
 * Publish (permanently decrypt) an encrypted book: flags off server-side,
 * then the plaintext tree is re-uploaded. The caller confirms with the user
 * FIRST — this is a one-way door until they lock again (new DEK).
 */
export async function publishBook(bookId: string): Promise<void> {
  const root = rootBookId(bookId);

  // Warm the DEK cache BEFORE the server clears wrapped_dek — the pull below
  // downloads ciphertext rows and the decrypt seam needs the key one last time.
  const { getDekForBook } = await import('./keys');
  await getDekForBook(root).catch(() => {
    throw new E2eeLifecycleError('Unlock your encrypted books first (passkey required)');
  });

  const { tree } = await postTransition(root, { encrypted: false });

  setBookEncrypted(root, false);
  await patchLocalLibrary(root, { encrypted: false, wrapped_dek: null });

  // Pull decrypts the remaining ciphertext locally (cached DEK), then the
  // push re-uploads plaintext — the seam passes it through (flag is off).
  await pullBookTree(tree);
  await pushBookTree(tree);
  log.user(`Book published (decrypted): ${root}`, '/e2ee/lifecycle.ts');
}

/**
 * Reader open-gate: resolve once the book is readable. Plaintext books and
 * already-unlocked vaults resolve immediately; otherwise the unlock modal
 * runs (passkey or recovery code). Rejects if the user dismisses it.
 */
export async function ensureUnlockedForBook(bookId: string): Promise<void> {
  const root = rootBookId(bookId);
  const db = await getConnection();
  const record = await new Promise<{ encrypted?: boolean } | undefined>((resolve, reject) => {
    const req = db.transaction('library', 'readonly').objectStore('library').get(root);
    req.onsuccess = () => resolve(req.result as { encrypted?: boolean } | undefined);
    req.onerror = () => reject(req.error);
  });
  // Unknown-locally books resolve too: if the server row is encrypted, the
  // library loader records the flag and the DECRYPT path throws VaultLockedError,
  // which the caller routes back through this gate via the modal.
  if (record?.encrypted !== true) return;
  if (await isVaultUnlocked()) return;

  const { showUnlockModal } = await import('./ui/unlockModal');
  await showUnlockModal();
}

/** Logout hook: drop in-memory keys (IDB wipe is handled by clearDatabase). */
export function lockSessionCaches(): void {
  clearKeyCaches();
}
