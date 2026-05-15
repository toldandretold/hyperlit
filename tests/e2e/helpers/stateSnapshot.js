/**
 * Page state snapshot helpers.
 *
 * snapshotPageState captures a forensic snapshot of everything we care about
 * around a hypercite/SPA navigation: URL, history state + containerStack
 * depth, hyperlit-container DOM count, open overlays, sub-books, hypercite
 * underlines, listener counts, navigation health, and the restoration log.
 *
 * Snapshots are pushed into a timeline by the tour orchestrator and attached
 * to test output for forensic visibility.
 */

export async function snapshotPageState(page, label) {
  return page.evaluate((label) => {
    const stack = history.state?.containerStack;
    const restorationLog = Array.isArray(window.__restorationLog) ? window.__restorationLog : [];

    // Check whether perimeter buttons are interactable. We can't use
    // elementFromPoint at the centre — these buttons wrap transparent SVG
    // icons, so the centre pixel "sees through" to #app-container even when
    // the button is fully functional. Instead, dispatch a synthetic click
    // on the button itself, watch whether the page's own listener captures
    // it (we install a one-shot capture-phase listener for the probe), and
    // restore the previous state.
    const interactabilityProbe = (() => {
      const out = {};
      for (const id of ['toc-toggle-button', 'editButton', 'logoContainer', 'settingsButton']) {
        const el = document.getElementById(id);
        if (!el) { out[id] = { exists: false }; continue; }
        const r = el.getBoundingClientRect();
        const inViewport = r.width > 0 && r.height > 0
          && r.bottom > 0 && r.top < window.innerHeight
          && r.right > 0 && r.left < window.innerWidth;
        const cs = window.getComputedStyle(el);
        // pointer-events inherits, so the button can show "none" because of
        // any ancestor. Walk to the TOPMOST ancestor that still has
        // pointer-events:none — that's the actual source. Also record every
        // ancestor in the chain that contributes (full forensic trail).
        const peChain = [];
        for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
          if (window.getComputedStyle(cur).pointerEvents !== 'none') break;
          peChain.push({
            id: cur.id || null,
            tag: cur.tagName.toLowerCase(),
            classes: cur.className || null,
            inlinePE: cur.style.pointerEvents || null,
          });
        }
        const blocker = peChain.length ? peChain[peChain.length - 1] : null;
        out[id] = {
          exists: true,
          inViewport,
          rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
          pointerEvents: cs.pointerEvents,
          visibility: cs.visibility,
          display: cs.display,
          opacity: cs.opacity,
          disabled: !!el.disabled,
          tabIndex: el.tabIndex,
          inlinePointerEvents: el.style.pointerEvents || null,
          classes: el.className || null,
          peBlocker: blocker,    // topmost ancestor with pointer-events:none
          peChain: peChain,      // every ancestor in the inherited chain
        };
      }
      return out;
    })();
    return {
      label,
      ts: Date.now(),
      url: window.location.href,
      pathname: window.location.pathname,
      hash: window.location.hash,
      historyLength: window.history.length,
      historyState: cloneSafe(history.state),
      historyStackDepth: Array.isArray(stack) ? stack.length : 0,
      bookId: window.book || (document.querySelector('.main-content')?.id ?? null),
      isEditing: !!window.isEditing,
      openMainContainer: !!document.querySelector('#hyperlit-container.open'),
      stackedContainersTotal: document.querySelectorAll('.hyperlit-container-stacked').length,
      stackedContainersOpen: document.querySelectorAll('.hyperlit-container-stacked.open').length,
      bodyOpenClass: document.body.classList.contains('hyperlit-container-open'),
      subBookCount: document.querySelectorAll('[data-book-id]').length,
      hyperciteListenerCount: document.querySelectorAll('u[data-hypercite-listener="true"]').length,
      underlines: document.querySelectorAll('.main-content u[id^="hypercite_"]').length,
      pasteOpenIcons: document.querySelectorAll('.main-content a.open-icon[id^="hypercite_"]').length,
      footnoteRefs: document.querySelectorAll('.main-content sup.footnote-ref, .main-content a.footnote-ref, .main-content sup[fn-count-id]').length,
      tocOpen: !!document.querySelector('#toc-container.open'),
      restorationLogSize: restorationLog.length,
      restorationLog: restorationLog.slice(-30), // tail to keep snapshot bounded
      health: typeof window.checkNavigationHealth === 'function'
        ? safeCall(window.checkNavigationHealth)
        : null,
      scrollY: window.scrollY,
      interactability: interactabilityProbe,
    };

    function safeCall(fn) {
      try { return fn(); } catch (e) { return { error: String(e) }; }
    }
    function cloneSafe(o, depth = 0) {
      if (depth > 6 || o == null) return o;
      const t = typeof o;
      if (t !== 'object') return o;
      if (Array.isArray(o)) return o.slice(0, 50).map(v => cloneSafe(v, depth + 1));
      const out = {};
      for (const k of Object.keys(o).slice(0, 30)) {
        try { out[k] = cloneSafe(o[k], depth + 1); } catch { out[k] = '[unserialisable]'; }
      }
      return out;
    }
  }, label);
}

