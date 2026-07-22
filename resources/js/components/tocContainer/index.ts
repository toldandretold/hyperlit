// TocContainerManager — the #toc-container panel. Owns the openContainer override
// (render TOC + bookmark before showing), heading scan + 30s cache, TOC render +
// click navigation, and the cache-invalidation API consumed by the data layer
// (divEditor / largePasteHandler). The singleton lives in ./managerRef so the
// button folder and these standalone functions share it without a cycle; the
// bookmark UI is in ./bookmark. Registry init/destroy live in
// ../tocToggleButton/tocToggleButton.
import { getNodesFromIndexedDB } from "../../indexedDB/index";
import { book } from "../../app";
import { ContainerManager } from "../utilities/containerManager";
import { getTocManager } from "./managerRef";
import { updateOrInsertBookmark, setInitialBookmarkPosition } from "./bookmark";

// Invalidate TOC cache when background download completes/fails (chunked lazy loading)
window.addEventListener('backgroundDownloadComplete', () => {
  if (tocCache) {
    tocCache.data = null;
    tocCache.lastScanTime = 0;
  }
});
window.addEventListener('backgroundDownloadFailed', () => {
  if (tocCache) {
    tocCache.data = null;
    tocCache.lastScanTime = 0;
  }
});

export class TocContainerManager extends (ContainerManager as any) {
  constructor(containerId: any, overlayId: any, buttonId: any, frozenContainerIds: any = []) {
    super(containerId, overlayId, buttonId, frozenContainerIds);
  }

  async openContainer() {
    // Restore baseline container structure (scroller, masks, controls).
    if (this.initialContent) {
      this.container.innerHTML = this.initialContent;
    }
    // Contents is the default tab on every open (user decision).
    activeTab = 'contents';
    buildTabBar(this.container);
    // Now render TOC into the restored structure.
    await generateTableOfContents();

    // Prepare container for opening but keep it hidden until fully ready
    if ((window as any).containerCustomizer) (window as any).containerCustomizer.loadCustomizations();

    // Set up all state BEFORE making container visible
    this.isOpen = true;
    (window as any).activeContainer = this.container.id;

    if (this.container.id === "toc-container") {
      this.saveNavElementsState();
    }

    this.updateState();

    // Add bookmark and set scroll position BEFORE showing container
    updateOrInsertBookmark(this.container, tocCache.data);
    setInitialBookmarkPosition(this.container);

    // NOW make container visible with open class applied immediately
    this.container.classList.remove("hidden");
    this.container.classList.add("open");

    // Only focus the container if it's not a back button navigation
    if (!this.isBackNavigation) {
      this.container.focus();
    }

    // Base ContainerManager trap (toc-container is in FOCUS_TRAP_CONTAINER_IDS):
    // Tab cycles the TOC entry links, Escape closes, focus returns to the
    // toggle button. This override skips super.openContainer(), so engage here.
    this._engageFocusTrap();
  }
}

// TOC cache management
let tocCache: any = {
  data: null,
  lastScanTime: 0,
  bookId: null,
  headingCount: 0
};

// ── Tabs: Contents (default) | Hyperlights ──────────────────────────────────
// The Hyperlights tab lists the user's own highlights (incl. ghosts) as
// clickable previews — see ./hyperlightsTab. Contents re-selected on every open.
let activeTab: 'contents' | 'hyperlights' = 'contents';

/** Build (idempotently) the fixed two-tab bar above the scroller. */
function buildTabBar(container: HTMLElement): void {
  container.querySelector('.toc-tab-bar')?.remove();
  const bar = document.createElement('div');
  bar.className = 'toc-tab-bar';
  bar.setAttribute('role', 'tablist');
  bar.innerHTML = `
    <button type="button" class="toc-tab-btn${activeTab === 'contents' ? ' active' : ''}" role="tab" aria-selected="${activeTab === 'contents'}" data-toc-tab="contents">Contents</button>
    <button type="button" class="toc-tab-btn${activeTab === 'hyperlights' ? ' active' : ''}" role="tab" aria-selected="${activeTab === 'hyperlights'}" data-toc-tab="hyperlights">Hyperlights</button>
  `;
  bar.addEventListener('click', (event: Event) => {
    const btn = (event.target as HTMLElement).closest('.toc-tab-btn') as HTMLElement | null;
    const tab = btn?.getAttribute('data-toc-tab') as 'contents' | 'hyperlights' | null;
    if (!btn || !tab || tab === activeTab) return;
    activeTab = tab;
    bar.querySelectorAll('.toc-tab-btn').forEach((b) => {
      const selected = b.getAttribute('data-toc-tab') === tab;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-selected', String(selected));
    });
    void renderActiveTab(container);
  });
  // Insert ABOVE the scroller so the bar stays fixed while content scrolls.
  const scroller = container.querySelector('.scroller');
  if (scroller) container.insertBefore(bar, scroller);
  else container.prepend(bar);
}

