/**
 * citationPathRenderer — "how this citation was checked", rendered for a reader.
 *
 * The review report stores a sanitizer-safe `<table data-chart="citation-path">` per claim
 * (built by ClaimMarkdownFormatter::buildPathTableMd from CitationPath::summarize — one row per
 * reviewer QUESTION, narrating what happened, with GitHub links to the code that did it). This
 * swaps the table for a compact `<details>` block: a chip strip that shows the outcome at a
 * glance, opening into the narration. With JS off the table itself reads as the story — same
 * contract as chartRenderer / graphRenderer.
 *
 * DOM + inline styles with CSS-var fallbacks (the house pattern here): the block lives inside
 * stored book content rendered on any theme, so it inherits the reader's tokens rather than
 * shipping its own stylesheet.
 */

const KIND_COLORS: Record<string, string> = {
  resolved: '#27ae60',    // matches the verdict chart's "Confirmed" green
  nomatch: '#8b93a7',
  routed: '#5eb0ef',
  evidence: '#e0a44b',
  notrecorded: '#e67e22',
};

const KIND_CHIP_LABEL: Record<string, string> = {
  resolved: 'identified',
  nomatch: 'not identified',
  routed: 'read',
  evidence: 'evidence',
  notrecorded: 'not recorded',
};

interface PathRow {
  band: string;
  kind: string;
  question: string;
  text: string;
  link: HTMLAnchorElement | null;
}

function parseRows(table: HTMLTableElement): PathRow[] {
  const rows: PathRow[] = [];
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const cells = tr.querySelectorAll('td');
    const qCell = cells.item(0);
    const aCell = cells.item(1);
    if (!qCell || !aCell) return;
    const link = aCell.querySelector('a');
    // Clone the narration cell and drop the link so text and link render separately.
    const textCell = aCell.cloneNode(true) as HTMLElement;
    textCell.querySelector('a')?.remove();
    rows.push({
      band: tr.getAttribute('data-band') ?? '',
      kind: tr.getAttribute('data-kind') ?? '',
      question: qCell.textContent ?? '',
      text: (textCell.textContent ?? '').trim(),
      link: link ? (link.cloneNode(true) as HTMLAnchorElement) : null,
    });
  });
  return rows;
}

function chip(kind: string): HTMLElement {
  const color = KIND_COLORS[kind] ?? '#8b93a7';
  const el = document.createElement('span');
  el.textContent = KIND_CHIP_LABEL[kind] ?? kind;
  el.style.cssText = `display:inline-block;font-size:0.72em;padding:0.05em 0.6em;border-radius:9px;`
    + `border:1px solid ${color};color:${color};margin-left:0.45em;vertical-align:middle;`;
  return el;
}

function buildBlock(rows: PathRow[], recorded: boolean): HTMLElement {
  const details = document.createElement('details');
  details.className = 'citation-path';
  details.style.cssText = 'margin:0.5em 0;font-size:0.92em;border:1px solid '
    + 'var(--color-border, rgba(128,128,128,0.35));border-radius:7px;padding:0.35em 0.7em;';

  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;color:var(--color-text-muted, #8b93a7);';
  summary.append('How this was checked');
  // The verdict-at-a-glance chips: the ladder outcome always; "not recorded" when it applies.
  const headline = rows.find((r) => r.kind === 'resolved') ?? rows.find((r) => r.kind === 'nomatch');
  if (headline) summary.append(chip(headline.kind));
  if (!recorded) summary.append(chip('notrecorded'));
  details.append(summary);

  for (const row of rows) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:0.45em 0 0;';
    const q = document.createElement('strong');
    q.style.cssText = `font-size:0.82em;letter-spacing:0.04em;color:${KIND_COLORS[row.kind] ?? 'inherit'};`;
    q.textContent = row.question.toUpperCase();
    const text = document.createElement('span');
    text.style.cssText = 'display:block;color:var(--color-text, inherit);';
    text.textContent = row.text;
    p.append(q, text);
    if (row.link) {
      row.link.textContent = 'see the code that did this ↗';
      row.link.style.cssText = 'font-size:0.82em;';
      text.append(' ');
      text.append(row.link);
    }
    details.append(p);
  }

  return details;
}

