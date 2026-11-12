/**
 * Tillage — the commoner score ("hectares of the commons tilled") drawn as a
 * collapsible section at the top of the Stats overlay's scrolling body.
 *
 * A ROSE chart in two levels:
 *  - TOP: one slice per dimension of contribution (Hosting, Being cited,
 *    Citing others, Editing, Annotating), each slice's AREA proportional to
 *    the hectares earned in it (radius ∝ √hectares — a radius-proportional
 *    rose exaggerates the big slice quadratically). Rings inside a slice
 *    preview its sources, centre outward, in falling shades of its green.
 *  - DRILLED: click (or Enter on) a slice and it opens into its own rose,
 *    one slice per SOURCE, labelled with count × weight. A back button
 *    returns to the top.
 * A faint full-size track behind every slice keeps empty dimensions and
 * sources visible, so the chart doubles as the map of how hectares are earned.
 *
 * Groups, sources, labels and weights all come from GET /api/me/commoner
 * (`CommonerScoreService::breakdownFor`) — the single definition. Nothing here
 * knows what a hypercite is worth; a new source or dimension added
 * server-side draws itself. The payload also carries the whole commons'
 * total (aggregate only), shown as the user's share.
 *
 * PRIVATE own-view, like the score itself.
 */

import { log } from '../../utilities/logger';
import { cardSvg, downloadPng, readPalette, shareMode, sharePng, svgToPng } from './tillageExport';

export interface TillageSource {
    key: string;
    group: string;
    label: string;
    count: number;
    per: number;
}

export interface TillageGroup {
    key: string;
    label: string;
}

export interface CommonerBreakdown {
    hectares: number;
    groups: TillageGroup[];
    sources: TillageSource[];
    commons: { hectares: number; commoners: number } | null;
}

const COLLAPSE_KEY = 'hyperlit.stats.tillageCollapsed';

/** Shades within one green, used for rings (top level) and source slices (drilled). */
const SHADE = [1, 0.72, 0.52, 0.36, 0.24];

function shade(i: number): number {
    return SHADE[Math.min(i, SHADE.length - 1)] ?? 1;
}

function esc(s: string): string {
    return s.replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
}

function fmt(n: number): string {
    return n.toLocaleString('en');
}

/**
 * Collapsed by DEFAULT — the summary line's mini rose is the invitation to
 * open it, and the book list is what most visits are for. Only an explicit
 * open ('0', written by the toggle) keeps it open on the next visit.
 */
function readCollapsed(): boolean {
    try {
        return localStorage.getItem(COLLAPSE_KEY) !== '0';
    } catch {
        return true;
    }
}

function writeCollapsed(collapsed: boolean): void {
    try {
        localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
        /* per-viewer convenience only */
    }
}

/** Normalise whatever the endpoint returned into a breakdown we can draw. */
export function parseBreakdown(data: unknown): CommonerBreakdown | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const rawSources = Array.isArray(d.sources) ? d.sources : [];
    const sources: TillageSource[] = rawSources
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map(s => ({
            key: String(s.key ?? ''),
            group: String(s.group ?? 'other'),
            label: String(s.label ?? s.key ?? ''),
            count: Math.max(0, Number(s.count) || 0),
            per: Math.max(0, Number(s.per) || 0),
        }));
    const rawGroups = Array.isArray(d.groups) ? d.groups : [];
    const groups: TillageGroup[] = rawGroups
        .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
        .map(g => ({ key: String(g.key ?? ''), label: String(g.label ?? g.key ?? '') }));
    // A source naming a group the payload didn't declare still gets a slice.
    for (const s of sources) {
        if (!groups.some(g => g.key === s.group)) groups.push({ key: s.group, label: s.group });
    }
    const c = d.commons && typeof d.commons === 'object' ? d.commons as Record<string, unknown> : null;
    const commons = c
        ? { hectares: Math.max(0, Number(c.hectares) || 0), commoners: Math.max(0, Number(c.commoners) || 0) }
        : null;
    return { hectares: Math.max(0, Number(d.hectares) || 0), groups, sources, commons };
}

/* ── geometry ─────────────────────────────────────────────────────────── */

