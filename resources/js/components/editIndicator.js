// editIndicator.js
import { verbose } from '../utilities/logger.js';
import { getPerimeterButtonsHidden } from '../utilities/operationState.js';

export let isProcessing = false
export let isComplete   = false

// Keep track of topRightContainer state
let topRightContainer = null
let topRightVisibilityBeforeEdit = null

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  topRightContainer = document.getElementById('topRightContainer')
})

// helper to emit events
function emitProcessingChange() {
  document.dispatchEvent(
    new CustomEvent("processing-change", { detail: { isProcessing } })
  )
}

/** Reset both flags and clear any inline fills */
function resetIndicator() {
  isProcessing = false
  isComplete   = false
  emitProcessingChange()

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
  if (cloudSvgPath) cloudSvgPath.removeAttribute('style')

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

/** Mark "saving…" → orange */
export function showSpinner() {
  if (isProcessing) return
  resetIndicator()
  isProcessing = true
  emitProcessingChange()

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
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

  console.log('Indicator → orange (saving)')
}

/** Mark "done" → green, then fade back to grey after 1s */
export function showTick() {
  if (!isProcessing || isComplete) return
  isComplete = true

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-success)'
  }
  console.log('Indicator → green (synced to server)')

  // after a short pause, restore to grey AND restore topRight visibility
  setTimeout(() => {
    resetIndicator()
    console.log('Indicator → grey (ready)')
  }, 1500)
}

/** Mark "error" → red, then fade back to grey after 3s */
export function showError() {
  if (!isProcessing) return
  isComplete = true

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-error)'
  }
  console.log('Indicator → red (sync error)')

  // after a longer pause, restore to grey AND restore topRight visibility
  setTimeout(() => {
    resetIndicator()
    console.log('Indicator → grey (ready after error)')
  }, 3000)
}

/** Cancel forced visibility (called when user toggles perimeter buttons during save) */
export function cancelForcedVisibility() {
  console.log('🔵 Canceling edit indicator forced visibility')
  topRightVisibilityBeforeEdit = null
  // Keep processing state and color - just cancel the restore behavior
}