/**
 * Listeners module - Handles event listeners for mark elements
 */

import { handleUnifiedContentClick } from '../hyperlitContainer/containerActions';
import { applyGroupHover, clearGroupHover } from './markGroup';
import { verbose } from '../utilities/logger';

// Per-element guard — prevents double-fires without blocking other buttons
const processingElements = new WeakSet<object>();

/**
 * Attach click and hover listeners to all mark elements
 */
export function attachMarkListeners(scope: ParentNode = document): void {
    // Get all mark elements (both with ID and with just class)
    const markTags = scope.querySelectorAll("mark");
    verbose.user(`Attaching mark listeners (${markTags.length} elements)`, '/hyperlights/listeners.js');

    markTags.forEach(function(mark) {
        // Remove existing listeners
        mark.removeEventListener("click", handleMarkClick);
        mark.removeEventListener("mouseover", handleMarkHover);
        mark.removeEventListener("mouseout", handleMarkHoverOut);

        // Add new listeners
        mark.addEventListener("click", handleMarkClick);
        mark.addEventListener("mouseover", handleMarkHover);
        mark.addEventListener("mouseout", handleMarkHoverOut);

        (mark as HTMLElement).dataset.listenerAttached = "true";
    });
}

/**
 * Handle click events on mark elements
 */
export async function handleMarkClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement;
  // Find the closest mark element (handles clicks on nested elements like spans)
  const markElement = target.closest('mark');
  if (!markElement) {
    console.log(`🎯 Click not inside a mark element - ignoring`);
    return;
  }

  // A link/button inside the highlight: do NOT claim or preventDefault. Let the click bubble
  // to the lazyLoader globalLinkHandler — it blocks private/deleted target books AND opens the
  // unified container (where detection adds this overlapping highlight via closest('mark')).
  // A hypercite link does NOT navigate away: globalLinkHandler intercepts it. A plain link
  // navigates normally. (Claiming it here would set defaultPrevented and make globalLinkHandler
  // bail at its `if (event.defaultPrevented) return;` guard — the in-mark dead-click bug.)
  if (target.tagName === 'A' || target.tagName === 'BUTTON') {
    console.log(`🎯 ${target.tagName} inside mark - deferring to link handler`);
    return;
  }

  // Plain highlight-text click: claim the event and open the highlight container.
  event.preventDefault();

  // Grab all classes that look like HL_* from the mark element
  const highlightIds = Array.from(markElement.classList).filter((cls) =>
    cls.startsWith("HL_")
  );
  if (highlightIds.length === 0) {
    console.error("❌ No highlight IDs found on mark");
    return;
  }

  // Check which highlights are newly created
  const newHighlightIds = markElement.getAttribute('data-new-hl');
  const newIds = newHighlightIds ? newHighlightIds.split(',') : [];

  console.log(`New highlight IDs: ${newIds.join(", ")}`);
  console.log(`Opening highlights: ${highlightIds.join(", ")}`);

  // Use unified container system - pass the mark element, not the clicked target
  await handleUnifiedContentClick(markElement, highlightIds, newIds);
}

/**
 * Handle mouseover events on mark elements.
 * A highlight is rendered as multiple sibling marks (split by overlaps and
 * footnote sups) — light up the WHOLE group sharing the hovered mark's HL_*
 * classes, so what glows matches the actual highlighted text.
 */
export function handleMarkHover(event: Event): void {
    const target = event.target as HTMLElement;
    const mark = target.closest ? target.closest('mark') : null;
    if (!mark) return;
    applyGroupHover(mark);
}

/**
 * Handle mouseout events on mark elements
 */
export function handleMarkHoverOut(event: Event): void {
    (event.target as HTMLElement).style.textDecoration = "none";
    clearGroupHover();
}

/**
 * Bind both click and touchstart events to an element with debouncing
 */
export function addTouchAndClickListener(element: HTMLElement, handler: (event: Event) => unknown): void {
  const el = element as any;
  // Check if we've already attached listeners to prevent duplicates
  if (el._listenersAttached) {
    console.log("🚫 Listeners already attached to element, skipping");
    return;
  }

  const wrappedHandler = async function(event: Event) {
    if (processingElements.has(element)) {
      console.log("🚫 Handler already processing for this element, ignoring duplicate event");
      return;
    }

    processingElements.add(element);
    event.preventDefault();
    event.stopPropagation();

    try {
      await handler(event);
    } catch (err) {
      console.error("Button handler error:", err);
    } finally {
      processingElements.delete(element);
    }
  };

  // Add the listeners
  element.addEventListener("mousedown", wrappedHandler);
  element.addEventListener("touchstart", wrappedHandler);

  // Store handler ref so cleanup can remove listeners
  el._wrappedHandler = wrappedHandler;

  // Mark that we've attached listeners using a custom property
  el._listenersAttached = true;
}
