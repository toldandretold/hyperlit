/**
 * Evict one book from the reader's local cache (same-origin IndexedDB —
 * "MarkdownDB", shared with the framed readers) so the next pane load does a
 * genuinely fresh server sync.
 *
 * WHY: approve/revert mutate the citing book's nodes server-side and bump its
 * clocks, but the framed reader's freshness heuristics run against whatever
 * library/nodes rows are already cached — and a pane force-reloaded seconds
 * after the mutation has been observed rendering the STALE cached node (the
 * reverted ↗ still visible while Postgres was clean). Deleting the book's
 * nodes + library rows sidesteps every heuristic: no local copy, full fetch.
 *
 * Opened WITHOUT a version so no upgrade/versionchange can fire (two framed
 * readers already race those). Missing DB or stores → quiet no-op.
 */

import { verbose } from '../utilities/logger';

export function purgeBookFromIdb(book: string): Promise<void> {
  return new Promise((resolvePurge) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolvePurge();
      }
    };

    try {
      const open = indexedDB.open('MarkdownDB');
      open.onerror = done;
      open.onsuccess = () => {
        const db = open.result;
        try {
          // nodes/hypercites/hyperlights are keyed [book, x]; library by book.
          // Annotations must go too: an approve/revert changes the CITED
          // book's hypercites without touching its nodes, and a pane reloaded
          // against cached annotation rows misses the new underline.
          const compound = ['nodes', 'hypercites', 'hyperlights'];
          const stores = [...compound, 'library'].filter((s) => db.objectStoreNames.contains(s));
          if (!stores.length) {
            db.close();
            done();
            return;
          }
          const tx = db.transaction(stores, 'readwrite');
          for (const name of compound) {
            if (stores.includes(name)) {
              // [book] sorts before every [book, x] and [book, []] after
              // (arrays order above numbers and strings).
              tx.objectStore(name).delete(IDBKeyRange.bound([book], [book, []]));
            }
          }
          if (stores.includes('library')) {
            tx.objectStore('library').delete(book);
          }
          tx.oncomplete = () => {
            db.close();
            verbose.nav(`hypercites: purged ${book} from local cache`, 'maintainerHypercites');
            done();
          };
          tx.onerror = () => {
            db.close();
            done();
          };
        } catch {
          db.close();
          done();
        }
      };
    } catch {
      done();
    }
  });
}
