/**
 * Integrity capture — installed via page.addInitScript before page scripts.
 *
 * Watches console output for the `[integrity]` channel that
 * `resources/js/integrity/reporter.js` uses (`console.warn('[integrity]
 * MISMATCH DETECTED', ...)` and related), and the integrity modal DOM
 * (#integrity-send-report-btn or .integrity-card) that pops up on
 * mismatch. Pushes structured events to `window.__integrityEvents` so
 * specs can snapshot them at phase boundaries.
 *
 * No app-code changes. Pure observation.
 */
export const integrityCaptureScript = () => {
  if (window.__integrityCaptureInstalled) return;
  window.__integrityCaptureInstalled = true;
  window.__integrityEvents = [];

  const push = (event) => {
    try { window.__integrityEvents.push({ ts: Date.now(), ...event }); } catch { /* swallow */ }
  };

  const isIntegrityLine = (args) => {
    try {
      return args.some(a => typeof a === 'string' && a.includes('[integrity]'));
    } catch { return false; }
  };

  // Wrap console.warn — primary signal
  const origWarn = console.warn;
  console.warn = function (...args) {
    if (isIntegrityLine(args)) {
      const msg = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
      push({ kind: 'integrityWarn', msg });
    }
    return origWarn.apply(this, args);
  };

  // Wrap console.error — also used by reporter.js for retry-queue failures
  const origErr = console.error;
  console.error = function (...args) {
    if (isIntegrityLine(args)) {
      const msg = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
      push({ kind: 'integrityError', msg });
    }
    return origErr.apply(this, args);
  };

  // MutationObserver for the integrity modal — appears on confirmed mismatch
  const installModalObserver = () => {
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          const id = node.id || '';
          const cls = node.className || '';
          if (id === 'integrity-overlay' || (typeof cls === 'string' && cls.includes('integrity-card'))) {
            push({ kind: 'integrityModalShown', id, classes: typeof cls === 'string' ? cls : null });
          }
          // Also catch when the modal is nested deeper than direct child
          if (node.querySelector && node.querySelector('#integrity-send-report-btn')) {
            push({ kind: 'integrityModalShown', via: 'descendant' });
          }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installModalObserver, { once: true });
  } else {
    installModalObserver();
  }

  // Intercept fetch to /api/integrity/report to confirm a backend report was sent
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && url.includes('/api/integrity/report')) {
        push({ kind: 'integrityReportSent', url });
      }
    } catch { /* swallow */ }
    return origFetch.apply(this, args);
  };

  window.__resetIntegrityEvents = () => {
    if (Array.isArray(window.__integrityEvents)) window.__integrityEvents.length = 0;
  };

  function safeStringify(o) {
    try { return JSON.stringify(o).slice(0, 200); } catch { return '[unserialisable]'; }
  }
};
