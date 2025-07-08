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
  
  const layer1 = document.querySelector('#Layer_1 .cls-1')
  if (layer1) layer1.removeAttribute('style')
  
  // RESTORE topRightContainer visibility
  if (topRightContainer && topRightVisibilityBeforeEdit !== null) {
    if (topRightVisibilityBeforeEdit === false) {
      topRightContainer.classList.add('hidden-nav')
      console.log('🟢 Hid topRightContainer after editing')
    } else {
      topRightContainer.classList.remove('hidden-nav')
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
  
  const layer1 = document.querySelector('#Layer_1 .cls-1')
  if (layer1) {
    layer1.style.fill = '#EF8D34'
  }
  
  // SAVE current topRightContainer state and make it visible
  if (topRightContainer) {
    topRightVisibilityBeforeEdit = !topRightContainer.classList.contains('hidden-nav')
    topRightContainer.classList.remove('hidden-nav')
    console.log('🟠 Saved topRight visibility before edit:', topRightVisibilityBeforeEdit)
    console.log('🟠 Made topRightContainer visible for editing')
  }
  
  console.log('Indicator → orange (saving)')
}

/** Mark "done" → green, then fade back to grey after 1s */
export function showTick() {
  if (!isProcessing || isComplete) return
  isComplete = true

  const layer1 = document.querySelector('#Layer_1 .cls-1')
  if (layer1) {
    layer1.style.fill = '#10a64a'
  }
  console.log('Indicator → green (done)')

  // after a short pause, restore to grey AND restore topRight visibility
  setTimeout(() => {
    resetIndicator()
    console.log('Indicator → grey (ready)')
  }, 1500)
}