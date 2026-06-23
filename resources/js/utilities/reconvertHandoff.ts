// Zero-import leaf — coordinates the "reconvert just finished, load fresh + correctly ordered"
// hand-off across the full page reload that reconvert triggers.
//
// Why this exists: reconvert clears IndexedDB then reloads. On the reload the reader would find
// IDB empty and take the racey fresh-load path (loadFromJSONFiles vs the background chunk
// downloader), which interleaves renders → scrambled node order until a SECOND manual refresh
// (by which point IDB is populated and the deterministic cached path runs). This leaf lets:
//   • reconvert.ts          — mark the hand-off + show a blocking overlay before reloading,
//   • readerEntry.ts        — re-populate IDB fresh + ordered BEFORE first render (behind overlay),
//   • loadHyperText.ts      — force-fresh the *.json fetches while the hand-off is active,
//   • backgroundDownload.ts — pause the racing chunk download while the hand-off is active.
//
// It is import-free on purpose (safe to import from any layer without cycle risk).

const HANDOFF_KEY = 'hyperlit:reconvertedBook';
const OVERLAY_ID = 'reconvert-blocking-overlay';

// ── hand-off flag (survives the reload via sessionStorage) ──────────────────────────────
export function setReconvertHandoff(bookId: string): void {
  try { sessionStorage.setItem(HANDOFF_KEY, bookId); } catch { /* private mode / no storage */ }
}
export function getReconvertHandoff(): string | null {
  try { return sessionStorage.getItem(HANDOFF_KEY); } catch { return null; }
}
export function isReconvertHandoff(bookId?: string): boolean {
  const v = getReconvertHandoff();
  if (!v) return false;
  return bookId ? v === bookId : true;
}
export function clearReconvertHandoff(): void {
  try { sessionStorage.removeItem(HANDOFF_KEY); } catch { /* noop */ }
}

// ── pre-reload runtime guard (the polling window, before the reload happens) ─────────────
export function setReconvertInProgress(v: boolean): void {
  try { (window as any)._reconvertInProgress = v; } catch { /* noop */ }
}
export function isReconvertInProgress(): boolean {
  try { return !!(window as any)._reconvertInProgress; } catch { return false; }
}

// True while a reconvert is mid-flight OR a just-reconverted book is doing its gated first load.
export function reconvertSyncActive(bookId?: string): boolean {
  return isReconvertInProgress() || isReconvertHandoff(bookId);
}

// ── blocking overlay (opaque cover so the user never sees the interim state) ─────────────
export function showReconvertOverlay(message = 'Reconverting…'): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (document.getElementById(OVERLAY_ID)) { updateReconvertOverlay(message); return; }
  const el = document.createElement('div');
  el.id = OVERLAY_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;' +
    'gap:10px;background:var(--hyperlit-bg,#1a1a1a);color:var(--hyperlit-orange,#ef8d34);' +
    'font-size:15px;font-family:inherit;';
  el.innerHTML =
    '<span style="width:16px;height:16px;border:2px solid currentColor;border-top-color:transparent;' +
    'border-radius:50%;display:inline-block;animation:reconvertspin 0.8s linear infinite;"></span>' +
    '<span data-reconvert-msg></span>' +
    '<style>@keyframes reconvertspin{to{transform:rotate(360deg)}}</style>';
  document.body.appendChild(el);
  updateReconvertOverlay(message);
}
export function updateReconvertOverlay(message: string): void {
  if (typeof document === 'undefined') return;
  const msg = document.querySelector(`#${OVERLAY_ID} [data-reconvert-msg]`);
  if (msg) msg.textContent = message;
}
export function hideReconvertOverlay(): void {
  if (typeof document === 'undefined') return;
  document.getElementById(OVERLAY_ID)?.remove();
}
