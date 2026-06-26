/**
 * scrolling/scrollHelpers — low-level, DOM-facing scroll mechanics: the
 * consistent scroll method (offsetTop-based + image-aware correction), the
 * public scrollElementIntoMainContent entry, and small element predicates.
 */
import { verbose } from '../utilities/logger';
import { userScrollState } from './navState';
import { shouldSkipScrollRestoration } from './userScrollDetection';
import { nextScrollReason } from './scrollTrace';

// Reusable scroll correction — recalculates offsetTop and snaps if the element drifted
function correctScrollPosition(targetElement: any, scrollableContainer: any, headerOffset: number): void {
  let elementOffset = 0;
  let el = targetElement;
  while (el && el !== scrollableContainer) {
    elementOffset += el.offsetTop;
    el = el.offsetParent;
  }

  const elementRect = targetElement.getBoundingClientRect();
  const containerRect = scrollableContainer.getBoundingClientRect();
  const currentElementPosition = elementRect.top - containerRect.top;

  if (Math.abs(currentElementPosition - headerOffset) > 20) {
    const targetScrollTop = Math.max(0, elementOffset - headerOffset);
    nextScrollReason('scroll-correction');
    scrollableContainer.scrollTo({ top: targetScrollTop, behavior: "instant" });
  }
}

// Consistent scroll method to be used throughout the application
export function scrollElementWithConsistentMethod(targetElement: any, scrollableContainer: any, headerOffset = 192): number | undefined {
  if (!targetElement || !scrollableContainer) {
    console.error("Missing target element or scrollable container for consistent scroll");
    return;
  }

  // Skip if content doesn't overflow (nothing to scroll)
  if (scrollableContainer.scrollHeight <= scrollableContainer.clientHeight) {
    return;
  }

  // Mark as navigation scroll to prevent user scroll detection interference
  userScrollState.isNavigating = true;

  // Calculate element's position using offsetTop for stable positioning
  let elementOffset = 0;
  let el = targetElement;
  while (el && el !== scrollableContainer) {
    elementOffset += el.offsetTop;
    el = el.offsetParent;
  }

  const targetScrollTop = Math.max(0, elementOffset - headerOffset);

  // Apply scroll with instant behavior to avoid animation conflicts
  nextScrollReason('consistent-scroll');
  scrollableContainer.scrollTo({
    top: targetScrollTop,
    behavior: "instant"
  });

  // --- Image-aware scroll correction ---
  // Collect images inside the container that are above the target element and still loading
  const allImages = scrollableContainer.querySelectorAll("img");
  const pendingImages: any[] = [];
  for (const img of allImages) {
    // Only care about images that appear before the target in document order
    if (img.compareDocumentPosition(targetElement) & Node.DOCUMENT_POSITION_FOLLOWING) {
      if (!img.complete) {
        pendingImages.push(img);
      }
    }
  }

  // Always fire a 100ms correction for non-image layout shifts (fonts, etc.)
  setTimeout(() => {
    if (shouldSkipScrollRestoration("scroll correction")) return;
    userScrollState.isNavigating = true;
    correctScrollPosition(targetElement, scrollableContainer, headerOffset);
  }, 100);

  if (pendingImages.length === 0) {
    // No pending images — just clear navigation flag after the 100ms correction settles
    setTimeout(() => { userScrollState.isNavigating = false; }, 1000);
  } else {
    // Track how many images are still pending so we know when all are done
    let remaining = pendingImages.length;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanupFns: Array<() => void> = [];

    const onImageSettled = () => {
      remaining--;
      if (shouldSkipScrollRestoration("image load correction")) return;

      // Re-assert navigating so the correction scroll isn't treated as user scroll
      userScrollState.isNavigating = true;
      requestAnimationFrame(() => {
        correctScrollPosition(targetElement, scrollableContainer, headerOffset);
      });

      // Reset the release timer — wait 500ms after the last image event
      if (releaseTimer) clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => { userScrollState.isNavigating = false; }, 500);
    };

    for (const img of pendingImages) {
      const onLoad = () => onImageSettled();
      const onError = () => onImageSettled();
      img.addEventListener("load", onLoad, { once: true });
      img.addEventListener("error", onError, { once: true });
      cleanupFns.push(() => {
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onError);
      });
    }

    // Safety cleanup at 8 seconds — remove any remaining listeners to prevent leaks
    setTimeout(() => {
      cleanupFns.forEach(fn => fn());
      userScrollState.isNavigating = false;
    }, 8000);
  }

  return targetScrollTop;
}

export function scrollElementIntoMainContent(targetElement: any, headerOffset = 50): void {
  // Find scrollable parent from the target element directly (handles lkj vs lkjPrivate etc)
  const scrollableParent = targetElement.closest(".reader-content-wrapper") ||
                           targetElement.closest(".home-content-wrapper") ||
                           targetElement.closest(".user-content-wrapper");

  if (!scrollableParent) {
    console.error("No scrollable parent wrapper found for target element");
    return;
  }

  // 🎯 USE CONSISTENT SCROLL METHOD
  scrollElementWithConsistentMethod(targetElement, scrollableParent, headerOffset);
}

export function lockScrollToTarget(targetElement: any, headerOffset = 50, attempts = 3): void {
  let count = 0;
  const interval = setInterval(() => {
    scrollElementIntoMainContent(targetElement, headerOffset);
    count++;
    if (count >= attempts) clearInterval(interval);
  }, 300);
}

export function isValidContentElement(el: any): boolean {
  // Exclude sentinels & non-content elements:
  if (
    !el.id ||
    el.id.includes("sentinel") ||
    el.id.startsWith("toc-") ||
    el.id === "ref-overlay"
  ) {
    verbose.nav(`Skipping non-tracked element: ${el.id}`, 'scrolling/scrollHelpers');
    return false;
  }
  return ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "IMG"].includes(
    el.tagName
  );
}

// Utility: wait for an element and then scroll to it.
export function waitForElementAndScroll(targetId: string, maxAttempts = 10, attempt = 0): void {
  const targetElement = document.getElementById(targetId);
  if (targetElement) {
    verbose.nav(`Target ID "${targetId}" found! Scrolling...`, 'scrolling/scrollHelpers');
    setTimeout(() => {
      scrollElementIntoMainContent(targetElement, 50);
    }, 150);
    return;
  }
  if (attempt >= maxAttempts) {
    console.warn(`❌ Gave up waiting for "${targetId}".`);
    return;
  }
  setTimeout(
    () => waitForElementAndScroll(targetId, maxAttempts, attempt + 1),
    200
  );
}
