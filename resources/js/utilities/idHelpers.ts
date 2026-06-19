// idHelpers — zero-import pure ID generation + DOM-walk helpers, split out of IDfunctions.ts so the
// (lazy, edit-only) divEditor/editToolbar/paste can import them WITHOUT pulling IDfunctions' heavy eager
// deps (pageLoad/currentLazyLoader, SPA/ProgressOverlayConductor, indexedDB barrel, syncQueue/master,
// cloudRef). Only deps: leaf logger + blockElements constant + the app `book` global (app.js is the eager
// entry root — referencing it folds nothing). IDfunctions.ts re-exports everything here.
import { verbose } from './logger';
import { ID_SKIP_TAGS } from './blockElements';
import { book } from '../app';
// Type-only import (erased at runtime) — keeps idHelpers a zero-runtime-import leaf.
import type { BookId } from '../indexedDB/types';

// 🚀 PERFORMANCE: Cache regex pattern (compiled once, used everywhere)
export const NUMERICAL_ID_PATTERN = /^\d+(\.\d+)?$/;

// ================================================================
// IDENTIFIER VOCABULARY
// The editor write path (divEditor / editToolbar / paste / editButton) shuffles
// THREE distinct kinds of identifier. Giving each its own type stops the classic
// "bookId used where a node id was expected" bug (see mainContent?.id gotcha).
// ================================================================

/**
 * A node's POSITIONAL id — the DOM `el.id`, a decimal-shaped string like "100"
 * or "100.5" (matches NUMERICAL_ID_PATTERN). It encodes reading order and is the
 * IDB key component (its numeric form is `NodeRecord.startLine: number`).
 *
 * Branded so it is NOT interchangeable with BookId / DataNodeId. String-backed on
 * purpose: a JS number would collapse decimal-depth (1.10 → 1.1) that
 * compareDecimalStrings / needsRenumbering rely on, and lose precision on deep ids.
 */
export type LineId = string & { readonly __brand: 'LineId' };

/**
 * A node's STABLE id — the DOM `data-node-id` (`node_id` in IDB/Postgres), shaped
 * `${bookId}_${ts}_${rand}` by generateDataNodeId(). Survives renumbering; globally
 * unique in Postgres (but NOT in IDB — parent + sub-book can share one).
 *
 * Branded so it is NOT interchangeable with LineId / BookId. Unlike LineId there is
 * no value-format to validate (it's an opaque token), so asDataNodeId is a pure brand.
 */
export type DataNodeId = string & { readonly __brand: 'DataNodeId' };

// Re-export BookId + its helpers so the editor folders import all three id vocabularies from one place.
export type { BookId } from '../indexedDB/types';
export { asBookId, isBookId, LATEST, MOST_RECENT, MOST_CONNECTED, MOST_LIT } from '../indexedDB/types';

/** Type guard: is this string a positional node id (decimal-shaped)? */
export function isLineId(s: string | null | undefined): s is LineId {
  return s != null && NUMERICAL_ID_PATTERN.test(s);
}

/**
 * Brand a string as a LineId. Dev-warns (like isDuplicateId) when the value is not
 * a numerical id, making the DOM→LineId boundary explicit without throwing in prod.
 */
export function asLineId(s: string): LineId {
  if (!NUMERICAL_ID_PATTERN.test(s)) {
    console.warn(`asLineId: "${s}" is not a numerical node id (expected /^\\d+(\\.\\d+)?$/)`);
  }
  return s as LineId;
}

/** Type guard: is this a non-empty DataNodeId (the stable `data-node-id`)? */
export function isDataNodeId(s: string | null | undefined): s is DataNodeId {
  return typeof s === 'string' && s.length > 0;
}

/** Brand a string as a DataNodeId. Pure brand — the token has no fixed format to validate. */
export function asDataNodeId(s: string): DataNodeId {
  return s as DataNodeId;
}

/**
 * Detect if we need to renumber (decimals getting too deep)
 * Only trigger renumbering when decimals exceed MAX_DECIMAL_DEPTH
 */
