/**
 * Target-not-found capture — installed via page.addInitScript before page scripts.
 *
 * Records every "Couldn't find 'X' — showing start of book" toast
 * (`#target-not-found-toast`, rendered by `resources/js/components/toast/toast.ts`) with the URL
 * and rendered book at the moment it mounted.
 *
 * WHY THIS IS A GLOBAL CAPTURE AND NOT A PER-SPEC ASSERTION
 *
 * That toast is the app saying "you asked me to go somewhere that isn't here, so I gave up and
 * showed you the top of the book". Whatever produced it, the reader's position was thrown away
 * and they are looking at content they didn't ask for. Nothing throws, no console error is
 * emitted, and the URL/structure/registry all stay valid — so every end-state assertion in this
 * suite passes straight through it. It was found by a human WATCHING a green run: a parent book's
 * `HL_…` replayed onto the `/AIreview` sub-book during a back/forward burst, which opened a
 * container over text containing no such highlight. 18/18 passed.
 *
 * It also self-dismisses after 4s, so sampling DOM state between steps cannot see it reliably —
 * hence hooking the mount rather than polling for the element.
 *
 * Toasts are mirrored into sessionStorage because `addInitScript` re-runs per document: a
 * `page.goto` mid-test would otherwise reset the in-page array and lose everything before it.
 *
 * No app-code changes. Pure observation.
 */
export const targetNotFoundCaptureScript = () => {
  if (window.__targetNotFoundCaptureInstalled) return;
  window.__targetNotFoundCaptureInstalled = true;

  const KEY = '__e2eTargetNotFoundToasts';

  const readAll = () => {
    try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { return []; }
  };

  // Expose a getter rather than a plain array so a cross-document read still sees everything.
  window.__getTargetNotFoundToasts = readAll;

  /**
   * Which book actually owns the id the toast names? That single fact splits the failure modes:
   * owned by ANOTHER book → a stale target replayed across a book change; owned by THIS book →
   * a chunk/record that hadn't arrived; owned by nobody → genuinely deleted or never synced.
   * Enriched asynchronously (the appendChild hook must stay synchronous) and written back.
   */
  const enrichOwner = async (index, targetId) => {
    try {
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open('MarkdownDB');
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
      const ownersIn = (storeName, indexName) => new Promise((res) => {
        try {
          const store = db.transaction(storeName, 'readonly').objectStore(storeName);
          if (!store.indexNames.contains(indexName)) return res([]);
          const req = store.index(indexName).getAll(targetId);
          req.onsuccess = () => res((req.result || []).map((r) => r.book));
          req.onerror = () => res([]);
        } catch { res([]); }
      });
      const owners = [
        ...(await ownersIn('hypercites', 'hyperciteId')),
        ...(await ownersIn('hyperlights', 'hyperlight_id')),
      ];
      const all = readAll();
      if (all[index]) {
        all[index].targetOwnedBy = [...new Set(owners)];
        sessionStorage.setItem(KEY, JSON.stringify(all));
      }
    } catch { /* diagnostics are best-effort */ }
  };

  const record = (node) => {
    try {
      const text = node.textContent || '';
      const entry = {
        ts: Date.now(),
        text,
        href: location.href,
        rendered: document.querySelector('.main-content')?.id || null,
        // The book's own extent, so a failure says WHY at a glance: a target far outside
        // [first, max] is a carried-over id from another book, not a stale one from this one.
        nodeCount: (window.nodes || []).length,
        maxLine: (window.nodes || []).reduce((m, n) => Math.max(m, Number(n.startLine) || 0), 0),
        // WHO toasted. Several call sites produce identical messages ("Citation not found" has
        // no id to even enrich an owner for), and attributing one to the wrong site cost a whole
        // debugging round — the stack names the caller on the first failure instead.
        stack: new Error().stack.split('\n').slice(2, 10).join(' | '),
      };
      const all = readAll();
      all.push(entry);
      sessionStorage.setItem(KEY, JSON.stringify(all));

      const named = text.match(/'([^']+)'/);
      if (named) void enrichOwner(all.length - 1, named[1]);
    } catch { /* never let instrumentation break the page */ }
  };

  const origAppend = Element.prototype.appendChild;
  Element.prototype.appendChild = function (node) {
    try {
      if (node && node.id === 'target-not-found-toast') record(node);
    } catch { /* swallow */ }
    return origAppend.call(this, node);
  };
};
