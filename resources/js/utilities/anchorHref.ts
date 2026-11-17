/**
 * anchorHref — the ONE way click handlers read an anchor's destination.
 *
 * `HTMLAnchorElement.href` is a string. `SVGAElement.href` is an
 * `SVGAnimatedString` OBJECT (`{ baseVal, animVal }`), and `String(it)` is
 * "[object SVGAnimatedString]". Both document-level click routers
 * (lazyLoader's globalLinkHandler and LinkNavigationHandler.handleLinkClick)
 * used `new URL(link.href, origin)`, so a click on a dot of the hypercite
 * network map (an `<a>` inside an `<svg>`) was preventDefault-ed and SPA-routed
 * to a book called "[object SVGAnimatedString]" whenever a feed lazy loader was
 * alive on the hero page — which is the state a tab is in after a feed was
 * opened, after back/forward, or after a bfcache return. Zero-import leaf.
 */

type MaybeAnimatedHref = string | { baseVal?: unknown; animVal?: unknown } | null | undefined;

/**
 * The anchor's href as a string, or null when it has none. For an SVG anchor
 * the LIVE attribute is used (the map's capture-phase handler rewrites it just
 * before the click bubbles, so the rewrite is honoured).
 */
export function anchorHrefOf(link: Element): string | null {
  const raw = (link as unknown as { href?: MaybeAnimatedHref }).href;
  let href: string | null = null;
  if (typeof raw === 'string') {
    href = raw;
  } else if (raw && typeof raw === 'object') {
    const attr = link.getAttribute('href');
    href = attr ?? (typeof raw.baseVal === 'string' ? raw.baseVal : null);
  } else {
    href = link.getAttribute('href');
  }
  if (href === null) return null;
  const trimmed = href.trim();

  return trimmed === '' ? null : trimmed;
}

/** The anchor's destination resolved against `base`, or null when absent/unparseable. */
export function anchorUrlOf(link: Element, base: string = window.location.href): URL | null {
  const href = anchorHrefOf(link);
  if (href === null) return null;
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}
