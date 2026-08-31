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
    zIndex: '9999',
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
    link.href = node.getAttribute('href') ?? '#';
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
        // The map draws in the hero's dark ink — figureViewer's default dark
        // backdrop would swallow it; glass lets the lava lamp glow through.
        background: '#f2ede4',
        glassOverlay: true,
      });
    });
    return;
  }

  const node = mapNodeFrom(target);
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
