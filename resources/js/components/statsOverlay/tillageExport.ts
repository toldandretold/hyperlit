/**
 * Tillage as a shareable IMAGE — a square card (title, your hectares, the rose,
 * your share of the commons, hyperlit.io) rendered to PNG for someone who
 * wants to post their tillage. Entirely the user's act: nothing here publishes
 * anything; it hands the PNG to the OS share sheet, the clipboard, or a
 * download. Not part of Hyperlit's public-facing UX.
 *
 * A zero-import leaf: tillage.ts hands it finished chart markup and text, so
 * the two can't form an import cycle.
 *
 * Why the card carries its OWN <style>: an SVG drawn to a canvas through an
 * <img> is an isolated document — the page's stylesheet (and its CSS custom
 * properties) never reach it, so every colour is resolved from the live panel
 * at export time and inlined. The same isolation is why no web font is used.
 */

export interface CardText {
    title: string;
    headline: string;
    note: string;
}

export interface CardPalette {
    bg: string;
    text: string;
    greens: string[];
}

export const CARD_SIZE = 1200;

const FALLBACK_GREENS = ['#2e7d32', '#00897b', '#7cb342', '#558b2f', '#9e9d24'];

function esc(s: string): string {
    return s.replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
}

/** Resolve the panel's live colours, so the image matches what the user sees (light or dark). */
export function readPalette(el: Element): CardPalette {
    const cs = getComputedStyle(el);
    const greens = FALLBACK_GREENS.map((fallback, i) => cs.getPropertyValue(`--tillage-g${i}`).trim() || fallback);
    const bg = cs.getPropertyValue('--color-background').trim() || '#efe4c8';
    const text = cs.color || '#2b2418';
    return { bg, text, greens };
}

/**
 * The card as standalone SVG markup. `chart` is the rose exactly as the panel
 * draws it (tillage.ts's roseSvg output); it is nested at a fixed box.
 */
export function cardSvg(chart: string, t: CardText, p: CardPalette): string {
    const S = CARD_SIZE;
    const pad = 80;
    // The rose's own viewBox is 460 × 320.
    const chartW = S - 2 * pad;
    const chartH = Math.round(chartW * (320 / 460));
    const chartY = 250;

    const nested = chart
        .replace(/<svg class="tillage-chart"/, `<svg x="${pad}" y="${chartY}" width="${chartW}" height="${chartH}"`)
        // Interactivity means nothing in a picture.
        .replace(/\s(role|tabindex|aria-label|data-drill)="[^"]*"/g, '');

    // Ring separators are the BACKGROUND colour, as in the panel; that rule
    // (.tillage-slice .tillage-ring) comes after the per-green one at equal
    // specificity, so it wins the stroke.
    const greens = p.greens.map((g, i) =>
        `.tillage-g-${i} .tillage-ring,.tillage-g-${i} .tillage-track{fill:${g};stroke:${g}}`,
    ).join('');
    const style = `
      text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;fill:${p.text}}
      ${greens}
      .tillage-track{fill-opacity:.09;stroke-opacity:.25;stroke-width:.75}
      .tillage-slice .tillage-ring{stroke:${p.bg};stroke-width:.75;stroke-opacity:1}
      .tillage-hub{fill:${p.text};opacity:.35}
      .tillage-slice-label{font-size:13px;font-weight:600}
      .tillage-slice-ha{font-size:11.5px;opacity:.6}`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <style>${style}</style>
  <rect width="${S}" height="${S}" fill="${p.bg}"/>
  <text x="${pad}" y="140" font-size="68" font-weight="700">${esc(t.title)}</text>
  <text x="${pad}" y="200" font-size="34" opacity=".72">${esc(t.headline)}</text>
  ${nested}
  ${t.note ? `<text x="${S / 2}" y="${chartY + chartH + 70}" font-size="30" opacity=".7" text-anchor="middle">${esc(t.note)}</text>` : ''}
  <text x="${S - pad}" y="${S - 60}" font-size="28" opacity=".5" text-anchor="end">hyperlit.io</text>
</svg>`;
}

/** Rasterise standalone SVG markup to a PNG blob. */
export async function svgToPng(svg: string, size = CARD_SIZE): Promise<Blob> {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('tillage card failed to render'));
            img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d canvas context');
        ctx.drawImage(img, 0, 0, size, size);
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('canvas produced no PNG'))), 'image/png');
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

export type ShareMode = 'share' | 'copy' | 'download';

/**
 * What the share button can do here: the OS share sheet when it accepts image
 * files (phones, Safari, recent Chrome), else copying the PNG to the
 * clipboard, else (old browsers) just a download.
 */
export function shareMode(): ShareMode {
    try {
        const probe = new File([''], 'tillage.png', { type: 'image/png' });
        if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] })) return 'share';
    } catch {
        /* canShare can throw on odd inputs in some engines — fall through */
    }
    if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') return 'copy';
    return 'download';
}

export function downloadPng(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a tick to start the download before the URL dies.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type ShareOutcome = 'shared' | 'copied' | 'downloaded' | 'cancelled';

/**
 * Hand the PNG on. `png` may still be rendering — it is passed as a PROMISE so
 * the clipboard write starts synchronously inside the click (Safari refuses a
 * clipboard write that begins after an await; ClipboardItem accepts a
 * Promise<Blob> precisely for this).
 */
export async function sharePng(png: Promise<Blob>, filename: string, text: string): Promise<ShareOutcome> {
    const mode = shareMode();
    if (mode === 'copy') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        return 'copied';
    }
    const blob = await png;
    if (mode === 'share') {
        try {
            await navigator.share({ files: [new File([blob], filename, { type: 'image/png' })], text });
            return 'shared';
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
            throw e;
        }
    }
    downloadPng(blob, filename);
    return 'downloaded';
}
