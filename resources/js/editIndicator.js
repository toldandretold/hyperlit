// editIndicator.js

let isProcessing = false
let isComplete   = false

/** Reset both flags and clear any inline fills */
function resetIndicator() {
  isProcessing = false
  isComplete   = false
  const layer1 = document.querySelector('#Layer_1 .cls-1')
  if (layer1) layer1.removeAttribute('style')
}

/** Mark “saving…” → orange */
export function showSpinner() {
  if (isProcessing) return
  resetIndicator()
  isProcessing = true

  const layer1 = document.querySelector('#Layer_1 .cls-1')
  if (layer1) {
    layer1.style.fill = '#EF8D34'
    // your SVG’s own `transition: fill 0.3s` will animate this
  }
  console.log('Indicator → orange (saving)')
}

/** Mark “done” → green, then fade back to grey after 1s */
export function showTick() {
  if (!isProcessing || isComplete) return
  isComplete = true

  const layer1 = document.querySelector('#Layer_1 .cls-1')
  if (layer1) {
    layer1.style.fill = '#10a64a'
  }
  console.log('Indicator → green (done)')

  // after a short pause, restore to grey
  setTimeout(() => {
    resetIndicator()
    console.log('Indicator → grey (ready)')
  }, 1000)
}