// Extends tap areas for footnote/citation elements on mobile.
// Unlike the toolbar tapAreaExtender, this does NOT preventDefault on touchstart,
// so text selection (long-press + drag) works normally.
// Only fires on quick taps (<250ms, <10px movement, no text selected).

import { isActivelyScrollingForLinkBlock } from './scrolling.js';
import { handleFootnoteOrCitationClick } from './footnotesCitations.js';

const TAP_MAX_DURATION = 250;  // ms
const TAP_MAX_MOVEMENT = 10;   // px
const ZONE_MAIN = 8;           // matches disabled CSS ::before inset
const ZONE_CONTAINER = 16;     // matches disabled container CSS ::before inset

// Flag set during touchstart when a footnote/citation is nearby (direct hit or expanded zone).
// Consumed by togglePerimeterButtons to avoid toggling buttons on near-miss footnote taps.
let _nearbyFootnoteDetected = false;

export function hasFootnoteTapTarget() {
  return _nearbyFootnoteDetected;
}

export function initFootnoteTapExtender() {
  const isTouchDevice = matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (!isTouchDevice) return { destroy() {} };

  let touchState = null;

  function findNearestTarget(x, y) {
    // Collect all footnote/citation elements currently in the DOM
    const selectors = 'sup[fn-count-id], a.in-text-citation, a.citation-ref, a[id^="hypercite_"]';
    const elements = document.querySelectorAll(selectors);

    let best = null;
    let bestDist = Infinity;

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      // Determine zone size: larger inside hyperlit containers
      const inContainer = el.closest('#hyperlit-container, .hyperlit-container-stacked');
      const zone = inContainer ? ZONE_CONTAINER : ZONE_MAIN;

      const expanded = {
        left:   rect.left   - zone,
        right:  rect.right  + zone,
        top:    rect.top    - zone,
        bottom: rect.bottom + zone,
      };

      if (x >= expanded.left && x <= expanded.right &&
          y >= expanded.top  && y <= expanded.bottom) {
        // Touch is inside the expanded zone — pick the closest by center distance
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        const dist = Math.hypot(x - cx, y - cy);
        if (dist < bestDist) {
          bestDist = dist;
          best = el;
        }
      }
    }

    return best;
  }

  function onTouchStart(e) {
    _nearbyFootnoteDetected = false;

    // Only track single-finger taps
    if (e.touches.length !== 1) {
      touchState = null;
      return;
    }

    const touch = e.touches[0];

    // If the touch directly hit a footnote/citation element, let the existing
    // click handler in footnotesCitations.js deal with it — return null target.
    const directHit = touch.target?.closest?.('sup[fn-count-id], a.in-text-citation, a.citation-ref, a[id^="hypercite_"]');
    if (directHit) {
      _nearbyFootnoteDetected = true;
      touchState = null;
      return;
    }

    const target = findNearestTarget(touch.clientX, touch.clientY);
    if (!target) {
      touchState = null;
      return;
    }

    _nearbyFootnoteDetected = true;

    // Do NOT call preventDefault — allow text selection to proceed
    touchState = {
      target,
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: performance.now(),
    };
  }

  function onTouchEnd(e) {
    if (!touchState) return;

    const state = touchState;
    touchState = null;

    const touch = e.changedTouches[0];
    const duration = performance.now() - state.startTime;
    const dx = Math.abs(touch.clientX - state.startX);
    const dy = Math.abs(touch.clientY - state.startY);
    const movement = Math.max(dx, dy);

    // Guard 1: Must be a quick tap
    if (duration > TAP_MAX_DURATION) return;

    // Guard 2: Must not have moved far (filters out drag/scroll)
    if (movement > TAP_MAX_MOVEMENT) return;

    // Guard 3: Must not have text selected (long-press creates a selection)
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;

    // Guard 4: Must not be actively scrolling
    if (isActivelyScrollingForLinkBlock()) return;

    // All guards passed — fire the appropriate handler
    e.preventDefault();
    if (state.target.matches('a[id^="hypercite_"]')) {
      state.target.click();
    } else {
      handleFootnoteOrCitationClick(state.target);
    }
  }

  function onTouchCancel() {
    touchState = null;
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: false });
  document.addEventListener('touchcancel', onTouchCancel, { passive: true });

  return {
    destroy() {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
      touchState = null;
    }
  };
}
