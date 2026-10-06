/**
 * "Has something outside the app rewritten this page's text?" — a zero-import
 * leaf (window-backed so every code-split module instance in the tab sees the
 * SAME latch, and import-free so it can be consulted from `indexedDB/`,
 * `lazyLoader/`, `divEditor/` and `hyperlights/` without a cycle; the
 * `batch.ts ← footnoteSelfHeal ← chunkRender` chain is already a dynamic-import
 * dance specifically to dodge one).
 *
 * THE BUG THIS EXISTS FOR. A browser translator (Chrome/Google, Edge, Safari)
 * rewrites the text of every rendered node in place. Several read-mode paths
 * then derive node content FROM the live DOM and persist it — the footnote
 * render-heal (`lazyLoader/footnoteSelfHeal.ts`) → `batchUpdateIndexedDBRecords`
 * → IndexedDB → `queueForSync` → Postgres. So a reader with translation on could
 * have Google's output saved as the book. Worse, `contentProcessor` unwraps
 * `<font>` tags on save ("browser artifacts from execCommand") and Chrome's
 * entire footprint inside a paragraph is `<font style="vertical-align: inherit;">`,
 * so the write-back strips the only evidence and stores the translation as clean,
 * indistinguishable content — after which the integrity verifier reports DOM↔IDB
 * agreement, because by then both sides are translated.
 *
 * TWO LAYERS, DELIBERATELY SPLIT. This module is the *precise* layer: it answers
 * "was this page translated?" from vendor markers, and because it is precise its
 * answer is allowed to drive user-visible decisions (refuse edit mode, refuse an
 * annotation, suspend chunk windowing). The *broad* layer is
 * `integrity/canonicalText.ts`'s `domMatchesStored`, which refuses any read-mode
 * write whose DOM text no longer matches what is stored. That one catches
 * translators this module cannot see (Safari leaves no DOM marker at all) but
 * must never feed the latch here, because render-time passes legitimately rewrite
 * text — `renderCharts` swaps a `<table>` for an `<svg>` — so divergence is
 * normal on a healthy book and latching on it would disable edit mode for every
 * book containing a chart.
 *
 * THE LATCH IS STICKY for the page's lifetime. "Show original" is not guaranteed
 * to restore byte-identical DOM, and any chunk appended while translation was on
 * was translated on arrival, so the page is left in a mixed state. The remedy is
 * a reload, which clears this for free — the registry dies with the window.
 */

/** What tipped us off. Recorded for logging and for the user-facing message. */
export type TranslationEvidence =
  | 'none'
  /** `<html class="translated-ltr">` / `translated-rtl` — Chrome / Google Translate. */
  | 'html-class'
  /** `_msttexthash` / `_msthash` attributes — Edge / Microsoft Translator. */
  | 'ms-attrs';

/** How long the subtree watch coalesces mutations before probing. */
const SUBTREE_PROBE_THROTTLE_MS = 1000;

interface TranslationState {
  latched: boolean;
  evidence: TranslationEvidence;
  watching: boolean;
}

function state(): TranslationState {
  const w = window as any;
  if (!w.__hyperlitExternalTranslation) {
    w.__hyperlitExternalTranslation = { latched: false, evidence: 'none', watching: false };
  }
  return w.__hyperlitExternalTranslation as TranslationState;
}

/** Chrome/Google stamps the direction of the target language onto <html>. */
function hasHtmlClassMarker(): boolean {
  const cl = document.documentElement?.classList;
  return !!cl && (cl.contains('translated-ltr') || cl.contains('translated-rtl'));
}

/** Edge/Microsoft Translator stamps a content hash onto every element it rewrites. */
function hasMicrosoftMarker(): boolean {
  return !!document.querySelector('[_msttexthash], [_msthash]');
}