const W = 460;
const H = 320;
const CX = W / 2;
const CY = H / 2;
const R = 108;          // radius of the biggest slice / the track
const GAP = 0.04;       // radians between slices
const MIN_RING = 1.5;   // anything earned is never invisible
const LABEL_CHARS = 18; // wrap slice labels past this

/** An annular sector (a wedge when r0 = 0). Angles in radians, 0 = 12 o'clock, clockwise. */
function sector(r0: number, r1: number, a0: number, a1: number): string {
    const pt = (r: number, a: number) => `${(CX + r * Math.sin(a)).toFixed(2)} ${(CY - r * Math.cos(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const outer = `M ${pt(r1, a0)} A ${r1.toFixed(2)} ${r1.toFixed(2)} 0 ${large} 1 ${pt(r1, a1)}`;
    if (r0 <= 0) return `${outer} L ${CX} ${CY} Z`;
    return `${outer} L ${pt(r0, a1)} A ${r0.toFixed(2)} ${r0.toFixed(2)} 0 ${large} 0 ${pt(r0, a0)} Z`;
}

/**
 * Two balanced lines, split at the space nearest the middle, so neither line
 * runs much past the chart's edge. A label short enough stays on one line.
 */
function wrap(label: string): string[] {
    if (label.length <= LABEL_CHARS) return [label];
    const mid = label.length / 2;
    let best = -1;
    for (let i = 0; i < label.length; i++) {
        if (label[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    }
    return best < 0 ? [label] : [label.slice(0, best), label.slice(best + 1)];
}

interface RoseRing {
    key: string;
    ha: number;
    opacity: number;
    title: string;
}

interface RoseSlice {
    key: string;
    label: string;
    sub: string;
    ha: number;
    colour: number;           // which green (tillage-g-N)
    rings: RoseRing[];        // drawn centre outward
    drill: boolean;           // clicking opens it
}

/**
 * `mini`: the same rose as a text-height glyph — no labels, no hub, no
 * interactivity, viewBox cropped to the track. Its minimum ring is far wider
 * in viewBox units, because at ~14px a 1.5-unit ring is a fifth of a pixel.
 */
function roseSvg(slices: RoseSlice[], aria: string, mini = false): string {
    const minRing = mini ? 14 : MIN_RING;
    const n = Math.max(1, slices.length);
    const span = (2 * Math.PI) / n;
    const maxHa = Math.max(1, ...slices.map(s => s.ha));

    const body = slices.map((slice, index) => {
        // First slice centred at 12 o'clock.
        const a0 = index * span - span / 2 + GAP / 2;
        const a1 = a0 + span - GAP;
        const mid = (a0 + a1) / 2;

        let cum = 0;
        let rPrev = 0;
        const rings = slice.rings.map(r => {
            if (r.ha <= 0) return '';
            cum += r.ha;
            const rOut = Math.max(rPrev + minRing, R * Math.sqrt(cum / maxHa));
            const path = sector(rPrev, rOut, a0, a1);
            rPrev = rOut;
            const title = mini ? '' : `<title>${esc(r.title)}</title>`;
            return `<path class="tillage-ring" data-src="${esc(r.key)}" d="${path}" fill-opacity="${r.opacity}">${title}</path>`;
        }).join('');

        if (mini) {
            return `<g class="tillage-slice tillage-g-${slice.colour % 5}">
              <path class="tillage-track" d="${sector(0, R, a0, a1)}"/>${rings}
            </g>`;
        }

        // Label just outside the track, anchored by which side of the rose it sits on.
        const lines = wrap(slice.label);
        const lr = R + 14;
        const lx = CX + lr * Math.sin(mid);
        const ly = CY - lr * Math.cos(mid);
        const sin = Math.sin(mid);
        const cos = Math.cos(mid);
        const anchor = Math.abs(sin) < 0.3 ? 'middle' : sin > 0 ? 'start' : 'end';
        const block = lines.length * 14 + 13;
        const top = cos > 0.3 ? ly - block + 8 : cos < -0.3 ? ly + 8 : ly - block / 2 + 8;
        const text = lines.map((l, i) =>
            `<text class="tillage-slice-label" x="${lx.toFixed(1)}" y="${(top + i * 14).toFixed(1)}" text-anchor="${anchor}">${esc(l)}</text>`,
        ).join('') + `<text class="tillage-slice-ha" x="${lx.toFixed(1)}" y="${(top + lines.length * 14).toFixed(1)}" text-anchor="${anchor}">${esc(slice.sub)}</text>`;

        const interactive = slice.drill
            ? ` role="button" tabindex="0" data-drill="${esc(slice.key)}" aria-label="${esc(`${slice.label}: ${slice.sub}. Show its parts`)}"`
            : '';
        return `<g class="tillage-slice tillage-g-${slice.colour % 5}${slice.drill ? ' is-drillable' : ''}" style="--tillage-i:${index}"${interactive}>
          <path class="tillage-track" d="${sector(0, R, a0, a1)}"/>
          <g class="tillage-rings">${rings}</g>
          ${text}
        </g>`;
    }).join('');

    if (mini) {
        const pad = 4;
        return `<svg class="tillage-mini-svg" viewBox="${CX - R - pad} ${CY - R - pad} ${2 * (R + pad)} ${2 * (R + pad)}" aria-hidden="true" focusable="false">${body}</svg>`;
    }

    // role="group", not "img": an img's children are presentational, which
    // would hide the clickable slices from assistive tech.
    return `<svg class="tillage-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(aria)}">
      ${body}
      <circle class="tillage-hub" cx="${CX}" cy="${CY}" r="2.5"/>
    </svg>`;
}

function sourceHa(s: TillageSource): number {
    return s.count * s.per;
}

function topSlices(b: CommonerBreakdown): RoseSlice[] {
    return b.groups.map((g, i) => {
        const members = b.sources.filter(s => s.group === g.key);
        const ha = members.reduce((sum, s) => sum + sourceHa(s), 0);
        return {
            key: g.key,
            label: g.label,
            sub: `${fmt(ha)} ha`,
            ha,
            colour: i,
            rings: members.map((s, j) => ({
                key: s.key,
                ha: sourceHa(s),
                opacity: shade(j),
                title: `${s.label}: ${fmt(s.count)} × ${s.per} ha = ${fmt(sourceHa(s))} ha`,
            })),
            drill: true,
        };
    });
}

/** TOP level: one slice per dimension, its sources as rings. Pure — unit-testable. */
export function tillageSvg(b: CommonerBreakdown): string {
    const slices = topSlices(b);
    const aria = slices.map(s => `${s.label}: ${s.ha} hectares`).join('; ') + `. Total ${b.hectares} hectares.`;
    return roseSvg(slices, aria);
}

/**
 * The same rose as a glyph for the collapsed summary line — your shape at a
 * glance without opening the section. Decorative (aria-hidden): the summary
 * text beside it already says the total.
 */
export function tillageMiniSvg(b: CommonerBreakdown): string {
    return roseSvg(topSlices(b), '', true);
}

/** DRILLED: one slice per source of a single dimension. Pure — unit-testable. */
export function tillageDetailSvg(b: CommonerBreakdown, groupKey: string): string {
    const gi = Math.max(0, b.groups.findIndex(g => g.key === groupKey));
    const members = b.sources.filter(s => s.group === groupKey);
    const slices: RoseSlice[] = members.map((s, j) => ({
        key: s.key,
        label: s.label,
        sub: `${fmt(s.count)} × ${s.per} = ${fmt(sourceHa(s))} ha`,
        ha: sourceHa(s),
        colour: gi,
        rings: [{ key: s.key, ha: sourceHa(s), opacity: shade(j), title: s.label }],
        drill: false,
    }));
    const aria = members.map(s => `${s.label}: ${s.count} × ${s.per} = ${sourceHa(s)} hectares`).join('; ');
    return roseSvg(slices, aria);
}

/* ── rendering ────────────────────────────────────────────────────────── */

function summaryText(b: CommonerBreakdown): string {
    return `${fmt(b.hectares)} hectare${b.hectares === 1 ? '' : 's'} of the knowledge commons`;
}

/** Your share of the whole commons, for under the chart; '' when there is no total to compare to. */
function shareText(b: CommonerBreakdown): string {
    if (!b.commons || b.commons.hectares <= 0) return '';
    const pct = (100 * b.hectares) / b.commons.hectares;
    const share = pct === 0 ? '0%' : pct < 0.1 ? '<0.1%' : `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
    const people = `${fmt(b.commons.commoners)} commoner${b.commons.commoners === 1 ? '' : 's'}`;
    return `${share} of the ${fmt(b.commons.hectares)} ha tilled by ${people}`;
}

