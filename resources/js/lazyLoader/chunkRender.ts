import katex from 'katex';
import { verbose } from '../utilities/logger';
import { renderBlockToHtml } from "../utilities/convertMarkdown";
import { sanitizeHtml } from '../utilities/sanitizeConfig';
import { applyGateFilter } from "../components/utilities/gateFilter";
import { isNewlyCreatedHighlight } from "../utilities/operationState";
import { renderCharts } from './chartRenderer';
import { renderHarvestNetworks } from './graphRenderer';
import { STRUCTURAL_BLOCK_TAGS } from '../utilities/blockElements';
import { applyDynamicFootnoteNumbers } from './footnoteSelfHeal';
import { handleBrokenImages } from './imageState';
// E2EE (docs/e2ee.md): registry is a zero-import leaf — a cheap SYNC check so
// plaintext renders (the overwhelming majority) skip the hydration import entirely.
import { isBookEncrypted, rootBookId } from '../e2ee/registry';
import type { NodeRecord, NodeHyperlightView, NodeHyperciteView } from '../indexedDB/types';

/**
 * Render LaTeX math elements using KaTeX (loaded on demand).
 * Only downloads KaTeX JS/CSS when the page actually contains math.
 *
 * @param {HTMLElement} container - The DOM element to search within
 */
export function renderMathElements(container: any) {
  const mathEls = container.querySelectorAll('latex, latex-block');
  if (mathEls.length === 0) return;

  mathEls.forEach((el: any) => {
    const encoded = el.getAttribute('data-math');
    if (!encoded) return;
    const latex = decodeURIComponent(escape(atob(encoded)));
    try {
      katex.render(latex, el, {
        displayMode: el.tagName.toLowerCase() === 'latex-block',
        throwOnError: false,
      });
    } catch (err) {
      console.warn('KaTeX render error:', err);
      el.textContent = latex;
    }
  });
}

// --- A simple throttle helper to limit scroll firing
export function throttle(fn: any, delay: any) {
  let timer: any = null;
  return function (this: any, ...args: any[]) {
    if (!timer) {
      timer = setTimeout(() => {
        fn.apply(this, args);
        timer = null;
      }, delay);
    }
  };
}

/**
 * Ensure exactly ONE no-delete-id marker exists per book.
 * Checks DOM first (fast), then IndexedDB, then adds if not found anywhere.
 *
 * Uses dynamic import to avoid circular dependency with divEditor/domUtilities.js
 * Persists marker to IndexedDB and syncs to backend.
 *
 * @param {HTMLElement} chunkElement - The chunk element that was just loaded
 * @param {Array} allNodesInBook - All nodes for this book from IndexedDB
 */
export async function ensureNoDeleteMarkerForBook(chunkElement: any, allNodesInBook: any, isFullyLoaded = true) {
  try {
    // 🔄 LAZY IMPORT: Avoid circular dependency (toc.js → containerManager → initializePage → lazyLoader → domUtilities → chunkMutationHandler → toc.js)
    const { getNoDeleteNode, setNoDeleteMarker }: any = await import('../divEditor/domUtilities');
    const { updateSingleIndexedDBRecord }: any = await import('../indexedDB/index');

    // Step 1: Check DOM for marker (O(1) - very fast)
    if (getNoDeleteNode()) {
      verbose.content('no-delete-id marker already exists in DOM', 'lazyLoaderFactory.js');
      return; // Already exists in DOM
    }

    // Step 2: Check if marker exists in any node in IndexedDB
    // Safety check: allNodesInBook might be undefined/null for new books
    const hasMarkerInDB = allNodesInBook && Array.isArray(allNodesInBook)
      ? allNodesInBook.some((node: any) => node.content && node.content.includes('no-delete-id="please"'))
      : false;

    if (hasMarkerInDB) {
      verbose.content('no-delete-id marker exists in IndexedDB (not yet loaded)', 'lazyLoaderFactory.js');
      return; // Exists in DB, will appear when that chunk loads
    }

    // Skip marker creation when not fully loaded — marker may exist in an unloaded chunk
    if (!isFullyLoaded) {
      verbose.content('Skipping no-delete-id marker check (partial load)', 'lazyLoaderFactory.js');
      return;
    }

    // Step 3: No marker anywhere - add to first node in this chunk
    const firstNode = chunkElement.querySelector('[id]');
    if (!firstNode) {
      console.warn('⚠️ Could not find node with ID to set no-delete marker');
      return;
    }

    // Step 3a: Set marker on DOM element
    setNoDeleteMarker(firstNode);
    console.log(`✅ Set no-delete-id marker on node ${firstNode.id} in DOM`);

    // Step 3b: Persist to IndexedDB but skip history creation
    // skipRedoClear: true because this is an automatic operation, not a user edit
    // skipHistory: true to prevent spurious history entries during undo/redo refresh cycles
    await updateSingleIndexedDBRecord({ id: firstNode.id }, { skipRedoClear: true, skipHistory: true });
    console.log(`✅ Persisted no-delete-id marker to IndexedDB (no history entry)`);
  } catch (error) {
    console.error('❌ FATAL: ensureNoDeleteMarkerForBook failed:', error);
    throw error; // Re-throw so we can see it in console
  }
}

