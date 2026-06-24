/**
 * Is this URL hash a content deep-link target — a hypercite / hyperlight / footnote / node startLine?
 *
 * Used to suppress the WRONG (lowest-chunk) server prerender on a FULL page load before it paints:
 * the browser strips the `#hash` from the request, so `TextController::show` can't know the target
 * and prerenders the lowest chunk. When the hash is a deep-link we hide that prerender (the client
 * then renders the real target chunk) — no flash.
 *
 * Mirrors the target patterns the resolvers accept (resolveTargetToChunkIdWithReason /
 * pageLoad/initialChunk). KEEP IN SYNC with the inline mirror in resources/views/reader.blade.php.
 */
export function isDeepLinkHash(hash: string | null | undefined): boolean {
  if (!hash) return false;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h) return false;
  return (
    h.startsWith('hypercite_') ||
    h.startsWith('HL_') ||
    /(^|_)Fn\d/.test(h) ||      // footnote id (Fn followed by a digit)
    /^\d+(\.\d+)?$/.test(h)     // numeric node startLine
  );
}
