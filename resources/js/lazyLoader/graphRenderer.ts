/**
 * Render the harvest knowledge-network tree from the data table the yield
 * report stores (YieldReportBook::networkTableInner — the sanitizer blocks
 * <svg> in node content, so the SVG is built here at render time). Same
 * contract as chartRenderer: find marker tables, replace with SVG.
 *
 * The tree grows LEFT → RIGHT: depth is a column, and a work's imported
 * sources stack DOWNWARD in the next column (a book with 90 sources is one
 * tall column). Vertical overflow just scrolls; the old horizontal fan
 * squashed every leaf into a fixed 900px and became an unreadable dot-sea.
 *
 * COLUMN ORDER IS THE BACKEND CONTRACT (keep in sync with YieldReportBook):
 * id | parent | depth | status | title | year | book | cited_by | link |
 * author | journal | publisher | type | reason
 * (the last five feed the hover citation card; legacy 9-column tables parse
 * fine — missing cells read as ''.)
 */

import { verbose } from '../utilities/logger';

interface HarvestNode {
  id: string;
  parent: string; // root book id, or a parent's held-version book id (depth ≥ 2)
  status: string;
  title: string;
  year: string;
  book: string; // held version book id ('' when not harvested)
  cited: number;
  link: string; // best external URL ('' when none)
  author: string;
  journal: string;
  publisher: string;
  type: string;
  reason: string;
  children: HarvestNode[];
  // assigned by layout
  x: number;
  y: number;
  r: number;
}

const STATUS_COLORS: Record<string, string> = {
  root: 'var(--color-text, #e0e0e0)',
  assigned: '#27ae60',
  assigned_existing: '#27ae60',
  skipped_over_budget: '#f1c40f',
  deferred: '#e67e22',
  // everything else (fetch_failed / ocr_failed / error / …) falls back to red
};
const FAIL_COLOR = '#e74c3c';

// The tree grows LEFT → RIGHT: each depth level is a vertical COLUMN, and a
// work's imported sources stack DOWNWARD in the next column. A book with 90
// sources is one tall column (the report just scrolls — vertical overflow is
// fine; the old horizontal fan squashed 90 dots into 900px and was unreadable).
const COLUMN_WIDTH = 190; // horizontal gap between depth levels (room for a leaf's title)
const NODE_GAP = 22; // vertical gap between stacked siblings / leaves
const LABEL_MAX_NODES = 400; // above this, drop inline titles (DOM weight) — hover still works
const LABEL_CHARS = 30; // inline title truncation
const LABEL_ROOM = 150; // width reserved to the right for the last column's titles
const PAD = 24;

function parseRows(table: Element): { root: HarvestNode | null; nodes: HarvestNode[] } {
  const mk = (cells: string[]): HarvestNode => ({
    id: cells[0] ?? '',
    parent: cells[1] ?? '',
    status: cells[3] || 'error',
    title: cells[4] ?? '',
    year: cells[5] ?? '',
    book: cells[6] ?? '',
    cited: parseInt(cells[7] ?? '', 10) || 0,
    link: cells[8] ?? '',
    author: cells[9] ?? '',
    journal: cells[10] ?? '',
    publisher: cells[11] ?? '',
    type: cells[12] ?? '',
    reason: cells[13] ?? '',
    children: [],
    x: 0,
    y: 0,
    r: 0,
  });

  let root: HarvestNode | null = null;
  const nodes: HarvestNode[] = [];
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td')).map(
      (td) => td.textContent?.trim() ?? '',
    );
    const node = mk(cells);
    if (!node.id) return; // malformed row — skip, never throw
    if (node.status === 'root' && !root) {
      root = node;
    } else {
      nodes.push(node);
    }
  });
  return { root, nodes };
}

/**
 * Wire children and reparent orphans. A depth ≥ 2 entry's parent is its
 * citing work's HELD BOOK id, so parents resolve via each entry's `book`
 * field; anything unresolvable (legacy data, parent outside this union)
 * fans from the root.
 */
function buildTree(root: HarvestNode, nodes: HarvestNode[]): void {
  const byBook = new Map<string, HarvestNode>();
  nodes.forEach((n) => {
    if (n.book) byBook.set(n.book, n);
  });
  nodes.forEach((n) => {
    const parent =
      n.parent && n.parent !== root.id ? byBook.get(n.parent) : undefined;
    // Guard self-citation (a work whose held book equals its parent).
    (parent && parent !== n ? parent : root).children.push(n);
  });
}

