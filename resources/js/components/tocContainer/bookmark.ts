// TOC bookmark concern (leaf): the reading-position bookmark shown in the TOC —
// reads the current scroll position, builds a dynamically-sized rotated SVG, and
// inserts/positions it. Was the bookmark half of toc.js. openContainer (in ./index)
// calls updateOrInsertBookmark + setInitialBookmarkPosition.
import { book } from "../../app";
import { getLocalStorageKey } from "../../indexedDB/index";

/** Get current scroll position from localStorage (session, then local). */
function getCurrentScrollPosition(): number | null {
  try {
    const scrollKey = getLocalStorageKey("scrollPosition", book);

    // Try sessionStorage first
    let savedPosition = sessionStorage.getItem(scrollKey);
    if (!savedPosition || savedPosition === "0") {
      // Fallback to localStorage
      savedPosition = localStorage.getItem(scrollKey);
    }

    if (savedPosition && savedPosition !== "0") {
      const parsed = JSON.parse(savedPosition);
      // Allow decimals: node ids (and thus saved elementIds) can be fractional
      // (150.5). The writer in lazyLoader stores them with /^\d+(\.\d+)?$/ — an
      // integer-only regex here silently rejected them, so the whole bookmark
      // failed to render whenever the reading position was on a decimal-id node.
      if (parsed && parsed.elementId && /^\d+(\.\d+)?$/.test(parsed.elementId)) {
        return parseFloat(parsed.elementId);
      }
    }
  } catch (e) {
    console.warn("Error reading scroll position:", e);
  }

  return null;
}

