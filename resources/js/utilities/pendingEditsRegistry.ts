/**
 * Pending-edit flush registry — a zero-import leaf (the initXDependencies/DI idiom).
 *
 * The editor (divEditor) and footnote annotations hold debounced/buffered edits. Before a hyperlit
 * container closes or the page unloads, those buffers must be flushed so nothing is lost. Previously
 * `hyperlitContainer/{core,stack}` and `indexedDB/syncQueue/unload` reached UP into `divEditor` and
 * `footnotes` via `await import()` to do this — a dependency pointing the wrong way, deferred to
 * runtime only to dodge a circular import (a "cycle-breaker").
 *
 * Inversion: producers register a flush callback here at module load; consumers call
 * `flushPendingEdits()` — importing only this leaf, never the feature modules. Imports point DOWN.
 *
 * (NB: distinct from postgreSQL.js `flushAllPendingEdits`, which is the broader clear+redownload
 * pipeline that also kicks masterSync. This one is just the editor/footnote buffers.)
 */

type FlushFn = () => void | Promise<void>;

const flushers = new Set<FlushFn>();

/** Register a buffer-flush callback (called by divEditor + footnotes at module load). */
export function registerPendingEditFlush(fn: FlushFn): void {
  flushers.add(fn);
}

/** Run every registered flush (await async ones). Safe to call when nothing is pending — each
 *  registered flush is itself a no-op when its buffer is empty. */
export async function flushPendingEdits(): Promise<void> {
  for (const fn of flushers) {
    try {
      await fn();
    } catch (e) {
      console.warn('[pendingEdits] a registered flush failed:', e);
    }
  }
}
