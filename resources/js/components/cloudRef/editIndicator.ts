// editIndicator.ts
// Controls the cloudRef button glow colors to indicate save status:
// - Orange: saving in progress
// - Green: save successful
// - Red: save error

import { log, verbose } from '../../utilities/logger';
import { getPerimeterButtonsHidden } from '../../utilities/operationState';
import { isIDBBroken } from '../../indexedDB/core/healthMonitor';

export let isProcessing = false
export let isComplete   = false

// Safety timeout: auto-reset if stuck orange for too long
let safetyTimer: ReturnType<typeof setTimeout> | null = null

// Keep track of topRightContainer state
let topRightContainer: HTMLElement | null = null
let topRightVisibilityBeforeEdit: boolean | null = null

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  topRightContainer = document.getElementById('topRightContainer')
})

// Cloud-glow on IDB-broken: subscribe to the health event (healthMonitor dispatches it rather than
// importing this UI module — keeps the data layer one-way / acyclic).
window.addEventListener('hyperlit:idb-broken', (e: any) => glowCloudRed(e?.detail))

// helper to emit events
function emitProcessingChange() {
  document.dispatchEvent(
    new CustomEvent("processing-change", { detail: { isProcessing } })
  )
}

// Deterministic save-state signal for tests/tooling. The VISUAL indicator is an
// inline-style CSS variable on the SVG path — unobservable via getAttribute('fill')
// (the e2e suite polled that for years and every wait silently burned its full
// timeout) — and green fades back to grey after 1.5s, so polling color is racy by
// design. Stamp machine-readable state on the #cloudRef button instead:
//   data-save-state: saving | saved | error | pending | idle
//   data-last-sync:  success | error | local — the OUTCOME of the most recent
//                    sync; persists through the idle reset and is cleared when a
//                    new save cycle starts. "Durably synced" = data-last-sync=
//                    "success" while data-save-state != "saving".
function setCloudAttr(name: string, value: string | null) {
  const btn = document.getElementById('cloudRef')
  if (!btn) return
  if (value === null) btn.removeAttribute(name)
  else btn.setAttribute(name, value)
}

// Pending-work checks: resetIndicator consults these before declaring 'idle'.
// The green/red glow closes a cycle the moment a SERVER sync round-trips, but
// edits queued during the 1.5s fade hit glowCloudOrange's isProcessing early-
// return, and the SaveQueue's debounced flush may still be holding nodes — so
// without this the indicator (and data-save-state) reads idle+success while
// typed text has not even reached IndexedDB. Navigating away in that window is
// real data loss (the nested e2e's vanishing L3 text). Layers with queues
// register a cheap "do I still hold work?" callback; if any says yes at reset
// time, a fresh 'saving' cycle re-arms instead of going idle.
type PendingWorkCheck = () => boolean
const pendingWorkChecks = new Set<PendingWorkCheck>()
export function registerPendingWorkCheck(check: PendingWorkCheck): () => void {
  pendingWorkChecks.add(check)
  return () => { pendingWorkChecks.delete(check) }
}
function hasPendingWork(): boolean {
  for (const check of pendingWorkChecks) {
    try { if (check()) return true } catch { /* a broken check must never block idle */ }
  }
  return false
}
let pendingReglow = false // an edit arrived during the fade window
let reengaging = false    // reentrancy guard: resetIndicator → glowCloudOrange → resetIndicator

/** Reset both flags and clear any inline fills */
function resetIndicator() {
  isProcessing = false
  isComplete   = false
  if (safetyTimer) clearTimeout(safetyTimer)
  safetyTimer = null
  emitProcessingChange()

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
  if (cloudSvgPath) cloudSvgPath.removeAttribute('style')
  setCloudAttr('data-save-state', 'idle') // keep data-last-sync — it records the outcome

  // RESTORE topRightContainer visibility with intelligent auto-hide
  if (topRightContainer && topRightVisibilityBeforeEdit !== null) {
    if (topRightVisibilityBeforeEdit === true) {
      // Original state was visible - restore visibility
      topRightContainer.classList.remove('perimeter-hidden')
      verbose.init('Kept topRightContainer visible after editing', 'editIndicator.js');
    } else {
      // Original state was hidden - check if other perimeter buttons are hidden
      // Use central state instead of DOM checks
      const perimeterButtonsAreHidden = getPerimeterButtonsHidden();

      if (perimeterButtonsAreHidden) {
        // Other buttons are hidden - auto-hide topRightContainer too
        topRightContainer.classList.add('perimeter-hidden')
        verbose.init('Auto-hiding topRightContainer after save (perimeter buttons are hidden)', 'editIndicator.js');
      } else {
        // Other buttons are visible - keep topRightContainer visible too
        verbose.init('Keeping topRightContainer visible after save (perimeter buttons are visible)', 'editIndicator.js');
      }
    }
    topRightVisibilityBeforeEdit = null
  }
}

// Called after a cycle's fade completes (green/red/local timers + the safety
// reset): if unsaved work is still queued (or edits arrived mid-fade), don't
// stay idle — re-arm a fresh 'saving' cycle so the state stays honest.
function maybeReengage() {
  if (reengaging) return
  if (pendingReglow || hasPendingWork()) {
    pendingReglow = false
    reengaging = true
    try { glowCloudOrange() } finally { reengaging = false }
  }
}