/** Create the bookmark SVG element (rotated 90 degrees anti-clockwise). */
function createBookmarkElement(length = 200, marginLeft = 40) {
  // 1. Define original geometry constants to calculate from.
  const topCapHeight = 2; // The height of the curved top part.
  const tailStructureHeight = 3.216; // The height of the tail structure.
  const fixedStructureHeight = topCapHeight + tailStructureHeight; // Total height of non-scalable parts.

  // 2. Calculate new geometry based on the desired length.
  const safeLength = Math.max(length, fixedStructureHeight + 20);
  const newShaftHeight = safeLength - fixedStructureHeight;

  // Define the Y-coordinates for the path.
  const y_top_base = 2519;
  const y_shaft_top = y_top_base + topCapHeight; // Y-coord where the straight shaft begins.
  const y_shaft_bottom = y_shaft_top + newShaftHeight; // Y-coord where the straight shaft ends.

  // 3. Dynamically construct the SVG path 'd' attribute.
  const d = `M219,${y_shaft_top} L219,${y_shaft_bottom} C219,${y_shaft_bottom + 0.889} 217.923,${y_shaft_bottom + 1.335} 217.293,${y_shaft_bottom + 0.705} L214.707,${y_shaft_bottom - 1.881} C214.317,${y_shaft_bottom - 2.271} 213.683,${y_shaft_bottom - 2.271} 213.293,${y_shaft_bottom - 1.881} L210.707,${y_shaft_bottom + 0.705} C210.077,${y_shaft_bottom + 1.335} 209,${y_shaft_bottom + 0.889} 209,${y_shaft_bottom} L209,${y_shaft_top} C209,2519.895 209.895,2519 211,2519 L217,2519 C218.105,2519 219,2519.895 219,${y_shaft_top}`;

  const bookmarkDiv = document.createElement("div");
  bookmarkDiv.classList.add("toc-bookmark");
  bookmarkDiv.style.cssText = `
    height: 20px;
    width: ${safeLength}px; /* Use calculated responsive length */
    margin-left: ${marginLeft}px; /* Use dynamic margin */
    margin-top: 8px;
    margin-bottom: 8px;
    padding: 0;
    position: relative; /* Establish a positioning context */
  `;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", `${safeLength}`);

  // The viewBox is now also dynamic, framing the newly generated path perfectly.
  const viewBoxHeight = (y_shaft_bottom + 1.335) - y_top_base;
  const viewBoxX = 204; // The path is drawn around X=209-219, so we center the viewBox there.
  const viewBoxWidth = 20;
  svg.setAttribute("viewBox", `${viewBoxX} ${y_top_base} ${viewBoxWidth} ${viewBoxHeight}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Absolutely position and center the SVG, then rotate it.
  svg.style.position = "absolute";
  svg.style.top = "50%";
  svg.style.left = "50%";
  svg.style.transform = "translate(-50%, -50%) rotate(-90deg)";

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.style.fill = "#EE4A95"; // Set fill directly on the path.

  svg.appendChild(path);
  bookmarkDiv.appendChild(svg);

  return bookmarkDiv;
}

/** Inserts or updates the bookmark in the TOC, sizing/positioning it dynamically. */
export function updateOrInsertBookmark(container: any, tocData: any) {
  const scroller = container.querySelector('.scroller');
  if (!scroller) return;

  // 1. Remove existing bookmark to ensure a clean slate
  const existingBookmark = scroller.querySelector('.toc-bookmark');
  if (existingBookmark) {
    existingBookmark.remove();
  }

  // 2. Check if we should have a bookmark (i.e., we have a scroll position)
  const currentScrollPosition = getCurrentScrollPosition();
  if (!currentScrollPosition) return;

  // 3. --- DYNAMIC BOOKMARK SIZING ---
  const getIndentPx = (headingType: any) => {
    const dummy = document.createElement(headingType);
    dummy.style.visibility = 'hidden';
    dummy.style.position = 'absolute';
    container.appendChild(dummy);
    const indent = parseInt(window.getComputedStyle(dummy).paddingLeft, 10);
    container.removeChild(dummy);
    return indent;
  };

  let currentSectionHeadingType = 'h1';
  if (tocData && tocData.length > 0) {
    let sectionItem = tocData[0];
    for (let i = 0; i < tocData.length; i++) {
      const item = tocData[i];
      const nextItem = tocData[i + 1];
      const itemId = parseFloat(item.id);
      const nextItemId = nextItem ? parseFloat(nextItem.id) : Infinity;
      if (currentScrollPosition >= itemId && currentScrollPosition < nextItemId) {
        sectionItem = item;
        break;
      }
    }
    if (currentScrollPosition >= parseFloat(tocData[tocData.length - 1].id)) {
      sectionItem = tocData[tocData.length - 1];
    }
    currentSectionHeadingType = sectionItem.type;
  }

  const indentations: any = { 'h1': 0, 'h2': getIndentPx('h2'), 'h3': getIndentPx('h3'), 'h4': getIndentPx('h4'), 'h5': getIndentPx('h5'), 'h6': getIndentPx('h6') };
  const dynamicMarginLeft = indentations[currentSectionHeadingType] || 0;

  const containerWidth = container.clientWidth;
  const computedContainerStyle = window.getComputedStyle(container);
  const containerPaddingLeft = parseInt(computedContainerStyle.paddingLeft, 10);
  const containerPaddingRight = parseInt(computedContainerStyle.paddingRight, 10);
  const contentAreaWidth = containerWidth - containerPaddingLeft - containerPaddingRight;
  const safetyPadding = 10;
  const maxLength = contentAreaWidth - dynamicMarginLeft - safetyPadding;
  const desiredLength = Math.min(200, Math.max(50, maxLength));

  // 4. Create the bookmark element
  const bookmarkElement = createBookmarkElement(desiredLength, dynamicMarginLeft);

  // 5. Find the correct DOM node to insert the bookmark before
  let insertionRefNode = null;
  for (const child of scroller.children) {
    if (child.tagName === 'A') {
      const href = child.getAttribute('href');
      if (href) {
        const id = parseFloat(href.substring(1));
        if (!isNaN(id) && currentScrollPosition < id) {
          insertionRefNode = child;
          break;
        }
      }
    }
  }

  console.log("📖 Inserting bookmark with calculated size and position.");
  scroller.insertBefore(bookmarkElement, insertionRefNode); // null → appends to the end.
}

/** Set initial TOC scroll position to the bookmark without animation. */
export function setInitialBookmarkPosition(container: any) {
  const scroller = container.querySelector('.scroller');
  const bookmark = scroller?.querySelector(".toc-bookmark");

  if (bookmark && scroller) {
    // Calculate position to show bookmark in upper third of the scroller
    const scrollerHeight = scroller.clientHeight;
    const bookmarkOffset = bookmark.offsetTop;
    const targetScroll = Math.max(0, bookmarkOffset - (scrollerHeight / 3));

    // Set position instantly without animation
    scroller.scrollTop = targetScroll;

    console.log("📖 Set initial TOC position to bookmark");
  }
}
