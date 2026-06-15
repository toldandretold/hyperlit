/**
 * serverSync/flush — drain the whole edit pipeline to the server before a
 * destructive clear+redownload (or logout), so no unsaved work is lost.
 *
 * Pipeline: footnote debounces → input debounce → SaveQueue → masterSync.
 * Split out of the former resources/js/postgreSQL.js.
 */
import { verbose } from '../../utilities/logger';

/**
 * Flush the entire editing pipeline to ensure no pending edits are lost.
 * Called before clearing IndexedDB data so unsaved work reaches the server first.
 */
export async function flushAllPendingEdits(): Promise<void> {
  // Fast path: nothing to flush if not editing and no pending syncs
  try {
    const { pendingSyncs } = await import('../syncQueue/queue');
    if (!(window as any).isEditing && pendingSyncs.size === 0) {
      return;
    }
  } catch (e) {
    // If we can't even check, proceed with flush attempts
  }

  verbose.content('Flushing all pending edits before clear+redownload', 'serverSync/flush');

  // 1. Flush footnote annotation debounces
  try {
    const { flushPendingFootnoteSaves } = await import('../../footnotes/footnoteAnnotations');
    flushPendingFootnoteSaves();
  } catch (e: any) {
    verbose.content(`Footnote flush skipped: ${e.message}`, 'serverSync/flush');
  }

  // 2. Flush input debounce (200ms timer)
  try {
    const { flushInputDebounce } = await import('../../divEditor/index');
    flushInputDebounce();
  } catch (e: any) {
    verbose.content(`Input debounce flush skipped: ${e.message}`, 'serverSync/flush');
  }

  // 3. Flush SaveQueue → IndexedDB (1.5s timer)
  try {
    const { flushAllPendingSaves } = await import('../../divEditor/index');
    await flushAllPendingSaves();
  } catch (e: any) {
    verbose.content(`SaveQueue flush skipped: ${e.message}`, 'serverSync/flush');
  }

  // 4. Flush masterSync → server (3s timer) with 5s timeout
  try {
    const { debouncedMasterSync } = await import('../syncQueue/master');
    await Promise.race([
      debouncedMasterSync.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (e: any) {
    verbose.content(`masterSync flush skipped: ${e.message}`, 'serverSync/flush');
  }

  verbose.content('Pending edits flushed', 'serverSync/flush');
}
