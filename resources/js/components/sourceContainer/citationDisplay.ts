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
