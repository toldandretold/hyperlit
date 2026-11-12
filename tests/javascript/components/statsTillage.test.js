import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseBreakdown, tillageSvg, tillageDetailSvg, tillageMiniSvg, tillageSectionHtml, loadTillage, __test,
} from '../../../resources/js/components/statsOverlay/tillage.ts';

const GROUPS = [
  { key: 'hosting', label: 'Hosting' },
  { key: 'cited', label: 'Being cited' },
  { key: 'citing', label: 'Citing others' },
  { key: 'editing', label: 'Editing' },
  { key: 'annotating', label: 'Annotating' },
];
const src = (key, group, count, per, label = key) => ({ key, group, label, count, per });

const sample = (commons = { hectares: 20000, commoners: 40 }) => parseBreakdown({
  hectares: 184 + 190 + 1575 + 6,
  groups: GROUPS,
  commons,
  sources: [
    src('hosted', 'hosting', 184, 1),
    src('book_liked', 'hosting', 38, 5),
    src('verified_oa', 'hosting', 0, 9, 'Verified open-access works (bonus)'),
    src('hypercited', 'cited', 63, 25),
    src('referenced', 'cited', 0, 15),
    src('highlighted', 'annotating', 6, 1),
  ],
});

const outerRadius = path => Number(path.match(/A ([\d.]+)/)[1]);
const ringPaths = svg => Object.fromEntries(
  [...svg.matchAll(/class="tillage-ring" data-src="([^"]+)" d="([^"]+)"/g)].map(m => [m[1], m[2]]),
);