function needsRenumbering(beforeId: string | null | undefined, afterId: string | null | undefined): boolean {
  const MAX_DECIMAL_DEPTH = 3; // Allow up to 3 decimal places (e.g., 1.123)

  if (!beforeId || !afterId) return false;

  const beforeNum = parseFloat(beforeId);
  const afterNum = parseFloat(afterId);

  if (isNaN(beforeNum) || isNaN(afterNum)) return false;

  // Check current decimal depth
  const beforeDecimal = beforeId.toString().split('.')[1] || '';
  const afterDecimal = afterId.toString().split('.')[1] || '';
  const currentMaxDepth = Math.max(beforeDecimal.length, afterDecimal.length);

  // If we're already at max depth, trigger renumbering
  if (currentMaxDepth >= MAX_DECIMAL_DEPTH) {
    console.log(`🔍 RENUMBER TRIGGER: Decimal depth ${currentMaxDepth} >= ${MAX_DECIMAL_DEPTH}`);
    return true;
  }

  // Allow normal decimal generation if under the limit
  return false;
}

// Utility: Generate a fallback unique ID if needed (used as a last resort).

export function compareDecimalStrings(a: string | null | undefined, b: string | null | undefined): number {
  verbose.content(`Comparing decimal strings: "${a}" vs "${b}"`, 'utilities/IDfunctions');

  // Handle null/undefined cases
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  // Convert to strings if they aren't already
  const aStr = a.toString();
  const bStr = b.toString();

  // Split into integer and decimal parts
  const [aInt = "", aDec = ""] = aStr.split(".");
  const [bInt = "", bDec = ""] = bStr.split(".");

  verbose.content(`Split results: a(${aInt}.${aDec}) vs b(${bInt}.${bDec})`, 'utilities/IDfunctions');

  // Compare integer parts numerically
  const aIntNum = parseInt(aInt);
  const bIntNum = parseInt(bInt);

  if (aIntNum !== bIntNum) {
    const result = aIntNum - bIntNum;
    verbose.content(`Integer parts differ: ${aIntNum} vs ${bIntNum}, result: ${result}`, 'utilities/IDfunctions');
    return result; // -1 if a < b, 1 if a > b, 0 if equal
  }

  verbose.content(`Integer parts equal (${aIntNum}), comparing decimal parts`, 'utilities/IDfunctions');

  // Integer parts are equal, compare decimal parts as strings
  // Pad the shorter decimal with zeros for proper comparison
  const maxLen = Math.max(aDec.length, bDec.length);
  const aPadded = aDec.padEnd(maxLen, '0');
  const bPadded = bDec.padEnd(maxLen, '0');

  verbose.content(`Padded decimals: "${aPadded}" vs "${bPadded}"`, 'utilities/IDfunctions');

  const result = aPadded.localeCompare(bPadded);
  verbose.content(`Decimal comparison result: ${result}`, 'utilities/IDfunctions');

  return result;
}


/**
 * Set both id and data-node-id on an element
 * This ensures new elements can be tracked through renumbering
 */
export function setElementIds(element: any, beforeId: any, afterId: any, bookId: any) {
  // Generate and set the numerical ID
  element.id = generateIdBetween(beforeId, afterId);

  // Defense in depth: generateIdBetween should produce a unique id, but if a
  // future bug or stale state slips one through, bump to the next available
  // decimal for the same base before the element is inserted into the DOM.
  // The element here is typically detached, so isIdInUse only flags conflicts
  // against other existing nodes.
  if (isIdInUse(element.id)) {
    const baseMatch = element.id.match(/^(\d+)/);
    if (baseMatch) {
      const bumpedId = getNextDecimalForBase(baseMatch[1]);
      console.warn(`setElementIds: generated id ${element.id} already in use, bumping to ${bumpedId}`);
      element.id = bumpedId;
    }
  }

  // Generate and set the permanent node_id if it doesn't exist
  if (!element.getAttribute('data-node-id')) {
    element.setAttribute('data-node-id', generateDataNodeId(bookId));
  }

  return element.id;
}

