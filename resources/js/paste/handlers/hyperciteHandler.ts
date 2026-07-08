/**
 * Hypercite Paste Handler
 *
 * Handles pasting of hypercites (citations with bidirectional linking).
 * Updates citedIN arrays and relationship statuses in both source and target documents.
 */

import { getActiveBook } from '../../hyperlitContainer/utilities/activeContext';
import {
  updateCitationForExistingHypercite,
  getNodesFromIndexedDB,
  addCitationToHypercite,
  getHyperciteFromIndexedDB,
  updateHyperciteInIndexedDB,
  getNodeFromIndexedDB,
  toPublicNode,
  syncHyperciteWithNodeImmediately
} from '../../indexedDB/index';
import { parseHyperciteHref, attachUnderlineClickListeners, delinkHypercite, restampHyperciteStatusInDOM } from '../../hypercites/index';
import { getEditToolbar } from '../../editToolbar/index';
import { getTextOffsetInElement } from '../../editToolbar/toolbarDOMUtils';
import { determineRelationshipStatus, isHyperciteId } from '../../hypercites/utils';
import { broadcastToOpenTabs } from '../../utilities/BroadcastListener';
import {
  setHandleHypercitePaste
} from '../../utilities/operationState';
import { queueNodeForSave } from '../../divEditor/index';
import { sanitizeHtml } from '../../utilities/sanitizeConfig';
import { extractQuotedText } from '../../utilities/textExtraction';
import { ensureSpaceAfterAnchor } from '../utils/anchorSpacing';

/**
 * Extract quoted text before a hypercite link element
 * @param {HTMLElement} container - Container holding the link
 * @param {HTMLElement} linkElement - The link element
 * @returns {string} - Cleaned quoted text
 */
function extractQuotedTextBeforeLink(container: any, linkElement: any) {
  // Method 1: Try to find text node immediately before the link
  let textNode = linkElement.previousSibling;
  let quotedText = "";

  while (textNode) {
    if (textNode.nodeType === Node.TEXT_NODE) {
      const text = textNode.textContent.trim();
      if (text) {
        quotedText = text + quotedText;
        break;
      }
    } else if (textNode.nodeType === Node.ELEMENT_NODE) {
      // Check if it's a span or other element containing text
      const textContent = textNode.textContent.trim();
      if (textContent) {
        quotedText = textContent + quotedText;
        break;
      }
    }
    textNode = textNode.previousSibling;
  }

  // Method 2: If no text found, try regex on container's text content
  if (!quotedText) {
    const fullText = container.textContent;
    const quoteMatch = fullText.match(/[''""]([^]*?)[''""](?=\s*↗|$)/);
    if (quoteMatch && quoteMatch[1]) {
      quotedText = quoteMatch[1];
    }
  }

  // Clean up word joiner characters (from previous pastes) then quotes
  quotedText = quotedText.replace(/\u2060/g, '').replace(/^[''""]/, '').replace(/[''""]$/, '');

  return quotedText;
}

/**
 * Extract quoted text from a paste wrapper element
 * Moved to utilities/textExtraction to avoid circular dependencies
 */
export { extractQuotedText } from '../../utilities/textExtraction';

/**
 * Save the current paragraph after a paste operation
 */
export function saveCurrentParagraph() {
  const selection: any = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    let currentElement = range.startContainer;
    if (currentElement.nodeType !== Node.ELEMENT_NODE) {
      currentElement = currentElement.parentElement;
    }

    // Find the closest block element (paragraph, pre, blockquote, etc.)
    let blockElement = currentElement.closest('p, pre, blockquote, h1, h2, h3, h4, h5, h6');

    if (blockElement && blockElement.id) {
      console.log("Manually saving block element:", blockElement.id, blockElement.tagName);
      // Manually save the element to IndexedDB
      queueNodeForSave(blockElement.id, 'update');
    }
  }
}

