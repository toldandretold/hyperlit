/**
 * Beacon outbox — pre-encrypted mirror of encrypted-book sync items.
 *
 * The unload beacon (syncQueue/unload.ts) reads `pendingSyncs` SYNCHRONOUSLY
 * at pagehide, but WebCrypto is async — so ciphertext must exist BEFORE the
 * page dies. queueForSync fire-and-forgets capture() on every enqueue: for
 * encrypted-book items it encrypts the item's data (usually settles in ms)
 * into a parallel map under the same queue key. At beacon time the outbox
 * copy is substituted; encrypted items not yet captured are SKIPPED and left
 * queued (a rare loss window comparable to a failed sendBeacon, and largely
 * covered by the visibilitychange full flush that precedes most page-hides).
 *
 * Plaintext-book items never enter the outbox.
 */

import { isBookEncrypted, rootBookId } from './registry';

interface OutboxItem {
  /** The queue item's `data`, with content fields encrypted. */
  data: Record<string, unknown>;
}

const outbox = new Map<string, OutboxItem>();
// Guards against an older (slower) capture overwriting a newer one.
const captureSeq = new Map<string, number>();

/**
 * Fire-and-forget: encrypt an enqueued item's data into the outbox.
 * Never throws (a failed capture just means the beacon skips the item).
 */
export function captureForBeacon(key: string, store: string, data: Record<string, unknown> | null): void {
  const book = typeof data?.book === 'string' ? data.book : '';
  if (!data || !book || !isBookEncrypted(book)) return;

  const seq = (captureSeq.get(key) ?? 0) + 1;
  captureSeq.set(key, seq);
  outbox.delete(key); // the previous ciphertext is stale the moment new data queues

  void (async () => {
    try {
      const [{ encryptRecordForStore }, { getDekForBook }] = await Promise.all([
        import('./transform'),
        import('./keys'),
      ]);
      const dek = await getDekForBook(book);
      const encrypted = await encryptRecordForStore(store, data, dek, rootBookId(book));
      if (captureSeq.get(key) === seq) {
        outbox.set(key, { data: encrypted });
      }
    } catch {
      // Vault locked or encryption failed — leave no entry; the beacon skips it.
      if (captureSeq.get(key) === seq) outbox.delete(key);
    }
  })();
}

/** The pre-encrypted data for a queue key, if capture has settled. */
export function getBeaconCiphertext(key: string): Record<string, unknown> | undefined {
  return outbox.get(key)?.data;
}

/** Drop one key (item sent or dequeued). */
export function discardBeaconCiphertext(key: string): void {
  outbox.delete(key);
  captureSeq.delete(key);
}

/** Drop everything (mirrors pendingSyncs.clear()). */
export function clearBeaconOutbox(): void {
  outbox.clear();
  captureSeq.clear();
}

/** Test hook: number of captured entries. */
export function beaconOutboxSize(): number {
  return outbox.size;
}