/**
 * Layered tidy tree, rotated: depth → x column, leaves get sequential y slots
 * (stacked downward), parents center vertically over their children. No
 * crossings by construction. Returns the number of leaf slots used (the tree's
 * HEIGHT in rows) — the tree grows downward, not rightward.
 */
function layoutTree(root: HarvestNode): number {
  let nextSlot = 0;
  const place = (node: HarvestNode, depth: number): void => {
    node.x = PAD + depth * COLUMN_WIDTH;
    node.r = Math.min(12, 4 + 2 * Math.log10(1 + node.cited));
    if (node.children.length === 0) {
      node.y = PAD + nextSlot * NODE_GAP;
      nextSlot += 1;
      return;
    }
    node.children.forEach((c) => place(c, depth + 1));
    const first = node.children[0]!; // length checked above
    const last = node.children[node.children.length - 1]!;
    node.y = (first.y + last.y) / 2;
  };
  place(root, 0);
  return nextSlot;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function nodeHref(node: HarvestNode): string | null {
  if (node.status === 'root' || node.book) return `/${node.book}`;
  return node.link || null;
}

const STATUS_LABELS: Record<string, string> = {
  root: 'Root book',
  assigned: 'Harvested',
  assigned_existing: 'Harvested (already held)',
  skipped_over_budget: 'Not yet harvested (spending limit)',
  deferred: 'Found but unverified',
};

/** Lazily created singleton hover card (shared by every network SVG on the page). */
function hoverCard(): HTMLElement {
  let card = document.getElementById('harvest-network-card');
  if (card) return card;
  card = document.createElement('div');
  card.id = 'harvest-network-card';
  // Inline styles: this floats on the READER page — no reader.css churn for
  // one element, and no overlay-inventory surface (it's a pointer tooltip).
  Object.assign(card.style, {
    position: 'fixed',
    zIndex: '50',
    maxWidth: '24em',
    padding: '0.6em 0.8em',
    borderRadius: '6px',
    background: 'rgba(0, 0, 0, 0.85)',
    color: '#e8e8e8',
    font: '0.8rem/1.45 sans-serif',
    pointerEvents: 'none',
    visibility: 'hidden',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(card);
  return card;
}

/** "Author, "Title"/Title, venue (Year)." + status line — mirrors the 3D panel. */
function fillCard(card: HTMLElement, node: HarvestNode): void {
  card.innerHTML = '';

  const citation = document.createElement('div');
  citation.appendChild(document.createTextNode(node.author ? `${node.author}, ` : ''));
  const isArticle = /article|chapter|paper|incollection/i.test(node.type);
  if (isArticle && node.title) {
    citation.appendChild(document.createTextNode(`“${node.title}”`));
  } else {
    const i = document.createElement('i');
    i.textContent = node.title;
    citation.appendChild(i);
  }
  const venue = node.journal || node.publisher;
  if (venue) citation.appendChild(document.createTextNode(`, ${venue}`));
  if (node.year) citation.appendChild(document.createTextNode(` (${node.year})`));
  citation.appendChild(document.createTextNode('.'));
  card.appendChild(citation);

  const status = document.createElement('div');
  status.style.opacity = '0.75';
  status.style.marginTop = '0.25em';
  const bits = [STATUS_LABELS[node.status] ?? 'Failed to harvest'];
  if (node.reason) bits.push(node.reason);
  if (node.cited) bits.push(`cited by ${node.cited.toLocaleString()}`);
  status.textContent = bits.join(' · ');
  card.appendChild(status);
}

// Touch has no hover, so the card PINS: tapping a node shows the card with
// the node's links INSIDE it (navigation moves there), tapping outside closes
// it. One shared flag — only one card exists.
let cardPinned = false;

function unpinCard(): void {
  cardPinned = false;
  const card = hoverCard();
  card.style.visibility = 'hidden';
  card.style.pointerEvents = 'none';
}

function pinCard(node: HarvestNode, x: number, y: number): void {
  const card = hoverCard();
  fillCard(card, node);

  // The links live in the card on touch (tap-through target).
  const links = document.createElement('div');
  links.style.marginTop = '0.45em';
  const mk = (href: string, label: string, external: boolean): HTMLAnchorElement => {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    a.style.color = '#6fd3c7';
    a.style.marginRight = '1.2em';
    if (external) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    return a;
  };
  if (node.status === 'root' || node.book) {
    links.appendChild(mk(`/${node.book}`, node.status === 'root' ? 'Open the book →' : 'Read in Hyperlit →', false));
  }
  if (node.link) {
    links.appendChild(mk(node.link, 'External source ↗', true));
  }
  if (links.childElementCount) card.appendChild(links);

  card.style.left = `${Math.min(x, window.innerWidth - 300)}px`;
  card.style.top = `${Math.min(y + 10, window.innerHeight - 120)}px`;
  card.style.pointerEvents = 'auto'; // links must be tappable
  card.style.visibility = 'visible';
  cardPinned = true;

  // Tap anywhere outside the card (and not on another node) closes it.
  const dismiss = (event: Event): void => {
    const t = event.target as Element;
    if (t.closest?.('#harvest-network-card') || t.closest?.('circle')) return;
    unpinCard();
    document.removeEventListener('pointerdown', dismiss, true);
  };
  document.addEventListener('pointerdown', dismiss, true);
}

/** Delegated wiring: hover → citation card at the cursor; touch tap → pinned card. */
function attachHoverCard(svg: SVGSVGElement, byCircle: Map<Element, HarvestNode>): void {
  const move = (event: MouseEvent): void => {
    if (cardPinned) return; // a pinned (tapped) card owns the surface
    const circle = (event.target as Element).closest?.('circle');
    const node = circle ? byCircle.get(circle) : undefined;
    const card = hoverCard();
    if (!node) {
      card.style.visibility = 'hidden';
      return;
    }
    fillCard(card, node);
    card.style.left = `${Math.min(event.clientX + 14, window.innerWidth - 300)}px`;
    card.style.top = `${event.clientY + 14}px`;
    card.style.visibility = 'visible';
  };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', () => {
    if (!cardPinned) hoverCard().style.visibility = 'hidden';
  });

  // Touch: tap = pin the card, don't navigate (the anchor's link moves into
  // the card). Desktop mouse clicks keep native/SPA anchor navigation.
  let lastPointerType = '';
  svg.addEventListener('pointerdown', (event) => {
    lastPointerType = (event as PointerEvent).pointerType || '';
  });
  svg.addEventListener('click', (event) => {
    const circle = (event.target as Element).closest?.('circle');
    const node = circle ? byCircle.get(circle) : undefined;
    if (!node) return;
    const isTouch = lastPointerType === 'touch'
      || (lastPointerType === '' && !!window.matchMedia?.('(hover: none)').matches);
    if (!isTouch) return;
    event.preventDefault();   // the wrapping <a> must not navigate on tap
    event.stopPropagation();  // nor be SPA-routed by LinkNavigationHandler
    pinCard(node, event.clientX, event.clientY);
  });
}

function buildForkTreeSvg(root: HarvestNode, nodes: HarvestNode[]): SVGSVGElement {
  layoutTree(root);
  const all = [root, ...nodes];
  const showLabels = all.length <= LABEL_MAX_NODES;

  const depthMaxX = Math.max(0, ...all.map((n) => n.x));
  const yMax = Math.max(0, ...all.map((n) => n.y));
  const width = depthMaxX + (showLabels ? LABEL_ROOM : PAD) + PAD;
  const height = yMax + PAD;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': 'Harvest knowledge network',
  });
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.maxWidth = `${Math.min(width, 960)}px`;
  svg.style.height = 'auto';
  svg.style.margin = '0.5em auto';

  const byCircle = new Map<Element, HarvestNode>(); // hover-card lookup

  // Edges first (under the nodes): parent-right → child-left beziers, so the
  // network reads as a left-to-right cascade.
  const walkEdges = (parent: HarvestNode): void => {
    parent.children.forEach((child) => {
      const midX = (parent.x + child.x) / 2;
      svg.appendChild(
        svgEl('path', {
          d: `M ${parent.x + parent.r} ${parent.y} C ${midX} ${parent.y}, ${midX} ${child.y}, ${child.x - child.r} ${child.y}`,
          fill: 'none',
          stroke: 'var(--color-text-faint, #666)',
          'stroke-width': '1',
        }),
      );
      walkEdges(child);
    });
  };
  walkEdges(root);

  all.forEach((node) => {
    const circle = svgEl('circle', {
      cx: String(node.x),
      cy: String(node.y),
      r: String(node.r),
      fill: STATUS_COLORS[node.status] ?? FAIL_COLOR,
    });
    // Hover shows the HTML citation card (attachHoverCard) — no SVG <title>,
    // whose native tooltip would double up. aria-label keeps the anchor named.
    byCircle.set(circle, node);

    const href = nodeHref(node);
    let mount: SVGElement = circle;
    if (href) {
      // chunkRender's tabindex="-1" pass ran before this renderer, so set it
      // here ourselves (keyboard model: Tab never enters content).
      const a = svgEl('a', { href, tabindex: '-1' });
      a.setAttribute('aria-label',
        node.title + (node.year ? ` (${node.year})` : '') + ` — ${node.status}`);
      if (!href.startsWith('/')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      }
      a.appendChild(circle);
      mount = a;
    }
    svg.appendChild(mount);

    // Titles read inline (no click needed): leaves label to the RIGHT (their
    // column has open space there); the root labels ABOVE (nothing to its
    // left). Internal nodes are covered by their children's column + hover.
    if (showLabels && node.title) {
      const isLeaf = node.children.length === 0;
      if (isLeaf || node === root) {
        const label = svgEl('text', {
          x: String(isLeaf ? node.x + node.r + 6 : node.x - node.r),
          y: String(isLeaf ? node.y + 3 : node.y - node.r - 5),
          'text-anchor': 'start',
          fill: 'var(--color-text, #e0e0e0)',
          'font-size': isLeaf ? '9' : '11',
          'font-family': 'sans-serif',
        });
        label.textContent =
          node.title.length > LABEL_CHARS ? node.title.slice(0, LABEL_CHARS - 1) + '…' : node.title;
        svg.appendChild(label);
      }
    }
  });

  attachHoverCard(svg, byCircle);
  return svg;
}

