// contentLink — zero-import leaf: classifies whether an <a> is a USER content link (unwrappable in
// edit mode) vs a system-generated link (footnote/hypercite/citation, left alone). Pulled out of
// hyperlights/deletion so EAGER code (components/selectionHandler) can use it WITHOUT statically
// importing the now-lazy hyperlights folder. Pure DOM checks, no imports.
export function isContentLink(anchor: Element | null): boolean {
  if (!anchor || anchor.tagName !== 'A') return false;

  const href = anchor.getAttribute('href');
  if (!href) return false;

  // System-generated link classes (footnotes only — citations are unwrappable)
  if (anchor.classList.contains('footnote-ref')) return false;

  // Hypercite links (id starts with "hypercite_")
  if (anchor.id && anchor.id.startsWith('hypercite_')) return false;

  // Links inside footnote sup markers
  if (anchor.closest('sup[fn-count-id]')) return false;

  // Links inside citation/hypercite sections
  if (anchor.closest('.hypercites-section, .citations-section, .hypercite-citation-section')) return false;

  return true;
}
