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
import { createDekForBook, getDekForBook, isVaultUnlocked, clearKeyCaches } from './keys';
import { setBookEncrypted, rootBookId } from './registry';
import { runPool, type ProgressFn } from './pool';

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
async function pullBookTree(tree: string[], onProgress?: ProgressFn): Promise<void> {
  const { syncBookDataFromDatabase } = await import('../indexedDB/serverSync/pull');
  const failures = await runPool(tree, async (id) => {
    const result = await syncBookDataFromDatabase(id);
    if (result && result.success === false && result.reason !== 'book_not_found') {
      throw new Error(result.reason ?? 'pull failed');
    }
  }, { onProgress });
  if (failures.length) {
    throw new E2eeLifecycleError(`Could not download ${failures.length} of ${tree.length} book parts — try again`);
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
 * plaintext according to the registry flag at push time. Parallel + retried:
 * a failure re-pushes rather than aborting the whole lock.
 */
async function pushBookTree(tree: string[], onProgress?: ProgressFn): Promise<void> {
  const { syncIndexedDBtoPostgreSQL } = await import('../indexedDB/serverSync/push');
  const failures = await runPool(tree, (id) => syncIndexedDBtoPostgreSQL(id).then(() => undefined), { onProgress });
  if (failures.length) {
    throw new E2eeLifecycleError(`Could not encrypt ${failures.length} of ${tree.length} book parts — try again`);
  }
}

/** Read a book's local library record (for the resume/fresh decision). */
async function getLocalLibrary(bookId: string): Promise<{ encrypted?: boolean; wrapped_dek?: string | null } | undefined> {
  const db = await getConnection();
  return new Promise((resolve, reject) => {
    const req = db.transaction('library', 'readonly').objectStore('library').get(bookId);
    req.onsuccess = () => resolve(req.result as { encrypted?: boolean; wrapped_dek?: string | null } | undefined);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Lock (encrypt) an existing book. Requires an unlocked vault. Explicit user
 * action per book — never automatic. Removes the book from server keyword
 * search (in-book search is unaffected; IndexedDB stays plaintext locally).
 */
export async function lockBook(bookId: string, onStatus?: (message: string) => void): Promise<void> {
  const root = rootBookId(bookId);
  if (!(await isVaultUnlocked())) {
    throw new E2eeLifecycleError('Unlock your encrypted books first (passkey required)');
  }

  // Resume vs fresh: ANY stored wrapped DEK — from a partial lock OR an
  // unfinished publish — must be REUSED, never replaced: ciphertext bound to it
  // (image blobs, undecrypted parts) may still exist, and minting a new key
  // would orphan that ciphertext permanently. (The server refuses to overwrite
  // a stored wrapped_dek for the same reason.) Only a truly DEK-less book
  // creates a fresh key.
  const existing = await getLocalLibrary(root);
  const resuming = !!existing?.wrapped_dek;

  onStatus?.('Preparing…');
  let wrappedDek: string | null = null;
  if (resuming) {
    await getDekForBook(root); // unwrap the existing DEK into the session cache
  } else {
    ({ wrappedDek } = await createDekForBook(root));
  }

  // Flag flip (idempotent server-side): pins private/unlisted, keeps the
  // existing wrapped_dek on resume, and returns the full tree. Content columns
  // stay readable-plaintext until the ciphertext push below overwrites them
  // (private-only window).
  const { tree } = await postTransition(root, wrappedDek ? { encrypted: true, wrapped_dek: wrappedDek } : { encrypted: true });

  setBookEncrypted(root, true);
  await patchLocalLibrary(root, {
    encrypted: true,
    wrapped_dek: wrappedDek ?? existing?.wrapped_dek,
    visibility: 'private',
    listed: false,
    slug: null,
  });

  // Complete-then-push (parallel + retried): pull the whole tree, then push it
  // back as ciphertext. Already-ciphertext parts re-push idempotently on a resume.
  await pullBookTree(tree, (d, t) => onStatus?.(`Downloading ${d}/${t}…`));
  await pushBookTree(tree, (d, t) => onStatus?.(`Encrypting ${d}/${t}…`));

  // Encrypt the image bytes (idempotent — already-encrypted rows skip).
  onStatus?.('Encrypting images…');
  const { encryptBookImages } = await import('./imageBlobs');
  await encryptBookImages(root);

  // ...and the TTS audio bytes (spoken plaintext of the book — same pattern).
  onStatus?.('Encrypting audio…');
  const { encryptBookAudio } = await import('./audioBlobs');
  await encryptBookAudio(root, (d, t) => onStatus?.(`Encrypting audio ${d}/${t}…`));
  log.user(`Book locked (E2EE): ${root}`, '/e2ee/lifecycle.ts');
}

/**
 * Publish (permanently decrypt) an encrypted book: flags off server-side,
 * then the plaintext tree is re-uploaded. The caller confirms with the user
 * FIRST — this is a one-way door until they lock again (new DEK).
 */
export async function publishBook(bookId: string, onStatus?: (message: string) => void): Promise<void> {
  const root = rootBookId(bookId);

  // Warm the DEK cache — the pull + image decrypt below need the key.
  await getDekForBook(root).catch(() => {
    throw new E2eeLifecycleError('Unlock your encrypted books first (passkey required)');
  });

  // Phase 1: flip the flag off but KEEP wrapped_dek. Clearing the only copy of
  // the DEK before the ciphertext (content + images) is gone would make a
  // failed decrypt PERMANENT data loss — so the key survives until finalize.
  onStatus?.('Preparing…');
  const { tree } = await postTransition(root, { encrypted: false });
  setBookEncrypted(root, false);
  await patchLocalLibrary(root, { encrypted: false }); // wrapped_dek retained locally too

  // Pull decrypts the remaining ciphertext locally (cached DEK), then the push
  // re-uploads plaintext — the seam passes it through (flag is off now).
  await pullBookTree(tree, (d, t) => onStatus?.(`Downloading ${d}/${t}…`));
  await pushBookTree(tree, (d, t) => onStatus?.(`Decrypting ${d}/${t}…`));

  // Decrypt the image bytes (robust + retried). Throws if any can't be
  // decrypted — and because wrapped_dek is still intact, that state is
  // recoverable (re-open finishes it) rather than lost.
  onStatus?.('Decrypting images…');
  const { decryptBookImages } = await import('./imageBlobs');
  await decryptBookImages(root, (d, t) => onStatus?.(`Decrypting images ${d}/${t}…`));

  // ...and the TTS audio bytes back to playable MP3s.
  onStatus?.('Decrypting audio…');
  const { decryptBookAudio } = await import('./audioBlobs');
  await decryptBookAudio(root, (d, t) => onStatus?.(`Decrypting audio ${d}/${t}…`));

  // Phase 2 (finalize): everything is plaintext — NOW clear the wrapped DEK on
  // the whole tree. This is the one-way door.
  await postTransition(root, { encrypted: false, finalize: true });
  await patchLocalLibrary(root, { wrapped_dek: null });
  log.user(`Book published (decrypted): ${root}`, '/e2ee/lifecycle.ts');
}

/**
 * Reader open-gate: resolve once the book is readable. Plaintext books and
 * already-unlocked vaults resolve immediately; otherwise the unlock modal
 * runs (passkey or recovery code). Rejects if the user dismisses it.
 */
export async function ensureUnlockedForBook(bookId: string): Promise<void> {
  const root = rootBookId(bookId);
  const record = await getLocalLibrary(root);

  // Self-heal an incomplete publish: the flag is off but a wrapped DEK lingers,
  // meaning a prior decrypt didn't finish (some image bytes may still be
  // ciphertext → they'd render broken). If the vault is already unlocked, finish
  // it in the background; never prompt (this is a non-encrypted book). Failures
  // are LOGGED (a silent swallow here cost a debugging round).
  if (record?.encrypted !== true && record?.wrapped_dek && (await isVaultUnlocked())) {
    void finishIncompletePublish(root).catch((error) => {
      log.error(`Incomplete-publish self-heal failed: ${root}`, '/e2ee/lifecycle.ts', error);
    });
    return;
  }

  // Unknown-locally books resolve too: if the server row is encrypted, the
  // library loader records the flag and the DECRYPT path throws VaultLockedError,
  // which the caller routes back through this gate via the modal.
  if (record?.encrypted !== true) return;
  if (await isVaultUnlocked()) return;

  const { showUnlockModal } = await import('./ui/unlockModal');
  await showUnlockModal();
}

/** Is this book stuck mid-publish (flag off but a wrapped DEK lingering)? */
export async function hasIncompletePublish(bookId: string): Promise<boolean> {
  const root = rootBookId(bookId);
  const record = await getLocalLibrary(root);
  return record?.encrypted !== true && !!record?.wrapped_dek;
}

/**
 * Finish a publish that died after the flag flipped off but before the DEK was
 * cleared — decrypt any still-ciphertext images, then finalize (clear the DEK).
 * Requires an unlocked vault. Throws on failure (wrapped_dek stays intact, so
 * it's always retryable). Called from the open-gate (background) and from the
 * visibility control (so the user's own click repairs the book).
 */
export async function finishIncompletePublish(bookId: string, onStatus?: (message: string) => void): Promise<void> {
  const root = rootBookId(bookId);
  onStatus?.('Decrypting images…');
  const { decryptBookImages } = await import('./imageBlobs');
  await decryptBookImages(root, (d, t) => onStatus?.(`Decrypting images ${d}/${t}…`));
  onStatus?.('Decrypting audio…');
  const { decryptBookAudio } = await import('./audioBlobs');
  await decryptBookAudio(root, (d, t) => onStatus?.(`Decrypting audio ${d}/${t}…`));
  await postTransition(root, { encrypted: false, finalize: true });
  await patchLocalLibrary(root, { wrapped_dek: null });
  log.user(`Finished an incomplete publish: ${root}`, '/e2ee/lifecycle.ts');
}

/** Logout hook: drop in-memory keys (IDB wipe is handled by clearDatabase). */
export function lockSessionCaches(): void {
  clearKeyCaches();
  // Revoke decrypted image + audio blob URLs too (only valid while unlocked).
  void import('../lazyLoader/encryptedImages').then(({ clearImageBlobCache }) => clearImageBlobCache());
  void import('../components/audioPlayer/encryptedAudio').then(({ clearAudioBlobCache }) => clearAudioBlobCache());
}