// ── The report-top figure: "How this review works" ───────────────────────────
// One flow chart per REPORT (not per claim): the six reviewer questions as a fork/join —
// the document's text splits into the claim branch and the citation branch, the citation
// descends through identify → read → grade, and the two meet at the verdict. Emitted by
// ReportBuilder::howThisWorksSection as a `data-chart="review-method"` marker table and
// swapped here for an SVG, same contract as the harvest network. Band colours match the
// published resolution map, because this figure is that map's one-screen summary.

const BAND_COLORS: Record<string, string> = {
  claim: '#27ae60', route: '#b07ad6', ladder: '#5eb0ef',
  acq: '#5fb3a3', grades: '#5fb3a3', join: '#27ae60',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

const bandColor = (band: string): string => BAND_COLORS[band] ?? '#888';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function svgText(x: number, y: number, text: string, size: number, fill: string, weight = 'normal', spacing = ''): SVGTextElement {
  const t = svgEl('text', { x: String(x), y: String(y), 'font-size': String(size), fill, 'font-family': 'sans-serif' });
  if (weight !== 'normal') t.setAttribute('font-weight', weight);
  if (spacing) t.setAttribute('letter-spacing', spacing);
  t.textContent = text;
  return t;
}

/** Two-line wrap for the band subtitles — measured by characters, good enough at 10px. */
function wrap2(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const cut = text.lastIndexOf(' ', width);
  const head = text.slice(0, cut > 0 ? cut : width);
  let tail = text.slice(head.length).trim();
  if (tail.length > width) tail = tail.slice(0, width - 1) + '…';
  return [head, tail];
}

/** An SVG hyperlink — <a> works inside SVG in every modern browser. */
function svgLink(href: string, child: SVGElement, label: string): SVGAElement {
  const a = svgEl('a', { href, target: '_blank', rel: 'noopener' });
  a.setAttribute('aria-label', label);
  (a as unknown as HTMLElement).style.cursor = 'pointer';
  a.appendChild(child);
  return a;
}

interface MethodBand { question: string; sub: string; codeUrl: string | null }
interface MethodStep { title: string; href: string }

const BOX_FILL = 'var(--color-background, #17191f)';

function methodBox(
  x: number, y: number, w: number, band: string, data: MethodBand,
  opts: { badge?: string; steps?: MethodStep[]; expanded?: boolean } = {},
): SVGGElement {
  const color = bandColor(band);
  const subLines = wrap2(data.sub, Math.floor(w / 5.2));
  const steps = opts.steps ?? [];
  const stepsShown = opts.expanded ? steps.length : 0;
  const toggleH = steps.length > 0 ? 16 : 0;
  const h = 44 + subLines.length * 13 + toggleH + stepsShown * 15 + (stepsShown ? 6 : 0);

  const g = svgEl('g', {});
  g.appendChild(svgEl('rect', {
    x: String(x), y: String(y), width: String(w), height: String(h), rx: '9',
    fill: BOX_FILL, stroke: color, 'stroke-width': '1.4',
  }));
  g.appendChild(svgText(x + 14, y + 21, data.question.toUpperCase(), 11.5, color, '600', '0.06em'));

  // "code ↗" — the band's own home on GitHub, top-right. The ladder band links to a FOLDER of
  // fifteen wave classes: the whole reason the extraction happened.
  if (data.codeUrl) {
    const codeText = svgText(x + w - 12, y + 21, 'code ↗', 9.5, 'var(--color-text-faint, #888)');
    codeText.setAttribute('text-anchor', 'end');
    codeText.setAttribute('text-decoration', 'underline');
    g.appendChild(svgLink(data.codeUrl, codeText, `Open the code behind “${data.question}” on GitHub`));
  }

  if (opts.badge) {
    const bt = svgText(x + w - 12, y + h - 9, opts.badge, 10, 'var(--color-text, #e0e0e0)');
    bt.setAttribute('text-anchor', 'end');
    g.appendChild(bt);
  }

  let yy = y + 37;
  subLines.forEach((line) => {
    g.appendChild(svgText(x + 14, yy, line, 10, 'var(--color-text-faint, #888)'));
    yy += 13;
  });

  if (steps.length > 0) {
    // A DATA ATTRIBUTE, not a listener: the figure viewer shows a CLONE of this svg and
    // cloneNode drops listeners — the first ship's expand/collapse was dead inside the viewer.
    // One delegated listener on the (stable) svg root handles every toggle, original and clone.
    const toggle = svgText(x + 14, yy + 3, `${opts.expanded ? '▾' : '▸'} ${steps.length} steps — click to ${opts.expanded ? 'collapse' : 'expand'}`,
      9.5, color);
    toggle.setAttribute('data-method-toggle', band);
    // Opts OUT of the figure viewer's grab-to-pan: its setPointerCapture retargets clicks to
    // the scroller, and only elements declaring themselves interactive are exempt.
    toggle.setAttribute('data-figure-interactive', '');
    (toggle as unknown as HTMLElement).style.cursor = 'pointer';
    g.appendChild(toggle);
    yy += 16;

    if (opts.expanded) {
      for (const step of steps) {
        const row = svgText(x + 26, yy + 4, `· ${step.title.slice(0, 46)}`, 9.5, 'var(--color-text, #e0e0e0)');
        g.appendChild(row);
        const link = svgText(x + w - 12, yy + 4, 'code ↗', 8.5, 'var(--color-text-faint, #888)');
        link.setAttribute('text-anchor', 'end');
        link.setAttribute('text-decoration', 'underline');
        g.appendChild(svgLink(step.href, link, `Open “${step.title}” on GitHub`));
        yy += 15;
      }
    }
  }

  (g as unknown as { boxH: number }).boxH = h;
  return g;
}

function methodEdge(x1: number, y1: number, x2: number, y2: number, color: string, dash = '', opacity = 0.7): SVGPathElement {
  const my = (y1 + y2) / 2;
  const p = svgEl('path', {
    d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`,
    fill: 'none', stroke: color, 'stroke-width': '1.4', opacity: String(opacity),
  });
  if (dash) p.setAttribute('stroke-dasharray', dash);
  return p;
}

/** The verdict fan's hues — the same ramp the summary bar chart uses, so they read as one. */
const VERDICT_COLORS: Record<string, string> = {
  'Broken Sources': '#e06a9a',
  'Unverified Sources': '#9b59b6',
  'Rejected': '#e74c3c',
  'Unlikely': '#e67e22',
  'Plausible': '#f1c40f',
  'Likely': '#a3d977',
  'Confirmed': '#27ae60',
};

interface MethodData {
  bands: Map<string, MethodBand>;
  steps: Map<string, MethodStep[]>;
  meta: Map<string, string>;
  verdicts: Array<{ label: string; count: number }>;
}

function renderMethodInto(svg: SVGSVGElement, data: MethodData, expanded: Set<string>): void {
  const W = 740;
  const faint = 'var(--color-text-faint, #888)';
  const { bands, steps, meta, verdicts } = data;
  const get = (id: string): MethodBand => bands.get(id) ?? { question: id, sub: '', codeUrl: null };
  const box = (x: number, y: number, w: number, id: string, badge?: string) => methodBox(x, y, w, id, get(id), {
    badge,
    steps: steps.get(id) ?? [],
    expanded: expanded.has(id),
  });

  // Two layers: every edge under every box. Boxes carry an opaque page-background fill, so a
  // curve routed behind one is OCCLUDED instead of striking through its label (the verdict fan
  // used to cut straight across "Unverified · 73").
  const edges: SVGElement[] = [];
  const nodes: SVGElement[] = [];

  // The document's text — the fork's origin. The subtitle corrects the picture a lone title
  // paints: the review never sends the whole body anywhere — it reads SEGMENTS, the text
  // around each detected in-text citation and footnote, hunting citation ↔ truth-claim pairs.
  nodes.push(svgEl('rect', { x: '160', y: '8', width: '420', height: '66', rx: '9', fill: BOX_FILL, stroke: faint }));
  const doc = svgText(370, 28, 'THE DOCUMENT’S TEXT', 12, 'var(--color-text, #e0e0e0)', '600', '0.05em');
  doc.setAttribute('text-anchor', 'middle');
  nodes.push(doc);
  const docSub = [
    'the text around each detected in-text citation and footnote',
    'is examined for citation ↔ truth-claim pairs',
  ];
  docSub.forEach((line, i) => {
    const s = svgText(370, 45 + i * 13, line, 9.5, faint);
    s.setAttribute('text-anchor', 'middle');
    nodes.push(s);
  });

  // Left branch: the claim (runs the page's height, joins at the bottom).
  const claimBox = box(12, 120, 330, 'claim', meta.has('claims') ? `${meta.get('claims')} claims` : undefined);
  nodes.push(claimBox);
  const claimH = (claimBox as unknown as { boxH: number }).boxH;

  // Right branch: the citation's descent.
  const colX = 388, colW = 340;
  let y = 120;
  const badges: Record<string, string | undefined> = {
    route: meta.has('citations') ? `${meta.get('citations')} citations` : undefined,
    ladder: meta.has('identified') ? `${meta.get('identified')} identified · ${meta.get('not_found')} not found` : undefined,
  };
  for (const id of ['route', 'ladder', 'acq', 'grades'] as const) {
    const b = box(colX, y, colW, id, badges[id]);
    nodes.push(b);
    const h = (b as unknown as { boxH: number }).boxH;
    if (id !== 'grades') {
      edges.push(methodEdge(colX + colW / 2, y + h, colX + colW / 2, y + h + 26, bandColor(id)));
    }
    y += h + 26;
  }

  // The join, then the verdict.
  const joinY = Math.max(y, 120 + claimH + 40) + 34;
  const joinBox = box(205, joinY, 330, 'join');
  nodes.push(joinBox);
  const joinH = (joinBox as unknown as { boxH: number }).boxH;

  const verdictY = joinY + joinH + 34;
  nodes.push(svgEl('rect', { x: '295', y: String(verdictY), width: '150', height: '38', rx: '19', fill: BOX_FILL, stroke: bandColor('join'), 'stroke-width': '1.6' }));
  const v = svgText(370, verdictY + 24, 'VERDICT', 12, bandColor('join'), '600', '0.08em');
  v.setAttribute('text-anchor', 'middle');
  nodes.push(v);

  // The verdict FAN: every outcome a claim can land on, spread beneath the pill with this
  // review's own counts — the same buckets (and hues) as the summary bar chart above.
  const shown = verdicts.filter((x) => x.count > 0);
  let fanBottom = verdictY + 38;
  if (shown.length > 0) {
    const fanY = verdictY + 92;
    const pillW = Math.min(170, Math.floor((W - 24) / Math.min(shown.length, 4)) - 10);
    const perRow = Math.max(1, Math.floor((W - 24) / (pillW + 10)));
    shown.forEach((item, i) => {
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, shown.length - row * perRow);
      const rowW = inRow * (pillW + 10) - 10;
      const px = (W - rowW) / 2 + (i % perRow) * (pillW + 10);
      const py = fanY + row * 46;
      const color = VERDICT_COLORS[item.label] ?? '#888';
      edges.push(methodEdge(370, verdictY + 38, px + pillW / 2, py + 15, color, '', 0.45));
      nodes.push(svgEl('rect', { x: String(px), y: String(py), width: String(pillW), height: '30', rx: '15', fill: BOX_FILL, stroke: color, 'stroke-width': '1.4' }));
      const label = svgText(px + pillW / 2, py + 19, `${item.label.replace(' Sources', '')} · ${item.count}`, 10.5, color, '600');
      label.setAttribute('text-anchor', 'middle');
      nodes.push(label);
      fanBottom = Math.max(fanBottom, py + 30);
    });
  }

  // Edges: the fork, the join, the spine's tail — all behind the boxes.
  edges.push(methodEdge(300, 74, 177, 120, faint));                          // doc → claim
  edges.push(methodEdge(440, 74, colX + colW / 2, 120, faint));              // doc → citation
  edges.push(methodEdge(177, 120 + claimH, 300, joinY, bandColor('claim'), '', 0.45)); // claim → join
  edges.push(methodEdge(colX + colW / 2, y, 440, joinY, bandColor('acq'), '', 0.45)); // grades → join
  edges.push(methodEdge(370, joinY + joinH, 370, verdictY, bandColor('join')));

  svg.setAttribute('viewBox', `0 0 ${W} ${fanBottom + 24}`);
  const edgeLayer = svgEl('g', {});
  edges.forEach((e) => edgeLayer.appendChild(e));
  const nodeLayer = svgEl('g', {});
  nodes.forEach((n) => nodeLayer.appendChild(n));
  svg.replaceChildren(edgeLayer, nodeLayer);
}

/**
 * The delegated toggle handler — attached ONCE per svg root (original or viewer clone), it
 * survives every re-render because renderMethodInto swaps CHILDREN, never the root.
 */
function wireMethodToggles(svg: SVGSVGElement, data: MethodData, expanded: Set<string>): void {
  svg.addEventListener('click', (e) => {
    const toggle = (e.target as Element).closest?.('[data-method-toggle]');
    if (!toggle) return;
    e.stopPropagation();
    const band = toggle.getAttribute('data-method-toggle') ?? '';
    expanded.has(band) ? expanded.delete(band) : expanded.add(band);
    renderMethodInto(svg, data, expanded);
  });
}

function methodFigure(data: MethodData): HTMLElement {
  const wrap = document.createElement('div');

  // ONE stable svg root: re-renders swap its children, so the delegated toggle listener and the
  // element the figure viewer clones both stay valid across every expand/collapse.
  const svg = svgEl('svg', { role: 'img', 'aria-label': 'How this review works' });
  Object.assign(svg.style, { display: 'block', width: '100%', maxWidth: '740px', height: 'auto', margin: '0.5em auto' });
  const expanded = new Set<string>();
  renderMethodInto(svg, data, expanded);
  wireMethodToggles(svg, data, expanded);
  wrap.appendChild(svg);

  const actions = document.createElement('div');
  Object.assign(actions.style, { display: 'flex', gap: '10px', justifyContent: 'center', margin: '0.25em 0 0.75em' });
  const expand = document.createElement('button');
  expand.type = 'button';
  expand.textContent = '⤢ Expand diagram';
  expand.setAttribute('aria-label', 'Expand the review-method diagram');
  expand.style.cssText = 'font:0.85rem sans-serif;line-height:1;padding:0.5em 0.9em;border:1px solid '
    + 'var(--color-text-faint, #666);border-radius:6px;background:none;color:var(--color-text, #e0e0e0);cursor:pointer;';
  expand.addEventListener('click', () => {
    // Lazy, same as the harvest figure: the viewer only loads if someone expands. The viewer
    // shows a CLONE (listeners dropped), so onMount re-wires the toggles on the copy — with its
    // OWN expansion state, seeded from the inline figure's, so the two don't fight.
    void import('../utilities/figureViewer').then(({ openFigureViewer }) => {
      openFigureViewer(svg, {
        title: 'How this review works',
        downloadName: 'review-method.svg',
        onMount: (shown) => {
          if (!(shown instanceof SVGSVGElement)) return;
          wireMethodToggles(shown, data, new Set(expanded));
        },
      });
    });
  });
  actions.appendChild(expand);
  wrap.appendChild(actions);
  return wrap;
}

/** Swap the review-method marker table for the flow-chart figure. */
export function renderReviewMethod(container: Element): void {
  container.querySelectorAll<HTMLTableElement>('table[data-chart="review-method"]').forEach((table) => {
    const data: MethodData = { bands: new Map(), steps: new Map(), meta: new Map(), verdicts: [] };
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      const qCell = cells.item(0);
      const aCell = cells.item(1);
      if (!qCell || !aCell) return;
      const band = tr.getAttribute('data-band') ?? '';
      const kind = tr.getAttribute('data-kind');
      const href = aCell.querySelector('a')?.getAttribute('href') ?? null;
      const textOf = (cell: Element) => {
        const clone = cell.cloneNode(true) as HTMLElement;
        clone.querySelector('a')?.remove();
        return (clone.textContent ?? '').trim();
      };
      if (kind === 'meta') {
        data.meta.set(band, textOf(aCell));
      } else if (kind === 'verdict') {
        data.verdicts.push({ label: textOf(qCell), count: Number(textOf(aCell)) || 0 });
      } else if (kind === 'step') {
        if (href) {
          const list = data.steps.get(band) ?? [];
          list.push({ title: textOf(qCell), href });
          data.steps.set(band, list);
        }
      } else {
        data.bands.set(band, { question: textOf(qCell), sub: textOf(aCell), codeUrl: href });
      }
    });
    if (data.bands.size === 0) return; // malformed: keep the table as its own fallback
    table.replaceWith(methodFigure(data));
  });
}

/** Swap every citation-path marker table in the container for its rendered block. */
export function renderCitationPaths(container: Element): void {
  container.querySelectorAll<HTMLTableElement>('table[data-chart="citation-path"]').forEach((table) => {
    const rows = parseRows(table);
    if (rows.length === 0) return; // malformed table: leave the fallback visible
    const recorded = table.getAttribute('data-recorded') === '1';
    table.replaceWith(buildBlock(rows, recorded));
  });
}