/** Button-styled action (real button or link) for the row under the network SVG. */
function networkAction(label: string, ariaLabel: string, href?: string): HTMLElement {
  const node = document.createElement(href ? 'a' : 'button');
  Object.assign(node.style, {
    font: '0.85rem/1 sans-serif',
    padding: '0.5em 0.9em',
    border: '1px solid var(--color-text-faint, #666)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--color-text, #e0e0e0)',
    textDecoration: 'none',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);
  node.textContent = label;
  node.setAttribute('aria-label', ariaLabel);
  // Content keyboard model: Tab never enters content (same as the SVG anchors).
  node.setAttribute('tabindex', '-1');
  if (node instanceof HTMLAnchorElement && href) node.href = href;
  if (node instanceof HTMLButtonElement) node.type = 'button';
  return node;
}

/** The SVG + its action row (expand / 3D), swapped in for the marker table. */
function networkFigure(root: HarvestNode, nodes: HarvestNode[]): HTMLElement {
  const wrap = document.createElement('div');
  const svg = buildForkTreeSvg(root, nodes);
  wrap.appendChild(svg);

  const actions = document.createElement('div');
  Object.assign(actions.style, {
    display: 'flex',
    gap: '10px',
    justifyContent: 'center',
    margin: '0.25em 0 0.75em',
  } satisfies Partial<CSSStyleDeclaration>);

  const expand = networkAction('⤢ Expand diagram', 'Expand the knowledge-network diagram');
  expand.addEventListener('click', () => {
    // Lazy: the viewer only loads if someone actually expands a figure.
    void import('../utilities/figureViewer').then(({ openFigureViewer }) => {
      openFigureViewer(svg, {
        title: `Knowledge network — ${root.title}`,
        downloadName: `knowledge-network-${root.id}.svg`,
      });
    });
  });
  actions.appendChild(expand);

  actions.appendChild(networkAction(
    'See in 3D network →',
    'Open this knowledge network in the 3D docuverse',
    `/3d/${encodeURIComponent(root.id)}?layers=hypercite,citation_verified,citation_auto`,
  ));

  wrap.appendChild(actions);
  return wrap;
}

/** Find harvest-network tables in a rendered chunk and swap each for its SVG. */
export function renderHarvestNetworks(container: Element): void {
  const tables = container.querySelectorAll('table[data-chart="harvest-network"]');
  tables.forEach((table) => {
    const { root, nodes } = parseRows(table);
    if (!root) {
      // No root row — leave the table as its own fallback rendering.
      verbose.content('harvest-network table without a root row — left as-is', 'graphRenderer');
      return;
    }
    buildTree(root, nodes);
    verbose.content(`rendering harvest network: ${nodes.length + 1} nodes`, 'graphRenderer');
    table.replaceWith(networkFigure(root, nodes));
  });
}