// Lucide "share" and "download" — the same 24px stroke family as the menu icons.
const ICON_SHARE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/></svg>';
const ICON_DOWNLOAD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';

/** Share/copy + download, beside the chart. The share label says what it will actually do here. */
function actionsHtml(): string {
    const mode = shareMode();
    const shareLabel = mode === 'copy' ? 'Copy tillage image' : 'Share tillage image';
    const shareBtn = mode === 'download'
        ? '' // nothing but a download is possible — one button is enough
        : `<button type="button" class="tillage-action" data-action="share" aria-label="${shareLabel}" title="${shareLabel}">${ICON_SHARE}</button>`;
    return `<div class="tillage-actions">
        ${shareBtn}
        <button type="button" class="tillage-action" data-action="download" aria-label="Download tillage image" title="Download tillage image">${ICON_DOWNLOAD}</button>
        <span class="tillage-action-status" role="status" aria-live="polite"></span>
      </div>`;
}

/** The export card for whichever view is showing (top level, or one dimension drilled into). */
function exportSvg(b: CommonerBreakdown, groupKey: string | null, paletteFrom: Element): string {
    const g = groupKey ? b.groups.find(x => x.key === groupKey) : null;
    const chart = groupKey ? tillageDetailSvg(b, groupKey) : tillageSvg(b);
    const groupHa = groupKey ? b.sources.filter(s => s.group === groupKey).reduce((sum, s) => sum + sourceHa(s), 0) : 0;
    return cardSvg(chart, {
        title: g ? `Tillage · ${g.label}` : 'Tillage',
        headline: g ? `${fmt(groupHa)} of my ${summaryText(b)}` : summaryText(b),
        note: groupKey ? '' : shareText(b),
    }, readPalette(paletteFrom));
}