/**
 * Normalize old hypercite DOM structures to the new single-element format.
 * Old: <a href="..."><sup class="open-icon">↗</sup></a>
 * Flipped: <sup class="open-icon"><a href="...">↗</a></sup>
 * New: <a href="..." class="open-icon">↗</a>
 */
export function normalizeHyperciteElements(container: any) {
  // Case 1: Normal old format — <a><sup class="open-icon">↗</sup></a>
  container.querySelectorAll('a[href*="#hypercite_"] > sup.open-icon').forEach((sup: any) => {
    const anchor = sup.parentElement;
    anchor.classList.add('open-icon');
    anchor.textContent = '↗';
  });

  // Case 2: Flipped format — <sup class="open-icon"><a>↗</a></sup>
  container.querySelectorAll('sup.open-icon > a[href*="#hypercite_"]').forEach((anchor: any) => {
    const sup = anchor.parentElement;
    anchor.classList.add('open-icon');
    anchor.textContent = '↗';
    sup.parentNode.insertBefore(anchor, sup);
    sup.remove();
  });
}

/**
 * Helper: Creates a chunk element given an array of node objects.
 */
// Keep createChunkElement function signature unchanged
export function createChunkElement(nodes: NodeRecord[], instance: any) {
  // <-- Correct, simple signature
  verbose.content(`createChunkElement: ${nodes.length} nodes, chunk ${nodes.length > 0 ? nodes[0]?.chunk_id : 'unknown'}`, 'lazyLoaderFactory.js');

  if (!nodes || nodes.length === 0) {
    return null;
  }

  const chunkId = nodes[0]!.chunk_id;  // length>0 guaranteed above
  const chunkWrapper = document.createElement("div");
  chunkWrapper.setAttribute("data-chunk-id", String(chunkId));  // chunk_id is a number; attrs are strings
  chunkWrapper.classList.add("chunk");

  nodes.forEach((node, nodeIndex) => {
    // ✅ Server handles migration - node_id should already exist
    // If not, log warning but continue (should not happen after migration)
    if (!node.node_id) {
      console.error(`⚠️ Node ${node.startLine} missing node_id after server migration!`);
    }

    // Note: Footnote migration is now handled server-side in DatabaseToIndexedDBController.php
    // nodes.footnotes is populated before data reaches the client

    let html = renderBlockToHtml(node);

    // IMPORTANT: Apply hypercites FIRST, then highlights
    // This ensures marks wrap AROUND hypercite <u> elements (protected parents)
    // instead of hypercites being split across mark boundaries
    if (node.hypercites && node.hypercites.length > 0) {
      html = applyHypercites(html, node.hypercites);
    }

    if (node.hyperlights && node.hyperlights.length > 0) {
      html = applyHighlights(html, node.hyperlights, instance.bookId);
    }

    const temp = document.createElement("div");
    // SECURITY: Sanitize HTML to prevent stored XSS from malicious EPUB uploads
    temp.innerHTML = sanitizeHtml(html);

    // 🔄 NORMALIZE: Unwrap <p> inside <li> (marked produces these on paste, but the
    // editor/mutation observer expects bare inline content inside <li>)
    temp.querySelectorAll('li > p').forEach(p => {
      const li = p.parentElement!;
      while (p.firstChild) {
        li.insertBefore(p.firstChild, p);
      }
      p.remove();
    });

    // 🎬 RECONSTRUCT: YouTube embeds after sanitization (iframe/button stripped by DOMPurify)
    temp.querySelectorAll('.video-embed[data-video-id]').forEach((embed: any) => {
      const videoId = embed.dataset.videoId;
      // Clear residual text left by KEEP_CONTENT (e.g. "×" from stripped button)
      embed.textContent = '';
      // Rebuild button + iframe from the stored video ID
      const btn = document.createElement('button');
      btn.className = 'video-delete-btn';
      btn.contentEditable = 'false';
      btn.setAttribute('aria-label', 'Delete video');
      btn.dataset.action = 'delete-video';
      btn.textContent = '\u00d7';
      const wrapper = document.createElement('div');
      wrapper.className = 'video-wrapper';
      wrapper.contentEditable = 'false';
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${videoId}`;
      iframe.setAttribute('frameborder', '0');
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.allowFullscreen = true;
      wrapper.appendChild(iframe);
      embed.appendChild(btn);
      embed.appendChild(wrapper);
    });

    // 🖼️ RECONSTRUCT: Broken image wrappers after sanitization
    // DOMPurify strips button + contenteditable attr, leaving "×" as plain text.
    // Unwrap the stale wrapper so handleBrokenImages() recreates it with a working button.
    temp.querySelectorAll('.broken-image-wrapper').forEach(wrapper => {
      const img = wrapper.querySelector('img');
      if (img) {
        img.classList.remove('broken-image');
        // Wrap in <p> so the firstElement extraction (line 1244) sets data-node-id
        // on the <p>, not on the bare <img> which will get re-wrapped by the
        // error handler inside a new .broken-image-wrapper.
        const p = document.createElement('p');
        p.appendChild(img);
        wrapper.replaceWith(p);
      } else {
        wrapper.remove();
      }
    });

    // 🔄 NORMALIZE: Migrate old hypercite format to new single-element format
    // Old: <a><sup class="open-icon">↗</sup></a> or flipped <sup class="open-icon"><a>↗</a></sup>
    // New: <a class="open-icon">↗</a>
    normalizeHyperciteElements(temp);

    // 🧹 CLEANUP: Strip navigation classes that shouldn't persist from database
    // Target: <a>, <u>, and arrow icons (<sup>, <span> with .open-icon)
    const navigationClasses = ['arrow-target', 'hypercite-target', 'hypercite-dimmed'];
    const elementsWithNavClasses = temp.querySelectorAll('a, u, .open-icon, sup, span');
    elementsWithNavClasses.forEach(el => {
      navigationClasses.forEach(className => {
        el.classList.remove(className);
      });
    });

    // ⌨️ KEYBOARD MODEL (docs/a11y-findings.md): Tab never enters content, on
    // ANY page or container — book anchors, home/user feed cards, sub-book
    // content alike are reached via the contentHopper hop layer (n/p keys;
    // when a hyperlit container is open it becomes the hop territory).
    // Render-time only; the save path (contentProcessor) strips tabindex.
    temp.querySelectorAll('a[href]').forEach(a => a.setAttribute('tabindex', '-1'));

    // 📝 DYNAMIC FOOTNOTE NUMBERING: Apply display numbers from FootnoteNumberingService
    // This replaces the old static fn-count-id with dynamically calculated numbers.
    // Pass the node's startLine + bookId so any mutation triggers a deferred
    // write-back to IDB (render-time self-heal — keeps stored content in sync
    // with the map even when no renumber has fired this session).
    applyDynamicFootnoteNumbers(temp, { startLine: node.startLine, bookId: node.book });

    // 📐 MATH RENDERING: Render LaTeX math via KaTeX
    renderMathElements(temp);
    renderCharts(temp);
    renderHarvestNetworks(temp);
    handleBrokenImages(temp);
    // E2EE (docs/e2ee.md): for an encrypted book, swap each media <img> src to a
    // decrypted blob URL on the LIVE nodes (same objects attached to the page).
    // Cheap sync gate first so plaintext renders don't even load the module.
    if (instance.bookId && isBookEncrypted(rootBookId(String(instance.bookId)))) {
      void import('./encryptedImages').then(({ hydrateEncryptedImages }) =>
        hydrateEncryptedImages(temp, instance.bookId),
      );
    }

    // Find the first Element child (skip text nodes)
    let firstElement: any = temp.firstChild;
    while (firstElement && firstElement.nodeType !== Node.ELEMENT_NODE) {
      firstElement = firstElement.nextSibling;
    }

    if (firstElement) {
      // ✅ data-node-id should already be in HTML from server
      // But ensure numerical id is set
      firstElement.setAttribute('id', node.startLine);
      if (node.node_id && !firstElement.getAttribute('data-node-id')) {
        firstElement.setAttribute('data-node-id', node.node_id);
      }
      chunkWrapper.appendChild(firstElement);
    } else {
      console.error(`⚠️ Node ${nodeIndex + 1} (line ${node.startLine}) produced no Element content. HTML: ${html.substring(0, 100)}`);
    }
  });

  verbose.content(`createChunkElement completed for chunk #${chunkId}`, 'lazyLoaderFactory.js');
  return chunkWrapper;
}


export function applyHypercites(html: any, hypercites: NodeHyperciteView[]) {
  if (!hypercites || hypercites.length === 0) return html;

  // Client-side gate filter — removes gated hypercites before rendering
  hypercites = applyGateFilter(hypercites, 'hypercite');
  if (hypercites.length === 0) return html;

  // Separate ghost hypercites from active ones
  const activeHypercites = hypercites.filter((h: any) => h.relationshipStatus !== 'ghost');
  const ghostHypercites = hypercites.filter((h: any) => h.relationshipStatus === 'ghost');

  const segments = createHyperciteSegments(activeHypercites);

  const tempElement = document.createElement("div");
  // 🔒 SECURITY: sanitize BEFORE assigning to innerHTML. Even though this div is
  // detached, an `<img onerror>` / `<svg onload>` in raw node content fires here,
  // BEFORE the final sanitizeHtml() in the lazy loader — a stored-XSS bypass.
  // Sanitising at the sink protects every caller (lazy loader, broadcast,
  // highlight deletion) and neutralises any unsanitised rows already in the DB.
  // sanitizeHtml is a no-op on legitimate markup, so char positions are unchanged.
  tempElement.innerHTML = sanitizeHtml(html);

  segments.sort((a: any, b: any) => b.charStart - a.charStart);

  // Overlap brightness ramp (asymptotic): each extra overlapping hypercite closes
  // RAMP_GROWTH of the remaining gap toward RAMP_CAP, so brightness climbs gradually
  // and never gets "too bright" — leaving clear headroom for the navigated (target)
  // cite, which jumps to full opacity (see u.hypercite-target in app.css).
  //   intensity(n) = CAP - (CAP - BASE) * (1 - GROWTH)^(n-1)
  //   → n: 1=.30  2=.39  3=.44  4=.47  5=.49  6=.50
  const RAMP_BASE = 0.30;    // n=1 seed (lone couple/poly, and the curve's floor)
  const RAMP_CAP = 0.51;     // hard ceiling — overlaps never exceed this
  const RAMP_GROWTH = 0.42;  // fraction of the remaining gap closed per extra overlap

  for (const segment of segments) {
    const positions = findPositionsInDOM(tempElement, segment.charStart, segment.charEnd);

    if (positions) {
      const underlineElement = document.createElement("u");

      // Handle single vs multiple hypercites in segment
      if (segment.hyperciteIDs.length === 1) {
        underlineElement.id = segment.hyperciteIDs[0];
        const actualStatus = segment.statuses[0];
        underlineElement.className = actualStatus || 'single';

        // Set hypercite intensity for single hypercite (start dim)
        if (actualStatus === 'couple' || actualStatus === 'poly') {
          underlineElement.style.cssText = `--hypercite-intensity: ${RAMP_BASE}`;
        }
      } else {
        // Multiple hypercites overlapping. Each overlap segment is a distinct,
        // non-overlapping char range, so charStart/charEnd give a unique id —
        // keeping the `hypercite_overlapping` prefix so prefix consumers still
        // match. A bare literal here produced duplicate DOM ids when a page had
        // ≥2 overlap segments (tripping the duplicate-id health check).
        underlineElement.id = `hypercite_overlapping_${segment.charStart}_${segment.charEnd}`;

        let finalStatus = 'single';
        const coupleCount = segment.statuses.filter((status: any) => status === 'couple').length;

        if (segment.statuses.includes('poly')) {
          finalStatus = 'poly';
        } else if (coupleCount >= 2) {
          finalStatus = 'poly';
        } else if (segment.statuses.includes('couple')) {
          finalStatus = 'couple';
        }

        underlineElement.className = finalStatus;
        underlineElement.setAttribute("data-overlapping", segment.hyperciteIDs.join(","));

        // Set hypercite intensity for overlapping hypercites (more overlaps = brighter,
        // but gradually and asymptotically — never blowing out, see ramp consts above)
        if (finalStatus === 'couple' || finalStatus === 'poly') {
          const overlappingCount = segment.hyperciteIDs.length;
          const intensity = RAMP_CAP - (RAMP_CAP - RAMP_BASE) * Math.pow(1 - RAMP_GROWTH, overlappingCount - 1);
          underlineElement.style.cssText = `--hypercite-intensity: ${intensity}`;
        }
      }

      try {
        wrapRangeWithElement(
          positions.startNode,
          positions.startOffset,
          positions.endNode,
          positions.endOffset,
          underlineElement
        );
      } catch (error) {
        console.error("❌ Highlight wrapping failed completely", error);
      }
    }
  }

  // Render ghost hypercites as invisible tombstone anchors appended at end of content
  for (const ghost of ghostHypercites) {
    const tombstone = document.createElement('u');
    tombstone.id = ghost.hyperciteId;
    tombstone.className = 'hypercite-tombstone';
    tombstone.setAttribute('data-ghost', 'true');

    // Find the content element (first child element of tempElement)
    const contentElement = tempElement.firstElementChild || tempElement;
    contentElement.appendChild(tombstone);
  }

  return tempElement.innerHTML;
}

function createHyperciteSegments(hypercites: any) {
  // Collect all boundary points
  const boundaries = new Set<any>();

  hypercites.forEach((hypercite: any) => {
    boundaries.add(hypercite.charStart);
    boundaries.add(hypercite.charEnd);
  });

  const sortedBoundaries = Array.from(boundaries).sort((a: any, b: any) => a - b);
  const segments: any[] = [];

  // Create segments between each pair of boundaries
  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const segmentStart = sortedBoundaries[i];
    const segmentEnd = sortedBoundaries[i + 1];

    // Find which hypercites cover this segment
    const coveringHypercites = hypercites.filter((hypercite: any) =>
      hypercite.charStart <= segmentStart && hypercite.charEnd >= segmentEnd
    );

    if (coveringHypercites.length > 0) {
      segments.push({
        charStart: segmentStart,
        charEnd: segmentEnd,
        hyperciteIDs: coveringHypercites.map((h: any) => h.hyperciteId),
        statuses: coveringHypercites.map((h: any) => h.relationshipStatus || 'single')
      });
    }
  }

  return segments;
}



// Update the applyHighlights function to use server-provided is_user_highlight flag
export function applyHighlights(html: any, highlights: NodeHyperlightView[], bookId: any) {
  if (!highlights || highlights.length === 0) {
    return html;
  }

  // Client-side gate filter — removes gated highlights before rendering
  highlights = applyGateFilter(highlights, 'hyperlight');

  // Drop phantom "HL_overlap" records — residue of the pre-fix save bug
  // (positionCollector keyed records by mark.id, and overlap segments render
  // with the synthetic id "HL_overlap"). They are not real highlights;
  // rendering them inflates data-highlight-count (triggering the dim-at-3+
  // hover rule on only part of a highlight) and splits cohesive mark groups.
  // hyperlights:purge-overlap-phantoms removes them server-side; this guard
  // keeps stale IDB copies inert.
  highlights = highlights.filter((h: any) => h.highlightID !== 'HL_overlap');

  if (highlights.length === 0) return html;

  const tempElement = document.createElement("div");
  // 🔒 SECURITY: sanitize BEFORE innerHTML — see the matching note in
  // applyHypercites(). A detached `<img onerror>` still fires, ahead of the lazy
  // loader's final sanitizeHtml(), so we must neutralise it right at the sink.
  tempElement.innerHTML = sanitizeHtml(html);

  const segments = createHighlightSegments(highlights);

  // Keep reverse order but recalculate positions each time
  segments.sort((a: any, b: any) => b.charStart - a.charStart);

  for (const segment of segments) {
    // Recalculate positions based on current DOM state
    const positions = findPositionsInDOM(tempElement, segment.charStart, segment.charEnd);

    if (!positions) {
      const hlId = segment.highlightIDs.join(', ');
      const totalLen = getTextNodes(tempElement).reduce((sum: any, n: any) => sum + n.textContent.length, 0);
      console.warn(`⚠️ applyHighlights: findPositionsInDOM returned null — highlight [${hlId}], charStart=${segment.charStart}, charEnd=${segment.charEnd}, totalTextLength=${totalLen}`);
      continue;
    }

    {
      const markElement = document.createElement("mark");

      // Always set data-highlight-count and intensity
      markElement.setAttribute("data-highlight-count", segment.highlightIDs.length);
      const intensity = Math.min(segment.highlightIDs.length / 5, 1); // Cap at 5 highlights
      // Use cssText so it serializes properly when we get innerHTML
      markElement.style.cssText = `--highlight-intensity: ${intensity}`;

      // Check if any highlight in this segment belongs to current user using server flag OR is newly created
      const hasUserHighlight = segment.highlightIDs.some((id: any) => {
        const highlight = highlights.find((h: any) => h.highlightID === id);
        const isNewlyCreated = isNewlyCreatedHighlight(id);
        return highlight ? highlight.is_user_highlight : isNewlyCreated;
      });

      if (segment.highlightIDs.length === 1) {
        markElement.id = segment.highlightIDs[0];
        markElement.className = segment.highlightIDs[0];
      } else {
        markElement.id = "HL_overlap";
        markElement.className = segment.highlightIDs.join(" ");
      }

      // Add user-specific class for styling
      if (hasUserHighlight) {
        markElement.classList.add('user-highlight');
      }

      // Check for AI review verdict highlights and add color class
      const aiReviewHighlight = segment.highlightIDs
        .map((id: any) => highlights.find((h: any) => h.highlightID === id))
        .find((h: any) => h?.creator?.startsWith('AIreview:'));

      if (aiReviewHighlight && aiReviewHighlight.annotation) {
        const verdict = aiReviewHighlight.annotation.split(' — ')[0].toLowerCase();
        const verdictClass = ({
          'confirmed': 'hl-confirmed',
          'likely': 'hl-likely',
          'plausible': 'hl-plausible',
          'unlikely': 'hl-unlikely',
          'rejected': 'hl-rejected',
          'source not found': 'hl-source-not-found',
        } as any)[verdict];
        if (verdictClass) {
          markElement.classList.add(verdictClass);
        }
      }

      // Use surroundContents instead of extractContents
      wrapRangeWithElement(
        positions.startNode,
        positions.startOffset,
        positions.endNode,
        positions.endOffset,
        markElement
      );
    }
  }

  return tempElement.innerHTML;
}


function createHighlightSegments(highlights: any) {
  // Collect all boundary points
  const boundaries = new Set<any>();

  highlights.forEach((highlight: any) => {
    boundaries.add(highlight.charStart);
    boundaries.add(highlight.charEnd);
  });

  const sortedBoundaries = Array.from(boundaries).sort((a: any, b: any) => a - b);
  const segments: any[] = [];

  // Create segments between each pair of boundaries
  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const segmentStart = sortedBoundaries[i];
    const segmentEnd = sortedBoundaries[i + 1];

    // Find which highlights cover this segment
    const coveringHighlights = highlights.filter((highlight: any) => {
      return highlight.charStart <= segmentStart && highlight.charEnd >= segmentEnd;
    });

    if (coveringHighlights.length > 0) {
      segments.push({
        charStart: segmentStart,
        charEnd: segmentEnd,
        highlightIDs: coveringHighlights.map((h: any) => h.highlightID)
      });
    }
  }

  return segments;
}



function findPositionsInDOM(rootElement: any, startChar: any, endChar: any) {
  const textNodes = getTextNodes(rootElement);
  let currentIndex = 0;
  let startNode = null,
    startOffset = 0;
  let endNode = null,
    endOffset = 0;

  for (const node of textNodes) {
    const nodeLength = node.textContent.length;
    if (currentIndex <= startChar && currentIndex + nodeLength > startChar) {
      startNode = node;
      startOffset = startChar - currentIndex;
      break;
    }
    currentIndex += nodeLength;
  }

  currentIndex = 0;
  for (const node of textNodes) {
    const nodeLength = node.textContent.length;
    if (currentIndex <= endChar && currentIndex + nodeLength >= endChar) {
      endNode = node;
      endOffset = endChar - currentIndex;
      break;
    }
    currentIndex += nodeLength;
  }

  if (startNode && endNode) {
    return { startNode, startOffset, endNode, endOffset };
  }

  return null;
}

function wrapRangeWithElement(startNode: any, startOffset: any, endNode: any, endOffset: any, wrapElement: any) {
  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    // Check if range is within a single block element
    // extractContents() is safe within a block but can corrupt structure across blocks
    const commonAncestor = range.commonAncestorContainer;
    const blockTags = STRUCTURAL_BLOCK_TAGS;

    // Find the containing block element
    let containingBlock: any = commonAncestor;
    while (containingBlock && containingBlock.nodeType !== Node.ELEMENT_NODE) {
      containingBlock = containingBlock.parentNode;
    }
    while (containingBlock && !blockTags.has(containingBlock.tagName)) {
      containingBlock = containingBlock.parentNode;
    }

    // Check if start and end are in the same block element
    let startBlock = startNode;
    while (startBlock && !blockTags.has(startBlock.tagName)) {
      startBlock = startBlock.parentNode;
    }
    let endBlock = endNode;
    while (endBlock && !blockTags.has(endBlock.tagName)) {
      endBlock = endBlock.parentNode;
    }

    const isSameBlock = startBlock === endBlock && startBlock !== null;
    const hasProtectedElements = rangeContainsProtectedElements(startNode, endNode);

    if (isSameBlock && !hasProtectedElements) {
      // Safe to use extractContents - handles inline elements correctly
      // This keeps <u>, <sup>, <b>, <i>, etc. intact inside the wrapper
      const contents = range.extractContents();
      const wrapper = wrapElement.cloneNode(false);
      wrapper.appendChild(contents);
      range.insertNode(wrapper);
    } else {
      // Cross-block range - use text-node approach to avoid corrupting block structure
      wrapTextNodesInRange(startNode, startOffset, endNode, endOffset, wrapElement);
    }
  } catch (error) {
    console.error("❌ Range wrapping failed:", error);
    // Fallback to text-node approach
    try {
      wrapTextNodesInRange(startNode, startOffset, endNode, endOffset, wrapElement);
    } catch (fallbackError) {
      console.error("❌ Fallback text node wrapping also failed:", fallbackError);
    }
  }
}

/**
 * Wrap text nodes individually when range spans different block elements
 * This prevents extractContents() from corrupting DOM structure
 */
function wrapTextNodesInRange(startNode: any, startOffset: any, endNode: any, endOffset: any, templateElement: any) {
  // Special case: start and end are the same text node
  if (startNode === endNode) {
    wrapPartialTextNode(startNode, startOffset, endOffset, templateElement);
    return;
  }

  // Get all text nodes between start and end
  const commonAncestor = findCommonAncestor(startNode, endNode);
  if (!commonAncestor) return;

  // If commonAncestor is a text node, use its parent
  const searchRoot = commonAncestor.nodeType === Node.TEXT_NODE
    ? commonAncestor.parentNode
    : commonAncestor;

  if (!searchRoot) return;

  const textNodes = getTextNodes(searchRoot);
  let inRange = false;

  for (const textNode of textNodes) {
    if (textNode === startNode) {
      inRange = true;
      // Wrap from startOffset to end of this node
      if (startOffset < textNode.textContent.length) {
        wrapPartialTextNode(textNode, startOffset, textNode.textContent.length, templateElement);
      }
    } else if (textNode === endNode) {
      // Wrap from start to endOffset of this node
      if (endOffset > 0) {
        wrapPartialTextNode(textNode, 0, endOffset, templateElement);
      }
      break;
    } else if (inRange) {
      // Wrap entire text node
      wrapEntireTextNode(textNode, templateElement);
    }
  }
}

function findCommonAncestor(node1: any, node2: any) {
  const ancestors1 = [];
  let current = node1;
  while (current) {
    ancestors1.push(current);
    current = current.parentNode;
  }

  current = node2;
  while (current) {
    if (ancestors1.includes(current)) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Find a protected parent element that shouldn't have mark/u wrappers
 * inserted inside it (e.g., footnote sups, hypercites). Returns the element or null.
 */
function getProtectedParent(textNode: any) {
  let parent = textNode.parentNode;
  while (parent && parent.nodeType === Node.ELEMENT_NODE) {
    // Footnote sups - wrapping inside them breaks click handling
    if (parent.tagName === 'SUP' && parent.hasAttribute('fn-count-id')) {
      return parent;
    }
    // Footnote links
    if (parent.tagName === 'A' && parent.classList.contains('footnote-ref')) {
      return parent;
    }
    // Hypercite underlines - wrapping inside them breaks click handling and splits the hypercite
    if (parent.tagName === 'U' && (
      parent.id?.startsWith('hypercite_') ||
      parent.classList.contains('couple') ||
      parent.classList.contains('poly') ||
      parent.classList.contains('single')
    )) {
      return parent;
    }
    // Stop at block-level elements
    if (['P', 'DIV', 'BLOCKQUOTE', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(parent.tagName)) {
      return null;
    }
    parent = parent.parentNode;
  }
  return null;
}

/**
 * Check if a range contains any protected elements (footnotes, hypercites).
 * Used to determine whether to use extractContents() or text-node wrapping.
 */
function rangeContainsProtectedElements(startNode: any, endNode: any) {
  // Check if start or end nodes are inside protected elements
  if (getProtectedParent(startNode) || getProtectedParent(endNode)) {
    return true;
  }

  // Check if any protected elements exist between start and end
  const commonAncestor = findCommonAncestor(startNode, endNode);
  if (!commonAncestor) return false;

  const searchRoot = commonAncestor.nodeType === Node.TEXT_NODE
    ? commonAncestor.parentNode
    : commonAncestor;

  if (!searchRoot) return false;

  // Check for footnote sups
  const footnoteSups = searchRoot.querySelectorAll('sup[fn-count-id]');
  if (footnoteSups.length > 0) return true;

  // Check for hypercite underlines
  const hypercites = searchRoot.querySelectorAll('u[id^="hypercite_"], u.couple, u.poly, u.single');
  if (hypercites.length > 0) return true;

  return false;
}

/**
 * Wrap an entire protected element (like a footnote sup) with the wrapper element.
 * This maintains proper DOM structure so click handlers work correctly.
 */
function wrapProtectedElement(element: any, templateElement: any) {
  // Skip if this element was already wrapped (avoid double-wrapping)
  if (element.parentNode?.nodeName === templateElement.nodeName) {
    return;
  }
  // Also check if already wrapped by checking for mark/u parent with same ID pattern
  const existingWrapper = element.parentNode;
  if (existingWrapper &&
      (existingWrapper.nodeName === 'MARK' || existingWrapper.nodeName === 'U') &&
      existingWrapper.id) {
    return;
  }

  const wrapper = templateElement.cloneNode(false);
  element.parentNode.insertBefore(wrapper, element);
  wrapper.appendChild(element);
}

function wrapPartialTextNode(textNode: any, start: any, end: any, templateElement: any) {
  if (start >= end || !textNode.parentNode) return;

  // If text is inside a protected element (footnote sup), wrap the whole element instead
  const protectedParent = getProtectedParent(textNode);
  if (protectedParent) {
    wrapProtectedElement(protectedParent, templateElement);
    return;
  }

  const text = textNode.textContent;
  const middle = text.substring(start, end);

  // Skip if the middle portion is only whitespace
  if (!middle.trim()) return;

  const before = text.substring(0, start);
  const after = text.substring(end);

  const parent = textNode.parentNode;

  // Create the wrapper element (clone template to preserve classes/attributes)
  const wrapper = templateElement.cloneNode(false);
  wrapper.textContent = middle;

  // Replace the text node with before + wrapper + after
  if (before) {
    parent.insertBefore(document.createTextNode(before), textNode);
  }
  parent.insertBefore(wrapper, textNode);
  if (after) {
    parent.insertBefore(document.createTextNode(after), textNode);
  }
  parent.removeChild(textNode);
}

function wrapEntireTextNode(textNode: any, templateElement: any) {
  // Skip whitespace-only text nodes
  if (!textNode.parentNode || !textNode.textContent.trim()) return;

  // If text is inside a protected element (footnote sup), wrap the whole element instead
  const protectedParent = getProtectedParent(textNode);
  if (protectedParent) {
    wrapProtectedElement(protectedParent, templateElement);
    return;
  }

  const wrapper = templateElement.cloneNode(false);
  textNode.parentNode.insertBefore(wrapper, textNode);
  wrapper.appendChild(textNode);
}

function getTextNodes(element: any): any[] {
  let textNodes: any[] = [];
  for (let node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      textNodes.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      textNodes.push(...getTextNodes(node));
    }
  }
  return textNodes;
}
