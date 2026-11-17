// The hypercite-network map's dots are `<a>` elements inside an `<svg>`. Once a
// feed lazy loader is alive on a hero page (feed opened, back/forward, bfcache
// return) its document-level click handler forwards every anchor click to
// LinkNavigationHandler.handleLinkClick, which built its URL from `link.href` —
// an SVGAnimatedString OBJECT on SVG anchors — so a dot click was
// preventDefault-ed and SPA-routed to a book called "[object SVGAnimatedString]".
// On a fresh hero (no loader) the click fell through to native navigation and
// worked, which is why the bug read as "comes and goes".
//
// Pinned here: the routed destination is the REAL slug + the map's intro hash,
// an a-initial slug from an /a/ page is a cross-book hop (not "same book" by
// bare prefix on the literal book id "a"), and the `<a download>` skip survives.
import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../../../resources/js/SPA/navigation/NavigationManager', () => ({
  NavigationManager: { navigateByStructure: vi.fn().mockResolvedValue(undefined) },
}));

const SVG_NS = 'http://www.w3.org/2000/svg';
let LinkNavigationHandler; let NavigationManager; let initJournalHyperciteMap; let destroyJournalHyperciteMap;

/** Build the server's map markup; `href` modelled as a browser's SVGAnimatedString. */
function renderMap(dots) {
  document.body.innerHTML = '<div id="app-container"><section class="welcome-copy"><div class="journal-hypercite-map"></div></section></div>';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('data-map-noun', 'document');
  for (const d of dots) {
    const a = document.createElementNS(SVG_NS, 'a');
    a.setAttribute('href', d.href);
    a.setAttribute('tabindex', '-1');
    a.setAttribute('data-map-node', 'lit');
    a.setAttribute('aria-label', d.title ?? d.href);
    if (d.intro) a.setAttribute('data-intro', d.intro);
    Object.defineProperty(a, 'href', {
      configurable: true,
      get() {
        const el = this;
        return { get baseVal() { return el.getAttribute('href'); }, toString() { return '[object SVGAnimatedString]'; } };
      },
    });
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('r', '3');
    a.appendChild(circle);
    svg.appendChild(a);
  }
  document.querySelector('.journal-hypercite-map').appendChild(svg);
  return svg;
}

/** The lazyLoader's document-level handler, reduced to its forwarding step. */
let feedLoaderHandler = null;
function openFeed() {
  feedLoaderHandler = (e) => { void LinkNavigationHandler.handleLinkClick(e); };
  document.addEventListener('click', feedLoaderHandler);
}
function closeFeed() {
  if (feedLoaderHandler) document.removeEventListener('click', feedLoaderHandler);
  feedLoaderHandler = null;
}

function desktopClick(target) {
  if (typeof PointerEvent === 'function') {
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true }));
  }
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  target.dispatchEvent(ev);
  return ev;
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeAll(async () => {
  // `book` in app.ts is derived from the URL at import time: on /a/{slug} it is the literal "a".
  window.history.replaceState(null, '', '/a/decolonising-security');
  ({ LinkNavigationHandler } = await import('../../../../resources/js/SPA/navigation/LinkNavigationHandler'));
  ({ NavigationManager } = await import('../../../../resources/js/SPA/navigation/NavigationManager'));
  ({ initJournalHyperciteMap, destroyJournalHyperciteMap } = await import('../../../../resources/js/components/journalHyperciteMap'));
});

beforeEach(() => {
  closeFeed();
  destroyJournalHyperciteMap();
  NavigationManager.navigateByStructure.mockClear();
  window.history.replaceState(null, '', '/a/decolonising-security');
  sessionStorage.clear();
  localStorage.clear();
});

