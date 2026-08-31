/**
 * Hover/tap card + expand button for the journal hero's hypercite network
 * (the inline SVG from app/Services/JournalHarvest/JournalHyperciteMap).
 * Each node is an `<a data-map-node …>` carrying title/author/year/connections.
 *
 * Pointer model (mirrors graphRenderer's harvest-network card):
 *  - Mouse: hover shows the card, click follows the link.
 *  - Touch: tap PINS the card instead of navigating (the map has no inline
 *    labels, so a blind navigation would be a mystery link) — the pinned
 *    card's title is the link; tapping elsewhere closes it.
 *
 * The blade's #journal-map-expand button opens the SVG in the shared
 * figureViewer overlay with `glassOverlay` (the lava lamp glows through) and
 * a light card backdrop (the map draws in ink — figureViewer's default dark
 * backdrop would swallow it).
 *
 * One singleton card div, inline styles (no reader.css churn, and it is a
 * tooltip, not an overlay-inventory surface), document-level CAPTURE
 * delegation so it survives SPA navigation and beats LinkNavigationHandler
 * to touch taps.
 */

import { getSavedAnchor } from '../../scrolling/readingAnchor';

const CARD_ID = 'journal-map-card';
const OFFSET = 14;

const KIND_LABELS: Record<string, string> = {
  lit: 'Hypercited article',
  article: 'Article',
  beyond: 'Hypercited book beyond the journal',
};

let card: HTMLDivElement | null = null;
let wired = false;
let pinned = false;
let lastPointerType = '';