function render(body: HTMLElement, b: CommonerBreakdown, groupKey: string | null): void {
    if (groupKey) {
        const g = b.groups.find(x => x.key === groupKey);
        const ha = b.sources.filter(s => s.group === groupKey).reduce((sum, s) => sum + sourceHa(s), 0);
        body.innerHTML = `
          <div class="tillage-drill-head">
            <button type="button" class="tillage-back" aria-label="Back to all dimensions">&larr; All</button>
            <span class="tillage-drill-title">${esc(g?.label ?? groupKey)}</span>
            <span class="tillage-drill-ha">${fmt(ha)} ha</span>
          </div>
          ${actionsHtml()}
          ${tillageDetailSvg(b, groupKey)}`;
        body.querySelector<HTMLElement>('.tillage-back')?.focus();
        return;
    }
    // Just the share — the chart explains itself, and drilling in is left
    // for the user to discover.
    const share = shareText(b);
    body.innerHTML = actionsHtml() + tillageSvg(b) + (share ? `<p class="tillage-note">${esc(share)}</p>` : '');
}

/** The collapsible shell; filled by `loadTillage`. */
export function tillageSectionHtml(): string {
    return `
      <details class="stats-tillage"${readCollapsed() ? '' : ' open'}>
        <summary class="stats-tillage-summary">
          <span class="tillage-mini" aria-hidden="true"></span>
          <span class="stats-tillage-title">Tillage</span>
          <span class="stats-tillage-total">&hellip;</span>
        </summary>
        <div class="stats-tillage-body"><p class="tillage-note">Loading&hellip;</p></div>
      </details>`;
}

/**
 * Drill in on a slice (click, or Enter/Space when focused) and back out.
 * Listeners sit on the body, which outlives every re-render. Each handled
 * click stops propagation, like every other branch of the overlay's own
 * click handler.
 */