describe('tillage rose — top level', () => {
  it('one clickable, focusable slice per dimension; empty dimensions keep a track', () => {
    const svg = tillageSvg(sample());
    expect((svg.match(/data-drill="/g) || []).length).toBe(5);
    expect((svg.match(/tabindex="0"/g) || []).length).toBe(5);
    expect((svg.match(/class="tillage-track"/g) || []).length).toBe(5);
    expect(svg).toContain('>Citing others<');
  });

  it('is a role=group, never role=img (img children are hidden from assistive tech)', () => {
    expect(tillageSvg(sample())).toMatch(/<svg[^>]*role="group"/);
    expect(tillageSvg(sample())).not.toContain('role="img"');
  });

  it('slice AREA is proportional to hectares (radius ∝ √ha)', () => {
    const rings = ringPaths(tillageSvg(sample()));
    const cited = outerRadius(rings.hypercited);
    const hosting = outerRadius(rings.book_liked); // 184 + 190
    expect((hosting / cited) ** 2).toBeCloseTo(374 / 1575, 3);
  });

  it('a tiny source beside a huge one is still a visible ring; zero draws none', () => {
    const rings = ringPaths(tillageSvg(sample()));
    expect(outerRadius(rings.highlighted)).toBeGreaterThanOrEqual(1.5);
    expect(rings.referenced).toBeUndefined();
  });

  it('zero hectares: all tracks, no rings, no NaN', () => {
    const b = parseBreakdown({ hectares: 0, groups: GROUPS, sources: [src('hosted', 'hosting', 0, 1)] });
    const svg = tillageSvg(b);
    expect(svg).not.toContain('class="tillage-ring"');
    expect(svg).not.toContain('NaN');
  });
});

describe('tillage rose — drilled into one dimension', () => {
  it('one slice per SOURCE of that dimension only, labelled count × weight, not clickable', () => {
    const svg = tillageDetailSvg(sample(), 'hosting');
    expect((svg.match(/class="tillage-slice /g) || []).length).toBe(3);
    expect(svg).toContain('184 × 1 = 184 ha');
    expect(svg).toContain('38 × 5 = 190 ha');
    expect(svg).not.toContain('data-drill');
    expect(svg).not.toContain('hypercited');
  });

  it('wraps a long source label rather than running off the chart', () => {
    const svg = tillageDetailSvg(sample(), 'hosting');
    expect(svg).toContain('>Verified open-access<');
    expect(svg).toContain('>works (bonus)<');
  });
});

describe('tillage mini glyph', () => {
  it('is the same rose — one slice per dimension, same rings — with no text or controls', () => {
    const mini = tillageMiniSvg(sample());
    expect((mini.match(/class="tillage-slice /g) || []).length).toBe(5);
    expect(Object.keys(ringPaths(mini)).sort()).toEqual(Object.keys(ringPaths(tillageSvg(sample()))).sort());
    expect(mini).not.toMatch(/<text|<title|data-drill|tabindex/);
    expect(mini).toContain('aria-hidden="true"');
  });

  it('crops to the track so it fills a text-height box', () => {
    expect(tillageMiniSvg(sample())).toMatch(/viewBox="118 48 224 224"/);
  });
});

describe('tillage summary + payload', () => {
  it('the summary names your hectares of the knowledge commons; the share sits under the chart', () => {
    expect(__test.summaryText(sample())).toBe('1,955 hectares of the knowledge commons');
    expect(__test.shareText(sample())).toBe('9.8% of the 20,000 ha tilled by 40 commoners');
    expect(__test.shareText(sample({ hectares: 10_000_000, commoners: 9 }))).toBe('<0.1% of the 10,000,000 ha tilled by 9 commoners');
    expect(__test.shareText(sample(null))).toBe('');
  });

  it('weights and groups come from the payload; an undeclared group still gets a slice', () => {
    const b = parseBreakdown({ hectares: 7, groups: [], sources: [src('x', 'newthing', 1, 7)] });
    expect(b.groups).toEqual([{ key: 'newthing', label: 'newthing' }]);
    expect(tillageDetailSvg(b, 'newthing')).toContain('1 × 7 = 7 ha');
  });

  it('escapes labels and tolerates a junk payload', () => {
    const b = parseBreakdown({ hectares: 1, groups: [{ key: 'g', label: '<b>' }], sources: [{ key: 'x', group: 'g', label: '<img onerror=1>', count: 1, per: 1 }, null] });
    expect(tillageSvg(b) + tillageDetailSvg(b, 'g')).not.toMatch(/<img|<b>/);
    expect(parseBreakdown(null)).toBeNull();
    expect(parseBreakdown({}).commons).toBeNull();
  });

  it('ships as a native collapsible <details>, collapsed by default; an explicit open is remembered', () => {
    localStorage.removeItem('hyperlit.stats.tillageCollapsed');
    expect(tillageSectionHtml()).toMatch(/<details class="stats-tillage">/);
    localStorage.setItem('hyperlit.stats.tillageCollapsed', '0');
    expect(tillageSectionHtml()).toMatch(/<details class="stats-tillage" open>/);
    localStorage.setItem('hyperlit.stats.tillageCollapsed', '1');
    expect(tillageSectionHtml()).toMatch(/<details class="stats-tillage">/);
    localStorage.removeItem('hyperlit.stats.tillageCollapsed');
  });
});

describe('tillage drill-down (DOM)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function mount() {
    const payload = {
      hectares: 1955,
      commons: { hectares: 20000, commoners: 40 },
      groups: GROUPS,
      sources: [src('hosted', 'hosting', 184, 1), src('book_liked', 'hosting', 38, 5), src('hypercited', 'cited', 63, 25)],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
    document.body.innerHTML = tillageSectionHtml();
    const section = document.querySelector('.stats-tillage');
    await loadTillage(section);
    return section;
  }

  it('click a slice → its parts; back → the top level, focus returned to that slice', async () => {
    const section = await mount();
    expect(section.querySelector('.stats-tillage-total').textContent).toBe('1,955 hectares of the knowledge commons');
    expect(section.querySelector('.tillage-note').textContent).toBe('9.8% of the 20,000 ha tilled by 40 commoners');
    expect(section.querySelector('.tillage-mini svg')).not.toBeNull();

    section.querySelector('[data-drill="hosting"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(section.querySelector('.tillage-drill-title').textContent).toBe('Hosting');
    expect(section.querySelector('.tillage-drill-ha').textContent).toBe('374 ha');
    expect(section.querySelectorAll('.stats-tillage-body .tillage-slice')).toHaveLength(2);
    expect(document.activeElement?.classList.contains('tillage-back')).toBe(true);

    section.querySelector('.tillage-back').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(section.querySelectorAll('[data-drill]')).toHaveLength(5);
    expect(document.activeElement?.getAttribute('data-drill')).toBe('hosting');
  });

  it('Enter on a focused slice drills in (keyboard users get the same path)', async () => {
    const section = await mount();
    const slice = section.querySelector('[data-drill="cited"]');
    slice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(section.querySelector('.tillage-drill-title').textContent).toBe('Being cited');
  });

  it('a drill click does not bubble to the overlay (its root handler closes on stray clicks)', async () => {
    const section = await mount();
    const outer = vi.fn();
    document.body.addEventListener('click', outer);
    section.querySelector('[data-drill="hosting"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(outer).not.toHaveBeenCalled();
  });
});
