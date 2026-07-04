// Citation-area interactions for the source container. The citation + license
// markup itself is produced by buildSourceHtml; this module owns the
// #privacy-toggle button (public ⇄ private), persisting the change to
// IndexedDB and the backend. Takes the SourceContainerManager as `self`.
import { openDatabase } from '../../indexedDB/index';
import type { LibraryRecord } from '../../indexedDB/types';
import { book } from '../../app';
import { clearEditPermissionCache } from '../../utilities/auth/index';
import { getRecord, PUBLIC_SVG, PRIVATE_SVG } from './helpers';

export async function handlePrivacyToggle(self: any) {
  const btn = self.container.querySelector("#privacy-toggle");
  if (!btn) return;

  // E2EE (docs/e2ee.md): visibility is pinned to private while encrypted —
  // the server would silently force it back anyway. Publishing decrypts first.
  const encryptBtn = self.container.querySelector("#encrypt-toggle");
  if (encryptBtn?.dataset.isEncrypted === "true") {
    alert("This book is encrypted, so it stays private. Use the lock button to publish (permanently decrypts) first.");
    return;
  }

  const isCurrentlyPrivate = btn.dataset.isPrivate === "true";

  const message = isCurrentlyPrivate
    ? "Make this book public? Anyone can view it."
    : "Make this book private? Only you can view it.";

  if (!confirm(message)) return;

  try {
    // Get library record
    const db = await openDatabase();
    const record: LibraryRecord | null = await getRecord(db, "library", book);

    if (!record) {
      alert("Library record not found.");
      return;
    }

    // Update visibility status (string: 'public' or 'private')
    const newVisibility = isCurrentlyPrivate ? 'public' : 'private';
    record.visibility = newVisibility;

    // Keep raw_json in sync with top-level visibility. TODO(raw_json phase-out): raw_json is the
    // @deprecated denormalized copy slated for removal — DELETE this whole block once it's gone (no
    // new readers). Cast for now rather than typing raw_json's fields.
    if (record.raw_json && typeof record.raw_json === 'object') {
      (record.raw_json as { visibility?: string }).visibility = newVisibility;
    }

    // Save to IndexedDB - properly wait for the transaction to complete
    const tx = db.transaction("library", "readwrite");
    const store = tx.objectStore("library");
    await new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    // Sync to backend - use the explicit newVisibility to ensure correct value
    console.log(`📤 Syncing visibility change to backend: ${newVisibility}`);
    await self.syncLibraryRecordToBackend(record);

    // Update button
    btn.dataset.isPrivate = (!isCurrentlyPrivate).toString();
    btn.innerHTML = !isCurrentlyPrivate ? PRIVATE_SVG : PUBLIC_SVG;
    btn.title = !isCurrentlyPrivate
      ? 'Book is Private - Click to make public'
      : 'Book is Public - Click to make private';

    console.log(`✅ Book privacy updated to: ${newVisibility}`);

    clearEditPermissionCache(book);

  } catch (error: any) {
    console.error("Error updating privacy status:", error);
    alert("Error updating privacy status: " + error.message);
  }
}

/**
 * E2EE lock/publish toggle (docs/e2ee.md). Lock = encrypt the book with the
 * user's passkey vault (forces private, drops out of sitewide search).
 * Publish = PERMANENTLY decrypt on the server, then normal visibility rules
 * apply again. Both transitions re-upload the whole book tree.
 */
export async function handleEncryptToggle(self: any) {
  const btn = self.container.querySelector("#encrypt-toggle");
  if (!btn) return;

  const isCurrentlyEncrypted = btn.dataset.isEncrypted === "true";

  const message = isCurrentlyEncrypted
    ? "Publish this book? This PERMANENTLY decrypts it on the server — the server (and anyone you share it with) can read it from then on."
    : "Lock this book with your passkey? It becomes end-to-end encrypted: forced private, removed from sitewide search (searching inside the book still works), and unreadable without your passkey or recovery code.";
  if (!confirm(message)) return;

  btn.disabled = true;
  try {
    const { lockBook, publishBook } = await import("../../e2ee/lifecycle");
    if (isCurrentlyEncrypted) {
      await publishBook(String(book));
    } else {
      const { isVaultUnlocked } = await import("../../e2ee/keys");
      if (!(await isVaultUnlocked())) {
        const { showUnlockModal } = await import("../../e2ee/ui/unlockModal");
        await showUnlockModal(); // throws if dismissed / no vault yet
      }
      await lockBook(String(book));
    }

    const nowEncrypted = !isCurrentlyEncrypted;
    btn.dataset.isEncrypted = nowEncrypted.toString();
    btn.textContent = nowEncrypted ? "🔐" : "🔓";
    btn.title = nowEncrypted
      ? "Encrypted — click to publish (permanently decrypts on the server)"
      : "Not encrypted — click to lock with your passkey";
    clearEditPermissionCache(book);
    alert(nowEncrypted ? "Book locked — it is now end-to-end encrypted." : "Book published — it is decrypted on the server; you can now make it public.");
  } catch (error: any) {
    alert(
      error?.name === "PasskeyError" || /passkey|vault/i.test(String(error?.message))
        ? error.message
        : "Encryption change failed: " + (error?.message ?? "unknown error"),
    );
  } finally {
    btn.disabled = false;
  }
}