/**
 * Probe every signal. Returns the first that fires, in reliability order.
 *
 * DELIBERATELY NARROW — only signals that cannot occur without a translator.
 * A `<font>`-wrapper sniff was tried and removed: Chrome's footprint inside a
 * paragraph is `<font style="vertical-align: inherit;">`, but `<font>` is ALSO
 * what `execCommand` emits during ordinary editing and what old pasted content
 * carries (it is exactly why `contentProcessor` unwraps them on save). Because
 * this latch is sticky and window-backed, one false positive disables edit mode
 * and annotation writes for the rest of the session — so the latch must only
 * carry signals it cannot be wrong about. Breadth is the other layer's job:
 * `integrity/canonicalText.domMatchesStored` refuses any read-mode write whose
 * text drifted, which covers Safari (no marker at all) and anything new.
 */
function probe(): TranslationEvidence {
  if (hasHtmlClassMarker()) return 'html-class';
  if (hasMicrosoftMarker()) return 'ms-attrs';
  return 'none';
}

/**
 * Record that the page is externally translated. Idempotent and one-way — the
 * first evidence wins and the latch never lifts (see the stickiness note above).
 * Adds `hl-externally-translated` to the root element so CSS can respond, and
 * dispatches `hyperlit:external-translation` ONCE so an in-flight edit session
 * can stand itself down.
 */
export function markExternallyTranslated(evidence: TranslationEvidence): void {
  if (evidence === 'none') return;
  const s = state();
  if (s.latched) return;
  s.latched = true;
  s.evidence = evidence;
  document.documentElement?.classList.add('hl-externally-translated');
  window.dispatchEvent(
    new CustomEvent('hyperlit:external-translation', { detail: { evidence } }),
  );
}

/**
 * Is the page externally translated? Cheap and synchronous — safe to call per
 * node in a render loop. Once latched it is a boolean read; before that it is a
 * class check plus (at most) two `querySelector`s against the document.
 */
export function isExternallyTranslated(): boolean {
  const s = state();
  if (s.latched) return true;
  const evidence = probe();
  if (evidence === 'none') return false;
  markExternallyTranslated(evidence);
  return true;
}

/** What tipped us off, for logging and for the user-facing explanation. */
export function externalTranslationEvidence(): TranslationEvidence {
  return state().evidence;
}

/**
 * Watch for translation being switched on mid-session. Idempotent — safe to call
 * from more than one entry point.
 *
 * Observes `<html>`'s attributes (Chrome sets the class there, and also rewrites
 * `lang` to the target language) plus the content subtree, where Edge's hashes
 * and the `<font>` wrappers appear. The subtree callback is latch-guarded and
 * disconnects once it fires, so it costs nothing after the first positive and
 * nothing at all on an untranslated page beyond the observer itself.
 */
export function startExternalTranslationWatch(): void {
  const s = state();
  if (s.watching) return;
  s.watching = true;

  // Translation may already be on — e.g. Chrome's "always translate this
  // language" setting translates before our scripts run.
  if (isExternallyTranslated()) return;

  // The <html> attribute signal is cheap and high-precision, so it probes
  // immediately. Chrome sets the class at the moment translation starts.
  const attrObserver = new MutationObserver(() => {
    if (isExternallyTranslated()) stop();
  });
  attrObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'lang'],
  });

  // The subtree signals (Edge hashes, <font> wrappers) need a subtree observer,
  // which fires on EVERY mutation in the app — a chunk render appends ~100 nodes
  // and the editor mutates per keystroke. Probing there would run two
  // document-wide querySelectors per mutation, so the callback only sets a flag
  // and a throttled timer does the actual probe. Nothing user-visible depends on
  // catching this within a frame: the data-safety guarantee is carried by
  // `canonicalText.domMatchesStored`, which is checked on the write itself.
  let pending = false;
  const subtreeObserver = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (isExternallyTranslated()) stop();
    }, SUBTREE_PROBE_THROTTLE_MS);
  });
  subtreeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  function stop(): void {
    attrObserver.disconnect();
    subtreeObserver.disconnect();
  }
}