/**
 * Handle pasting of hypercites
 * @param {ClipboardEvent} event - Paste event
 * @returns {Promise<boolean>} true if handled as hypercite, false otherwise
 */
export async function handleHypercitePaste(event: any, targetBookId: any, clipboardHtml?: string) {
  // IMPORTANT: take the clipboard HTML captured SYNCHRONOUSLY at paste start.
  // The paste pipeline `await`s (format processing) before calling us, and Firefox
  // empties event.clipboardData once the handler yields — so re-reading it here
  // returns "" and every hypercite paste silently fell through to plain insertion.
  // Fall back to a live read only if the caller didn't pass it.
  if (clipboardHtml === undefined) {
    clipboardHtml = event.clipboardData.getData("text/html");
  }
  if (!clipboardHtml) return false;

  // Parse clipboard HTML
  // SECURITY: Sanitize clipboard HTML to prevent XSS
  const pasteWrapper = document.createElement("div");
  pasteWrapper.innerHTML = sanitizeHtml(clipboardHtml);

  // Clear any numeric IDs to prevent conflicts
  pasteWrapper.querySelectorAll('[id]').forEach((el: any) => {
    if (/^\d+(\.\d+)?$/.test(el.id)) {
      el.removeAttribute('id');
    }
  });

  // Strip ghost tombstone <u> tags — CHECK 4 already relocated them on cut
  pasteWrapper.querySelectorAll('u.hypercite-tombstone[data-ghost="true"]').forEach((el: any) => el.remove());

  // ── Source <u> hypercite detection (cut+paste ghost restoration) ──
  const sourceUTags = pasteWrapper.querySelectorAll('u[id^="hypercite_"]');
  if (sourceUTags.length > 0) {
    const restorations: any[] = [];
    for (const uTag of sourceUTags) {
      const hyperciteId = uTag.id;
      // Only restore if a tombstone exists for this ID in the current DOM.
      // Tombstone = this was a cut (not a copy from another book).
      const tombstone = document.getElementById(hyperciteId);
      if (tombstone && tombstone.classList.contains('hypercite-tombstone')) {
        restorations.push({ hyperciteId, uTag, tombstone });
      }
    }

    if (restorations.length > 0) {
      event.preventDefault();
      setHandleHypercitePaste(true); // suppress mutation observer

      const booka = targetBookId || getActiveBook();

      try {
        for (const { hyperciteId, uTag, tombstone } of restorations) {
          const hypercite = await getHyperciteFromIndexedDB(booka, hyperciteId);
          if (!hypercite) continue;

          // 1. Restore status from citedIN
          const citedCount = Array.isArray(hypercite.citedIN) ? hypercite.citedIN.length : 0;
          const restoredStatus = determineRelationshipStatus(citedCount);

          // 2. Remove tombstone, queue old parent for save
          const oldParent = tombstone.closest('p, h1, h2, h3, h4, h5, h6, div, blockquote');
          tombstone.remove();
          if (oldParent?.id) queueNodeForSave(oldParent.id, 'update');

          // 3. Fix class on the <u> tag we're about to insert
          uTag.className = restoredStatus;

          // 4. Update IndexedDB: restore status, clear stale node_id/charData
          //    (batch.js will repopulate when the destination node saves)
          const oldNodeIds = hypercite.node_id || [];
          await updateHyperciteInIndexedDB(booka, hyperciteId, {
            ...hypercite,
            relationshipStatus: restoredStatus,
            node_id: [],
            charData: {},
          }, false);

          // 5. Rebuild arrays for old nodes (removes ghost from their embedded arrays)
          if (oldNodeIds.length > 0) {
            const { getNodesByDataNodeIDs, rebuildNodeArrays } = await import('../../indexedDB/hydration/rebuild');
            const nodes = await getNodesByDataNodeIDs(oldNodeIds);
            await rebuildNodeArrays(nodes.filter((n: any) => n.book === booka));
          }
        }

        // 5b. Strip browser cruft from clipboard content before insertion
        //     Browser adds inline styles, data attrs, wrapper <p> tags, Apple <br> tags
        pasteWrapper.querySelectorAll('[style]').forEach((el: any) => el.removeAttribute('style'));
        pasteWrapper.querySelectorAll('[data-hypercite-listener]').forEach((el: any) => el.removeAttribute('data-hypercite-listener'));
        pasteWrapper.querySelectorAll('br.Apple-interchange-newline').forEach((el: any) => el.remove());
        // Unwrap ALL <span> wrappers — browser loves adding these during cut/paste
        for (const span of pasteWrapper.querySelectorAll('span')) {
          while (span.firstChild) span.parentNode!.insertBefore(span.firstChild, span);
          span.remove();
        }
        // Unwrap clipboard <p> wrappers — the destination paragraph provides block context
        for (const p of pasteWrapper.querySelectorAll('p')) {
          while (p.firstChild) p.parentNode!.insertBefore(p.firstChild, p);
          p.remove();
        }
        // Remove trailing <br> tags left over from browser paste formatting
        while (pasteWrapper.lastChild && pasteWrapper.lastChild.nodeName === 'BR') {
          pasteWrapper.lastChild.remove();
        }

        // 6. Insert using same pattern as citation-link paste
        const htmlToInsert = pasteWrapper.innerHTML;
        const selection: any = window.getSelection();
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const fragment = document.createDocumentFragment();
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = htmlToInsert;
          while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);
          range.deleteContents();
          range.insertNode(fragment);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          document.execCommand("insertHTML", false, htmlToInsert);
        }

        // 7. Save destination paragraph
        saveCurrentParagraph();

        // 8. Sync
        const { debouncedMasterSync } = await import('../../indexedDB/index');
        await debouncedMasterSync.flush();

      } finally {
        setHandleHypercitePaste(false);
        attachUnderlineClickListeners();
      }

      return true;
    }
  }

  // Look for hypercite link by href pattern (more reliable than id attribute)
  // Browsers may not preserve id or class attributes when copying, but href is always preserved
  const links = pasteWrapper.querySelectorAll('a[href*="#hypercite_"]');
  const citeLinks: any[] = []; // Collect ALL valid hypercite links

  console.log('🔍 Checking for hypercite links:', {
    foundLinks: links.length,
    pasteWrapperHTML: pasteWrapper.innerHTML.substring(0, 200)
  });

  // Find all links that are hypercite arrows (new format: a.open-icon, old format: a > sup/span)
  for (const link of links) {
    // NOTE: textContent, not innerText \u2014 pasteWrapper is a detached <div>, and
    // Firefox returns "" for innerText on non-rendered nodes (Chrome/WebKit are
    // lenient). innerText here silently broke hypercite paste-linking in Firefox.
    const linkText = (link.textContent || '').replace(/[\u200B\s]/g, '');
    if (linkText === "↗") {
      const isNewFormat = link.classList.contains('open-icon');
      const hasSupOrSpan = link.querySelector('sup, span');
      if (isNewFormat || hasSupOrSpan) {
        citeLinks.push(link);
      }
    }
  }

  // Check if this paste contains hypercite links
  if (citeLinks.length === 0) {
    return false; // Not a hypercite paste
  }

  console.log(`✅ Found ${citeLinks.length} hypercite link(s) in paste`);

  // Prevent default paste behavior
  event.preventDefault();

  console.log(`Detected ${citeLinks.length} hypercite(s) in pasted content`);

  // Get current book (where paste is happening)
  const bookb = targetBookId || getActiveBook();

  // Process all hypercite links and build combined content
  const contentFragment = document.createDocumentFragment();
  const updateTasks: any[] = []; // Store update promises to await later

  for (const citeLink of citeLinks) {
    const originalHref = citeLink.getAttribute("href");
    const parsed = parseHyperciteHref(originalHref);

    if (!parsed) {
      console.warn("Failed to parse hypercite href:", originalHref);
      continue; // Skip this link and continue with others
    }

    const { booka, hyperciteIDa, citationIDa } = parsed;
    console.log("Parsed citation info:", { booka, hyperciteIDa, citationIDa });

    // SECURITY: never re-embed the raw clipboard href. sanitizeHtml() (above) keeps
    // a legitimate hypercite <a> intact, but citeLink.getAttribute("href") returns the
    // DECODED value — splicing that into an HTML string that is later re-parsed would
    // resurrect a `"`-escaped payload (e.g. href='…"><img onerror=…>'). We only accept
    // a well-formed hypercite id and rebuild the href from validated parts.
    if (!isHyperciteId(hyperciteIDa)) {
      console.warn("Rejecting hypercite link with malformed id:", hyperciteIDa);
      continue;
    }
    const safeHref = `/${booka}#${hyperciteIDa}`;

    // Generate new hypercite ID for this instance
    const hyperciteIDb = "hypercite_" + Math.random().toString(36).substr(2, 8);

    // Create the citation ID for this new instance
    const citationIDb = `/${bookb}#${hyperciteIDb}`;

    // Extract quoted text using helper function
    let quotedText = extractQuotedTextBeforeLink(pasteWrapper, citeLink);

    // Fallback to old extraction method if helper fails
    if (!quotedText) {
      quotedText = extractQuotedText(pasteWrapper);
    }

    console.log(`🔍 Extracted quoted text for link ${citeLinks.indexOf(citeLink) + 1}:`, `"${quotedText}"`);

    // Build the inserted content with DOM APIs (NOT an HTML string). setAttribute /
    // textContent escape their inputs, so nothing here is ever parsed back out of a
    // string — quotedText and the href cannot break out of their context.
    if (contentFragment.childNodes.length > 0) {
      contentFragment.appendChild(document.createTextNode(' '));
    }
    contentFragment.appendChild(document.createTextNode(`'${quotedText}'⁠`));
    const anchor = document.createElement('a');
    anchor.setAttribute('href', safeHref);
    anchor.id = hyperciteIDb;
    anchor.className = 'open-icon';
    anchor.textContent = '↗';
    contentFragment.appendChild(anchor);

    // Store update task to process after insertion
    updateTasks.push({
      booka,
      hyperciteIDa,
      citationIDb,
      citationIDa
    });
  }

  // Check if we successfully processed any hypercites
  if (contentFragment.childNodes.length === 0) {
    console.warn("No valid hypercites were processed");
    return false;
  }

  console.log(`📝 Built combined content for ${updateTasks.length} hypercite(s)`);

  // Set the flag to prevent MutationObserver from processing this paste
  setHandleHypercitePaste(true);
  console.log("setHandleHypercitePaste flag to true");

  // ── Undo snapshot: seal any open typing group and capture pre-paste state ──
  const undoManager = getEditToolbar()?.undoManager;
  let undoSnapshot: any = null;
  if (undoManager) {
    undoManager.sealGroup();
    const sel: any = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      let anchor = sel.getRangeAt(0).startContainer;
      if (anchor.nodeType !== Node.ELEMENT_NODE) anchor = anchor.parentElement;
      const block = anchor?.closest('p, pre, blockquote, h1, h2, h3, h4, h5, h6');
      if (block && block.id) {
        let cursorBefore = 0;
        try {
          cursorBefore = getTextOffsetInElement(block, sel.focusNode, sel.focusOffset);
        } catch (e: any) { /* ignore */ }
        undoSnapshot = {
          elementId: block.id,
          oldHTML: block.innerHTML,
          bookId: bookb,
          cursorBefore,
        };
      }
    }
  }

  // Capture the target node ID BEFORE DOM manipulation
  // (cursor position may shift after insertNode + collapse)
  let targetNodeId: any = null;
  {
    const sel: any = window.getSelection();
    if (sel.rangeCount > 0) {
      let anchor = sel.getRangeAt(0).startContainer;
      if (anchor.nodeType !== Node.ELEMENT_NODE) anchor = anchor.parentElement;
      const block = anchor?.closest('[id]');
      if (block && /^\d+(\.\d+)?$/.test(block.id)) {
        targetNodeId = block.id;
      }
    }
  }

  // Insert the combined content - use a more controlled approach.
  // contentFragment was built entirely with DOM APIs (createElement / setAttribute /
  // textContent), so it is inserted directly — no HTML string is ever re-parsed.
  const selection: any = window.getSelection();
  // Capture anchor refs before insertion — the same node objects survive the
  // DocumentFragment move performed by range.insertNode().
  const insertedAnchors: any[] = Array.from<any>(contentFragment.querySelectorAll('a.open-icon'));
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);

    // Clear the range and insert our DOM-built fragment
    range.deleteContents();
    range.insertNode(contentFragment);

    // Move cursor to end of insertion
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // Fallback to execCommand if selection isn't available. Serialising the
    // DOM-built fragment is safe: every value was escaped by setAttribute /
    // textContent, so re-parsing it cannot introduce markup.
    const tmp = document.createElement('div');
    tmp.appendChild(contentFragment);
    document.execCommand("insertHTML", false, tmp.innerHTML);
  }

  // Guarantee a space (or end-of-block) after each inserted anchor before save.
  // Some browsers (observed on Safari 26.4) strip the leading space from the
  // surviving text node after range.deleteContents() + insertNode(), leaving the
  // DOM looking correct visually but serialising to IDB without the space.
  insertedAnchors.forEach(ensureSpaceAfterAnchor);

  // Save the affected node — use pre-captured ID as fallback
  saveCurrentParagraph();
  if (targetNodeId) {
    // Belt-and-suspenders: ensure the pre-identified node is queued
    // even if saveCurrentParagraph()'s cursor-based lookup missed it
    console.log("🛡️ targetNodeId fallback: ensuring node", targetNodeId, "is queued for save");
    queueNodeForSave(targetNodeId, 'update');
  }

  // ── Push undo entry for hypercite paste ──
  if (undoManager && undoSnapshot) {
    const block = document.getElementById(undoSnapshot.elementId);
    if (block) {
      const newHTML = block.innerHTML;
      const sel2 = window.getSelection();
      let cursorAfter = 0;
      if (sel2 && sel2.rangeCount > 0) {
        try {
          cursorAfter = getTextOffsetInElement(block, sel2.focusNode, sel2.focusOffset);
        } catch (e: any) { /* ignore */ }
      }

      // Freeze task data for closures
      const capturedUpdateTasks = updateTasks.map((t: any) => ({
        booka: t.booka,
        hyperciteIDa: t.hyperciteIDa,
        citationIDb: t.citationIDb,
        hyperciteIDb: t.citationIDb.split('#')[1],
      }));

      undoManager._pushUndo(undoSnapshot.bookId, {
        type: 'input',
        elementId: undoSnapshot.elementId,
        oldHTML: undoSnapshot.oldHTML,
        newHTML,
        bookId: undoSnapshot.bookId,
        cursorBefore: undoSnapshot.cursorBefore,
        cursorAfter,
        onUndo: async () => {
          for (const task of capturedUpdateTasks) {
            try {
              await delinkHypercite(task.hyperciteIDb, `/${task.booka}#${task.hyperciteIDa}`);
            } catch (err: any) {
              console.error('[UndoManager] onUndo delink error:', err);
            }
          }
          attachUnderlineClickListeners();
        },
        onRedo: async () => {
          for (const task of capturedUpdateTasks) {
            try {
              const result = await updateCitationForExistingHypercite(
                task.booka, task.hyperciteIDa, task.citationIDb
              );
              if (result && result.success) {
                // Update source hypercite DOM class (same-page paste)
                const sourceEl = document.getElementById(task.hyperciteIDa);
                if (sourceEl) sourceEl.className = result.newStatus as any;

                const hyperciteToSync = await getHyperciteFromIndexedDB(task.booka, task.hyperciteIDa);
                const nodeToSync = result.startLine != null
                  ? await getNodeFromIndexedDB(task.booka, result.startLine)
                  : null;
                if (hyperciteToSync && nodeToSync) {
                  await syncHyperciteWithNodeImmediately(task.booka, hyperciteToSync, nodeToSync);
                }

                // Broadcast to other tabs
                broadcastToOpenTabs(task.booka, result.startLine);
              }
            } catch (err: any) {
              console.error('[UndoManager] onRedo relink error:', err);
            }
          }
          // Re-save target node to rebuild arrays, then flush
          queueNodeForSave(undoSnapshot.elementId, 'update');
          const { debouncedMasterSync } = await import('../../indexedDB/index');
          await debouncedMasterSync.flush();
          attachUnderlineClickListeners();
        },
      });
      console.log(`[UndoManager] Pushed hypercite paste undo entry for #${undoSnapshot.elementId} (${capturedUpdateTasks.length} task(s))`);
    }
  }

  // Update all original hypercites' citedIN arrays
  // Use batched sync for multiple hypercites to avoid 429 rate limiting
  const shouldBatch = updateTasks.length > 1;

  try {
    console.log(`🔄 Updating ${updateTasks.length} original hypercite(s)... (${shouldBatch ? 'BATCHED' : 'IMMEDIATE'} sync)`);

    if (!shouldBatch) {
      // SINGLE HYPERCITE: Use existing immediate sync behavior
      for (const task of updateTasks) {
        const { booka, hyperciteIDa, citationIDb, citationIDa } = task;

        try {
          const updateResult = await updateCitationForExistingHypercite(
            booka,
            hyperciteIDa,
            citationIDb
          );

          if (updateResult && updateResult.success) {
            console.log(`✅ Successfully linked: ${citationIDa} cited in ${citationIDb}`);

            // Sync BOTH hypercite AND node immediately in ONE atomic transaction
            const hyperciteToSync = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
            const nodeToSync = updateResult.startLine != null
              ? await getNodeFromIndexedDB(booka, updateResult.startLine)
              : null;

            if (hyperciteToSync && nodeToSync) {
              console.log("🚀 Syncing hypercite + node in unified transaction...");
              await syncHyperciteWithNodeImmediately(booka, hyperciteToSync, nodeToSync);
              console.log("✅ Hypercite + node synced to server in one transaction.");
            } else if (hyperciteToSync) {
              console.log("⚠️ startLine null — syncing hypercite alone");
              const { queueForSync, debouncedMasterSync } = await import('../../indexedDB/index');
              queueForSync("hypercites", hyperciteIDa, "update", hyperciteToSync);
              await debouncedMasterSync.flush();
            } else {
              console.error("❌ Failed to fetch hypercite from IndexedDB for sync");
            }

            // Update the DOM in the CURRENT tab. Re-stamp EVERY rendered instance
            // of the source marker (class + --hypercite-intensity + couple/poly
            // click listener), not just a bare className flip — a bare flip left
            // the source visually dim (no intensity var) and unclickable (the
            // listener only lives on couple/poly). The broadcast below can't do
            // this for a cross-book source: the source book is not the current
            // book, so updateDomNode never touches it (see hypercites/marking.ts).
            if (updateResult.newStatus) {
              const stamped = restampHyperciteStatusInDOM(hyperciteIDa, updateResult.newStatus);
              console.log(`(Paste Handler) Re-stamped ${stamped} DOM instance(s) of ${hyperciteIDa} → ${updateResult.newStatus}`);
            }

            // Broadcast to OTHER tabs
            broadcastToOpenTabs(booka, updateResult.startLine);

          } else {
            console.warn(`⚠️ Failed to update citation for ${citationIDa}`);
          }
        } catch (error: any) {
          console.error(`❌ Error updating hypercite ${hyperciteIDa}:`, error);
          // Continue processing other hypercites even if one fails
        }
      }
    } else {
      // MULTIPLE HYPERCITES: Batch all updates into ONE request
      const updatedHypercites: any[] = [];
      const affectedDataNodeIDs = new Set(); // Track affected nodes for rebuild
      const affectedBooks = new Set(); // Track books that own the affected nodes
      const domUpdates: any[] = []; // Store DOM updates to apply after successful sync

      // Process all hypercites and collect updates
      for (const task of updateTasks) {
        const { booka, hyperciteIDa, citationIDb, citationIDa } = task;

        try {
          // ✅ NEW SYSTEM: Update only the normalized hypercites table
          const existingHypercite = await getHyperciteFromIndexedDB(booka, hyperciteIDa);
          if (!existingHypercite) {
            console.error(`❌ Hypercite ${hyperciteIDa} not found in normalized hypercites table`);
            continue;
          }

          // Update citedIN array
          if (!Array.isArray(existingHypercite.citedIN)) {
            existingHypercite.citedIN = [];
          }
          if (!existingHypercite.citedIN.includes(citationIDb)) {
            existingHypercite.citedIN.push(citationIDb);
          }

          // Update relationship status based on citedIN length
          const updatedRelationshipStatus =
            existingHypercite.citedIN.length === 0 ? "single" :
            existingHypercite.citedIN.length === 1 ? "couple" :
            "poly";

          existingHypercite.relationshipStatus = updatedRelationshipStatus;

          // Save to normalized hypercites table
          const hyperciteSuccess = await updateHyperciteInIndexedDB(
            booka,
            hyperciteIDa,
            {
              citedIN: existingHypercite.citedIN,
              relationshipStatus: updatedRelationshipStatus,
              // Defense-in-depth: hyperciteIDa is already validated (isHyperciteId) and
              // the status is internal, but hypercitedText is stored data — sanitize the
              // assembled markup so this write path can never persist active content.
              hypercitedHTML: sanitizeHtml(`<u id="${hyperciteIDa}" class="${updatedRelationshipStatus}">${existingHypercite.hypercitedText}</u>`),
            },
            true // skipQueue: we're doing batched sync immediately
          );

          if (!hyperciteSuccess) {
            console.error(`Failed to update hypercite ${hyperciteIDa}`);
            continue;
          }

          // Track affected node UUIDs for rebuild
          if (existingHypercite.node_id && Array.isArray(existingHypercite.node_id)) {
            existingHypercite.node_id.forEach((dataNodeID: any) => affectedDataNodeIDs.add(dataNodeID));
            affectedBooks.add(booka);
          }

          // Get final hypercite record for sync
          const finalHyperciteRecord = await getHyperciteFromIndexedDB(booka, hyperciteIDa);

          if (finalHyperciteRecord) {
            // Add to batch collection
            updatedHypercites.push(finalHyperciteRecord);

            // Determine startLine for broadcasting (use first affected node)
            let affectedStartLine: any = null;
            if (finalHyperciteRecord.node_id && finalHyperciteRecord.node_id.length > 0) {
              const nodes = await getNodesFromIndexedDB(booka);
              const affectedNode = nodes.find((n: any) => finalHyperciteRecord.node_id.includes(n.node_id));
              affectedStartLine = affectedNode?.startLine || null;
            }

            // Store DOM update for later
            domUpdates.push({
              hyperciteIDa,
              newStatus: updatedRelationshipStatus,
              startLine: affectedStartLine,
              booka,
              citationIDa
            });

            console.log(`✅ NEW SYSTEM: Prepared batch update for: ${citationIDa} cited in ${citationIDb}`);
          }
        } catch (error: any) {
          console.error(`❌ Error processing hypercite ${hyperciteIDa}:`, error);
          // Continue processing other hypercites even if one fails
        }
      }

      // ✅ NEW SYSTEM: Rebuild affected node arrays from normalized tables
      if (affectedDataNodeIDs.size > 0) {
        try {
          const { getNodesByDataNodeIDs, rebuildNodeArrays } = await import('../../indexedDB/hydration/rebuild');
          const allNodes = await getNodesByDataNodeIDs(Array.from<any>(affectedDataNodeIDs));
          // Filter to correct book(s) — getNodesByDataNodeIDs may return a parent book's
          // node when the same node_id exists in both parent and sub-book.
          const affectedNodes = allNodes.filter((n: any) => affectedBooks.has(n.book));
          await rebuildNodeArrays(affectedNodes);
          console.log(`✅ NEW SYSTEM: Rebuilt arrays for ${affectedNodes.length} affected nodes`);
        } catch (error: any) {
          console.error(`❌ NEW SYSTEM: Error rebuilding node arrays:`, error);
        }
      }

      // 4. Make ONE batched API call for all hypercites
      if (updatedHypercites.length > 0) {
        console.log(`📤 Syncing ${updatedHypercites.length} hypercite(s) in ONE batched request...`);

        try {
          // Group hypercites by book for batching
          const hypercitesByBook: any = {};
          updatedHypercites.forEach((hc: any) => {
            if (!hypercitesByBook[hc.book]) {
              hypercitesByBook[hc.book] = [];
            }
            hypercitesByBook[hc.book].push(hc);
          });

          // ✅ NEW SYSTEM: Sync only hypercites (nodes are rebuilt from normalized tables)
          const hyperciteSyncPromises = Object.entries(hypercitesByBook).map(([book, hypercites]) =>
            fetch("/api/db/hypercites/upsert", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-TOKEN": document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "",
              },
              credentials: "include",
              body: JSON.stringify({ book, data: hypercites }),
            })
          );

          // Wait for all hypercite sync operations to complete
          const allResponses = await Promise.all(hyperciteSyncPromises);

          // Check if all requests succeeded
          const allSucceeded = allResponses.every((res: any) => res.ok);

          if (allSucceeded) {
            console.log(`✅ Batched sync successful for ${updatedHypercites.length} hypercite(s)`);

            // 5. Apply DOM updates only after successful sync. Full render-
            // equivalent re-stamp (class + intensity + listener) of every rendered
            // instance — see the single-hypercite path above and marking.ts.
            domUpdates.forEach(({ hyperciteIDa, newStatus, startLine, booka }) => {
              const stamped = restampHyperciteStatusInDOM(hyperciteIDa, newStatus);
              console.log(`(Paste Handler) Re-stamped ${stamped} DOM instance(s) of ${hyperciteIDa} → ${newStatus}`);

              // Broadcast to OTHER tabs
              broadcastToOpenTabs(booka, startLine);
            });
          } else {
            console.error('❌ Some batched sync requests failed');
            allResponses.forEach((res, idx) => {
              if (!res.ok) {
                console.error(`Request ${idx + 1} failed with status: ${res.status}`);
              }
            });
          }
        } catch (error: any) {
          console.error('❌ Error during batched sync:', error);
        }
      }

      // Flush sync queue immediately after batched updates
      console.log("⚡ Flushing sync queue immediately after batched hypercite paste...");
      const { debouncedMasterSync } = await import('../../indexedDB/index');
      await debouncedMasterSync.flush();
      console.log("✅ Sync queue flushed.");
    }

    console.log(`✅ Completed updating ${updateTasks.length} hypercite(s)`);

  } catch (error: any) {
    console.error("❌ Error during hypercite paste updates:", error);
  } finally {
    // Clear the flag in the finally block to guarantee it's always reset
    setHandleHypercitePaste(false);
    console.log("setHandleHypercitePaste cleared");

    // Attach click listeners to the newly pasted hypercite links
    // This was previously done by BroadcastListener re-rendering, but we now skip self-broadcasts
    attachUnderlineClickListeners();
    console.log("✅ Attached click listeners to pasted hypercite(s)");
  }

  return true; // Successfully handled as hypercite
}