/** Render the scroller for the currently selected tab. */
async function renderActiveTab(container: HTMLElement): Promise<void> {
  if (activeTab === 'contents') {
    await generateTableOfContents();
    // Bookmark applies to the contents view only.
    updateOrInsertBookmark(container, tocCache.data);
    setInitialBookmarkPosition(container);
    return;
  }
  const scroller = container.querySelector('.scroller') as HTMLElement | null;
  if (!scroller) return;
  scroller.innerHTML = '<p class="toc-hyperlights-empty">Loading…</p>';
  // Dynamic import keeps the highlights machinery out of the TOC's eager path.
  const { renderHyperlightsTab } = await import('./hyperlightsTab');
  await renderHyperlightsTab(scroller, book);
}

/** Check if TOC cache is valid for the current book */
function isTocCacheValid() {
  const currentBook = book;
  const isValid = (
    tocCache.data !== null &&
    tocCache.bookId === currentBook &&
    Date.now() - tocCache.lastScanTime < 30000 // 30 second cache
  );

  return isValid;
}

/**
 * Scan nodes content for heading elements.
 * When the book is not fully loaded, fetches headings from the server
 * instead of scanning IndexedDB (which only has a partial dataset).
 */
async function scanForHeadings() {
  // pageLoad is a bootstrap module — import it dynamically to avoid a static
  // component→bootstrap import cycle (flagged by the acyclic-import gate).
  const { currentLazyLoader } = await import("../../pageLoad/currentLazyLoaderState");
  // If not fully loaded, fetch headings from server endpoint
  if (!currentLazyLoader?.isFullyLoaded) {
    try {
      console.log("📖 Book not fully loaded — fetching headings from server...");
      const url = `/api/database-to-indexeddb/books/${book}/headings`;
      const resp = await fetch(url);
      if (resp.ok) {
        const headings = await resp.json();
        // Server returns sorted [{id, type, text}] — add link property
        const withLinks = headings.map((h: any) => ({ ...h, link: `#${h.id}` }));
        console.log(`📖 Server returned ${withLinks.length} headings`);
        return withLinks;
      }
    } catch (e) {
      console.warn('Server headings fetch failed, falling back to IndexedDB:', e);
    }
  }

  // Existing IndexedDB scan (used when fully loaded or server fails)
  console.log("📖 Scanning nodes for headings...");

  let nodes: any[] = [];
  try {
    nodes = await getNodesFromIndexedDB(book);
  } catch (e) {
    console.error("Error retrieving nodes from IndexedDB:", e);
    return [];
  }

  const headings: any[] = [];
  // Match id="..." but NOT data-node-id="..." (require space or < before id)
  const headingRegex = /^<(h[1-6])[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h[1-6]>/i;

  for (const chunk of nodes) {
    if (!chunk.content) continue;

    const match = chunk.content.match(headingRegex);
    if (match) {
      const [, tagName, id, textContent] = match;

      // Clean up the text content (remove any nested HTML tags and decode entities)
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = textContent.replace(/<[^>]*>/g, '');
      const cleanText = tempDiv.textContent!.trim();

      if (cleanText) {
        headings.push({
          id,
          type: tagName.toLowerCase(),
          text: cleanText,
          link: `#${id}`,
        });
      }
    }
  }

  console.log(`📖 Found ${headings.length} headings`);
  return headings.sort((a, b) => {
    // Sort by numerical ID if possible, otherwise alphabetically
    const aNum = parseFloat(a.id);
    const bNum = parseFloat(b.id);
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return aNum - bNum;
    }
    return a.id.localeCompare(b.id);
  });
}

