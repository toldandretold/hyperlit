/**
 * Node content processor — turns a live editor node into its persisted form.
 *
 * Extracted from batch.js (decompose-and-convert): collects annotation
 * positions, footnote/citation references, then produces the CLEANED content
 * string that goes into the DB — marks/u/font/styled-span tags unwrapped,
 * inline styles stripped (preserving --*-intensity), navigation classes and
 * render-time artifacts (KaTeX output, broken-image wrappers) removed.
 *
 * Behavior pinned by tests/javascript/indexedDB/batchUpdate.characterization.test.js.
 */

import {
  collectMarkAndCitePositions,
  type CollectedHyperlight,
  type CollectedHypercite,
  type ExistingHypercite,
} from './positionCollector';
import { extractFootnoteIdsFromElement } from '../../paste/utils/extractFootnoteIds';
import { stripInlineStylePreservingIntensity } from '../../utilities/stripInlineStyle';
import type { CitationRef, FootnoteRef, ChunkId } from '../types';
import { asChunkId, parseChunkId } from '../types';

export interface ProcessedNodeContent {
  /** outerHTML of the cleaned clone — what gets persisted as NodeRecord.content */
  content: string;
  hyperlights: CollectedHyperlight[];
  hypercites: CollectedHypercite[];
  footnotes: FootnoteRef[];
  citations: CitationRef[];
}

/**
 * Helper function to determine chunk_id from the DOM
 * Looks for parent chunk div since data-chunk-id is on the chunk, not individual nodes
 */
export function determineChunkIdFromDOM(IDnumerical: string): ChunkId {
  const node = document.getElementById(IDnumerical);
  if (node) {
    // Look for parent chunk div (data-chunk-id is on the chunk, not the node)
    const chunkDiv = node.closest('.chunk[data-chunk-id]');
    if (chunkDiv) {
      const chunkIdAttr = chunkDiv.getAttribute('data-chunk-id');
      if (chunkIdAttr) {
        // parseChunkId = parseFloat, NOT parseInt: chunk_id can be a decimal (a chunk
        // inserted between two others via fractional indexing). Truncating here would
        // corrupt the stored chunk_id on save. (Backend re-emits it as an integer.)
        return parseChunkId(chunkIdAttr);
      }
    }
  }
  return asChunkId(0); // Default fallback
}

/**
 * Process node content to extract highlights, hypercites, and clean content
 * This removes <mark> and <u> tags while preserving their positions
 */
