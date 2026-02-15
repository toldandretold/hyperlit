// Extends tap areas for toolbar buttons on mobile
// Captures taps in the gap below/around buttons and triggers them

export function initTapAreaExtender(toolbar) {
  if (!toolbar) return;

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (!isMobile) return; // Only needed on mobile

  console.log('🎯 Tap area extender initialized on mobile');

  let matchedButton = null;

  // TOUCHSTART: Prevent default early to stop focus changes
  document.addEventListener('touchstart', (e) => {
    // If the touch already hit a button directly, let it through
    if (e.target.closest('button')) {
      console.log('🎯 Touchstart hit button directly, letting through');
      matchedButton = null;
      return;
    }

    // Get touch coordinates
    const touch = e.touches[0];
    const touchX = touch.clientX;
    const touchY = touch.clientY;

    console.log(`🎯 Touchstart at (${touchX}, ${touchY}) - checking for nearby buttons`);

    const buttons = Array.from(toolbar.querySelectorAll('button:not(.citation-close-btn)'));

    // Find button whose extended zone contains the touch
    matchedButton = buttons.find(btn => {
      const rect = btn.getBoundingClientRect();
      const extendedRect = {
        left: rect.left - 10,
        right: rect.right + 10,
        top: rect.top - 20,
        bottom: rect.bottom + 100, // Extended tap zone below button
      };

      const matches = (
        touchX >= extendedRect.left &&
        touchX <= extendedRect.right &&
        touchY >= extendedRect.top &&
        touchY <= extendedRect.bottom
      );

      if (matches) {
        console.log(`🎯 Touchstart match found: ${btn.id}, rect: top=${rect.top}, bottom=${rect.bottom}, extended bottom=${extendedRect.bottom}`);
      }

      return matches;
    });

    if (matchedButton) {
      console.log(`🎯 Touchstart: Preventing default to stop focus change for ${matchedButton.id}`);
      e.preventDefault();
      e.stopPropagation();
    } else {
      console.log('🎯 Touchstart: No matching button found');
    }
  }, { capture: true, passive: false });

  // TOUCHEND: Trigger the button click
  document.addEventListener('touchend', (e) => {
    if (matchedButton) {
      console.log(`🎯 Touchend: Triggering ${matchedButton.id} from extended zone`);
      e.preventDefault();
      e.stopPropagation();
      matchedButton.click();
      matchedButton = null;
    }
  }, { capture: true, passive: false });
}
