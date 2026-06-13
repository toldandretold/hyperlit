/**
 * Hypercite Utility Functions
 *
 * Pure helper functions with no side effects.
 * These functions perform data transformations, validation, and parsing.
 */
import type { RelationshipStatus } from '../indexedDB/types';

/**
 * Generate a unique hypercite ID
 * @returns A unique hypercite ID (e.g., "hypercite_x7k2pq9")
 */
export function generateHyperciteID(): string {
  return "hypercite_" + Math.random().toString(36).substring(2, 9);
}

export interface ParsedHyperciteHref { citationIDa: string; hyperciteIDa: string; booka: string }

/**
 * Parse hypercite href URL to extract components
 */
export function parseHyperciteHref(href: string): ParsedHyperciteHref | null {
  try {
    const url = new URL(href, window.location.origin);
    const booka = url.pathname.replace(/^\//, ""); // e.g., "booka"
    const hyperciteIDa = url.hash.substr(1);       // e.g., "hyperciteIda"
    const citationIDa = `/${booka}#${hyperciteIDa}`; // e.g., "/booka#hyperciteIda"
    return { citationIDa, hyperciteIDa, booka };
  } catch (error) {
    console.error("Error parsing hypercite href:", href, error);
    return null;
  }
}

/**
 * Extract hypercite ID from href URL
 */
export function extractHyperciteIdFromHref(hrefUrl: string): string | null {
  try {
    const url = new URL(hrefUrl, window.location.origin);
    const hash = url.hash;

    if (hash && hash.startsWith('#hypercite_')) {
      return hash.substring(1); // Remove the # symbol
    }

    return null;
  } catch (error) {
    console.error("Error parsing href URL:", hrefUrl, error);
    return null;
  }
}

/**
 * Determine relationship status based on citedIN array length
 */
export function determineRelationshipStatus(citedINLength: number): RelationshipStatus {
  if (citedINLength === 0) {
    return "single";
  } else if (citedINLength === 1) {
    return "couple";
  } else {
    return "poly";
  }
}

/**
 * Remove a citedIN entry that matches the given hypercite element ID
 */
export function removeCitedINEntry(citedINArray: string[], hyperciteElementId: string): string[] {
  if (!Array.isArray(citedINArray)) {
    return [];
  }

  return citedINArray.filter(citedINUrl => {
    // Extract the hypercite ID from the citedIN URL
    const urlParts = citedINUrl.split('#');
    if (urlParts.length > 1) {
      const citedHyperciteId = urlParts[1];
      return citedHyperciteId !== hyperciteElementId;
    }
    return true; // Keep entries that don't match the expected format
  });
}

/**
 * Find the nearest parent element with a numerical ID (e.g., "1", "2.1")
 */
export function findParentWithNumericalId(element: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current) {
    const id = current.getAttribute("id");
    if (id && /^\d+(?:\.\d+)?$/.test(id)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Check if a selection spans multiple nodes with numerical IDs
 */
export function selectionSpansMultipleNodes(range: Range): boolean {
  const walker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: function(node: Node) {
        // Only accept nodes that have a numerical ID and intersect with our range
        const el = node as HTMLElement;
        if (el.id && /^\d+(?:\.\d+)?$/.test(el.id)) {
          if (range.intersectsNode(node)) {
            return NodeFilter.FILTER_ACCEPT;
          }
        }
        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  let nodeCount = 0;
  while (walker.nextNode()) {
    nodeCount++;
    if (nodeCount > 1) {
      return true; // Found more than one node, so it spans multiple
    }
  }

  return false; // Single node or no nodes
}
