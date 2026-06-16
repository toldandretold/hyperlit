// Pure cursor / scroll-position helpers for edit mode (leaf — no sibling imports):
// place the caret at the end of an element, recover the saved scroll element,
// find first/last content elements, and detect overflow. Used by enableEditMode
// to decide where the caret lands when entering edit mode.

// Get the saved scroll position's element id (session, then local).
export function getSavedScrollElementId(bookId: any): string | null {
  const storageKey = `scrollPosition_${bookId}`;
  try {
    const scrollData = sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey);
    if (scrollData) {
      const parsed = JSON.parse(scrollData);
      return parsed.elementId;
    }
  } catch (error) {
    console.warn("Error parsing saved scroll position:", error);
  }
  return null;
}

// Place the caret at the end of a specific element's content.
export function placeCursorAtEndOfElement(elementId: string): boolean {
  const targetElement = document.getElementById(elementId);

  if (!targetElement) {
    console.warn(`Element with id="${elementId}" not found`);
    return false;
  }

  try {
    // Focus the element first
    targetElement.focus();

    // Create range and selection
    const range = document.createRange();
    const selection = window.getSelection()!;

    // Select all content in the element
    range.selectNodeContents(targetElement);
    // Collapse to end (cursor at end of content)
    range.collapse(false);

    // Apply the selection
    selection.removeAllRanges();
    selection.addRange(range);

    return true;
  } catch (error) {
    console.error(`Error placing cursor in element ${elementId}:`, error);
    return false;
  }
}

// First element with an id (excluding lazy-loader sentinels).
export function getFirstElementWithId(container: any): string | null {
  const elementsWithId = container.querySelectorAll("[id]");
  if (elementsWithId.length > 0) {
    // Filter out sentinel divs that lazy loader creates
    const contentElements = Array.from(elementsWithId).filter((el: any) => {
      const id = el.id;
      return !id.endsWith('-top-sentinel') && !id.endsWith('-bottom-sentinel');
    });

    if (contentElements.length > 0) {
      return (contentElements[0] as any).id;
    }
  }
  return null;
}

export function doesContentExceedViewport(container: any): boolean {
  const containerRect = container.getBoundingClientRect();
  const viewportHeight = window.innerHeight;

  // Check if container bottom is beyond viewport
  return containerRect.bottom > viewportHeight;
}

// Last element with meaningful (non-empty, non-sentinel) content.
export function getLastContentElement(container: any): string | null {
  const elementsWithId = container.querySelectorAll("[id]");
  if (elementsWithId.length === 0) return null;

  // Filter out elements that are empty, structural, or sentinel divs
  const contentElements = Array.from(elementsWithId).filter((el: any) => {
    const id = el.id;
    const text = el.textContent?.trim();
    // Exclude sentinels and empty elements
    return text &&
           text.length > 0 &&
           !id.endsWith('-top-sentinel') &&
           !id.endsWith('-bottom-sentinel');
  });

  if (contentElements.length === 0) return null;

  // Return the last element with content
  return (contentElements[contentElements.length - 1] as any).id;
}
