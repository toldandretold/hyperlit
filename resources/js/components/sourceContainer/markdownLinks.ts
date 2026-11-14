// Link handling for the single-book Markdown download (downloads.ts) — the
// client mirror of BookMarkdownExporter's convertFragment / absolutizeLinks.
//
// A downloaded .md has no site root, so a root-relative href (`/book_x#…`) is a
// NOTE PATH to Obsidian, which answers a click by creating a blank note. And
// Markdown has no footnote-inside-a-footnote, so a hypercite arrow sitting in
// a footnote body cannot become another `[^n]` — it is written out inline as
// the cited book's citation, linking the hyperlit deep URL.
//
// Pure DOM/string helpers (no IndexedDB, no Turndown) so they can be tested.

export interface HyperciteTarget {
  targetBookId: string;
  sourceUrl: string;
}

/** `/book_x/Fn1_y#hypercite_z` → the cited book + the absolute deep URL. */
export function parseHyperciteHref(href: string | null, origin: string): HyperciteTarget | null {
  if (!href) return null;
  try {
    const parsed = new URL(href, origin);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    return {
      targetBookId: decodeURIComponent(segments[0]!),
      sourceUrl: parsed.origin + parsed.pathname + (parsed.hash || ''),
    };
  } catch {
    return null;
  }
}

export function isHyperciteArrow(anchor: Element): boolean {
  return anchor.classList.contains('open-icon') || !!anchor.querySelector('sup.open-icon');
}

/**
 * Root-relative links → absolute. In-page `#fragment` links, protocol-relative
 * and already-absolute URLs are left alone.
 */
export function absolutizeLinks(root: Element, origin: string): void {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('/') && !href.startsWith('//')) {
      a.setAttribute('href', origin.replace(/\/$/, '') + href);
    }
  });
}

const SENTINEL_RE = /[ \t]*@@HLHC(\d+)@@/g;

/**
 * Prepare a footnote body for conversion: each hypercite arrow becomes a
 * sentinel token (bracket syntax would be escaped by the converter) and every
 * remaining root-relative link is absolutized. `finish` swaps the sentinels in
 * the converted markdown for ` (citation)`.
 */
export async function prepareFootnoteHtml(
  html: string,
  origin: string,
  citationFor: (target: HyperciteTarget) => Promise<string>,
): Promise<{ html: string; finish: (markdown: string) => string }> {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild!;
  const citations: string[] = [];

  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    if (!isHyperciteArrow(anchor)) continue;
    const target = parseHyperciteHref(anchor.getAttribute('href'), origin);
    if (!target) continue;
    citations.push((await citationFor(target)).replace(/\.\s*$/, ''));
    anchor.replaceWith(root.ownerDocument.createTextNode(`@@HLHC${citations.length}@@`));
  }

  absolutizeLinks(root, origin);

  return {
    html: root.innerHTML,
    finish: (markdown: string) =>
      citations.length === 0
        ? markdown
        : markdown.replace(SENTINEL_RE, (_m, n) => {
            const citation = citations[Number(n) - 1];
            return citation ? ` (${citation})` : '';
          }),
  };
}
