/**
 * Hypercite Visual Animations
 *
 * Provides visual feedback for hypercite navigation with highlighting and dimming effects.
 */

import { showTargetNotFoundToast } from '../components/toast/toast';

// Module-level timeout reference for managing highlight animations
let highlightTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Highlight target hypercite and dim others when navigating to a specific hypercite
 */
export function highlightTargetHypercite(targetHyperciteId: string, delay = 300): void {
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
  let targetElements: Element[] = [];

  // 1. Check for direct element (individual segment)
  const directElement = document.getElementById(targetHyperciteId);
  if (directElement) {
    console.log(`🎯 Found direct element for ${targetHyperciteId}:`, directElement);
    targetElements.push(directElement);
  }

  // 2. Check ALL overlapping elements for segments containing this hypercite
  const overlappingElements = document.querySelectorAll('u[data-overlapping]');
  for (const element of Array.from(overlappingElements)) {
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
        const handleAnimationEnd = (e: Event) => {
          if (e.target === element) {
            element.classList.remove('hypercite-target');
            element.removeEventListener('animationend', handleAnimationEnd);
            console.log(`✅ Hypercite target animation ended for ${element.id}`);
          }
        };
        element.addEventListener('animationend', handleAnimationEnd);

        // 🎯 Highlight arrow icons and auto-remove when animation ends
        const arrowIcons = element.matches('.open-icon')
          ? [element]
          : Array.from(element.querySelectorAll('.open-icon'));
        arrowIcons.forEach(arrow => {
          arrow.classList.add('arrow-target');
          console.log(`✨ Added arrow highlight to icon in ${targetHyperciteId}`);

          // Listen for animation end and remove class
          const handleAnimationEnd = (e: Event) => {
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
      // Surface feedback instead of silently doing nothing — e.g. a cite whose stored range
      // was corrupted to zero-width never renders, so navigation would otherwise just stall.
      showTargetNotFoundToast({ target: targetHyperciteId });
    }

    // Dim all other hypercites (but not the target elements)
    allHypercites.forEach(element => {
      if (!targetElements.includes(element)) {
        element.classList.add('hypercite-dimmed');

        // Listen for animation end and remove class
        const handleAnimationEnd = (e: Event) => {
          if (e.target === element) {
            element.classList.remove('hypercite-dimmed');
            element.removeEventListener('animationend', handleAnimationEnd);
          }
        };
        element.addEventListener('animationend', handleAnimationEnd);
      }
    });

    console.log(`🔅 Dimmed ${allHypercites.length - targetElements.length} non-target hypercites`);

    // Remove highlighting after 2.5 seconds with smooth transition back
    // Store timeout reference so it can be cleared by subsequent navigations
    highlightTimeout = setTimeout(() => {
      console.log(`🌅 Starting fade-out animation for: ${targetHyperciteId}`);
      restoreNormalHyperciteDisplay();
      highlightTimeout = null; // Clear reference after completion
    }, 2000);

  }, delay);

}

/**
 * Restore normal hypercite display by removing all navigation classes
 */
export function restoreNormalHyperciteDisplay(): void {
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

/**
 * Spawn the floating 👻 bubble at a screen position: float-up + fade, then
 * self-remove. Shared by ghost hypercite tombstones AND ghost hyperlight
 * navigation (hyperlitContainer/highlightNav) — the bubble is transient and
 * never touches document content.
 */
export function spawnGhostBubble(rect: DOMRect, idSuffix: string): void {
  // Remove any existing bubble for this anchor (duplicate guard)
  const existingBubble = document.getElementById(`ghost-bubble-${idSuffix}`);
  if (existingBubble) existingBubble.remove();

  const bubble = document.createElement('div');
  bubble.id = `ghost-bubble-${idSuffix}`;
  bubble.className = 'ghost-bubble';
  bubble.textContent = '👻';
  bubble.style.left = `${rect.left}px`;
  bubble.style.top = `${rect.top}px`;
  document.body.appendChild(bubble);

  // Trigger animation on next frame so the initial state is painted first
  requestAnimationFrame(() => {
    bubble.classList.add('ghost-bubble-animate');
  });

  // Self-remove on animation end
  bubble.addEventListener('animationend', () => {
    bubble.remove();
  }, { once: true });

  // Safety timeout in case animationend doesn't fire
  setTimeout(() => {
    if (bubble.parentNode) bubble.remove();
  }, 5000);
}

/**
 * Reveal a ghost tombstone as a floating translucent bubble that floats up and fades away.
 * Called when navigating to a tombstone via "See in source text".
 */
export function revealGhostIfTombstone(elementId: string): boolean {
  const el = document.getElementById(elementId);
  if (!el || !el.classList.contains('hypercite-tombstone')) return false;

  spawnGhostBubble(el.getBoundingClientRect(), elementId);
  return true;
}
