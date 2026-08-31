/**
 * Hover card for the journal hero's hypercite network (the inline SVG from
 * app/Services/JournalHarvest/JournalHyperciteMap). Each node is an
 * `<a data-map-node …>` carrying title/author/year/connections — hovering one
 * shows a small fixed-position card; clicking still just follows the link.
 *
 * Same pattern as graphRenderer's citation card: one singleton div, inline
 * styles (no reader.css churn, and no overlay-inventory surface — it is a
 * tooltip, not a modal), document-level delegation so it survives SPA
 * navigation and works however many maps are on the page. Touch devices skip
 * the card entirely — a tap navigates, and a card under a lifted finger is
 * noise.
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

function fillCard(el: HTMLDivElement, node: HTMLElement): void {
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

  const title = document.createElement('div');
  title.textContent = node.getAttribute('data-title') ?? '';
  title.style.fontWeight = '600';
  el.appendChild(title);

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

function onPointerOver(event: PointerEvent): void {
  if (event.pointerType === 'touch') return; // tap = navigate, no card
  const node = mapNodeFrom(event.target);
  if (!node) return;
  const el = ensureCard();
  fillCard(el, node);
  el.style.visibility = 'visible';
  placeCard(el, event.clientX, event.clientY);
}

function onPointerMove(event: PointerEvent): void {
  if (!card || card.style.visibility !== 'visible') return;
  if (!mapNodeFrom(event.target)) {
    card.style.visibility = 'hidden';
    return;
  }
  placeCard(card, event.clientX, event.clientY);
}

function onPointerOut(event: PointerEvent): void {
  if (!card) return;
  const leaving = mapNodeFrom(event.target);
  const entering = mapNodeFrom(event.relatedTarget);
  if (leaving && leaving !== entering) {
    card.style.visibility = 'hidden';
  }
}

/** Create-once + reset: document delegation survives SPA navigation. */
export function initJournalHyperciteMap(): void {
  card = ensureCard();
  card.style.visibility = 'hidden';
  if (wired) return;
  document.addEventListener('pointerover', onPointerOver);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerout', onPointerOut);
  wired = true;
}

export function destroyJournalHyperciteMap(): void {
  if (wired) {
    document.removeEventListener('pointerover', onPointerOver);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerout', onPointerOut);
    wired = false;
  }
  card?.remove();
  card = null;
}