function ensureCard(): HTMLDivElement {
  const existing = document.getElementById(CARD_ID);
  if (existing instanceof HTMLDivElement) return existing;

  const el = document.createElement('div');
  el.id = CARD_ID;
  Object.assign(el.style, {
    position: 'fixed',
    // Above figureViewer's overlay (10000) — the expanded network is the
    // same anchors (a clone), so the card must ride over the glass too.
    zIndex: '10001',
    maxWidth: '280px',
    padding: '10px 12px',
    borderRadius: '8px',
    background: 'rgba(34, 31, 32, 0.94)', // hero ink — matches the map
    color: '#f1f2f2',
    font: '13px/1.45 sans-serif',
    pointerEvents: 'none',
    visibility: 'hidden',
    boxShadow: '0 4px 18px rgba(0, 0, 0, 0.35)',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  return el;
}

/** @param linked  Pinned (touch) cards make the title a real link. */
function fillCard(el: HTMLDivElement, node: HTMLElement, linked: boolean): void {
  el.textContent = '';

  const kind = document.createElement('div');
  const kindKey = node.getAttribute('data-map-node') ?? 'article';
  const connections = node.getAttribute('data-connections');
  kind.textContent = (KIND_LABELS[kindKey] ?? KIND_LABELS.article!)
    + (connections ? ` · ${connections} connection${connections === '1' ? '' : 's'}` : '');
  Object.assign(kind.style, {
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    opacity: '0.7',
    marginBottom: '4px',
  } satisfies Partial<CSSStyleDeclaration>);
  el.appendChild(kind);

  const titleText = node.getAttribute('data-title') ?? '';
  if (linked) {
    const link = document.createElement('a');
    link.href = effectiveHref(node);
    link.textContent = `${titleText} →`;
    Object.assign(link.style, {
      color: 'inherit',
      fontWeight: '600',
      textDecoration: 'underline',
      display: 'block',
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(link);
  } else {
    const title = document.createElement('div');
    title.textContent = titleText;
    title.style.fontWeight = '600';
    el.appendChild(title);
  }

  const author = node.getAttribute('data-author');
  const year = node.getAttribute('data-year');
  if (author || year) {
    const meta = document.createElement('div');
    meta.textContent = [author, year].filter(Boolean).join(' · ');
    Object.assign(meta.style, {
      opacity: '0.8',
      marginTop: '3px',
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(meta);
  }
}

function placeCard(el: HTMLDivElement, x: number, y: number): void {
  const { innerWidth, innerHeight } = window;
  const rect = el.getBoundingClientRect();
  let left = x + OFFSET;
  let top = y + OFFSET;
  if (left + rect.width > innerWidth - 8) left = x - rect.width - OFFSET;
  if (top + rect.height > innerHeight - 8) top = y - rect.height - OFFSET;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function mapNodeFrom(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? (target.closest('a[data-map-node]') as HTMLElement | null)
    : null;
}

/**
 * Where a node's link should actually go. Hypercited dots carry `data-intro`
 * — the first hypercite's URL fragment. A visitor with NO saved reading
 * position for that book lands straight on hypercited text (the system
 * introducing itself); anyone who has read it before navigates plain and the
 * reader restores their position. getSavedAnchor is the sanctioned
 * restore-flavoured read of the saved reading position.
 */
function effectiveHref(node: HTMLElement): string {
  const href = node.getAttribute('href') ?? '#';
  const intro = node.getAttribute('data-intro');
  if (!intro || href.includes('#')) return href;
  const book = decodeURIComponent(href.replace(/^\//, ''));
  if (getSavedAnchor(book)) return href;
  return `${href}#${intro}`;
}

/** Finger-sized reach for finger-blind dots: a touch can miss by ~this many
 *  CSS px and still land on the nearest node. */
const TAP_ASSIST_RADIUS = 28;

/**
 * The nearest node to a touch point, within TAP_ASSIST_RADIUS. The dots are a
 * few rendered pixels wide (and packed at blob density), so requiring a
 * direct hit made mobile taps hopeless — same philosophy as the reader's
 * footnoteTapExtender. Works on the hero map AND the figureViewer clone
 * (both are `svg` holding a[data-map-node] anchors).
 */
function nearestMapNode(from: Element, x: number, y: number): HTMLElement | null {
  const svg = from.closest('svg');
  if (!svg || !svg.querySelector('a[data-map-node]')) return null;
  let best: HTMLElement | null = null;
  let bestDist = TAP_ASSIST_RADIUS;
  svg.querySelectorAll<SVGCircleElement>('a[data-map-node] circle').forEach((circle) => {
    const r = circle.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestDist) {
      bestDist = d;
      best = circle.closest('a[data-map-node]') as HTMLElement | null;
    }
  });
  return best;
}

function isTouch(): boolean {
  return lastPointerType === 'touch'
    || (lastPointerType === '' && !!window.matchMedia?.('(hover: none)').matches);
}

function unpin(): void {
  if (!card) return;
  pinned = false;
  card.style.pointerEvents = 'none';
  card.style.visibility = 'hidden';
}

function onPointerDown(event: PointerEvent): void {
  lastPointerType = event.pointerType;
}

function onPointerOver(event: PointerEvent): void {
  if (pinned || event.pointerType === 'touch') return;
  const node = mapNodeFrom(event.target);
  if (!node) return;
  const el = ensureCard();
  fillCard(el, node, false);
  el.style.visibility = 'visible';
  placeCard(el, event.clientX, event.clientY);
}

function onPointerMove(event: PointerEvent): void {
  if (pinned || !card || card.style.visibility !== 'visible') return;
  if (!mapNodeFrom(event.target)) {
    card.style.visibility = 'hidden';
    return;
  }
  placeCard(card, event.clientX, event.clientY);
}

function onPointerOut(event: PointerEvent): void {
  if (pinned || !card) return;
  const leaving = mapNodeFrom(event.target);
  const entering = mapNodeFrom(event.relatedTarget);
  if (leaving && leaving !== entering) {
    card.style.visibility = 'hidden';
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The hypercite glyph (the reader's ↗-mint button icon, viewBox 0 0 36 36). */
const HYPERCITE_ICON_PATHS = [
  'M17.71,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0ZM23.32,24.31h-4.82v-3.71c0-1.36.28-2.44.85-3.23.57-.79,1.54-1.49,2.92-2.09l1.04,1.97c-.85.4-1.44.8-1.76,1.19-.32.39-.51.86-.54,1.4h2.3v4.47h0Z',
  'M30.34,2.51h-13.47c-2.97,0-5.39,2.42-5.39,5.39-2.97,0-5.39,2.42-5.39,5.39v13.47c0,2.97,2.42,5.39,5.39,5.39h13.47c2.97,0,5.39-2.42,5.39-5.39,2.97,0,5.39-2.42,5.39-5.39V7.9c0-2.97-2.42-5.39-5.39-5.39ZM27.65,26.76c0,1.49-1.21,2.69-2.69,2.69h-13.47c-1.49,0-2.69-1.21-2.69-2.69v-13.47c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47ZM33.04,21.37c0,1.49-1.21,2.69-2.69,2.69v-10.78c0-2.97-2.42-5.39-5.39-5.39h-10.78c0-1.49,1.21-2.69,2.69-2.69h13.47c1.49,0,2.69,1.21,2.69,2.69v13.47Z',
];

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Dress the download clone as shareable art: the brand lava gradient behind
 * everything, breathing room, and a bottom-left caption — hypercite glyph +
 * the journal's name. Runs on a detached clone (figureViewer's
 * decorateDownload seam); the on-screen figure never sees any of this.
 */
function decorateDownload(clone: SVGSVGElement): void {
  const vb = clone.viewBox.baseVal;
  if (!vb || !vb.width) return;

  const margin = vb.width * 0.07;
  const captionBand = vb.width * 0.1;
  const x = vb.x - margin;
  const y = vb.y - margin;
  const w = vb.width + 2 * margin;
  const h = vb.height + 2 * margin + captionBand;
  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  clone.style.background = ''; // the gradient rect IS the background

  // Brand lava gradient (the homepage lamp's palette), SVG-native so it
  // survives serialization and canvas rasterization.
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: 'jhm-dl-grad', x1: '0', y1: '0', x2: '0.35', y2: '1' });
  ([['0', '#ee4b96'], ['0.3', '#e8639a'], ['0.65', '#ef8d34'], ['1', '#4eacae']] as const)
    .forEach(([offset, color]) => grad.appendChild(svgEl('stop', { offset, 'stop-color': color })));
  defs.appendChild(grad);
  const backdrop = svgEl('rect', {
    x: String(x), y: String(y), width: String(w), height: String(h), fill: 'url(#jhm-dl-grad)',
  });
  clone.insertBefore(backdrop, clone.firstChild);
  clone.insertBefore(defs, backdrop);

  // Bottom-left caption: glyph + journal name, in the map's ink.
  const journal = (clone.getAttribute('aria-label') ?? '').replace(/^Hypercite network of /, '');
  const glyph = captionBand * 0.52;
  const gx = x + margin * 0.75;
  const gy = y + h - margin * 0.55 - glyph;
  const icon = svgEl('g', {
    transform: `translate(${gx}, ${gy}) scale(${glyph / 36})`,
    fill: '#221F20',
  });
  HYPERCITE_ICON_PATHS.forEach((d) => icon.appendChild(svgEl('path', { d })));
  clone.appendChild(icon);

  if (journal) {
    const label = svgEl('text', {
      x: String(gx + glyph * 1.25),
      y: String(gy + glyph * 0.72),
      'font-family': 'sans-serif',
      'font-weight': '600',
      'font-size': String(glyph * 0.52),
      fill: '#221F20',
    });
    label.textContent = journal;
    clone.appendChild(label);
  }
}

/** Capture-phase: must beat LinkNavigationHandler + the anchor's default. */
function onClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;

  if (target?.closest('#journal-map-expand')) {
    const svg = document.querySelector<SVGSVGElement>('.journal-hypercite-map svg');
    if (!svg) return;
    void import('../../utilities/figureViewer').then(({ openFigureViewer }) => {
      openFigureViewer(svg, {
        title: svg.getAttribute('aria-label') ?? 'Hypercite network',
        downloadName: 'hypercite-network.svg',
        // Downloads become shareable art: lava gradient + glyph + journal
        // name (decorateDownload); background is just the JPEG's base fill
        // under the gradient. On screen, glass all the way.
        background: '#f2ede4',
        decorateDownload,
        glassOverlay: true,
        // Square figure — open with the whole network visible, not fit-width.
        fit: 'contain',
      });
    });
    return;
  }

  let node = mapNodeFrom(target);
  if (!node && isTouch() && target) {
    // Missed-by-a-little touch: snap to the nearest dot in reach.
    node = nearestMapNode(target, event.clientX, event.clientY);
  }
  if (node && !isTouch()) {
    // Desktop click navigates — retarget to the intro deep-link (first-time
    // visitors only) by rewriting the href BEFORE the default/SPA navigation
    // reads it. Idempotent: effectiveHref keeps an existing hash.
    node.setAttribute('href', effectiveHref(node));
    return; // let the click proceed normally
  }

  if (node && isTouch()) {
    // Tap = inspect, not navigate (labels only live in the card). The pinned
    // card's title link does the navigating.
    event.preventDefault();
    event.stopPropagation();
    const el = ensureCard();
    fillCard(el, node, true);
    pinned = true;
    el.style.pointerEvents = 'auto';
    el.style.visibility = 'visible';
    placeCard(el, event.clientX, event.clientY);
    return;
  }

  if (pinned) {
    if (target?.closest(`#${CARD_ID} a`)) {
      unpin(); // let the link navigate (SPA or full), card gone either way
      return;
    }
    if (!target?.closest(`#${CARD_ID}`)) {
      unpin();
    }
  }
}

/** Create-once + reset: document delegation survives SPA navigation. */
export function initJournalHyperciteMap(): void {
  card = ensureCard();
  unpin();
  if (wired) return;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerover', onPointerOver);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerout', onPointerOut);
  document.addEventListener('click', onClick, true);
  wired = true;
}

export function destroyJournalHyperciteMap(): void {
  if (wired) {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerover', onPointerOver);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerout', onPointerOut);
    document.removeEventListener('click', onClick, true);
    wired = false;
  }
  pinned = false;
  card?.remove();
  card = null;
}
