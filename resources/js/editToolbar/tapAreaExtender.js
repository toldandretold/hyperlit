// Extends tap areas for toolbar buttons on mobile
// Captures taps in the gap below/around buttons and triggers them

export function initTapAreaExtender(toolbar) {
  if (!toolbar) return { enable: () => {}, disable: () => {} };

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (!isMobile) return { enable: () => {}, disable: () => {} };

  console.log('🎯 Tap area extender initialized on mobile');

  let enabled = false;
  let matchedButton = null;
  let touchStartY = null;

  // TOUCHSTART: Prevent default early to stop focus changes
  document.addEventListener('touchstart', (e) => {
    if (!enabled) return;

    // If the touch already hit a button directly, let it through
    if (e.target.closest('button')) {
      matchedButton = null;
      return;
    }

    // Get touch coordinates
    const touch = e.touches[0];
    const touchX = touch.clientX;
    const touchY = touch.clientY;

    const buttons = Array.from(toolbar.querySelectorAll('button:not(.citation-close-btn)'));

    // Find button whose extended zone contains the touch
    matchedButton = buttons.find(btn => {
      const rect = btn.getBoundingClientRect();
      const extendedRect = {
        left: rect.left - 10,
        right: rect.right + 10,
        top: rect.top - 20,
        bottom: rect.bottom + 120,
      };

      const matches = (
        touchX >= extendedRect.left &&
        touchX <= extendedRect.right &&
        touchY >= extendedRect.top &&
        touchY <= extendedRect.bottom
      );

      if (matches) {
        console.log(`🎯 Touchstart match: ${btn.id}`);
      }

      return matches;
    }) || null;

    if (matchedButton) {
      touchStartY = touchY;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    } else {
      touchStartY = null;
    }
  }, { capture: true, passive: false });

  // TOUCHEND: Trigger the button click
  document.addEventListener('touchend', (e) => {
    if (!enabled || !matchedButton) return;

    const deltaY = Math.abs(e.changedTouches[0].clientY - touchStartY);
    if (deltaY > 5) {
      console.log(`🎯 Touchend: cancelled (scrolled ${deltaY.toFixed(0)}px)`);
      matchedButton = null;
      touchStartY = null;
      return;
    }

    console.log(`🎯 Touchend: Triggering ${matchedButton.id} from extended zone`);
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    matchedButton.click();
    matchedButton = null;
    touchStartY = null;
  }, { capture: true, passive: false });

  return {
    enable()  { enabled = true;  console.log('🎯 Tap extender ENABLED');  },
    disable() { enabled = false; matchedButton = null; touchStartY = null; console.log('🎯 Tap extender DISABLED'); },
  };
}