/** Glow the cloudRef button orange to indicate saving in progress */
export function glowCloudOrange() {
  if (isProcessing) {
    // A completed cycle is fading out (green/red still showing) — remember that
    // NEW work arrived so the fade re-arms instead of going idle, and flip the
    // machine-readable state back to 'saving' IMMEDIATELY (a durable-sync
    // waiter polling mid-fade must not read the stale saved+success).
    if (isComplete) {
      pendingReglow = true
      setCloudAttr('data-save-state', 'saving')
      setCloudAttr('data-last-sync', null)
    }
    return
  }
  resetIndicator()
  isProcessing = true
  emitProcessingChange()
  setCloudAttr('data-save-state', 'saving')
  setCloudAttr('data-last-sync', null) // new cycle — previous outcome no longer describes it

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1') as HTMLElement | null
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-saving)'
  }

  // SAVE current topRightContainer state and make it visible
  if (topRightContainer) {
    topRightVisibilityBeforeEdit = !topRightContainer.classList.contains('perimeter-hidden')
    topRightContainer.classList.remove('perimeter-hidden')
    verbose.init(`Saved topRight visibility before edit: ${topRightVisibilityBeforeEdit}`, 'editIndicator.js');
    verbose.init('Made topRightContainer visible for editing', 'editIndicator.js');
  }

  // Safety timeout: auto-reset if green/red never fires (e.g., filtered mutations, errors)
  if (safetyTimer) clearTimeout(safetyTimer)
  safetyTimer = setTimeout(() => {
    if (isProcessing && !isComplete) {
      if (isIDBBroken()) {
        log.error('CloudRef safety timeout — IDB broken, showing red', 'editIndicator.js')
        glowCloudRed()
      } else {
        log.error('CloudRef safety reset — stuck orange for 30s', 'editIndicator.js')
        resetIndicator()
        maybeReengage()
      }
    }
  }, 30000)
}

/** Glow the cloudRef button green to indicate success, then fade back to grey after 1.5s */
export function glowCloudGreen() {
  // A server ACK only means the LAST batch landed. If local queues still hold
  // newer work (the SaveQueue's debounced flush, edits made since that batch
  // was cut), declaring success now is a lie that durable-sync waiters act on
  // — the vanishing-L3-text data loss in the nested e2e. Keep the cycle open
  // as 'saving'; the next push's green re-checks, and only a green with
  // nothing pending settles.
  if (hasPendingWork()) {
    if (isProcessing) setCloudAttr('data-save-state', 'saving')
    else glowCloudOrange() // work pending but no open cycle — open one
    return
  }
  // Record the outcome even when the glow itself is skipped (e.g. a sync that
  // finished after the safety reset) — the sync DID succeed.
  setCloudAttr('data-last-sync', 'success')
  if (!isProcessing || isComplete) return
  isComplete = true
  setCloudAttr('data-save-state', 'saved')

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1') as HTMLElement | null
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-success)'
  }

  // after a short pause, restore to grey AND restore topRight visibility
  setTimeout(() => {
    resetIndicator()
    maybeReengage()
  }, 1500)
}

/**
 * Glow the cloudRef button red to indicate error, then fade back to grey after 3s.
 * @param errorInfo Optional error descriptor — see saveErrorToast.classifySyncError.
 *   When provided (and the error warrants it) an explanatory toast is shown. Omitting it
 *   preserves the legacy glow-only behaviour, so un-enriched callers never surface a toast.
 */
export function glowCloudRed(errorInfo?: any) {
  setCloudAttr('data-last-sync', 'error') // record the outcome even if the glow is skipped
  if (!isProcessing) return
  isComplete = true
  setCloudAttr('data-save-state', 'error')

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1') as HTMLElement | null
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-error)'
  }

  // Explain WHAT went wrong (severity-tiered toast). Lazy import keeps editIndicator light.
  if (errorInfo) {
    import('../saveErrorToast/saveErrorToast')
      .then(({ showSaveErrorToast }) => showSaveErrorToast(errorInfo))
      .catch(() => { /* toast module unavailable — glow still conveys the error */ })
  }

  // after a longer pause, restore to grey AND restore topRight visibility
  setTimeout(() => {
    resetIndicator()
    maybeReengage()
  }, 3000)
}

/** Glow the cloudRef button orange to indicate saved locally, pending sync when online */
export function glowCloudLocalSave() {
  setCloudAttr('data-last-sync', 'local')
  if (!isProcessing) return
  isComplete = true
  setCloudAttr('data-save-state', 'pending')

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1') as HTMLElement | null
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-saving)'
  }

  // Keep orange longer than green to emphasize pending state
  setTimeout(() => {
    resetIndicator()
    maybeReengage()
  }, 2000)
}

/** Cancel forced visibility (called when user toggles perimeter buttons during save) */
export function cancelForcedVisibility() {
  topRightVisibilityBeforeEdit = null
  // Keep processing state and color - just cancel the restore behavior
}

/**
 * Show green glow for background sync success (e.g., after coming back online)
 * Unlike glowCloudGreen, this doesn't require isProcessing to be true
 */
export function glowCloudSyncSuccess() {
  setCloudAttr('data-last-sync', 'success')
  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1') as HTMLElement | null
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-success)'
  }

  // Fade back to grey after 2 seconds
  setTimeout(() => {
    if (cloudSvgPath) cloudSvgPath.removeAttribute('style')
  }, 2000)
}
