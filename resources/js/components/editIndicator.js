// editIndicator.js
// Controls the cloudRef button glow colors to indicate save status:
// - Orange: saving in progress
// - Green: save successful
// - Red: save error

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

/** Glow the cloudRef button orange to indicate saving in progress */
export function glowCloudOrange() {
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

  console.log('CloudRef → orange (saving)')
}

/** Glow the cloudRef button green to indicate success, then fade back to grey after 1.5s */
export function glowCloudGreen() {
  if (!isProcessing || isComplete) return
  isComplete = true

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-success)'
  }
  console.log('CloudRef → green (synced to server)')

  // after a short pause, restore to grey AND restore topRight visibility
  setTimeout(() => {
    resetIndicator()
    console.log('CloudRef → grey (ready)')
  }, 1500)
}

/** Glow the cloudRef button red to indicate error, then fade back to grey after 3s */
export function glowCloudRed() {
  if (!isProcessing) return
  isComplete = true

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = 'var(--status-error)'
  }
  console.log('CloudRef → red (sync error)')

  // after a longer pause, restore to grey AND restore topRight visibility
  setTimeout(() => {
    resetIndicator()
    console.log('CloudRef → grey (ready after error)')
  }, 3000)
}

/** Cancel forced visibility (called when user toggles perimeter buttons during save) */
export function cancelForcedVisibility() {
  console.log('🔵 Canceling edit indicator forced visibility')
  topRightVisibilityBeforeEdit = null
  // Keep processing state and color - just cancel the restore behavior
}