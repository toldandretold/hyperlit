// editIndicator.js

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

  // RESTORE topRightContainer visibility
  if (topRightContainer && topRightVisibilityBeforeEdit !== null) {
    if (topRightVisibilityBeforeEdit === false) {
      topRightContainer.classList.add('perimeter-hidden')
      console.log('🟢 Hid topRightContainer after editing')
    } else {
      topRightContainer.classList.remove('perimeter-hidden')
      console.log('🟢 Kept topRightContainer visible after editing')
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
    cloudSvgPath.style.fill = '#EF8D34'
  }

  // SAVE current topRightContainer state and make it visible
  if (topRightContainer) {
    topRightVisibilityBeforeEdit = !topRightContainer.classList.contains('perimeter-hidden')
    topRightContainer.classList.remove('perimeter-hidden')
    console.log('🟠 Saved topRight visibility before edit:', topRightVisibilityBeforeEdit)
    console.log('🟠 Made topRightContainer visible for editing')
  }

  console.log('Indicator → orange (saving)')
}

/** Mark "done" → green, then fade back to grey after 1s */
export function showTick() {
  if (!isProcessing || isComplete) return
  isComplete = true

  const cloudSvgPath = document.querySelector('#cloudRef-svg .cls-1')
  if (cloudSvgPath) {
    cloudSvgPath.style.fill = '#10a64a'
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
    cloudSvgPath.style.fill = '#dc3545'
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