/** Generates the Table of Contents with caching. */
export async function generateTableOfContents(containerIdLegacy?: any, buttonIdLegacy?: any) {
  console.log("📋 generateTableOfContents called");

  const tocContainer = document.getElementById("toc-container"); // Get fresh reference
  if (!tocContainer) {
    console.error("TOC container not found!");
    return;
  }

  // Check if we can use cached data
  if (isTocCacheValid()) {
    console.log("📋 Using cached TOC data");
    renderTOC(tocContainer, tocCache.data);
    attachTocClickHandler();
    return;
  }

  // Scan for headings and cache the results
  console.log("📋 Cache invalid, scanning for headings...");
  const tocData = await scanForHeadings();

  // Update cache
  tocCache = {
    data: tocData,
    lastScanTime: Date.now(),
    bookId: book,
    headingCount: tocData.length
  };

  console.log("📋 Cache updated, rendering TOC");
  // Render the TOC
  renderTOC(tocContainer, tocData);
  attachTocClickHandler();
}

/** Attach click handler for TOC navigation (separated for reuse) */
function attachTocClickHandler() {
  const tocContainer = document.getElementById("toc-container") as any; // Get fresh reference
  if (!tocContainer) return;

  // Remove existing listeners to avoid duplicates
  const existingHandler = tocContainer._tocClickHandler;
  if (existingHandler) {
    tocContainer.removeEventListener("click", existingHandler);
  }

  // Add new click handler
  const clickHandler = async (event: any) => {
    // Hyperlights-tab entry: close the TOC, then the "from afar" flow (opens
    // the hyperlit container + scrolls; ghosts get the anchor + 👻 bubble
    // instead of a doomed mark-hunt). Checked BEFORE the generic <a> branch —
    // entries are anchors too.
    const hlEntry = event.target.closest('.toc-hyperlight-entry');
    if (hlEntry) {
      event.preventDefault();
      const highlightId = hlEntry.getAttribute('data-highlight-id');
      if (!highlightId) return;
      getTocManager().closeContainer();
      const { navigateAndOpenHighlight } = await import('../../hyperlitContainer/highlightNav');
      void navigateAndOpenHighlight(highlightId);
      return;
    }

    const link = event.target.closest("a");
    if (link) {
      event.preventDefault();
      const targetId = link.hash.substring(1);
      if (!targetId) return;

      getTocManager().closeContainer();
      console.log(`📌 Navigating via TOC to: ${targetId}`);
      // scrolling + pageLoad are bootstrap modules — dynamic import breaks the
      // static component→bootstrap cycle the acyclic-import gate guards.
      const { navigateToInternalId } = await import("../../scrolling/index");
      const { currentLazyLoader } = await import("../../pageLoad/currentLazyLoaderState");
      navigateToInternalId(targetId, currentLazyLoader, false);
    }
  };

  tocContainer.addEventListener("click", clickHandler);
  tocContainer._tocClickHandler = clickHandler;
}

/** Renders the TOC data into a container. */
export function renderTOC(container: any, tocData: any) {
  // Scroller is now pre-rendered in HTML - just find it
  const scroller = container.querySelector('.scroller');

  if (!scroller) {
    console.error('❌ Scroller not found in TOC container - check reader.blade.php');
    return;
  }

  // Clear existing content and repopulate (no DOM structure changes)
  scroller.innerHTML = '';

  // Create the TOC entries inside the scroller.
  tocData.forEach((item: any, index: number) => {
    const anchor = document.createElement("a");
    anchor.href = item.link;

    const heading = document.createElement(item.type);
    heading.textContent = item.text;

    // If this is the first heading, add the "first" class.
    if (index === 0) {
      heading.classList.add("first");
    }

    anchor.appendChild(heading);
    scroller.appendChild(anchor);
  });
}

/** Force invalidate cache - rescan on next access */
export function invalidateTocCache() {
  tocCache.data = null;
  tocCache.lastScanTime = 0;
}

/** Check if a node change affects headings and invalidate cache if needed */
export function checkAndInvalidateTocCache(nodeId: any, nodeElement: any) {
  if (!nodeElement) return false;

  // Check if this is a heading element
  const isHeading = /^h[1-6]$/i.test(nodeElement.tagName);

  if (isHeading) {
    console.log(`🔄 Heading ${nodeId} changed, invalidating TOC cache`);
    invalidateTocCache();
    return true;
  }

  return false;
}

/** Force invalidate cache for any node deletion (safer approach) */
export function invalidateTocCacheForDeletion(nodeId: any) {
  invalidateTocCache();
}

/** Force immediate TOC refresh (bypasses cache) */
export async function refreshTOC() {
  invalidateTocCache();
  await generateTableOfContents();
}
