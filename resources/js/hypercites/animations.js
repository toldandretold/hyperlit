/**
 * Hypercite Visual Animations
 *
 * Provides visual feedback for hypercite navigation with highlighting and dimming effects.
 */

// Module-level timeout reference for managing highlight animations
let highlightTimeout = null;

/**
 * Highlight target hypercite and dim others when navigating to a specific hypercite
 * @param {string} targetHyperciteId - The ID of the hypercite being navigated to
 * @param {number} delay - Delay in milliseconds before highlighting starts (default: 300ms)
 */
export function highlightTargetHypercite(targetHyperciteId, delay = 300) {
  console.log(`🎯 Highlighting target hypercite: ${targetHyperciteId} (with ${delay}ms delay)`);

  // Clear any existing timeout from previous navigation to prevent race conditions
  if (highlightTimeout) {
    console.log('🧹 Clearing previous highlight timeout to prevent animation glitches');
    clearTimeout(highlightTimeout);
    highlightTimeout = null;
  }

  // Find all hypercite elements (u tags with couple, poly, or single classes, and a tags with hypercite_ IDs)
  const allHypercites = document.querySelectorAll('u.single, u.couple, u.poly, a[id^="hypercite_"]');

  // Find ALL segments for this hypercite (both individual and overlapping)
  let targetElements = [];

  // 1. Check for direct element (individual segment)
  const directElement = document.getElementById(targetHyperciteId);
  if (directElement) {
    console.log(`🎯 Found direct element for ${targetHyperciteId}:`, directElement);
    targetElements.push(directElement);
  }

  // 2. Check ALL overlapping elements for segments containing this hypercite
  const overlappingElements = document.querySelectorAll('u[data-overlapping]');
  for (const element of overlappingElements) {
    const overlappingIds = element.getAttribute('data-overlapping');
    if (overlappingIds && overlappingIds.split(',').map(id => id.trim()).includes(targetHyperciteId)) {
      console.log(`🎯 Found target hypercite ${targetHyperciteId} in overlapping element:`, element);
      targetElements.push(element);
    }
  }

  // Clean up old classes IMMEDIATELY (before the setTimeout delay)
  const allHighlighted = document.querySelectorAll('a.hypercite-target, a.hypercite-dimmed, u.hypercite-target, u.hypercite-dimmed');
  allHighlighted.forEach(element => {
    element.classList.remove('hypercite-target', 'hypercite-dimmed');
  });

  // Remove ALL arrow highlights immediately
  const allArrows = document.querySelectorAll('.arrow-target');
  allArrows.forEach(arrow => {
    arrow.classList.remove('arrow-target');
  });

  // Wait for the specified delay, then apply highlighting with smooth transition
  setTimeout(() => {
    console.log(`✨ Starting hypercite highlighting animation for: ${targetHyperciteId}`);

    // Apply target highlighting to ALL elements containing this hypercite
    if (targetElements.length > 0) {
      targetElements.forEach(element => {
        element.classList.add('hypercite-target');

        // Listen for animation end and remove class
        const handleAnimationEnd = (e) => {
          if (e.target === element) {
            element.classList.remove('hypercite-target');
            element.removeEventListener('animationend', handleAnimationEnd);
            console.log(`✅ Hypercite target animation ended for ${element.id}`);
          }
        };
        element.addEventListener('animationend', handleAnimationEnd);

        // 🎯 Highlight arrow icons and auto-remove when animation ends
        const arrowIcons = element.querySelectorAll('.open-icon, sup.open-icon, span.open-icon');
        arrowIcons.forEach(arrow => {
          arrow.classList.add('arrow-target');
          console.log(`✨ Added arrow highlight to icon in ${targetHyperciteId}`);

          // Listen for animation end and remove class
          const handleAnimationEnd = (e) => {
            if (e.target === arrow) {
              arrow.classList.remove('arrow-target');
              arrow.removeEventListener('animationend', handleAnimationEnd);
              console.log(`✅ Arrow animation ended, class removed`);
            }
          };
          arrow.addEventListener('animationend', handleAnimationEnd);
        });
      });
      console.log(`✅ Added target highlighting to ${targetElements.length} segments for: ${targetHyperciteId}`);
    } else {
      console.warn(`⚠️ Could not find target hypercite element: ${targetHyperciteId}`);
    }

    // Dim all other hypercites (but not the target elements)
    allHypercites.forEach(element => {
      if (!targetElements.includes(element)) {
        element.classList.add('hypercite-dimmed');

        // Listen for animation end and remove class
        const handleAnimationEnd = (e) => {
          if (e.target === element) {
            element.classList.remove('hypercite-dimmed');
            element.removeEventListener('animationend', handleAnimationEnd);
          }
        };
        element.addEventListener('animationend', handleAnimationEnd);
      }
    });

    console.log(`🔅 Dimmed ${allHypercites.length - targetElements.length} non-target hypercites`);

    // Remove highlighting after 5 seconds with smooth transition back
    // Store timeout reference so it can be cleared by subsequent navigations
    highlightTimeout = setTimeout(() => {
      console.log(`🌅 Starting fade-out animation for: ${targetHyperciteId}`);
      restoreNormalHyperciteDisplay();
      highlightTimeout = null; // Clear reference after completion
    }, 5000);

  }, delay);

}

/**
 * Restore normal hypercite display by removing all navigation classes
 */
export function restoreNormalHyperciteDisplay() {
  console.log(`🔄 Restoring normal hypercite display`);

  // Select both <a> and <u> tags with these classes (anchors in annotations, underlines in text)
  const allHypercites = document.querySelectorAll('a.hypercite-target, a.hypercite-dimmed, u.hypercite-target, u.hypercite-dimmed');
  allHypercites.forEach(element => {
    element.classList.remove('hypercite-target', 'hypercite-dimmed');
  });

  // 🎯 NEW: Also remove arrow highlighting
  const allArrows = document.querySelectorAll('.arrow-target');
  allArrows.forEach(arrow => {
    arrow.classList.remove('arrow-target');
  });

  console.log(`✅ Restored normal display for ${allHypercites.length} hypercites and ${allArrows.length} arrows`);
}