export function summariseSnapshot(s) {
  const i = s.interactability || {};
  const broken = Object.entries(i)
    .filter(([, p]) => p.exists && (
      p.pointerEvents === 'none' || p.display === 'none' ||
      p.visibility === 'hidden' || p.opacity === '0' || p.disabled
    ))
    // Don't surface the deliberate perimeter-hidden toggle as "broken"
    .filter(([, p]) => !(p.peChain || []).some(
      a => typeof a.classes === 'string' && a.classes.includes('perimeter-hidden')
    ))
    .map(([id]) => id);
  return [
    `[${s.label}]`,
    `url=${s.pathname}${s.hash}`,
    `histLen=${s.historyLength}`,
    `histStack=${s.historyStackDepth}`,
    `stacked=${s.stackedContainersTotal}(open=${s.stackedContainersOpen})`,
    `bodyOpen=${s.bodyOpenClass ? 'Y' : 'N'}`,
    `subBooks=${s.subBookCount}`,
    `underlines=${s.underlines}`,
    `pasteLinks=${s.pasteOpenIcons}`,
    `restorationLog=${s.restorationLogSize}`,
    `health=${s.health?.issues?.length ?? 0}i/${s.health?.warnings?.length ?? 0}w`,
    broken.length ? `css-broken=${broken.join(',')}` : '',
  ].filter(Boolean).join(' ');
}

/**
 * Walk a timeline of snapshots looking for anomalies that suggest the bugs
 * the user reported (container flood, restoration colliding with click-open).
 *
 * Returns an array of anomaly records. Empty array == healthy.
 */
export function detectAnomalies(timeline, { stackJumpThreshold = 1 } = {}) {
  const anomalies = [];

  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1];
    const cur = timeline[i];

    // Container flood: stacked containers grew by more than threshold in one step
    const jump = cur.stackedContainersTotal - prev.stackedContainersTotal;
    if (jump > stackJumpThreshold) {
      anomalies.push({
        at: cur.label,
        kind: 'container-flood',
        from: prev.stackedContainersTotal,
        to: cur.stackedContainersTotal,
        delta: jump,
        prevLabel: prev.label,
      });
    }

    // Container persisted across an SPA navigation
    if (cur.openMainContainer && prev.openMainContainer && cur.pathname !== prev.pathname) {
      anomalies.push({
        at: cur.label,
        kind: 'container-persisted-across-nav',
        prevLabel: prev.label,
      });
    }

    // Orphaned stacked containers in DOM but none are open
    if (cur.stackedContainersTotal > 0 && cur.stackedContainersOpen === 0 && !cur.openMainContainer) {
      anomalies.push({
        at: cur.label,
        kind: 'orphaned-stacked-containers',
        total: cur.stackedContainersTotal,
      });
    }

    // Health-check issues
    if (cur.health?.issues?.length) {
      anomalies.push({
        at: cur.label,
        kind: 'health-issue',
        issues: cur.health.issues,
      });
    }

    // Orphan overlay: a tour step explicitly marked this state (set by
    // the cross-book hypercite tour after rapid back/forward).
    if (cur.orphanOverlay && cur.orphanOverlay.refOverlayActive && !cur.orphanOverlay.anyOpenContainer) {
      anomalies.push({
        at: cur.label,
        kind: 'orphan-ref-overlay',
        state: cur.orphanOverlay,
      });
    }

    // Perimeter button uninteractive due to CSS: pointer-events:none,
    // display:none, visibility:hidden, opacity:0, or disabled.
    //
    // Filter:
    //   - Skip when a container is legitimately open (the overlay covers
    //     perimeter buttons by design while a hyperlit container is open).
    //   - Skip when pointer-events:none is inherited from a parent that has
    //     the `perimeter-hidden` class — that's the deliberate "tap to hide
    //     nav" feature in togglePerimeterButtons.js, not a bug. The next
    //     user tap on empty space toggles them back on.
    const containerOpen = cur.openMainContainer
      || cur.stackedContainersOpen > 0
      || cur.bodyOpenClass;
    if (cur.interactability && !containerOpen) {
      for (const [id, probe] of Object.entries(cur.interactability)) {
        if (!probe.exists) continue;
        const blockedByPerimeterToggle = (probe.peChain || []).some(
          a => typeof a.classes === 'string' && a.classes.includes('perimeter-hidden')
        );
        if (blockedByPerimeterToggle) continue;
        const broken = probe.pointerEvents === 'none'
          || probe.display === 'none'
          || probe.visibility === 'hidden'
          || probe.opacity === '0'
          || probe.disabled;
        if (broken) {
          anomalies.push({
            at: cur.label,
            kind: 'button-css-broken-post-close',
            button: id,
            cssState: {
              pointerEvents: probe.pointerEvents,
              display: probe.display,
              visibility: probe.visibility,
              opacity: probe.opacity,
              disabled: probe.disabled,
            },
            peBlocker: probe.peBlocker,
          });
        }
      }
    }
  }

  return anomalies;
}

/**
 * Inspect the tail of the restoration log around a label window for the
 * restoration-vs-click race condition.
 *
 * Returns events that overlap restoreStack/restoreLayer0 with stacked
 * container additions caused by handleUnifiedContentClick.
 */
export function detectRestorationRace(timeline, { windowMs = 1500 } = {}) {
  const races = [];
  // Aggregate the full restoration log from the last snapshot (it's cumulative)
  const final = timeline[timeline.length - 1];
  const log = final?.restorationLog || [];

  // Window-scan: any time a 'restoreStack' event has 'stackedContainerAdded'
  // events within windowMs that arrived from a different source (i.e. there
  // were already additions just before and now restoration is piling more on)
  for (let i = 0; i < log.length; i++) {
    const ev = log[i];
    if (ev.kind === 'restoreStack' || ev.kind === 'restoreLayer0') {
      const start = ev.ts - windowMs;
      const end = ev.ts + windowMs;
      const adds = log.filter(x => x.kind === 'stackedContainerAdded' && x.ts >= start && x.ts <= end);
      if (adds.length > 1) {
        races.push({
          kind: 'restoration-collision',
          restorationAt: ev.ts,
          restorationKind: ev.kind,
          stackedAddCount: adds.length,
          addsTs: adds.map(a => a.ts),
        });
      }
    }
  }
  return races;
}
