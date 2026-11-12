/**
 * Tillage as a shareable image: the card markup (standalone — the page's CSS
 * can't reach an SVG drawn to a canvas) and the share / copy / download
 * buttons. The canvas itself is stubbed: happy-dom cannot rasterise.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cardSvg, shareMode } from '../../../resources/js/components/statsOverlay/tillageExport.ts';
import {
  parseBreakdown, tillageSvg, tillageSectionHtml, loadTillage, __test,
} from '../../../resources/js/components/statsOverlay/tillage.ts';

const PALETTE = { bg: '#efe4c8', text: '#2b2418', greens: ['#111111', '#222222', '#333333', '#444444', '#555555'] };
const payload = {
  hectares: 1955,
  commons: { hectares: 20000, commoners: 40 },
  groups: [{ key: 'hosting', label: 'Hosting' }, { key: 'citing', label: 'Citing' }],
  sources: [
    { key: 'hosted', group: 'hosting', label: 'Published books you host', count: 184, per: 1 },
    { key: 'hypercited', group: 'citing', label: 'Hypercited by other texts', count: 63, per: 25 },
  ],
};

describe('tillage export card', () => {
  const svg = cardSvg(tillageSvg(parseBreakdown(payload)), {
    title: 'Tillage', headline: '1,955 hectares of the knowledge commons', note: '9.8% of the 20,000 ha tilled by 40 commoners',
  }, PALETTE);

  it('is a standalone square SVG carrying its own colours (no CSS variables — the page stylesheet never reaches it)', () => {
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="1200" height="1200"/);
    expect(svg).toContain('<style>');
    expect(svg).toContain('.tillage-g-0 .tillage-ring,.tillage-g-0 .tillage-track{fill:#111111');
    expect(svg).not.toContain('var(--');
  });

  it('carries the title, hectares, share and the hyperlit.io mark, with the rose nested at a fixed box', () => {
    expect(svg).toContain('>Tillage<');
    expect(svg).toContain('>1,955 hectares of the knowledge commons<');
    expect(svg).toContain('>9.8% of the 20,000 ha tilled by 40 commoners<');
    expect(svg).toContain('>hyperlit.io<');
    expect(svg).toMatch(/<svg x="80" y="250" width="1040" height="723" viewBox="0 0 460 320"/);
  });

  it('strips interactivity — a picture has no buttons', () => {
    expect(svg).not.toMatch(/tabindex|data-drill|role=/);
  });

  it('escapes the text it is given', () => {
    expect(cardSvg('<svg class="tillage-chart"></svg>', { title: '<b>', headline: '&', note: '' }, PALETTE))
      .not.toMatch(/<b>|>&</);
  });

  it('a drilled view exports that dimension, titled and framed as a part of the whole', () => {
    document.body.innerHTML = '<div id="x"></div>';
    const out = __test.exportSvg(parseBreakdown(payload), 'citing', document.getElementById('x'));
    expect(out).toContain('>Tillage · Citing<');
    expect(out).toContain('>1,575 of my 1,955 hectares of the knowledge commons<');
    expect(out).toContain('63 × 25 = 1,575 ha');
  });
});

describe('tillage share / download buttons (DOM)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __test.resetRasterizer();
    document.body.innerHTML = '';
  });

  async function mount() {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    const png = new Blob(['png'], { type: 'image/png' });
    const raster = vi.fn(async () => png);
    __test.setRasterizer(raster);
    document.body.innerHTML = tillageSectionHtml();
    const section = document.querySelector('.stats-tillage');
    await loadTillage(section);
    return { section, raster, png };
  }
  const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('download renders the current view and saves tillage.png', async () => {
    const { section, raster } = await mount();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.download).toBe('tillage.png');
    });
    click(section.querySelector('[data-action="download"]'));
    await flush();
    expect(raster).toHaveBeenCalledTimes(1);
    expect(raster.mock.calls[0][0]).toContain('>Tillage<');
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(section.querySelector('.tillage-action-status').textContent).toBe('Downloaded');
  });

  it('drilled in, the download is of that dimension', async () => {
    const { section, raster } = await mount();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.download).toBe('tillage-hosting.png');
    });
    click(section.querySelector('[data-drill="hosting"]'));
    click(section.querySelector('[data-action="download"]'));
    await flush();
    expect(raster.mock.calls.at(-1)[0]).toContain('>Tillage · Hosting<');
  });

  it('copy mode writes the PNG to the clipboard and says so', async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal('ClipboardItem', class { constructor(items) { this.items = items; } });
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined, clipboard: { write } });
    expect(shareMode()).toBe('copy');
    const { section } = await mount();
    const btn = section.querySelector('[data-action="share"]');
    expect(btn.getAttribute('aria-label')).toBe('Copy tillage image');
    click(btn);
    await flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(section.querySelector('.tillage-action-status').textContent).toBe('Copied');
  });

  it('share mode hands the PNG to the OS share sheet; a cancelled share is silent', async () => {
    const share = vi.fn(async () => { throw new DOMException('cancelled', 'AbortError'); });
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share });
    const { section } = await mount();
    const btn = section.querySelector('[data-action="share"]');
    expect(btn.getAttribute('aria-label')).toBe('Share tillage image');
    click(btn);
    await flush();
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].files[0].name).toBe('tillage.png');
    expect(section.querySelector('.tillage-action-status').textContent).toBe('');
  });

  it('pointing at the actions warms the render once; the click reuses it', async () => {
    const { section, raster } = await mount();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    section.querySelector('[data-action="download"]').dispatchEvent(new Event('pointerover', { bubbles: true }));
    click(section.querySelector('[data-action="download"]'));
    await flush();
    expect(raster).toHaveBeenCalledTimes(1);
  });

  it('a button click does not bubble to the overlay', async () => {
    const { section } = await mount();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const outer = vi.fn();
    document.body.addEventListener('click', outer);
    click(section.querySelector('[data-action="download"]'));
    expect(outer).not.toHaveBeenCalled();
  });
});