export function generateIdBetween(beforeId: any, afterId: any) {
  verbose.content(`Generating ID between: beforeId=${beforeId}, afterId=${afterId}`, 'utilities/IDfunctions');

  // RENUMBERING CHECK: Don't trigger here - let caller handle it after element is saved
  // Store the flag so caller can trigger renumbering deterministically
  const shouldRenumber = needsRenumbering(beforeId, afterId);
  if (shouldRenumber) {
    verbose.content('RENUMBERING NEEDED - Will trigger after element is saved', 'utilities/IDfunctions');
  }

  // Store renumbering flag on window for caller to check
  (window as any).__pendingRenumbering = shouldRenumber;

  // 1) No beforeId → just pick something before afterId
  if (!beforeId) {
    verbose.content("EXIT: No beforeId", 'utilities/IDfunctions');
    if (!afterId) return "1";
    const afterNum = parseFloat(afterId);
    return isNaN(afterNum)
      ? "1"
      : Math.max(1, Math.floor(afterNum) - 1).toString();
  }

  // 2) No afterId → increment with 100-unit gap
  if (!afterId) {
    verbose.content("EXIT: No afterId", 'utilities/IDfunctions');
    const beforeNum = parseFloat(beforeId);
    if (isNaN(beforeNum)) return `${beforeId}_1`;

    // Use 100-unit gaps to maintain renumbering pattern
    const beforeFloor = Math.floor(beforeNum);
    const nextInteger = beforeFloor + 100;

    // isIdInUse: true when ANY element already has this ID (prevents creating a duplicate)
    if (isIdInUse(nextInteger.toString())) {
      console.warn(
        `Next integer ${nextInteger} already exists, falling back to decimal`
      );
      const [intPart, decPart = ""] = beforeId.split(".");
      if (Number.isInteger(beforeNum)) {
        return `${beforeNum}.1`;
      }
      if (decPart.endsWith("9")) {
        return `${intPart}.${decPart}1`;
      }
      const last = parseInt(decPart.slice(-1), 10);
      return `${intPart}.${decPart.slice(0, -1)}${last + 1}`;
    }

    verbose.content(`EXIT: No afterId, using 100-gap: ${nextInteger}`, 'utilities/IDfunctions');
    return nextInteger.toString();
  }

  // 3) Both beforeId and afterId exist
  const beforeNum = parseFloat(beforeId);
  const afterNum = parseFloat(afterId);
  const cmp = compareDecimalStrings(beforeId, afterId);
  verbose.content(`Comparison result: ${cmp}`, 'utilities/IDfunctions');

  if (cmp >= 0) {
    console.warn(`IDs out of order: ${beforeId} ≥ ${afterId}`);
    return generateIdBetween(beforeId, null);
  }

  if (!isNaN(beforeNum) && !isNaN(afterNum)) {
    // handle outrageously long decimals by simple string logic…
    const beforeDecLen = beforeId.split(".")[1]?.length || 0;
    const afterDecLen = afterId.split(".")[1]?.length || 0;
    if (beforeDecLen > 10 || afterDecLen > 10) {
      console.warn("Very long decimal detected, using string‐only logic");
      const [i, d = ""] = beforeId.split(".");
      if (d.endsWith("9")) return `${i}.${d}1`;
      if (d) {
        const last = parseInt(d.slice(-1), 10);
        return `${i}.${d.slice(0, -1)}${last + 1}`;
      }
      return `${i}.1`;
    }

    // ✨ NEW: Check for integer gap >= 2, use midpoint
    if (Number.isInteger(beforeNum) && Number.isInteger(afterNum)) {
      const gap = afterNum - beforeNum;
      if (gap >= 2) {
        const midpoint = Math.floor((beforeNum + afterNum) / 2);
        verbose.content(`EXIT: Integer gap ${gap}, using midpoint: ${midpoint}`, 'utilities/IDfunctions');
        return midpoint.toString();
      }
    }

    // ✨ Check for integer gap when one is decimal
    // If there's room for an integer between them, use it
    const nextIntAfterBefore = Math.floor(beforeNum) + 1;
    if (compareDecimalStrings(nextIntAfterBefore.toString(), afterId) < 0) {
      console.log(`EXIT: Using next available integer: ${nextIntAfterBefore}`);
      return nextIntAfterBefore.toString();
    }

    const beforeParts = beforeId.split(".");
    const afterParts = afterId.split(".");
    const gap = afterNum - beforeNum;
    const lenB = beforeParts[1]?.length || 0;
    const lenA = afterParts[1]?.length || 0;

    // CASE 1) same integer part, both have decimals
    if (beforeParts[0] === afterParts[0] && lenB > 0 && lenA > 0) {
      console.log("Case 1: same int & both decimals");
      const intPart = beforeParts[0];
      const beforeDec = beforeParts[1];
      const afterDec = afterParts[1];

      // Pad both to the LONGER length to compare properly
      // 1.18 and 1.2 → treat as 1.18 vs 1.20
      const workingLength = Math.max(lenB, lenA);
      const paddedBeforeDec = beforeDec.padEnd(workingLength, "0");
      const paddedAfterDec = afterDec.padEnd(workingLength, "0");
      const beforeDecNum = parseInt(paddedBeforeDec, 10);
      const afterDecNum = parseInt(paddedAfterDec, 10);

      if (afterDecNum - beforeDecNum > 1) {
        // Room to increment: 1.18 and 1.2 → 1.19
        let newDec = (beforeDecNum + 1).toString().padStart(workingLength, "0");
        console.log(`EXIT: Room to increment decimal: ${intPart}.${newDec}`);
        return `${intPart}.${newDec}`;
      }

      // No room to increment, need to append a digit
      // 1.18 and 1.19 → 1.181
      console.log("EXIT: No room to increment, appending digit");
      return `${beforeId}1`;
    }

    // CASE 2: before is integer, after has decimals (e.g. 100 vs 100.1)
    verbose.content(`Checking case 2: beforeParts=${beforeParts.length}, afterParts=${afterParts.length}, sameInt=${beforeParts[0] === afterParts[0]}`, 'utilities/IDfunctions');
    if (
      beforeParts.length === 1 &&
      afterParts.length === 2 &&
      beforeParts[0] === afterParts[0]
    ) {
      // ... (This logic is correct for its purpose and is now protected by the fix above)
      verbose.content("EXIT: Case 2 triggered", 'utilities/IDfunctions');
      const suffix = "0".repeat(lenA) + "1";
      return `${beforeParts[0]}.${suffix}`;
    }

    // CASE 3: integers with gap (e.g. 1 and 2 → 1.1, or 3 and 5 → 4)
    verbose.content("Checking case 3...", 'utilities/IDfunctions');
    if (Number.isInteger(beforeNum) && Number.isInteger(afterNum)) {
      // ... (The fix above already handles the "3 and 5 -> 4" case, but this is fine as a fallback)
      if (afterNum - beforeNum === 1) {
        const candidate = `${beforeNum}.1`;
        // Guard against duplicates: a `${beforeNum}.1` may already exist further
        // down in the DOM. Recurse with a tighter range so the next call goes
        // through CASE 1 and yields `${beforeNum}.11` etc.
        if (isIdInUse(candidate)) {
          console.warn(`Case 3 candidate ${candidate} already exists, recursing`);
          return generateIdBetween(candidate, afterId);
        }
        return candidate;
      } else if (afterNum - beforeNum > 1) {
        const candidate = (beforeNum + 1).toString();
        if (isIdInUse(candidate)) {
          console.warn(`Case 3 candidate ${candidate} already exists, recursing`);
          return generateIdBetween(candidate, afterId);
        }
        return candidate;
      }
    }

    // CASE 4: before has decimal, after is integer
    if (!Number.isInteger(beforeNum) && Number.isInteger(afterNum)) {
      // ... (The fix above already handles the "3.5 and 5 -> 4" case)
      const beforeInt = Math.floor(beforeNum);
      if (afterNum - beforeInt > 1) {
        const candidate = (beforeInt + 1).toString();
        if (isIdInUse(candidate)) {
          console.warn(`Case 4 candidate ${candidate} already exists, recursing`);
          return generateIdBetween(candidate, afterId);
        }
        return candidate;
      } else {
        const [i, d = ""] = beforeId.split(".");
        const candidate = d.endsWith("9")
          ? `${i}.${d}1`
          : `${i}.${d.slice(0, -1)}${parseInt(d.slice(-1), 10) + 1}`;
        if (isIdInUse(candidate)) {
          console.warn(`Case 4 decimal candidate ${candidate} already exists, recursing`);
          return generateIdBetween(candidate, afterId);
        }
        return candidate;
      }
    }
  }

  // FINAL fallback: This should now be unreachable for valid numerical inputs.
  console.log("EXIT: Fallback");
  return `${beforeId}_next`;
}
// Helper function to find the ID of the previous element with a numerical ID
export function findPreviousElementId(node: any) {
  let prev = node.previousElementSibling;
  while (prev) {
    if (prev.id && /^\d+(\.\d+)?$/.test(prev.id)) {
      return prev.id;
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

// Helper function to find the ID of the next element with a numerical ID
export function findNextElementId(node: any) {
  let next = node.nextElementSibling;
  while (next) {
    if (next.id && /^\d+(\.\d+)?$/.test(next.id)) {
      return next.id;
    }
    next = next.nextElementSibling;
  }
  return null;
}

// 🚀 PERFORMANCE: Optimized numerical ID check (3-5x faster)
// Check if an id is numerical (integer or decimal)
export function isNumericalId(id: any) {
  return NUMERICAL_ID_PATTERN.test(id);
}




export function generateUniqueId() {
  const id = "node_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
  console.log(`🆔 generateUniqueId: Created fallback ID: ${id}`);
  return id;
}

// Generate a DataNodeId (the stable `data-node-id` / PG `node_id`) for persistent
// identification across renumbering. NOT the positional id — see generateInsertedLineId.
export function generateDataNodeId(bookId: BookId): DataNodeId {
  const id = `${bookId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  return asDataNodeId(id);
}

// Utility: Check if an id is duplicate within the document.
export function isDuplicateId(id: string): boolean {
  const elements = document.querySelectorAll(`#${CSS.escape(id)}`);
  const isDuplicate = elements.length > 1;
  if (isDuplicate) {
    console.warn(`🚨 isDuplicateId: Found duplicate ID: ${id} (${elements.length} instances)`);
    // Log the elements with this ID to help debugging
    elements.forEach((el, i) => {
      console.warn(`  Duplicate #${i+1}: <${el.tagName.toLowerCase()}> with content: "${el.textContent?.substring(0, 30)}..."`);
    });
  }
  return isDuplicate;
}

// Check if any element in the document already uses this ID (even a single one).
// Unlike isDuplicateId (which returns true only for 2+ elements), this returns
// true when 1+ element has the ID — used to prevent *creating* a duplicate.
export function isIdInUse(id: string): boolean {
  return document.querySelector(`#${CSS.escape(id)}`) !== null;
}

// Generate a positional LineId (the decimal `element.id`) for a newly inserted node,
// derived from its neighbours. Falls back to a non-numeric generateUniqueId() when no
// numeric base is available (hence the loose return type). NOT the stable data-node-id.
export function generateInsertedLineId(referenceNode: any, insertAfter = true) {
  console.log(`🔄 generateInsertedLineId: Called with reference node:`, 
    referenceNode ? `#${referenceNode.id} <${referenceNode.tagName.toLowerCase()}>` : 'null', 
    `insertAfter: ${insertAfter}`);
  
  if (!referenceNode || !referenceNode.id) {
    console.warn(`⚠️ generateInsertedLineId: No valid reference node, falling back to unique ID`);
    return generateUniqueId();
  }
  
  // Extract the numeric base from the reference node id.
  const baseMatch = referenceNode.id.match(/^(\d+)/);
  if (!baseMatch) {
    console.warn(`⚠️ generateInsertedLineId: Reference node ID "${referenceNode.id}" doesn't match expected pattern, falling back to unique ID`);
    return generateUniqueId();
  }
  
  const baseId = baseMatch[1];
  let newId: any;
  if (insertAfter) {
    newId = getNextDecimalForBase(baseId);
    console.log(`✅ generateInsertedLineId: Inserting AFTER #${referenceNode.id} → new ID: ${newId}`);
  } else {
    // For inserting before, try to derive from the previous sibling.
    const parent = referenceNode.parentElement;
    if (!parent) {
      console.warn(`⚠️ generateInsertedLineId: Reference node has no parent, falling back to unique ID`);
      return generateUniqueId();
    }
    
    const siblings = Array.from(parent.children);
    const pos = siblings.indexOf(referenceNode);
    console.log(`🔍 generateInsertedLineId: Reference node position among siblings: ${pos}/${siblings.length}`);
    
    if (pos > 0) {
      const prevSibling: any = siblings[pos - 1];
      if (prevSibling.id) {
        const prevMatch = prevSibling.id.match(/^(\d+)/);
        if (prevMatch) {
          const prevBase = prevMatch[1];
          newId = getNextDecimalForBase(prevBase);
          console.log(`✅ generateInsertedLineId: Using previous sibling #${prevSibling.id} → new ID: ${newId}`);
        } else {
          newId = `${baseId}.1`;
          console.log(`⚠️ generateInsertedLineId: Previous sibling has non-standard ID, using ${newId}`);
        }
      } else {
        newId = `${baseId}.1`;
        console.log(`⚠️ generateInsertedLineId: Previous sibling has no ID, using ${newId}`);
      }
    } else {
      newId = `${baseId}.1`;
      console.log(`✅ generateInsertedLineId: No previous sibling, using ${newId}`);
    }
  }
  
  return newId;
}



export function getNextDecimalForBase(base: any) {
  // Get all elements with this base in the current chunk
  const chunk = document.querySelector('.chunk');
  if (!chunk) return `${base}.1`;
  
  const baseElements = Array.from(chunk.querySelectorAll(`[id^="${base}."], [id="${base}"]`));
  
  // If no elements with this base exist, start with .1
  if (baseElements.length === 0) return `${base}.1`;
  
  // Sort by DOM order (visual order)
  baseElements.sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
  
  // Find the last element in DOM order
  const lastElement = baseElements[baseElements.length - 1];
  
  // If the last element is the base itself (no decimal), use .1
  if (lastElement!.id === base) return `${base}.1`;
  
  // Otherwise, increment the last decimal
  const match = lastElement!.id.match(/^(\d+)\.(\d+)$/);
  if (match) {
    const lastSuffix = parseInt(match[2]!, 10);
    return `${base}.${lastSuffix + 1}`;
  }
  
  // Fallback
  return `${base}.1`;
}

export function getNextIntegerId(id: any) {
  const n = Math.floor(parseFloat(id));
  return String(n + 1);
}





// Replace original ensureNodeHasValidId with enhanced version using decimal logic.
export function ensureNodeHasValidId(node: any, options: any = {}) {
  const { referenceNode, insertAfter } = options;
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  // Skip elements that shouldn't have IDs (e.g. inline tags, LI whose parent OL/UL has the ID)
  if (ID_SKIP_TAGS.has(node.tagName)) {
    console.log(`Skipping ID assignment for ${node.tagName} element`);
    return;
  }

  // (Removed: a dead `window.__enterKeyInfo` cursor-aware-id block — it was only ever
  //  read, never written, so it could never fire. The live id assignment is
  //  generateIdBetween CASE 3 & 4 + the setElementIds post-check, which guard every site.)

  // If node already has an id, check for duplicates:
  if (node.id) {
    if (isDuplicateId(node.id)) {
      const match = node.id.match(/^(\d+)(\.\d+)?$/);
      if (match) {
        const baseId = match[1];
        const newId = getNextDecimalForBase(baseId);
        console.log(`ID conflict detected. Changing node id from ${node.id} to ${newId}`);
        node.id = newId;
      } else {
        const oldId = node.id;
        node.id = generateUniqueId();
        console.log(`ID conflict detected (non-numeric). Changing node id from ${oldId} to ${node.id}`);
      }
    }
  } else {
    // NEW: Determine proper numerical ID based on position
    if (referenceNode && typeof insertAfter === "boolean") {
      node.id = generateInsertedLineId(referenceNode, insertAfter);

      // ✅ Also set data-node-id if not present
      if (!node.getAttribute('data-node-id')) {
        node.setAttribute('data-node-id', generateDataNodeId(book));
      }

      console.log(`Assigned new id ${node.id} and data-node-id based on reference insertion direction.`);
    } else {
      // Find the node's position in the DOM and assign appropriate ID
      let beforeId = findPreviousElementId(node);
      let afterId = findNextElementId(node);

      // Parent-aware fallback: when both are null (e.g. node inside a list where
      // siblings are LI elements with no numerical IDs), use the parent's context
      // to avoid generating ID "1" which would place the node at the top of the doc.
      if (beforeId === null && afterId === null && node.parentElement) {
        const parent = node.parentElement;
        const parentId = parent.id && /^\d+(\.\d+)?$/.test(parent.id) ? parent.id : null;
        if (parentId) {
          beforeId = parentId;
        } else {
          beforeId = findPreviousElementId(parent);
          afterId = findNextElementId(parent);
        }
      }

      node.id = generateIdBetween(beforeId, afterId);

      // ✅ Also set data-node-id if not present (same as setElementIds does)
      if (!node.getAttribute('data-node-id')) {
        node.setAttribute('data-node-id', generateDataNodeId(book));
      }

      console.log(`Assigned positional id ${node.id} and data-node-id to node <${node.tagName.toLowerCase()}> (between ${beforeId} and ${afterId})`);
    }
  }

}