describe('SVG map dots through the SPA link router', () => {
  test('fresh hero (no feed loader): a dot click is left to the browser', () => {
    const svg = renderMap([{ href: '/pushing-the-boundaries-can-we-decolonize-security-studies', intro: 'hypercite_t5skblf' }]);
    initJournalHyperciteMap();
    const ev = desktopClick(svg.querySelector('circle'));
    expect(ev.defaultPrevented).toBe(false);
    expect(NavigationManager.navigateByStructure).not.toHaveBeenCalled();
    // The map's own capture handler still deep-links a first-time visitor to the intro hypercite.
    expect(svg.querySelector('a').getAttribute('href')).toBe('/pushing-the-boundaries-can-we-decolonize-security-studies#hypercite_t5skblf');
  });

  test('with a feed loader alive: the click is SPA-routed to the REAL slug, intro hash intact', async () => {
    const svg = renderMap([{ href: '/pushing-the-boundaries-can-we-decolonize-security-studies', intro: 'hypercite_t5skblf' }]);
    initJournalHyperciteMap();
    openFeed();

    const ev = desktopClick(svg.querySelector('circle'));
    await settle();

    expect(ev.defaultPrevented).toBe(true);
    expect(NavigationManager.navigateByStructure).toHaveBeenCalledTimes(1);
    const opts = NavigationManager.navigateByStructure.mock.calls[0][0];
    expect(opts.toBook).toBe('pushing-the-boundaries-can-we-decolonize-security-studies');
    expect(opts.targetUrl).toBe(`${window.location.origin}/pushing-the-boundaries-can-we-decolonize-security-studies#hypercite_t5skblf`);
    expect(opts.hash).toBe('#hypercite_t5skblf');
    expect(JSON.stringify(opts)).not.toContain('SVGAnimatedString');
  });

  test('an a-initial slug from an /a/ page is a cross-book hop, not "same book" by prefix on the id "a"', async () => {
    const svg = renderMap([{ href: '/abolition-as-method-gabriel-2022', intro: 'hypercite_5t4wrtk' }]);
    initJournalHyperciteMap();
    openFeed();

    const ev = desktopClick(svg.querySelector('circle'));
    await settle();

    expect(ev.defaultPrevented).toBe(true);
    expect(NavigationManager.navigateByStructure).toHaveBeenCalledTimes(1);
    expect(NavigationManager.navigateByStructure.mock.calls[0][0].toBook).toBe('abolition-as-method-gabriel-2022');
    // The same-book branch would have rewritten the address bar to "/a#hypercite_…".
    expect(window.location.pathname).toBe('/a/decolonising-security');
  });

  test('a returning reader (saved position) is routed to the plain book URL', async () => {
    const svg = renderMap([{ href: '/pushing-the-boundaries-can-we-decolonize-security-studies', intro: 'hypercite_t5skblf' }]);
    // The writer's shape (readingAnchor.getSavedAnchor reads it): a numeric node id + when it moved.
    const { getLocalStorageKey } = await import('../../../../resources/js/indexedDB/index');
    sessionStorage.setItem(getLocalStorageKey('scrollPosition', 'pushing-the-boundaries-can-we-decolonize-security-studies'), JSON.stringify({ elementId: '100', savedAt: Date.now() }));
    initJournalHyperciteMap();
    openFeed();

    desktopClick(svg.querySelector('circle'));
    await settle();

    const opts = NavigationManager.navigateByStructure.mock.calls[0][0];
    expect(opts.toBook).toBe('pushing-the-boundaries-can-we-decolonize-security-studies');
    expect(opts.hash).toBe('');
  });

  test('the feed loader released (feed closed): dot clicks are native again', () => {
    const svg = renderMap([{ href: '/pushing-the-boundaries-can-we-decolonize-security-studies' }]);
    initJournalHyperciteMap();
    openFeed();
    closeFeed();
    const ev = desktopClick(svg.querySelector('circle'));
    expect(ev.defaultPrevented).toBe(false);
    expect(NavigationManager.navigateByStructure).not.toHaveBeenCalled();
  });

  test('regression guard: the archive panel\'s <a download> is still left to the browser', async () => {
    renderMap([]);
    openFeed();
    const a = document.createElement('a');
    a.href = '/exports/archive/decolonising-security/markdown';
    a.setAttribute('download', '');
    document.body.appendChild(a);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    await settle();
    expect(ev.defaultPrevented).toBe(false);
    expect(NavigationManager.navigateByStructure).not.toHaveBeenCalled();
  });

  test('an ordinary HTML content link routes exactly like a dot (negative control)', async () => {
    renderMap([]);
    openFeed();
    const a = document.createElement('a');
    a.href = '/digital-commons-rosnay-2020';
    document.body.appendChild(a);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    await settle();
    expect(ev.defaultPrevented).toBe(true);
    expect(NavigationManager.navigateByStructure.mock.calls[0][0].toBook).toBe('digital-commons-rosnay-2020');
  });
});
