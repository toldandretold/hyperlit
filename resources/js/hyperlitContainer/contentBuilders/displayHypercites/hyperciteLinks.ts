/**
 * Hypercite link parsing (zero-import leaf).
 *
 * Pure helpers for the citedIN-link URLs that the "Cited By" panel renders and the health-check
 * engine probes: URL sanitisation, content-item-id extraction, and the full per-citation metadata
 * parse (bookID / content-type / item-id / sub-book-id) lifted out of buildHyperciteContent.
 */

/**
 * Validate URL to prevent javascript: and other dangerous protocols.
 * @returns Safe URL or '#' if dangerous.
 */
export function sanitizeUrl(url: any) {
  if (!url) return '#';
  try {
    // Handle relative URLs by using current origin as base
    const parsed = new URL(url, window.location.origin);
    // Only allow http, https protocols
    if (['http:', 'https:'].includes(parsed.protocol)) {
      return url;
    }
    // For relative URLs starting with /, allow them
    if (url.startsWith('/') && !url.startsWith('//')) {
      return url;
    }
    console.warn(`Blocked dangerous URL protocol: ${parsed.protocol}`);
    return '#';
  } catch {
    // If URL parsing fails, check if it's a simple relative path
    if (url.startsWith('/') && !url.toLowerCase().includes('javascript:')) {
      return url;
    }
    return '#';
  }
}

/**
 * Extract the footnoteId or hyperlightId from a citation URL path.
 * @returns The content item ID (footnoteId or hyperlightId), or null.
 */
export function extractContentIdFromUrl(urlPart: any, isFootnoteURL: any, isHyperlightURL: any) {
  const pathParts = urlPart.split("/").filter((p: any) => p);

  if (isHyperlightURL) {
    // Format: /bookId/HL_xxx → hyperlightId = "HL_xxx"
    const hlPart = pathParts.find((p: any) => p.startsWith("HL_"));
    return hlPart || null;
  }

  if (isFootnoteURL) {
    // New format: /bookId/FnTimestamp_random → footnoteId = "FnTimestamp_random"
    const fnPart = pathParts.find((p: any) => /^Fn\d/.test(p));
    if (fnPart) return fnPart;

    // Old format: /bookId_FnN (single segment) → footnoteId = "bookId_FnN"
    const fnSegment = pathParts.find((p: any) => p.includes("_Fn"));
    return fnSegment || null;
  }

  return null;
}

/**
 * Parse one citedIN link into the render/health-check metadata the "Cited By" panel needs.
 * Mirrors the inline mapping that used to live in buildHyperciteContent.
 */
export function parseCitedInLink(citationID: any, hyperciteId: any) {
  const citationParts = citationID.split("#");
  const urlPart = citationParts[0];
  const isHyperlightURL = urlPart.includes("/HL_");
  const isFootnoteURL = urlPart.includes("_Fn") || /\/Fn\d/.test(urlPart);

  let bookID: any;
  if (isHyperlightURL) {
    const pathParts = urlPart.split("/");
    for (let i = 0; i < pathParts.length; i++) {
      if (pathParts[i].startsWith("HL_") && i > 0) {
        // Walk backwards, skipping Fn* segments and numeric-only segments (page numbers)
        for (let j = i - 1; j >= 0; j--) {
          if (pathParts[j] && !(/^Fn\d/.test(pathParts[j])) && !(/^\d+$/.test(pathParts[j]))) {
            bookID = pathParts[j];
            break;
          }
        }
        break;
      }
    }
    if (!bookID) {
      bookID = pathParts.filter((part: any) => part && !part.startsWith("HL_") && !(/^Fn\d/.test(part)) && !(/^\d+$/.test(part)))[0] || "";
    }
  } else if (isFootnoteURL) {
    const pathParts = urlPart.split("/").filter((p: any) => p);
    if (pathParts.length > 1) {
      // Multi-segment: /craftingtheuser/seq1_Fn... → first segment is book slug
      bookID = pathParts[0];
    } else {
      // Legacy single-segment: /bookId_FnN → extract before _Fn
      bookID = pathParts[0].split("_Fn")[0];
    }
  } else {
    bookID = urlPart.replace("/", "");
  }

  const hasHyperciteInUrl = citationParts.length > 1;
  const hyperciteIdFromUrl = hasHyperciteInUrl ? citationParts[1] : null;

  // Extract content item ID and sub-book ID for footnote/hyperlight health checks
  // Find the **last** Fn*/HL_* segment — this is the deepest content item
  const allPathParts = urlPart.split("/").filter((p: any) => p);
  let lastItemIndex = -1;
  for (let i = allPathParts.length - 1; i >= 0; i--) {
    if (allPathParts[i].startsWith("HL_") || /^Fn\d/.test(allPathParts[i]) || allPathParts[i].includes("_Fn")) {
      lastItemIndex = i;
      break;
    }
  }

  let contentType = 'node';
  let contentItemId = '';
  let subBookId = '';

  if (lastItemIndex >= 0) {
    const lastItem = allPathParts[lastItemIndex];
    contentType = lastItem.startsWith("HL_") ? 'hyperlight' : 'footnote';
    contentItemId = lastItem;
    // The URL path already IS the correct sub-book ID (including depth)
    subBookId = allPathParts.join('/');
  } else if (isFootnoteURL) {
    // Legacy format: /bookId_FnN (underscore, single segment)
    contentType = 'footnote';
    contentItemId = extractContentIdFromUrl(urlPart, true, false) || '';
  }

  return {
    citationID,
    hyperciteId,
    bookID,
    isHyperlightURL,
    isFootnoteURL,
    hasHyperciteInUrl,
    hyperciteIdFromUrl,
    contentType,
    contentItemId,
    subBookId,
  };
}