function wireDrill(body: HTMLElement, b: CommonerBreakdown): void {
    let returnTo: string | null = null;
    let view: string | null = null;
    // The PNG for the current view, started when the pointer/focus reaches the
    // actions so a click can hand it over without waiting (see sharePng).
    let png: { view: string | null; blob: Promise<Blob> } | null = null;
    const pngFor = (): Promise<Blob> => {
        if (!png || png.view !== view) {
            const blob = rasterize(exportSvg(b, view, body));
            blob.catch(() => { png = null; }); // a failed render is retried on the next ask
            png = { view, blob };
        }
        return png.blob;
    };
    const filename = () => `tillage${view ? `-${view}` : ''}.png`;
    const status = (msg: string) => {
        const el = body.querySelector<HTMLElement>('.tillage-action-status');
        if (!el) return;
        el.textContent = msg;
        window.setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2000);
    };
    const act = async (action: string) => {
        try {
            if (action === 'download') {
                downloadPng(await pngFor(), filename());
                status('Downloaded');
                return;
            }
            const outcome = await sharePng(pngFor(), filename(), summaryText(b));
            if (outcome === 'copied') status('Copied');
            else if (outcome === 'downloaded') status('Downloaded');
        } catch (error) {
            log.error('Stats overlay: tillage image export failed', '/components/statsOverlay/tillage.ts', error);
            status('Could not make the image');
        }
    };

    const open = (key: string) => {
        returnTo = key;
        view = key;
        render(body, b, key);
    };
    const back = () => {
        view = null;
        render(body, b, null);
        if (returnTo) {
            body.querySelector<SVGGElement>(`[data-drill="${CSS.escape(returnTo)}"]`)?.focus();
        }
    };

    body.addEventListener('click', e => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        if (t.closest('.tillage-back')) {
            e.stopPropagation();
            back();
            return;
        }
        const action = t.closest<HTMLElement>('[data-action]');
        if (action) {
            e.stopPropagation();
            void act(action.dataset.action ?? '');
            return;
        }
        const slice = t.closest('[data-drill]');
        if (slice) {
            e.stopPropagation();
            open(slice.getAttribute('data-drill') ?? '');
        }
    });
    const warm = (e: Event) => {
        if (e.target instanceof Element && e.target.closest('.tillage-actions')) void pngFor().catch(() => {});
    };
    body.addEventListener('pointerover', warm);
    body.addEventListener('focusin', warm);
    body.addEventListener('keydown', e => {
        const t = e.target instanceof Element ? e.target : null;
        const slice = t?.closest('[data-drill]');
        if (slice && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            open(slice.getAttribute('data-drill') ?? '');
        }
    });
}

export async function loadTillage(section: HTMLDetailsElement): Promise<void> {
    section.addEventListener('toggle', () => writeCollapsed(!section.open));
    const totalEl = section.querySelector<HTMLElement>('.stats-tillage-total');
    const body = section.querySelector<HTMLElement>('.stats-tillage-body');
    if (!totalEl || !body) return;
    try {
        const resp = await fetch('/api/me/commoner', {
            headers: { Accept: 'application/json' },
            credentials: 'include',
        });
        const data: unknown = await resp.json().catch(() => null); // consumes the body (drain gate)
        if (!resp.ok) throw new Error(`commoner fetch failed (${resp.status})`);
        const b = parseBreakdown(data);
        if (!b) throw new Error('commoner response unreadable');
        totalEl.textContent = summaryText(b);
        const mini = section.querySelector<HTMLElement>('.tillage-mini');
        if (mini) mini.innerHTML = tillageMiniSvg(b);
        render(body, b, null);
        wireDrill(body, b);
    } catch (error) {
        log.error('Stats overlay: failed to load tillage', '/components/statsOverlay/tillage.ts', error);
        totalEl.textContent = '';
        body.innerHTML = '<p class="tillage-note">Could not load your tillage right now.</p>';
    }
}

/** SVG → PNG. A seam so tests can stand in for the canvas, which happy-dom can't rasterise. */
let rasterize: (svg: string) => Promise<Blob> = svg => svgToPng(svg);

/** Exported for tests. */
export const __test = {
    summaryText,
    shareText,
    wrap,
    exportSvg,
    setRasterizer(fn: (svg: string) => Promise<Blob>) { rasterize = fn; },
    resetRasterizer() { rasterize = svg => svgToPng(svg); },
};
