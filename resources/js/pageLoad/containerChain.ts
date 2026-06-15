import {
  openDatabase,
} from "../indexedDB/index.js";

import { syncBookDataFromDatabase } from "../indexedDB/serverSync";

import { parseSubBookId, buildSubBookId } from '../utilities/subBookIdHelper.js';

// From the zero-import leaf, not lazyLoaderRegistry — so this module doesn't depend on the
// registry and lazyLoaderRegistry can import openContainerChain statically (no cycle, no breaker).
import { currentLazyLoader } from './currentLazyLoaderState';

/**
 * Wait for a DOM element to appear (by highlight class or footnote ID).
 * Uses MutationObserver with a timeout fallback.
 */
function waitForElement(itemId: string, container: any, timeout = 8000): Promise<any> {
  return new Promise((resolve) => {
    const selector = itemId.startsWith('HL_')
      ? `mark.${CSS.escape(itemId)}`
      : `#${CSS.escape(itemId)}`;

    const searchRoot = container || document;
    const existing = searchRoot.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = searchRoot.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(container || document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

/**
 * Frontend equivalent of TextController::walkChainToRoot.
 * Given a leaf sub-book ID, walk backwards to the root book,
 * building the full chain of {itemId, subBookId} pairs.
 */
async function walkChainToRoot(rootBook: string, leafSubBookId: string): Promise<any> {
  const chain = [];
  let currentSubBookId = leafSubBookId;

  for (let i = 0; i < 20; i++) {
    const parsed = parseSubBookId(currentSubBookId);
    if (!parsed.itemId) return null;

    chain.unshift({ itemId: parsed.itemId, subBookId: currentSubBookId });

    const parentBook = await findParentBook(currentSubBookId, parsed.itemId);
    if (!parentBook) return null;

    // Root reached when parentBook has no slashes
    if (!parentBook.includes('/')) {
      return (parentBook === rootBook) ? chain : null;
    }

    currentSubBookId = parentBook;
  }

  return null; // Safety limit
}

/**
 * Find the parent book of a sub-book by querying IndexedDB.
 * Mirrors TextController::findParentBook — checks footnotes then hyperlights.
 */
async function findParentBook(subBookId: string, itemId: string): Promise<any> {
  const db = await openDatabase();

  // Try footnotes
  if (itemId.includes('_Fn') || /^Fn\d/.test(itemId)) {
    const tx = db.transaction('footnotes', 'readonly');
    const index = tx.objectStore('footnotes').index('footnoteId');
    const results: any[] = await new Promise((resolve, reject) => {
      const req = index.getAll(itemId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    for (const fn of results) {
      if (buildSubBookId(fn.book, itemId) === subBookId) {
        return fn.book;
      }
    }
  }

  // Try hyperlights
  if (itemId.startsWith('HL_')) {
    const tx = db.transaction('hyperlights', 'readonly');
    const index = tx.objectStore('hyperlights').index('hyperlight_id');
    const results: any[] = await new Promise((resolve, reject) => {
      const req = index.getAll(itemId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    for (const hl of results) {
      if (buildSubBookId(hl.book, itemId) === subBookId) {
        return hl.book;
      }
    }
  }

  return null;
}

/**
 * Build the full container chain from URL path segments.
 * For level 1-2, all items are in the URL.
 * For level 3+, walks up via IndexedDB to find missing intermediate items.
 */
export async function buildChainFromUrl(bookId: string, pathSegments: string[]): Promise<any[]> {
  const afterBook = pathSegments.slice(1); // Everything after book ID
  if (afterBook.length === 0) return [];

  const firstAfterBook: any = afterBook[0];
  const isNested = /^\d+$/.test(firstAfterBook); // Level number present?
  const level = isNested ? parseInt(firstAfterBook, 10) : 1;

  // Extract visible Fn/HL segments from URL
  const visibleItems = afterBook.filter(seg =>
    seg.startsWith('HL_') || seg.includes('_Fn') || /^Fn\d/.test(seg)
  );

  if (visibleItems.length === 0) return [];

  // Level 1-2: all chain items are in the URL
  if (level <= visibleItems.length) {
    return visibleItems.map(seg => ({ itemId: seg, subBookId: null }));
  }

  // Level 3+: missing intermediate items, resolve via IndexedDB
  const rest = afterBook.join('/');
  const leafSubBookId = `${bookId}/${rest}`;
  const resolvedChain = await walkChainToRoot(bookId, leafSubBookId);

  if (resolvedChain) return resolvedChain;

  // Server-side fallback when IndexedDB doesn't have intermediate sub-book data
  try {
    console.log(`🔗 buildChainFromUrl: IndexedDB resolution failed, trying server...`);
    const response = await fetch(`/api/resolve-chain/${bookId}/${rest}`);
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.chain?.length > 0) {
        console.log(`🔗 buildChainFromUrl: Server resolved chain with ${data.chain.length} items`);
        return data.chain;
      }
    }
  } catch (err) {
    console.warn(`🔗 buildChainFromUrl: Server resolution failed:`, err);
  }

  // Fallback: use what we have from URL
  console.warn(`Could not resolve full chain for ${leafSubBookId}, using partial chain`);
  return visibleItems.map(seg => ({ itemId: seg, subBookId: null }));
}

/**
 * Open a chain of containers sequentially.
 * Closes any existing containers first, then opens each chain item
 * by finding its element and calling handleUnifiedContentClick.
 */
export async function openContainerChain(chain: any[], lazyLoader: any, finalHash: any = null) {
  if (!chain || chain.length === 0) return;

  // Close any existing containers to start from clean state
  const isContainerCurrentlyOpen = document.body.classList.contains('hyperlit-container-open');
  if (isContainerCurrentlyOpen) {
    try {
      const { closeHyperlitContainer } = await import('../hyperlitContainer/index');
      await closeHyperlitContainer(true);
    } catch (e) { /* ignore */ }
  }

  // Support both old string[] format and new {itemId, subBookId}[] format
  const normalized = chain.map(item =>
    typeof item === 'string' ? { itemId: item, subBookId: null } : item
  );

  // Pre-sync ALL sub-book data in parallel so containers open instantly
  const subBookIds = normalized.map(i => i.subBookId).filter(Boolean);
  if (subBookIds.length > 0) {
    console.log(`Pre-syncing ${subBookIds.length} sub-books...`);
    await Promise.allSettled(
      subBookIds.map(id => syncBookDataFromDatabase(id))
    );
  }

  // Open all containers in the chain — continueChainOpening handles both the
  // first item (searching document.body) and subsequent items (searching inside
  // the current container scroller), using the correct selector for HL_ marks.
  await continueChainOpening(normalized);

  // After chain is fully opened, scroll to final hash target (e.g. hypercite)
  if (finalHash) {
    await new Promise(r => setTimeout(r, 500));
    const { getCurrentContainer } = await import('../hyperlitContainer/stack');
    const container = getCurrentContainer();
    if (container) {
      const target = container.querySelector(`#${CSS.escape(finalHash)}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const { highlightTargetHypercite } = await import('../hypercites/animations');
        highlightTargetHypercite(finalHash, 500);
      }
    }
  }
}

/**
 * Continue opening stacked layers for each chain item.
 * Each iteration searches inside the current container's scroller
 * (or document.body if no container is open yet), then triggers
 * handleUnifiedContentClick which auto-stacks.
 */
async function continueChainOpening(chain: any[]) {
  for (const chainItem of chain) {
    const itemId = typeof chainItem === 'string' ? chainItem : chainItem.itemId;

    // Search inside the current container scroller if one is open,
    // otherwise search document.body (for the first chain item)
    const { getCurrentScroller } = await import('../hyperlitContainer/stack');
    const isContainerOpen = document.body.classList.contains('hyperlit-container-open');
    const scroller = isContainerOpen ? getCurrentScroller() : null;

    let element = await waitForElement(itemId, scroller || document.body, 8000);

    // If not found, the item may be beyond the 5-node preview.
    // Try expanding the sub-book via the "[read more]" button.
    if (!element && scroller) {
      const readMoreBtn = scroller.querySelector('.expand-sub-book');
      if (readMoreBtn) {
        console.log(`Expanding sub-book to find chain item ${itemId}...`);
        readMoreBtn.click();
        await new Promise(r => setTimeout(r, 2000));
        element = await waitForElement(itemId, scroller, 5000);
      }
    }

    // Fallback: if the element wasn't found (e.g. DOM is empty or wrong chunk loaded),
    // search the lazy loader's nodes to find and load the correct chunk
    if (!element && currentLazyLoader?.nodes) {
      let targetChunkId = null;
      for (const node of currentLazyLoader.nodes) {
        if (Array.isArray(node.footnotes) && node.footnotes.includes(itemId)) {
          targetChunkId = node.chunk_id;
          break;
        }
        if (node.content && node.content.includes(`id="${itemId}"`)) {
          targetChunkId = node.chunk_id;
          break;
        }
        if (itemId.startsWith('HL_') && Array.isArray(node.hyperlights)) {
          if (node.hyperlights.some((h: any) => h.highlightID === itemId)) {
            targetChunkId = node.chunk_id;
            break;
          }
        }
      }
      if (targetChunkId !== null) {
        console.log(`Loading chunk ${targetChunkId} for chain item ${itemId}`);
        await currentLazyLoader.loadChunk(targetChunkId, "down");
        element = await waitForElement(itemId, scroller || document.body, 3000);
      }
    }

    if (!element) {
      console.warn(`Chain item ${itemId} not found, stopping chain.`);
      break;
    }

    // Wait for any in-flight click processing to finish before opening next layer
    const { handleUnifiedContentClick, isClickProcessing } = await import('../hyperlitContainer/index');
    let waitAttempts = 0;
    while (isClickProcessing() && waitAttempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      waitAttempts++;
    }

    // Re-query element in current scope — the original reference may be stale
    // if the sub-book DOM was rebuilt during hydration
    const { getCurrentScroller: getLatestScroller } = await import('../hyperlitContainer/stack');
    const containerNowOpen = document.body.classList.contains('hyperlit-container-open');
    const latestScroller = containerNowOpen ? getLatestScroller() : null;
    const selector = itemId.startsWith('HL_')
      ? `mark.${CSS.escape(itemId)}`
      : `#${CSS.escape(itemId)}`;
    const freshElement = (latestScroller || document.body).querySelector(selector);
    if (freshElement) element = freshElement;

    await handleUnifiedContentClick(element);

    // Brief pause for stacked layer DOM render
    await new Promise(r => setTimeout(r, 500));
  }
}