export function processNodeContentHighlightsAndCites(
  node: HTMLElement,
  existingHypercites: ExistingHypercite[] = [],
): ProcessedNodeContent {
  // Collect <mark>/<u> positions via the pure leaf module (skips zero-width residue and
  // de-dupes by id — see positionCollector.ts + its unit tests).
  const { hyperlights, hypercites } = collectMarkAndCitePositions(node, existingHypercites);

  // Process ghost tombstone <a> tags — keep node_id tracking alive for ghosts
  const ghostAnchors = node.querySelectorAll('u.hypercite-tombstone[data-ghost="true"]');
  Array.from(ghostAnchors).forEach((anchor) => {
    if (!anchor.id || !anchor.id.startsWith('hypercite_')) return;

    const existingHypercite = existingHypercites.find(hc => hc.hyperciteId === anchor.id);

    // Ghost tombstones don't need meaningful charStart/charEnd (they're invisible)
    // but we need them in the array so updateHyperciteRecords updates node_id
    hypercites.push({
      hyperciteId: anchor.id,
      charStart: -1,
      charEnd: -1,
      relationshipStatus: 'ghost',
      citedIN: existingHypercite?.citedIN || [],
      time_since: existingHypercite?.time_since || Math.floor(Date.now() / 1000)
    });

    console.log("Tracked ghost tombstone:", {
      id: anchor.id,
      nodeId: node.getAttribute('data-node-id'),
    });
  });

  // Extract footnote references using shared utility
  // Returns objects {id, marker} to support non-numeric markers (*, 23a, etc.)
  const footnotes: FootnoteRef[] = extractFootnoteIdsFromElement(node);

  // Extract citation references (author-date citations)
  // These are <a> elements with class="citation-ref" and id starting with "Ref"
  const citations: CitationRef[] = [];
  const citationLinks = node.querySelectorAll('a.citation-ref[id^="Ref"]');
  citationLinks.forEach((link) => {
    citations.push({
      referenceId: link.id,
      text: link.textContent ?? ''
    });
  });

  // Create a clone to remove the mark and u tags
  const contentClone = node.cloneNode(true) as HTMLElement;

  // Remove all <mark> tags from the cloned content while preserving their inner HTML
  const clonedMarkTags = contentClone.getElementsByTagName("mark");
  while (clonedMarkTags.length > 0) {
    const markTag = clonedMarkTags[0]!;
    // Move all child nodes before the mark tag, preserving HTML structure (including <br>)
    while (markTag.firstChild) {
      markTag.parentNode!.insertBefore(markTag.firstChild, markTag);
    }
    // Remove the now-empty mark tag
    markTag.parentNode!.removeChild(markTag);
  }

  // Remove all <u> tags from the cloned content while preserving their inner HTML
  const clonedUTags = contentClone.getElementsByTagName("u");
  while (clonedUTags.length > 0) {
    const uTag = clonedUTags[0]!;
    // Move all child nodes before the u tag, preserving HTML structure (including <br>)
    while (uTag.firstChild) {
      uTag.parentNode!.insertBefore(uTag.firstChild, uTag);
    }
    // Remove the now-empty u tag
    uTag.parentNode!.removeChild(uTag);
  }

  // 🧹 REMOVE <font> tags (browser artifacts from execCommand)
  // These are inline wrappers the browser creates — unwrap to keep content
  const clonedFontTags = contentClone.getElementsByTagName("font");
  while (clonedFontTags.length > 0) {
    const fontTag = clonedFontTags[0]!;
    while (fontTag.firstChild) {
      fontTag.parentNode!.insertBefore(fontTag.firstChild, fontTag);
    }
    fontTag.parentNode!.removeChild(fontTag);
  }

  // 🧹 STRIP duplicate node IDs from inline descendants
  // When content is copy-pasted, inline elements can retain id/data-node-id
  // from their original nodes — these cause duplicate DOM IDs on render
  contentClone.querySelectorAll('[id]').forEach(el => {
    if (el === contentClone) return; // Don't strip the node's own ID
    if (/^\d+(\.\d+)*$/.test(el.id)) {
      el.removeAttribute('id');
      el.removeAttribute('data-node-id');
    }
  });

  // 🧹 REMOVE styled spans before saving (prevents them from being stored)
  const clonedSpans = Array.from(contentClone.querySelectorAll('span[style]'));
  clonedSpans.forEach(span => {
    // Check if span is still in the DOM (not already removed)
    if (span.parentNode) {
      // Move all child nodes before the span, preserving HTML structure (including <br>)
      while (span.firstChild) {
        span.parentNode.insertBefore(span.firstChild, span);
      }
      // Remove the now-empty span
      span.parentNode.removeChild(span);
    }
  });

  // 🧹 STRIP ALL inline style attributes from ALL elements (prevents bloat from copy/paste)
  // Keep our semantic tags clean - styles should come from CSS, not inline attributes.
  // Exception: preserve the *-intensity custom properties (hyperlight/hypercite opacity),
  // so the persisted content matches the live DOM (which keeps them) — no integrity mismatch.
  // querySelectorAll matches DESCENDANTS only — include the node element itself,
  // otherwise a style attribute on the root (e.g. <p style="...">) survives into the DB.
  const allElementsWithStyle = Array.from(contentClone.querySelectorAll('[style]'));
  if (contentClone.hasAttribute('style')) {
    allElementsWithStyle.push(contentClone);
  }
  allElementsWithStyle.forEach(element => {
    stripInlineStylePreservingIntensity(element);
  });

  // 🔄 NORMALIZE: Migrate old hypercite format to new single-element format on save
  // Old: <a><sup class="open-icon">↗</sup></a> or flipped <sup class="open-icon"><a>↗</a></sup>
  // New: <a class="open-icon">↗</a>
  contentClone.querySelectorAll('a[href*="#hypercite_"] > sup.open-icon').forEach(sup => {
    const anchor = sup.parentElement!;
    anchor.classList.add('open-icon');
    anchor.textContent = '↗';
  });
  contentClone.querySelectorAll('sup.open-icon > a[href*="#hypercite_"]').forEach(anchor => {
    const sup = anchor.parentElement!;
    anchor.classList.add('open-icon');
    anchor.textContent = '↗';
    sup.parentNode!.insertBefore(anchor, sup);
    sup.remove();
  });

  // 🧹 STRIP navigation classes from ALL elements before saving
  // These are temporary UI classes that shouldn't persist in the database
  // Target: <a>, <u>, and arrow icons (<sup>, <span> with .open-icon)
  const navigationClasses = ['arrow-target', 'hypercite-target', 'hypercite-dimmed'];
  const elementsWithNavClasses = contentClone.querySelectorAll('a, u, .open-icon, sup, span');
  elementsWithNavClasses.forEach(el => {
    navigationClasses.forEach(className => {
      el.classList.remove(className);
    });
  });

  // ⌨️ STRIP tabindex — a render-time artifact (chunkRender sets tabindex="-1"
  // on content anchors for the Tab-order model; the contentHopper sets it on
  // hop targets). Persisting it would mutate stored content and churn the
  // integrity hash system.
  contentClone.querySelectorAll('[tabindex]').forEach(el => el.removeAttribute('tabindex'));
  if (contentClone.hasAttribute('tabindex')) contentClone.removeAttribute('tabindex');

  // 🔗 NORMALIZE WORD JOINER before hypercite anchors (prevents line breaks)
  // Ensures all hypercite anchors have a word joiner character (\u2060) immediately before them
  // This prevents the arrow from being orphaned on its own line when text wraps
  const hyperciteAnchors = contentClone.querySelectorAll('a[href*="#hypercite_"]');
  hyperciteAnchors.forEach(anchor => {
    const prevSibling = anchor.previousSibling;
    // Check if previous sibling is a text node ending with word joiner
    if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
      if (!prevSibling.textContent!.endsWith('\u2060')) {
        // Add word joiner at the end of the text node
        prevSibling.textContent = prevSibling.textContent + '\u2060';
      }
    } else {
      // No text node before anchor - insert word joiner text node
      const wordJoiner = document.createTextNode('\u2060');
      anchor.parentNode!.insertBefore(wordJoiner, anchor);
    }
  });

  // Clean KaTeX-rendered HTML before saving — re-renders from data-math attribute
  const mathElements = contentClone.querySelectorAll('latex, latex-block');
  mathElements.forEach(el => {
    el.textContent = '';
  });

  // 🧹 STRIP broken-image wrappers — the broken-image state is reconstructed
  // at render time via the img error event in lazyLoaderFactory.
  // Saving the wrapper + button to IDB causes: (1) DOMPurify strips the button
  // but KEEP_CONTENT leaves "×" as plain text, (2) the img already has
  // class="broken-image" so the error handler skips it → no delete button.
  contentClone.querySelectorAll('.broken-image-wrapper').forEach(wrapper => {
    const img = wrapper.querySelector('img');
    if (img) {
      img.classList.remove('broken-image');
      img.removeAttribute('alt');
      wrapper.replaceWith(img);
    } else {
      wrapper.remove();
    }
  });

  // E2EE (docs/e2ee.md): a decrypted image was rendered with a transient
  // blob: src (see lazyLoader/encryptedImages). NEVER persist that — restore
  // the canonical /{book}/media/ src from data-hl-src and drop the transient
  // hydration markers, so IndexedDB (and thus the sync) always stores the
  // stable src. Harmless no-op for plaintext books (no img has data-hl-src).
  contentClone.querySelectorAll('img[data-hl-src]').forEach((img) => {
    const canonical = img.getAttribute('data-hl-src');
    if (canonical) img.setAttribute('src', canonical);
    img.removeAttribute('data-hl-src');
    img.classList.remove('e2ee-img-loading', 'e2ee-img-locked');
    if (img.getAttribute('class') === '') img.removeAttribute('class');
  });

  const result: ProcessedNodeContent = {
    content: contentClone.outerHTML,
    hyperlights,
    hypercites,
    footnotes,
    citations,
  };
  return result;
}
