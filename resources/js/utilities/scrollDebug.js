/**
 * Scroll debug — find what moves the reader scroller, for intermittent jumps.
 *
 * Always-armed, silent until something actually moves `.reader-content-wrapper`.
 * Survives reloads. Enable with:  localStorage.scrollDebug = '1'  (then reload).
 * Disable with:  delete localStorage.scrollDebug  (then reload).
 *
 * Two detectors:
 *  A) Instant — wraps focus()/scrollIntoView/scrollTo. The moment one of them
 *     changes the reader scrollTop, logs a warning + the exact call stack.
 *  B) On drift — keeps a ring buffer of recent focus/SIV calls. closeHyperlitContainer
 *     calls window.__scrollDebug.report() when it detects a close-time drift, so
 *     cause + effect print together. If B reports a drift but A never fired, no JS
 *     call moved it → scroll-anchoring (overflow:hidden lifting), not focus.
 */

const ENABLED = (() => {
  try { return localStorage.getItem('scrollDebug') === '1'; } catch { return false; }
})();

function scroller() {
  return document.querySelector('.reader-content-wrapper')
    || document.querySelector('.main-content')
    || document.querySelector('main');
}

function describe(el) {
  if (!(el instanceof Element)) return String(el);
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string'
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

// Ring buffer of recent suspect calls (detector B context)
const RING = [];
const RING_MAX = 30;
function push(entry) {
  RING.push(entry);
  if (RING.length > RING_MAX) RING.shift();
}

if (ENABLED) {
  console.log('🔬 scrollDebug armed (localStorage.scrollDebug=1). Disable: delete localStorage.scrollDebug');

  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (opts) {
    const sc = scroller();
    const before = sc ? sc.scrollTop : null;
    origFocus.call(this, opts);
    const after = sc ? sc.scrollTop : null;
    const moved = before !== null && before !== after;
    const stack = new Error().stack;
    push({ t: performance.now(), kind: 'focus', label: describe(this), before, after, moved, stack });
    if (moved) {
      console.warn(`🎯 focus() moved reader scroll ${before}→${after} (Δ${after - before}) on ${describe(this)}`, this, '\n', stack);
    }
  };

  const origSIV = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    const sc = scroller();
    const before = sc ? sc.scrollTop : null;
    const inside = sc && sc.contains(this);
    const stack = new Error().stack;
    push({ t: performance.now(), kind: 'scrollIntoView', label: describe(this), before, inside, stack });
    if (inside) {
      console.warn(`📜 scrollIntoView on ${describe(this)} (inside reader)`, this, '\n', stack);
    }
    return origSIV.apply(this, args);
  };

  const origScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    const sc = scroller();
    if (sc && this === sc) {
      const stack = new Error().stack;
      push({ t: performance.now(), kind: 'scrollTo', label: describe(this), before: sc.scrollTop, args: JSON.stringify(args), stack });
      console.warn(`🧭 scrollTo() on reader`, args, '\n', stack);
    }
    return origScrollTo.apply(this, args);
  };

  window.__scrollDebug = {
    /** Print the recent ring buffer. Called by closeHyperlitContainer on drift. */
    report(label = 'manual') {
      console.group(`🔬 scrollDebug report (${label}) — last ${RING.length} suspect calls`);
      const now = performance.now();
      RING.forEach(e => {
        const ago = (now - e.t).toFixed(0);
        const moved = e.moved ? ` MOVED ${e.before}→${e.after}` : '';
        console.log(`  -${ago}ms  ${e.kind}  ${e.label}${moved}`);
      });
      if (RING.length === 0) {
        console.log('  (empty — no focus/scrollIntoView/scrollTo fired. Likely scroll-anchoring on overflow:hidden lift.)');
      } else {
        console.log('Full entries (with stacks):', RING.slice());
      }
      console.groupEnd();
    },
    buffer: RING,
  };
}

export const scrollDebugEnabled = ENABLED;
