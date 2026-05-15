/**
 * Restoration spy — installs observers that record every hyperlit-container
 * lifecycle event, so the tour can reconstruct the order of operations during
 * a hypercite click and verify whether `restoreContainerStack()` is racing
 * `handleUnifiedContentClick()` (the suspected source of the "hella
 * containers open" glitch).
 *
 * Strategy: no app-code changes. We instead observe the side-effects that
 * the existing code emits:
 *   - history.js logs strings like "📊 Restoring hyperlit container from
 *     history", "📚 Restoring container stack (N layers)...", and
 *     "📚 Stacked layer N restored successfully" via console.log
 *   - createStackedContainerDOM appends new `.hyperlit-container-stacked`
 *     nodes (and matching `.ref-overlay-stacked` overlays) to document.body
 *   - body.classList toggles 'hyperlit-container-open' when any container opens
 *
 * Each event is pushed to window.__restorationLog as { ts, kind, ... }.
 * The tour serialises this log into snapshots so failures have a forensic trail.
 *
 * Install via page.addInitScript(restorationSpyScript) — runs before any
 * page script, mirroring listenerMonitor.js.
 */
export const restorationSpyScript = () => {
  if (window.__restorationSpyInstalled) return;
  window.__restorationSpyInstalled = true;
  window.__restorationLog = [];

  const log = (event) => {
    try {
      window.__restorationLog.push({ ts: Date.now(), ...event });
    } catch { /* swallow */ }
  };

  // ── Patch console.log to sniff history.js restoration log lines ──
  const origLog = console.log;
  console.log = function (...args) {
    try {
      const msg = args.map(a => typeof a === 'string' ? a : '').join(' ');
      if (msg.includes('Restoring hyperlit container from history')) {
        log({ kind: 'restoreLayer0Start', msg });
      } else if (msg.includes('Restoring container stack')) {
        log({ kind: 'restoreStackStart', msg });
      } else if (msg.includes('Successfully restored hyperlit container from history')) {
        log({ kind: 'restoreLayer0Done' });
      } else if (msg.includes('Stacked layer') && msg.includes('restored successfully')) {
        log({ kind: 'restoreStackedLayerDone', msg });
      } else if (msg.includes('Container stack restoration complete')) {
        log({ kind: 'restoreStackDone' });
      } else if (msg.includes('Stack restoration stopped at layer')) {
        log({ kind: 'restoreStackAborted', msg });
      } else if (msg.includes('No hyperlit container state found in history')) {
        log({ kind: 'restoreNoState' });
      }
    } catch { /* swallow */ }
    return origLog.apply(this, args);
  };

  // Also sniff console.error / console.warn for restoration failures
  const origErr = console.error;
  console.error = function (...args) {
    try {
      const msg = args.map(a => typeof a === 'string' ? a : '').join(' ');
      if (msg.includes('restoring hyperlit container') || msg.includes('restoring stacked layer')) {
        log({ kind: 'restoreError', msg });
      }
    } catch { /* swallow */ }
    return origErr.apply(this, args);
  };

  const installObservers = () => {
    const root = document.documentElement || document;

    const mo = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('hyperlit-container-stacked')) {
            log({
              kind: 'stackedContainerAdded',
              depth: node.getAttribute('data-layer') || node.dataset?.layer || null,
            });
          }
          if (node.id === 'ref-overlay' || node.classList?.contains('ref-overlay-stacked')) {
            log({ kind: 'overlayAdded', id: node.id || null });
          }
        }
        for (const node of r.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('hyperlit-container-stacked')) {
            log({
              kind: 'stackedContainerRemoved',
              depth: node.getAttribute('data-layer') || node.dataset?.layer || null,
            });
          }
        }
      }
    });
    mo.observe(root, { childList: true, subtree: true });

    if (document.body) {
      const bodyMo = new MutationObserver(() => {
        const open = document.body.classList.contains('hyperlit-container-open');
        log({ kind: 'bodyOpenClass', open });
      });
      bodyMo.observe(document.body, { attributes: true, attributeFilter: ['class'] });

      // Also watch #hyperlit-container open class
      const mainContainer = document.getElementById('hyperlit-container');
      if (mainContainer) {
        const mainMo = new MutationObserver(() => {
          log({ kind: 'mainContainerClass', open: mainContainer.classList.contains('open') });
        });
        mainMo.observe(mainContainer, { attributes: true, attributeFilter: ['class'] });
      }
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installObservers, { once: true });
  } else {
    installObservers();
  }

  window.__resetRestorationLog = () => {
    if (Array.isArray(window.__restorationLog)) window.__restorationLog.length = 0;
  };
};
